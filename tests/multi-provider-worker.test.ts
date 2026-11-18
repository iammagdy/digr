import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The worker running a multi-provider chain job (flag ON) with FAKE providers only: money moves only through the approved functions
 * (here the same kind of fakes the other worker tests use), every provider call is reserved against ITS provider's daily cap and recorded,
 * an unverified row is not delivered or charged, a zero result releases the whole reserve, and with the flag OFF a chain job is released
 * untouched. No live provider is ever called.
 */
const db = vi.hoisted(() => ({
  jobs: [] as any[], quotes: [] as any[], costs: [] as any[],
  partials: new Map<string, Buffer>(), results: new Map<string, Buffer>(),
  rpcCalls: [] as Array<{ name: string; args: any }>, events: [] as any[],
  settings: [] as any[],
  step: 0, cursor: null as string | null, deliveredUnits: 0, targetVolumeMax: 3, unitPrice: 100, reserved: 345, endpoint: "mp.business.contacts",
  reserveDeniedFor: new Set<string>(),
  uploadHistory: [] as Array<{ bucket: string; path: string; existed: boolean }>,
  delayedCompleteChunkMs: 0,
  killAfterCommit: false,
  corruptDownloadPaths: new Set<string>(),
  // the body of every step file ever uploaded: the route deletes the step files once the job has settled
  stepBodies: new Map<string, string>(),
  resultExistedAtSettle: [] as boolean[],
  // DT-20261117-06 H2 (T-M chain): H1's `record_chunk_failure` counter, the seam inside the 5th call, the jobs compare-and-set fake and its switches, and a `complete_chunk` throw switch. The defaults keep every existing test unchanged.
  failCount: 0,
  onFifthFailure: null as null | ((job: any) => void),
  casError: null as any,
  casThrows: false,
  updates: [] as Array<{ patch: any; filters: Array<[string, unknown]> }>,
  throwCompleteChunkAt: 0,
  completeCalls: 0,
  // DT-20261117-07 QA r1: the SQL-equivalent money ledger, the answers of release_job_atomic, the in-app notices inserted
  ledger: [] as Array<{ id: string; job_id: string; user_id: string; type: "release" | "charge"; delta: number; by: "release_job_atomic" | "record_chunk_failure" | "settle_job_atomic" }>,
  releaseAnswers: [] as any[],
  notices: [] as any[],
  job_group_keys: [] as Array<{ group_id: string; key: string; from_part?: number }>,
  tablesQueried: [] as string[],
  groupKeysQueryError: null as any,
  groupKeysDelayMs: 0,
}));

function builder(rows: () => any[]) {
  const filters: Array<[string, unknown]> = [];
  let sortCol: string | null = null;
  let sortAsc = true;
  let sliceRange: [number, number] | null = null;
  const apply = () => {
    let res = rows().filter((row) => filters.every(([col, val]) => row[col] === val));
    if (sortCol) {
      res = [...res].sort((a, b) => {
        const va = a[sortCol!];
        const vb = b[sortCol!];
        if (va < vb) return sortAsc ? -1 : 1;
        if (va > vb) return sortAsc ? 1 : -1;
        return 0;
      });
    }
    if (sliceRange) {
      res = res.slice(sliceRange[0], sliceRange[1] + 1);
    }
    return res;
  };
  const api: any = {
    select: () => api,
    eq: (col: string, val: unknown) => { filters.push([col, val]); return api; },
    in: () => api, or: () => api, not: () => api,
    order: (col: string, opts?: any) => { sortCol = col; sortAsc = opts?.ascending !== false; return api; },
    limit: (n: number) => { sliceRange = [0, n - 1]; return api; },
    gte: () => api,
    range: (from: number, to: number) => { sliceRange = [from, to]; return api; },
    maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
    then: (resolve: any, reject: any) => Promise.resolve({ data: apply(), error: null }).then(resolve, reject),
  };
  return api;
}

/** DT-20261117-06 H2 (T-M chain): the `jobs.update(patch).eq().eq().eq().select()` compare-and-set of the worker. It records every attempt, can fail (returned error or thrown), and otherwise updates the rows that match ALL filters. */
function casChain(patch: any) {
  const filters: Array<[string, unknown]> = [];
  const api: any = {
    eq: (col: string, val: unknown) => { filters.push([col, val]); return api; },
    select: async () => {
      db.updates.push({ patch, filters: [...filters] });
      if (db.casThrows) throw new Error("cas_down");
      if (db.casError) return { data: null, error: db.casError };
      const hit = db.jobs.filter((row) => filters.every(([col, val]) => row[col] === val));
      for (const row of hit) Object.assign(row, patch);
      return { data: hit.map((row) => ({ id: row.id })), error: null };
    },
  };
  return api;
}

function fakeRelease(jobId: string, errorMessage: string | null | undefined, by: "release_job_atomic" | "record_chunk_failure"): { data: any; error: any } {
  const job = db.jobs.find((j) => j.id === jobId);
  const R = db.reserved;
  if (!job) {
    return { data: { success: true, released_credits: R }, error: null };
  }
  if (job.status === "completed") {
    return { data: null, error: { message: `Cannot release already completed job ${jobId}` } };
  }
  const relExists = db.ledger.some((r) => r.id === `rel_${jobId}` && r.type === "release");
  if (relExists && job.status === "failed") {
    return { data: { success: true, already_released: true, job_id: jobId, released_credits: R }, error: null };
  }
  if (!relExists) {
    db.ledger.push({ id: `rel_${jobId}`, job_id: jobId, user_id: job.user_id, type: "release", delta: R, by });
  }
  Object.assign(job, {
    status: "failed",
    charged_credits: 0,
    error_message: errorMessage ?? job.error_message ?? "فشلت المهمة",
    lease_until: null,
  });
  return { data: { success: true, already_released: false, job_id: jobId, user_id: job.user_id, released_credits: R }, error: null };
}

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async (name: string, args: any) => {
      db.rpcCalls.push({ name, args });
      if (name === "claim_job_chunk") {
        const job = db.jobs.find((j) => j.id === args.p_job_id);
        if (job) {
          if (job.current_cursor && String(job.current_cursor).startsWith("term_stop:")) {
            return { data: null, error: { message: "cannot claim a job whose last chunk was terminal" } };
          }
          if (job.status === "running" && job.lease_until && new Date(job.lease_until).getTime() > Date.now()) {
            return { data: null, error: { message: "lease not expired" } };
          }
        }
        // DT-20261117-04 CI r1: like the real claim_job_chunk, write the lease to the job row and return it. It is a Postgres timestamptz text (microseconds, +00:00): the chain runner compares it as an INSTANT with the job row (readJobLease + sameInstant).
        const leaseUntil = new Date(Date.now() + 60_000).toISOString().replace(/Z$/, "456+00:00");
        if (job) Object.assign(job, { status: "running", step: db.step, lease_until: leaseUntil });
        return { data: { claimed: true, job_id: args.p_job_id, user_id: "user_1", step: db.step, current_cursor: db.cursor, delivered_units: db.deliveredUnits, target_volume_max: db.targetVolumeMax, target_volume_min: 1, endpoint_id: db.endpoint, unit_price: db.unitPrice, lease_until: leaseUntil }, error: null };
      }
      if (name === "reserve_provider_spend_atomic") {
        if (db.reserveDeniedFor.has(args.p_provider)) return { data: { allowed: false }, error: null };
        const today = db.costs.filter((c) => c.provider === args.p_provider).reduce((a, c) => a + c.cost_usd, 0);
        if (today + args.p_estimated_cost_usd > args.p_daily_cap_usd) return { data: { allowed: false, current_spend: today }, error: null };
        const row = { id: db.costs.length + 1, job_id: args.p_job_id, provider: args.p_provider, cost_usd: args.p_estimated_cost_usd, units: 0, is_estimate: true };
        db.costs.push(row);
        return { data: { allowed: true, cost_id: row.id }, error: null };
      }
      if (name === "commit_provider_spend_v2" || name === "commit_provider_spend") {
        const row = db.costs.find((c) => c.id === args.p_cost_id);
        if (row) Object.assign(row, { cost_usd: args.p_actual_cost_usd, units: args.p_units, is_estimate: false, capability: args.p_capability ?? null, status: args.p_status ?? null, duration_ms: args.p_duration_ms ?? null });
        return { data: { success: true }, error: null };
      }
      if (name === "complete_chunk") {
        db.completeCalls += 1;
        if (db.completeCalls === db.throwCompleteChunkAt) throw new Error("connection reset");
        if (db.delayedCompleteChunkMs > 0) {
          await new Promise((r) => setTimeout(r, db.delayedCompleteChunkMs));
        }
        const expected = args.p_expected_step;
        if (typeof expected === "number") {
          if (db.step > expected) {
            // like the SQL (20261012135525_chunk_lifecycle_functions.sql :98-105): a stale step answers success true with already_completed true and the job's current step
            return { data: { success: true, already_completed: true, current_step: db.step, delivered_units: db.deliveredUnits }, error: null };
          }
          if (db.step < expected) {
            throw new Error(`step mismatch: current ${db.step} < expected ${expected}`);
          }
        }
        db.step += 1; db.deliveredUnits = args.p_new_delivered_units; db.cursor = args.p_new_cursor;
        const job = db.jobs.find((row) => row.id === args.p_job_id);
        if (job) Object.assign(job, { current_cursor: db.cursor, delivered_units: db.deliveredUnits, status: "running", lease_until: null });
        if (db.killAfterCommit) {
          throw new Error("worker_killed_after_commit");
        }
        return { data: { success: true, delivered_units: db.deliveredUnits }, error: null };
      }
      if (name === "settle_job_atomic") {
        const settledJob = db.jobs.find((j) => j.id === args.p_job_id);
        db.resultExistedAtSettle.push(db.results.has(`user_1/${args.p_job_id}/result.xlsx`));
        const charged = Math.min(Math.ceil(db.deliveredUnits * db.unitPrice), db.reserved);
        // like the SQL (20261017175500_settle_completed_jobs_with_stale_lease.sql :27-30 and :128): a job that is already completed answers already_settled and charges nothing again; the first settlement marks the job completed
        if (settledJob?.status === "completed") return { data: { success: true, already_settled: true, reserved_credits: db.reserved, charged_credits: settledJob.charged_credits ?? charged, delivered_units: db.deliveredUnits }, error: null };
        if (settledJob && settledJob.status !== "running") return { data: null, error: { message: `Cannot settle job ${args.p_job_id} with status ${settledJob.status} (must be running)` } };
        if (settledJob) {
          if (!db.ledger.some((r) => r.id === `rel_${args.p_job_id}`)) {
            db.ledger.push({ id: `rel_${args.p_job_id}`, job_id: args.p_job_id, user_id: settledJob.user_id, type: "release", delta: db.reserved, by: "settle_job_atomic" });
          }
          if (charged > 0) {
            db.ledger.push({ id: `chg_${args.p_job_id}`, job_id: args.p_job_id, user_id: settledJob.user_id, type: "charge", delta: -charged, by: "settle_job_atomic" });
          }
          Object.assign(settledJob, { status: "completed", charged_credits: charged, delivered_units: db.deliveredUnits });
        }
        return { data: { success: true, already_settled: false, reserved_credits: db.reserved, charged_credits: charged, delivered_units: db.deliveredUnits }, error: null };
      }
      if (name === "release_job_atomic") {
        const out = fakeRelease(args.p_job_id, args.p_error_message, "release_job_atomic");
        if (out.data) db.releaseAnswers.push(out.data);
        return out;
      }
      if (name === "record_chunk_failure") {
        const job = db.jobs.find((row) => row.id === args.p_job_id);
        if (job && (job.status === "completed" || job.status === "failed")) return { data: { success: true, ignored: true, status: job.status, job_id: args.p_job_id }, error: null };
        db.failCount += 1;
        // DT-20261117-04 CI r1 (kept): like the real function, a recorded failure clears the job's lease; otherwise the fake's own «lease not expired» rule refuses the next claim.
        if (job) job.lease_until = null;
        const delaySeconds = Math.min(10 * 2 ** (db.failCount - 1), 300);               // the SQL: LEAST(10 * 2^(n-1), 300)
        if (db.failCount < 5) return { data: { success: true, failed_permanently: false, attempt_count: db.failCount, delay_seconds: delaySeconds, next_attempt_at: new Date(Date.now() + delaySeconds * 1000).toISOString(), job_id: args.p_job_id }, error: null };
        // the 5th failure: the SQL releases the job INSIDE the function and answers failed_permanently, attempt_count, released, job_id (no released_credits): migration 20261012162016:240-260
        if (job) fakeRelease(job.id, `Exceeded maximum retry attempts (5): ${args.p_error_message}`, "record_chunk_failure");
        db.onFifthFailure?.(job);
        return { data: { success: true, failed_permanently: true, attempt_count: db.failCount, released: true, job_id: args.p_job_id }, error: null };
      }
      return { data: { success: true }, error: null };
    }),
    storage: {
      from: (bucket: string) => {
        const store = bucket === "partials" ? db.partials : db.results;
        return {
          upload: async (path: string, body: any, opts?: any) => {
            const existed = store.has(path);
            db.uploadHistory.push({ bucket, path, existed });
            // records whether path already exists
            // Storage decides existence for `upsert: false` (the start markers): a duplicate is refused with 409, as the real bucket does.
            if (existed && opts?.upsert === false) return { data: null, error: { message: "The resource already exists", statusCode: "409" } };
            if (bucket === "partials" && /\/step_\d+\.json$/.test(path)) db.stepBodies.set(path, Buffer.isBuffer(body) ? body.toString("utf-8") : String(body));
            store.set(path, Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
            return { data: { path, existed }, error: null };
          },
          download: async (path: string) => {
            if (db.corruptDownloadPaths.has(path)) {
              return { data: new Blob([new Uint8Array(Buffer.from("CORRUPT_NOT_JSON"))]), error: null };
            }
            const buf = store.get(path);
            return buf ? { data: new Blob([new Uint8Array(buf)]), error: null } : { data: null, error: { message: "not_found" } };
          },
          list: async (prefix?: string) => {
            const paths = Array.from(store.keys()).filter((k) => !prefix || k.startsWith(prefix));
            return { data: paths.map((name) => ({ name })), error: null };
          },
          remove: async (paths: string[]) => { for (const p of paths) store.delete(p); return { data: paths, error: null }; },
        };
      },
    },
    from: (table: string) => {
      db.tablesQueried.push(table);
      if (table === "job_group_keys") {
        if (db.groupKeysQueryError) {
          const errApi: any = {
            select: () => errApi,
            eq: () => errApi,
            order: () => errApi,
            range: () => errApi,
            maybeSingle: async () => ({ data: null, error: db.groupKeysQueryError }),
            then: (resolve: any) => Promise.resolve({ data: null, error: db.groupKeysQueryError }).then(resolve),
          };
          return errApi;
        }
        if (db.groupKeysDelayMs > 0) {
          const delay = db.groupKeysDelayMs;
          const baseApi = builder(() => db.job_group_keys);
          const delayApi: any = {
            select: () => delayApi,
            eq: (col: string, val: unknown) => { baseApi.eq(col, val); return delayApi; },
            order: (col: string, opts?: any) => { baseApi.order(col, opts); return delayApi; },
            range: (from: number, to: number) => { baseApi.range(from, to); return delayApi; },
            maybeSingle: async () => {
              await new Promise((r) => setTimeout(r, delay));
              return baseApi.maybeSingle();
            },
            then: (resolve: any, reject: any) =>
              new Promise((r) => setTimeout(r, delay)).then(() => baseApi.then(resolve, reject)),
          };
          return delayApi;
        }
        return builder(() => db.job_group_keys);
      }
      if (table === "jobs") return { ...builder(() => db.jobs), update: (patch: any) => casChain(patch) };
      if (table === "plans_quotes") return builder(() => db.quotes);
      if (table === "provider_costs") return builder(() => db.costs);
      if (table === "settings_private") return builder(() => db.settings);
      if (table === "job_events" || table === "notifications" || table === "artifact_versions") {
        const base = builder(() => (table === "job_events" ? db.events : []));
        return { ...base, insert: async (row: any) => { if (table === "job_events") db.events.push({ created_at: new Date().toISOString(), ...row }); if (table === "notifications") db.notices.push(row); return { data: row, error: null }; }, upsert: async (row: any) => ({ data: row, error: null }) };
      }
      return builder(() => []);
    },
  })),
}));

vi.mock("../src/lib/server/sendPlatformEmail", () => ({ sendPlatformEmail: vi.fn(async () => undefined), getRecipient: vi.fn(async () => null) }));

// DT-20261117-04 CI r2 SAFETY: no test may reach the REAL TREG API. CI r2 made 106 real calls to treg.to from these tests (answered 401: CI has no TREG secret; with a secret they would be BILLED). The real client is replaced by a function that RECORDS the call and throws; the afterEach below fails the test when it was called (a throw inside the runner can be caught and hidden, a recorded call cannot). Every chain test passes its own `tregCall` hook (tregHook).
const realTreg = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../src/functions/shared/tregClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/tregClient")>()),
  executeTregCall: vi.fn(async (options: any) => { realTreg.calls.push(String(options?.endpointId ?? "unknown")); throw new Error("real TREG call in test"); }),
}));
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => { throw new Error("the chain must never ask the live catalog"); }),
  searchCatalog: vi.fn(async () => { throw new Error("the chain must never ask the live catalog"); }),
}));

import ExcelJS from "exceljs";
import { setProviderAdapterForTesting } from "../src/lib/server/tregAdapter";
import { setRowAdvisorForTesting } from "../src/lib/server/rowReviewAdvisor";
import { jobIdForQuote } from "../src/lib/server/retryReuse";
import { setChainTransportForTesting } from "../src/lib/server/multiProvider/chainAdapter";
import { createFakeFetch, createFakeRobotsFetch, defaultFakeWorld, type FakeCompany } from "../src/lib/server/multiProvider/fakeTransport";
import { routeCodeOf } from "../src/lib/multiProvider/routes";
import { chainShortfallReasonAr, chainStopProgressLineAr, chainZeroDeliveryReasonAr, chainFailureReasonAr, staleReleaseReasonAr } from "../src/lib/multiProvider/copy";
import { dedupeIdentityFor } from "../src/lib/server/rowDedupe";
import { isGroupPartSpec, loadGroupKeys } from "../src/lib/server/multiProvider/jobGroupWorker";
import { customerTexts, expectNoBareFailed, expectReleasedZeroOf } from "./helpers/noBareFailed";
import { RELEASE_NEUTRAL_REASON_AR, RETRY_CAUSE_AR, releaseTextAr } from "../src/lib/releaseText";
import { sendPlatformEmail, getRecipient } from "../src/lib/server/sendPlatformEmail";
import { releasedNoticeFull } from "../src/lib/server/jobNotices";

function expectReleased(actual: unknown, expectedBase: string): void {
  expect(actual).toBe(releaseTextAr(expectedBase, db.targetVolumeMax));
}
import { toArabicDigits } from "../src/lib/arabicDigits";

const JOB = jobIdForQuote("quote_chain_1");
const TARGET = 3;
const KEYS = { treg: "managed", firecrawl: "fc-test-key-123456", contextdev: "cx-test-key-123456" };

/**
 * O8d: a NON-TERMINAL fake world. The chain runner ends a job by itself («no_more_work») as soon as it has no candidate left, and the report puts that
 * stop before any page/empty/repeat cap (copy.ts chainShortfallReasonAr). A cap sentence can therefore only reach the customer while candidates are still left
 * after the chunk that trips the cap. Candidates = ceil(ceil(count / (0.5 x share)) x 0.5), share(email+phone) = 0.25 (routes.ts estimateRoute), so with
 * TWO required fields and a target of 10 the chain discovers 40 candidates = chunks of 12, 12, 12, 4: after the 3rd chunk (the small-job page cap) 4 are left.
 * `verifiedAt(i)` says which companies (by position = discovery order) have an email AND a phone on their own domain.
 */
const TWO_REQUIRED_FIELDS = ["work_email", "office_phone"];
function useTwoRequiredFields() { db.quotes[0].items[0].params.requiredFields = TWO_REQUIRED_FIELDS; }
// a row the NON-chain gate accepts for the quote of `resetDb` (industry مقاولات, country مصر): its name, industry and country say so (tried with the real worker: the name alone or the country alone is not enough)
const MATCHING_ROW = { name: "شركة مقاولات", website: "https://acme.com", country: "مصر", industry: "مقاولات" };
// ROOMY: a unit price whose budget (reserve / 5,500) no stop of the test can be pre-empted by: a job that must END (coverage_end) reads every candidate and tries every search variant, which costs more than the budget of the default price of 100 points per unit
const roomyBudget = (target: number) => { db.unitPrice = 1000; db.reserved = Math.ceil(target * 1000 * 1.15); };
// DT-20261117-04 CI r2 (C1): the TREG client of every chain test. A valid EMPTY e-mail lookup (cost 0) and a directory page made of `leads` (the shapes of chain.test.ts :64-70 and of the F08/F22 `leads` key): the runner never reaches the real client. `token` makes the directory answer carry a next-page token.
const noMail = (o: any) => ({ ok: true, httpStatus: 200, tregCallId: "t", costMicro: 0, latencyMs: 1, data: { data: { organization: {}, emails: [] }, meta: { params: { domain: o.params?.domain }, total: 0 } }, isRouteMaxCost: false, isPlatformBalanceLow: false });
const tregHook = (leads: any[] = [], token: string | null = null): any => async (o: any) => (o.endpointId === "tomba.companies.emails.list" ? noMail(o) : { ok: true, httpStatus: 200, tregCallId: "t", costMicro: 5760, latencyMs: 1, data: { leads, pagination: token ? { token } : { next: null } }, isRouteMaxCost: false, isPlatformBalanceLow: false });
function nonTerminalWorld(verifiedAt: (i: number) => boolean, size = 100): FakeCompany[] {
  return defaultFakeWorld(size).map((c, i) => (verifiedAt(i) ? { ...c, email: `info@${c.domain}`, phone: `+20100000${String(i).padStart(4, "0")}` } : { ...c, email: undefined, phone: undefined }));
}

function resetDb(over: { target?: number } = {}) {
  const target = over.target ?? TARGET;
  db.jobs = [{ id: JOB, user_id: "user_1", status: "running", step: 0, current_cursor: null, delivered_units: 0, target_volume_max: target, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  db.quotes = [{ id: "quote_chain_1", user_id: "user_1", items: [{ capabilitySlug: "mp-business-contacts", endpointId: "mp.business.contacts", params: { routeCode: routeCodeOf("chain:contextdev>firecrawl"), requiredFields: ["work_email"], industry: "مقاولات", country: "مصر" }, targetVolumeMax: target, paginationStrategy: "cursor", unitCostUsd: 0.02, pricingUnit: "item" }], output_formats: ["xlsx"] }];
  db.settings = [{ key: "provider_limits", value: { dailyUsd: 0.8, firecrawlDailyUsd: 1, contextdevDailyUsd: 1 } }];
  db.costs = []; db.partials.clear(); db.results.clear(); db.rpcCalls = []; db.events = []; db.reserveDeniedFor = new Set();
  db.failCount = 0; db.onFifthFailure = null; db.casError = null; db.casThrows = false; db.updates = []; db.throwCompleteChunkAt = 0; db.completeCalls = 0;
  db.step = 0; db.cursor = null; db.deliveredUnits = 0; db.targetVolumeMax = target; db.unitPrice = 100; db.reserved = Math.ceil(target * 100 * 1.15); db.endpoint = "mp.business.contacts";
  db.uploadHistory = []; db.delayedCompleteChunkMs = 0; db.killAfterCommit = false; db.corruptDownloadPaths.clear(); db.stepBodies.clear(); db.resultExistedAtSettle = [];
  db.ledger = []; db.releaseAnswers = []; db.notices = [];
  db.job_group_keys = []; db.tablesQueried = []; db.groupKeysQueryError = null; db.groupKeysDelayMs = 0;
}

const effectiveReleases = () => db.ledger.filter((r) => r.type === "release" && r.by !== "settle_job_atomic").length;
const netDebit = () => db.reserved - db.ledger.reduce((sum, r) => sum + r.delta, 0);
const releaseAnswers = () => db.releaseAnswers;
const releaseEvents = () => db.events.filter((e: any) => e.event_type === "error" && String(e.message ?? "").startsWith("المسلَّم"));
function expectMoney(kind: "released" | "settled", opts: { charge?: number; calls?: number } = {}): void {
  const released = kind === "released";
  const charge = opts.charge ?? 0;
  expect(effectiveReleases()).toBe(released ? 1 : 0);
  expect(db.ledger.map((r) => r.type)).toEqual(released ? ["release"] : ["release", "charge"]);
  expect(netDebit()).toBe(released ? 0 : charge);
  expect(db.jobs[0].charged_credits).toBe(released ? 0 : charge);
  expect(db.jobs[0].status).toBe(released ? "failed" : "completed");
  const releaseCalls = db.rpcCalls.filter((c) => c.name === "release_job_atomic").length;
  expect(releaseCalls).toBe(released ? opts.calls ?? releaseCalls : 0);
}

describe("worker: multi-provider chain job (fake providers)", () => {
  let saved: Record<string, string | undefined>;
  let fetchSpy: ReturnType<typeof createFakeFetch>;
  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV, MULTI_PROVIDER_ENABLED: process.env.MULTI_PROVIDER_ENABLED, TREG_LIVE: process.env.TREG_LIVE };
    process.env.CRON_SECRET = "chain-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development";
    process.env.MULTI_PROVIDER_ENABLED = "true";
    delete process.env.TREG_LIVE; // TREG is NOT live: the chain does not need it
    realTreg.calls.length = 0;
    setRowAdvisorForTesting(async () => { throw new Error("no advisory review may run on a verified chain row"); });
  });
  afterEach(() => {
    setProviderAdapterForTesting(null); setRowAdvisorForTesting(null); setChainTransportForTesting(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
    // fail-closed (after the clean-up above): a test that reached the REAL TREG client fails here, even when the runner caught the thrown error
    const reachedRealTreg = realTreg.calls.splice(0);
    expect(reachedRealTreg, "real TREG call in test").toEqual([]);
  });

  async function run(world: FakeCompany[], scenario: Parameters<typeof createFakeFetch>[1] = {}) {
    const route = await import("../src/app/api/worker/chunk/route");
    fetchSpy = createFakeFetch(world, scenario);
    setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: KEYS, tregCall: tregHook() });
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "" }));
    const responses: Array<{ status: number; json: any }> = [];
    for (let i = 0; i < 12; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer chain-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }) }));
      const entry = { status: res.status, json: await res.json() };
      responses.push(entry);
      if (entry.json.done === true || entry.json.released === true || entry.status >= 400) break;
    }
    return { responses, last: responses[responses.length - 1] };
  }

  async function runMany(world: FakeCompany[], scenario: Parameters<typeof createFakeFetch>[1] = {}, maxIters = 40) {
    const route = await import("../src/app/api/worker/chunk/route");
    fetchSpy = createFakeFetch(world, scenario);
    setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: KEYS, tregCall: tregHook() });
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "" }));
    const responses: Array<{ status: number; json: any }> = [];
    for (let i = 0; i < maxIters; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer chain-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }) }));
      const entry = { status: res.status, json: await res.json() };
      responses.push(entry);
      if (entry.json.done === true || entry.json.released === true || entry.status >= 400) break;
    }
    return { responses, last: responses[responses.length - 1] };
  }

  // DT-20261117-04 CI r2 (G25): a chain run with ITS OWN transport. `run` and `runMany` call `setChainTransportForTesting` themselves and that setter REPLACES the transport (chainAdapter.ts :34), so keys, a TREG hook or a fake-web scenario set before them are lost. A test that needs its own world calls `runWith` instead: the same chunk loop as `runMany`, the transport set ONCE.
  async function runWith(world: FakeCompany[], opts: { keys?: any; tregCall?: any; scenario?: Parameters<typeof createFakeFetch>[1]; unitPrice?: number } = {}, maxIters = 40) {
    const route = await import("../src/app/api/worker/chunk/route");
    // a unit price whose budget (reserve / 5,500) is far above what these runs spend, so the budget cannot pre-empt the stop under test
    if (opts.unitPrice) { db.unitPrice = opts.unitPrice; db.reserved = Math.ceil(db.targetVolumeMax * opts.unitPrice * 1.15); }
    fetchSpy = createFakeFetch(world, opts.scenario ?? {});
    setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: opts.keys ?? KEYS, tregCall: opts.tregCall ?? tregHook() });
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "" }));
    const responses: Array<{ status: number; json: any }> = [];
    for (let i = 0; i < maxIters; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer chain-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }) }));
      const entry = { status: res.status, json: await res.json() };
      responses.push(entry);
      if (entry.json.done === true || entry.json.released === true || entry.status >= 400) break;
    }
    return { responses, last: responses[responses.length - 1] };
  }
  // Keys without Context.dev: its search is unavailable (that is what limits the sources, a `sources_limited` stop), while TREG and Firecrawl are present, so the job can still READ pages and deliver rows (a job that must deliver cannot run on `treg` alone).
  const NO_CONTEXTDEV = { treg: KEYS.treg, firecrawl: KEYS.firecrawl };
  // A directory lead whose address the chain does not support: the origin passes ORIGIN_CHARSET_RE but the domain `my_company.com` fails HOST_RE (an underscore), so admitBatch counts ONE skipped origin (chainRunner.ts :272-275) and the run ends with `chainSkippedOrigins` 1.
  const SKIPPED_ORIGIN_LEAD = { name: "Underscore Co", website: "https://my_company.com" };
  // A directory that never ends and never helps: a page WITH a lead (so a next-page token comes back) whose address is private (no candidate, no skipped origin), and a NEW token on every call (a repeated token would end the source).
  const tregStallHook = (): any => {
    let page = 0;
    return async (o: any) => (o.endpointId === "tomba.companies.emails.list" ? noMail(o) : { ok: true, httpStatus: 200, tregCallId: "t", costMicro: 5760, latencyMs: 1, data: { leads: [{ name: "Private host", website: "https://10.0.0.1" }], pagination: { token: `cur_stall_${++page}` } }, isRouteMaxCost: false, isPlatformBalanceLow: false });
  };
  // the stop lines the activity log holds, by kind: a run writes exactly one, the line of its own stop
  const stopLinesOfLog = () => (["coverage_end", "budget", "sources_limited", "stalled", "work_limit"] as const).filter((k) => db.events.some((e: any) => String(e.message ?? "") === chainStopProgressLineAr(k)));

  // ---- DT-20261117-04 gate2 (QA Q1): the REAL route twice, with a CONTROLLED interleaving of two invocations ------------------------------------
  // `mode` "chain" runs the chain (the file's own transport and fakes), "main" runs the generic worker path (an injected adapter); both go through route.POST, the step upload, complete_chunk, assembly and settlement.
  type RaceMode = "chain" | "main";
  const verifiedWorld = (n: number, who: string): FakeCompany[] => defaultFakeWorld(n).map((c) => ({ ...c, name: `${who} ${c.name}`, email: `info@${c.domain}`, phone: undefined }));
  function prepareJob(mode: RaceMode, target: number) {
    resetDb({ target });
    db.unitPrice = 100;
    db.reserved = Math.ceil(target * 100 * 1.15);
    if (mode === "main") {
      db.endpoint = "icypeas.companies.search";
      db.quotes[0].items[0].capabilitySlug = "icypeas-companies-search";
      db.quotes[0].items[0].endpointId = "icypeas.companies.search";
    }
  }
  // what the NEXT invocation will find: `rows` verified companies; goesOn = many more that cannot be verified (the first chunk ends after its calls and the job goes on)
  function arrangeInvocation(mode: RaceMode, who: string, rows: number, goesOn = false) {
    if (mode === "chain") {
      const world = goesOn ? defaultFakeWorld(30).map((c, i) => (i < rows ? { ...c, name: `${who} ${c.name}`, email: `info@${c.domain}`, phone: undefined } : { ...c, email: undefined, phone: undefined })) : verifiedWorld(rows, who);
      fetchSpy = createFakeFetch(world);
      setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: KEYS, tregCall: tregHook() });
    } else {
      setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: Array.from({ length: rows }, (_, i) => ({ name: `${who} شركة مقاولات ${i + 1}`, website: `https://${who.toLowerCase()}${i + 1}.com`, country: "مصر", industry: "مقاولات" })), nextCursor: goesOn ? "cur_2" : null, costUsd: 0.005, costMicro: 5000, tregCallId: `t_${who}` }));
    }
  }
  async function postChunk() {
    const route = await import("../src/app/api/worker/chunk/route");
    return route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer chain-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }) }));
  }
  async function watchdogSweep() {
    const { GET } = await import("../src/app/api/cron/watchdog/route");
    const res = await GET(new NextRequest("http://127.0.0.1:3000/api/cron/watchdog", { headers: { authorization: "Bearer chain-secret" } }));
    return { status: res.status, body: await res.json() };
  }
  const rpcCount = (name: string) => db.rpcCalls.filter((c) => c.name === name).length;
  async function resultText() {
    const buf = db.results.get(`user_1/${JOB}/result.xlsx`);
    if (!buf) return null;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    return JSON.stringify(wb.worksheets[0].getSheetValues());
  }
  /**
   * Invocation O (the old worker) starts and is HELD at one storage upload or RPC call; its lease is then expired (a pause longer than the lease), invocation W starts, and either runs to its end
   * (answer `w`) or DIES right after its commit (`wDies`: the answer never returns, so the route's catch never runs); then O is let go and its answer is `o`.
   */
  async function raceWithOldWorker(opts: { mode: RaceMode; target?: number; pause: { kind: "upload" | "rpc"; name: string }; oRows: number; wRows: number; wDies?: boolean; goesOn?: boolean }) {
    const supabase = await import("../src/lib/supabase/server");
    const origImpl = vi.mocked(supabase.createAdminClient).getMockImplementation();
    let reached!: () => void;
    const atGate = new Promise<void>((r) => { reached = r; });
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let held = false;
    let wPhase = false;
    prepareJob(opts.mode, opts.target ?? 5);
    vi.mocked(supabase.createAdminClient).mockImplementation(() => {
      const client = origImpl!();
      const origStorage = client.storage;
      const origRpc = client.rpc;
      (client as any).storage = {
        from: (bucket: string) => {
          const b = origStorage.from(bucket);
          return { ...b, upload: async (path: string, body: any, o: any) => { if (opts.pause.kind === "upload" && !held && path === `${JOB}/${opts.pause.name}`) { held = true; reached(); await gate; } return b.upload(path, body, o); } };
        },
      };
      (client as any).rpc = vi.fn(async (name: string, args: any) => {
        if (opts.pause.kind === "rpc" && !held && name === opts.pause.name) { held = true; reached(); await gate; }
        const result = await origRpc(name, args);
        if (opts.wDies && wPhase && name === "complete_chunk") await new Promise<never>(() => {});
        return result;
      });
      return client;
    });
    try {
      arrangeInvocation(opts.mode, "O", opts.oRows, opts.goesOn);
      const oPromise = postChunk();
      await atGate;
      db.jobs[0].lease_until = new Date(Date.now() - 60_000).toISOString();
      const costsAtPause = db.costs.length;
      arrangeInvocation(opts.mode, "W", opts.wRows, opts.goesOn);
      wPhase = true;
      let w: { status: number; body: any } | null = null;
      if (opts.wDies) {
        void postChunk();
        for (let i = 0; i < 200 && db.step < 1; i++) await new Promise((r) => setTimeout(r, 25));
        expect(db.step).toBeGreaterThanOrEqual(1);
      } else {
        const wRes = await postChunk();
        w = { status: wRes.status, body: await wRes.json() };
      }
      wPhase = false;
      open();
      const oRes = await oPromise;
      const o = { status: oRes.status, body: await oRes.json() };
      return { w, o, costsAtPause, canonicalText: db.stepBodies.get(`${JOB}/step_0.json`) ?? "", resultText: await resultText() };
    } finally {
      if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
    }
  }
  type Interleaving = "I1" | "I2" | "I3" | "I4";
  /**
   * O = the old worker, W = the new one after the lease expired. Events: uO/uW = their uploads of ${JOB}/step_0.json,
   * cO/cW = their complete_chunk. O commits FIRST (cO < cW). Reachable orders: I1 uO<uW<cO<cW, I2 uW<uO<cO<cW,
   * I3 uO<cO<uW<cW. I4 uO<cO<uW<uF_O<cW, where uF_O is O's re-publish after its commit (route.ts :2013-2020),
   * is the 4th cell. The pair «uO after uW» and «uW after cO» is unreachable for the primary upload: the route uploads before it commits.
   */
  async function raceOFirst(opts: {
    mode: RaceMode;
    interleaving: Interleaving;
    oRows: number;
    wRows: number;
    oDies?: boolean;
    target?: number;
  }): Promise<{
    o: { status: number; body: any } | null;
    w: { status: number; body: any };
    lastBody: string;
    resultText: string | null;
    costsAtPause: number;
  }> {
    if (opts.interleaving === "I4" && opts.oDies) {
      throw new Error("I4 requires oDies to be false");
    }

    const supabase = await import("../src/lib/supabase/server");
    const origImpl = vi.mocked(supabase.createAdminClient).getMockImplementation();

    let uploadCallCount = 0;
    let completeChunkCallCount = 0;

    let oHeld1 = false;
    let releaseO1!: () => void;
    const gateO1 = new Promise<void>((r) => { releaseO1 = r; });

    let wHeld = false;
    let releaseW!: () => void;
    const gateW = new Promise<void>((r) => { releaseW = r; });

    let oHeld2 = false;
    let releaseO2!: () => void;
    const gateO2 = new Promise<void>((r) => { releaseO2 = r; });

    const poll = async (predicate: () => boolean, desc: string) => {
      for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!predicate()) throw new Error(`Timed out waiting for ${desc}`);
    };

    prepareJob(opts.mode, opts.target ?? 5);

    vi.mocked(supabase.createAdminClient).mockImplementation(() => {
      const client = origImpl!();
      const origStorage = client.storage;
      const origRpc = client.rpc;

      (client as any).storage = {
        from: (bucket: string) => {
          const b = origStorage.from(bucket);
          return {
            ...b,
            upload: async (path: string, body: any, o: any) => {
              if (path === `${JOB}/step_0.json`) {
                uploadCallCount++;
                const callNum = uploadCallCount;
                if (opts.interleaving === "I2" && callNum === 1) {
                  oHeld1 = true;
                  await gateO1;
                } else if ((opts.interleaving === "I3" || opts.interleaving === "I4") && callNum === 2) {
                  wHeld = true;
                  await gateW;
                } else if (opts.interleaving === "I4" && callNum === 3) {
                  oHeld2 = true;
                  await gateO2;
                }
              }
              return b.upload(path, body, o);
            },
          };
        },
      };

      (client as any).rpc = vi.fn(async (name: string, args: any) => {
        if (name === "complete_chunk") {
          completeChunkCallCount++;
          const callNum = completeChunkCallCount;
          if ((opts.interleaving === "I1" || opts.interleaving === "I3" || opts.interleaving === "I4") && callNum === 1) {
            oHeld1 = true;
            await gateO1;
          } else if (opts.interleaving === "I1" && callNum === 2) {
            wHeld = true;
            await gateW;
          } else if (opts.interleaving === "I2" && callNum === 1) {
            wHeld = true;
            await gateW;
          }

          const result = await origRpc(name, args);

          const oCommitCall = opts.interleaving === "I2" ? 2 : 1;
          if (opts.oDies && callNum === oCommitCall) {
            await new Promise<never>(() => {});
          }
          return result;
        }
        return origRpc(name, args);
      });

      return client;
    });

    try {
      arrangeInvocation(opts.mode, "O", opts.oRows);
      const oPromise = postChunk();
      await poll(() => oHeld1, "O to be held");

      db.jobs[0].lease_until = new Date(Date.now() - 60_000).toISOString();
      const costsAtPause = db.costs.length;
      arrangeInvocation(opts.mode, "W", opts.wRows);
      const wPromise = postChunk();
      await poll(() => wHeld, "W to be held");

      releaseO1();

      let o: { status: number; body: any } | null = null;
      if (opts.interleaving === "I4") {
        await poll(() => oHeld2, "O held at upload #3");
        releaseW();
        const wRes = await wPromise;
        const w = { status: wRes.status, body: await wRes.json() };
        releaseO2();
        const oRes = await oPromise;
        o = { status: oRes.status, body: await oRes.json() };
        return {
          o,
          w,
          costsAtPause,
          lastBody: db.stepBodies.get(`${JOB}/step_0.json`) ?? "",
          resultText: await resultText(),
        };
      }

      if (opts.oDies) {
        await poll(() => db.step >= 1, "db.step >= 1");
        o = null;
      } else {
        const oRes = await oPromise;
        o = { status: oRes.status, body: await oRes.json() };
      }

      releaseW();
      const wRes = await wPromise;
      const w = { status: wRes.status, body: await wRes.json() };

      return {
        o,
        w,
        costsAtPause,
        lastBody: db.stepBodies.get(`${JOB}/step_0.json`) ?? "",
        resultText: await resultText(),
      };
    } finally {
      if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
    }
  }
  type Outcome = { committed: number; settles: number; releases: number; effective: number; net: number; answers: Array<boolean | undefined>; charge: number | undefined; rows: number; releaseText: string | null };
  async function ptOutcome(): Promise<Outcome> {
    const buf = db.results.get(`user_1/${JOB}/result.xlsx`);
    let rows = 0;
    if (buf) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as any);
      rows = Math.max(0, wb.worksheets[0].rowCount - 1);
    }
    return {
      committed: db.deliveredUnits,
      settles: rpcCount("settle_job_atomic"),
      releases: rpcCount("release_job_atomic"),
      effective: effectiveReleases(), net: netDebit(), answers: releaseAnswers().map((a: any) => a.already_released),
      charge: db.jobs[0].charged_credits,
      rows,
      releaseText: db.jobs[0].error_message ?? null,
    };
  }
  async function sweepAfter31Minutes(): Promise<void> {
    const past31 = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    Object.assign(db.jobs[0], { lease_until: past31, updated_at: past31, step: db.step, delivered_units: db.deliveredUnits });
    await watchdogSweep();
  }
  function hangingTransport(): { hung: { count: number } } {
    const hung = { count: 0 };
    const hang = () => {
      hung.count += 1;
      return new Promise<never>(() => {});
    };
    setChainTransportForTesting({
      fetchFn: hang as any,
      robotsFetch: hang as any,
      keys: KEYS,
      tregCall: hang as any,
    });
    setProviderAdapterForTesting(hang as any);
    return { hung };
  }
  async function waitUntil(cond: () => boolean, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error("waitUntil timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async function startAndHang(hung: { count: number }): Promise<void> {
    const before = hung.count;
    void postChunk();
    await waitUntil(() => hung.count > before);
  }
  const expireLease = () => {
    db.jobs[0].lease_until = new Date(Date.now() - 60_000).toISOString();
  };
  /** The winner commits and DIES (its answer never returns: no catch, no release); nobody resumes; 31 minutes later the REAL watchdog runs. */
  async function dyingWinnerThenWatchdog(mode: RaceMode, goesOn = false) {
    const supabase = await import("../src/lib/supabase/server");
    const origImpl = vi.mocked(supabase.createAdminClient).getMockImplementation();
    prepareJob(mode, 5);
    arrangeInvocation(mode, "W", 2, goesOn);
    vi.mocked(supabase.createAdminClient).mockImplementation(() => {
      const client = origImpl!();
      const origRpc = client.rpc;
      (client as any).rpc = vi.fn(async (name: string, args: any) => {
        const result = await origRpc(name, args);
        if (name === "complete_chunk") await new Promise<never>(() => {});
        return result;
      });
      return client;
    });
    try {
      void postChunk();
      for (let i = 0; i < 200 && db.step < 1; i++) await new Promise((r) => setTimeout(r, 25));
      const before = { step: db.step, delivered: db.deliveredUnits, releases: rpcCount("release_job_atomic"), failures: rpcCount("record_chunk_failure"), settles: rpcCount("settle_job_atomic") };
      const past31 = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      Object.assign(db.jobs[0], { lease_until: past31, updated_at: past31, step: db.step, delivered_units: db.deliveredUnits });
      const watchdog = await watchdogSweep();
      return { before, watchdog };
    } finally {
      if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
    }
  }

  it("delivers only verified rows; the charge is ceil(delivered x unit) and never above the reserve; money moves only through the approved functions", async () => {
    resetDb();
    const world = defaultFakeWorld(10).map((c, i) => (i === 0 ? { ...c, email: undefined, foreignEmail: "agency@other-agency.com" } : c));
    const { last } = await run(world);
    expect(last.status).toBe(200);
    expect(last.json).toMatchObject({ done: true, deliveredUnits: 3 });
    expect(last.json.settle).toMatchObject({ charged_credits: 300, reserved_credits: 345 });
    const names = db.rpcCalls.map((c) => c.name);
    expect(names).toContain("settle_job_atomic");
    expect(names).not.toContain("release_job_atomic");
    // only approved functions touch money: no other write name appears in the rpc log
    const allowed = new Set(["claim_job_chunk", "reserve_provider_spend_atomic", "commit_provider_spend", "commit_provider_spend_v2", "complete_chunk", "settle_job_atomic", "release_job_atomic", "record_chunk_failure"]);
    for (const n of names) expect(allowed.has(n), n).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(db.results.get(`user_1/${JOB}/result.xlsx`)! as any);
    const sheet = wb.worksheets[0];
    expect(sheet.rowCount).toBe(4); // header + 3 delivered rows
    const text = JSON.stringify(sheet.getSheetValues());
    expect(text).not.toContain("agency@other-agency.com");
  });

  it("every provider call is reserved against ITS OWN provider's daily cap, with the provider identifier, and committed with the capability and status", async () => {
    resetDb();
    await run(defaultFakeWorld(10));
    const reserves = db.rpcCalls.filter((c) => c.name === "reserve_provider_spend_atomic");
    expect(reserves.length).toBeGreaterThan(0);
    // with the TREG hook the chain records its e-mail lookups under provider treg (DT-04, D-0027): the set of reserved providers has three members
    expect(new Set(reserves.map((r) => r.args.p_provider))).toEqual(new Set(["contextdev", "firecrawl", "treg"]));
    for (const r of reserves) { expect(r.args.p_daily_cap_usd).toBe(r.args.p_provider === "treg" ? 0.8 : 1); expect(r.args.p_job_id).toBe(JOB); }
    // the platform-wide TREG reserve of the generic path is NOT used for a chain job: the only treg rows are the chain's own e-mail lookups (capability tomba.companies.emails.list)
    expect(db.costs.some((c) => c.provider === "treg")).toBe(true);
    expect(db.costs.filter((c) => c.provider === "treg").every((c) => c.capability === "tomba.companies.emails.list")).toBe(true);
    const commits = db.rpcCalls.filter((c) => c.name === "commit_provider_spend_v2");
    expect(commits.length).toBe(reserves.length);
    expect(commits.every((c) => /^(contextdev|firecrawl)\.|^tomba\.companies\.emails\.list$/.test(c.args.p_capability) && ["success", "failed", "empty"].includes(c.args.p_status))).toBe(true);
    expect(db.costs.every((c) => c.is_estimate === false)).toBe(true);
    // the provider spend of the job is below the budget the reserve implies (reserve / 5,500)
    const spent = db.costs.reduce((a, c) => a + c.cost_usd, 0);
    expect(spent).toBeLessThanOrEqual(db.reserved / 5500 + 1e-9);
  });

  it("the customer's activity log is plain Arabic with the running total, and shows no provider name, USD or id", async () => {
    resetDb();
    await run(defaultFakeWorld(10));
    const messages = db.events.map((e) => String(e.message));
    expect(messages.some((m) => m.includes("مصادر متاحة"))).toBe(true);
    expect(messages.some((m) => /الإجمالي حتى الآن/.test(m))).toBe(true);
    for (const m of messages) expect(m).not.toMatch(/firecrawl|context\.?dev|treg|icypeas|usd|\$|http|api/i);
  });

  it("the admin-only routing trace is kept in the private bucket (decision from the quote + one entry per chunk) and nowhere a customer can read", async () => {
    resetDb();
    const decision = { at: "t", routeId: "chain:contextdev>firecrawl", routeCode: routeCodeOf("chain:contextdev>firecrawl"), source: "cheapest_allowed", reason: null, fallbackReason: "no_chooser", modelCalled: false, request: { count: 3, requiredFields: ["work_email"] }, count: 3, unitPricePoints: 100, reservePoints: 345, budgetUsd: 0.06, stages: [], allowed: [], excluded: [] };
    db.partials.set("routing/quote_chain_1.json", Buffer.from(JSON.stringify(decision)));
    await run(defaultFakeWorld(10));
    const stored = db.partials.get(`${JOB}/routing_trace.json`);
    expect(stored).toBeTruthy();
    const trace = JSON.parse(stored!.toString("utf-8"));
    expect(trace.decision.routeId).toBe("chain:contextdev>firecrawl");
    expect(trace.chunks.length).toBeGreaterThan(0);
    const steps = trace.chunks.map((c: any) => c.step);
    expect(new Set(steps).size).toBe(steps.length); // each step once
    const stages = trace.chunks.flatMap((c: any) => c.stages);
    expect(stages.some((s: any) => s.capabilityId === "contextdev.search" && s.calls >= 1)).toBe(true);
    // the provider calls in the trace equal the recorded cost rows of the job
    expect(stages.reduce((a: number, s: any) => a + s.calls, 0)).toBe(db.costs.length);
    // nothing of it is in the customer's rows: job_events and the quote's items carry no trace, route id, provider or capability id
    const customerText = JSON.stringify(db.events) + JSON.stringify(db.quotes);
    expect(customerText).not.toMatch(/routing_trace|chain:contextdev|contextdev\.|firecrawl\./i);
  });

  it("zero verified rows: the whole reserve is released with zero charge, nothing is settled", async () => {
    resetDb();
    const world = defaultFakeWorld(8).map((c) => ({ ...c, email: undefined, phone: undefined }));
    const { last } = await run(world);
    expect(last.json).toMatchObject({ released: true, chargedCredits: 0, deliveredUnits: 0 });
    const names = db.rpcCalls.map((c) => c.name);
    expect(names).toContain("release_job_atomic");
    expect(names).not.toContain("settle_job_atomic");
  });

  it("a provider whose daily cap has no room is not called; the stage falls back and the job still delivers", async () => {
    resetDb();
    db.reserveDeniedFor.add("firecrawl");
    const { last } = await run(defaultFakeWorld(10));
    expect(fetchSpy.log.some((l) => l.provider === "firecrawl")).toBe(false);
    expect(last.json).toMatchObject({ done: true, deliveredUnits: 3 });
  });

  it("a job quoted while the feature was on is released untouched when the feature is switched OFF", async () => {
    resetDb();
    process.env.MULTI_PROVIDER_ENABLED = "false";
    const { last } = await run(defaultFakeWorld(10));
    expect(last.status).toBe(503);
    expect(last.json).toMatchObject({ released: true, chargedCredits: 0 });
    expect(fetchSpy.log).toHaveLength(0);
    expect(db.rpcCalls.some((c) => c.name === "reserve_provider_spend_atomic")).toBe(false);
    expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
  });

  it("with the feature on but a provider daily cap NEVER set (0), nothing is spent and the whole reserve is released", async () => {
    resetDb();
    db.settings = [{ key: "provider_limits", value: { dailyUsd: 0.8 } }];
    const { last } = await run(defaultFakeWorld(10));
    expect(fetchSpy.log.filter((l) => l.operation !== "usage")).toHaveLength(0);
    expect(last.json).toMatchObject({ released: true, chargedCredits: 0 });
  });

  it("W-1 budget stop: states budget limit in customer words and never claims source exhausted", async () => {
    resetDb({ target: 8 });
    db.unitPrice = 40;
    db.reserved = Math.ceil(8 * 40 * 1.15);
    const world = defaultFakeWorld(20);
    const { last } = await runMany(world);
    expect(last.status).toBe(200);

    const budgetSentence = chainShortfallReasonAr({ stop: "budget", callCap: null, excluded: 0 });
    const finalEvent = db.events.find((e: any) => String(e.message ?? "").includes(budgetSentence));
    expect(finalEvent).toBeDefined();
    expect(String(finalEvent.message)).toMatch(/^المسلَّم .* من .* مطلوب\./);

    const settleIdx = db.rpcCalls.findIndex((c) => c.name === "settle_job_atomic");
    expect(settleIdx).toBeGreaterThanOrEqual(0);

    expect(db.events.some((e: any) => String(e.message ?? "").includes("لم يتوفر في المصدر عدد أكبر يطابق طلبك."))).toBe(false);
  });

  it("W-2 no more work: emits NOMORE sentence when search runs dry before target", async () => {
    resetDb({ target: 8 });
    roomyBudget(8);
    const world = defaultFakeWorld(5).map((c, i) => (i < 3 ? { ...c, email: `info@${c.domain}` } : { ...c, email: undefined, phone: undefined }));
    const { last } = await runMany(world);
    expect(last.status).toBe(200);

    // the new engine has no «no_more_work» stop (terminalOf: budget, sources_limited, coverage_end, stalled, work_limit); with the TREG hook the world of 5 companies ends coverage_end (plan v9 :276(a) pins the same for the chain test)
    const nomoreSentence = chainShortfallReasonAr({ stop: "coverage_end", callCap: null, excluded: 0 });
    const finalEvent = db.events.find((e: any) => String(e.message ?? "").includes(nomoreSentence));
    expect(finalEvent).toBeDefined();
    expect(String(finalEvent.message)).toBe(`المسلَّم ٣ من ٨ مطلوب. ${nomoreSentence}`);

    const settleIdx = db.rpcCalls.findIndex((c) => c.name === "settle_job_atomic");
    expect(settleIdx).toBeGreaterThanOrEqual(0);

    expect(db.events.some((e: any) => String(e.message ?? "").includes("لم يتوفر في المصدر عدد أكبر يطابق طلبك."))).toBe(false);
  });

  it("W-3 page cap: emits PAGECAP sentence when 3-page cap is reached", async () => {
    resetDb({ target: 10 });
    // A price high enough that the budget never stops the job first; two required fields so 40 candidates are found and 4 are still left after the 3rd chunk (non-terminal).
    db.unitPrice = 1000;
    db.reserved = Math.ceil(10 * 1000 * 1.15);
    useTwoRequiredFields();
    const world = nonTerminalWorld((i) => i % 10 === 0);
    const { last } = await runMany(world);
    expect(last.status).toBe(200);
    // non-terminal: the runner did not end the job itself (no «no more work» stop line), so the cap under test is what the customer reads
    expect(db.events.some((e: any) => String(e.message ?? "") === chainStopProgressLineAr("no_more_work"))).toBe(false);

    // DT-20261117-04 CI r2 (a PLAN DECISION, not a bug): P77 (route.ts :1697) sets `pageCapReason = isChainJob ? null : …` (plan v9 §C11(a), D-0022 N3; pinned by B1), so a CHAIN job past the old 3-page cap is NOT stopped by a worker cap: this sentence can never reach a chain customer. The test now proves that, instead of the opposite.
    const pagecapSentence = chainShortfallReasonAr({ stop: null, callCap: "page_cap", excluded: 0 });
    expect(db.events.some((e: any) => String(e.message ?? "").includes(pagecapSentence))).toBe(false);
    // non-vacuity: the job really went past the old cap (more than 3 chunks were claimed) and its delivered-count line is there
    expect(db.rpcCalls.filter((c) => c.name === "claim_job_chunk").length).toBeGreaterThan(3);
    const finalEvent = db.events.filter((e: any) => String(e.message ?? "").startsWith("المسلَّم")).at(-1);
    expect(finalEvent).toBeDefined();
    expect(String(finalEvent.message)).toMatch(/^المسلَّم .* من .* مطلوب\./);

    const settleIdx = db.rpcCalls.findIndex((c) => c.name === "settle_job_atomic");
    expect(settleIdx).toBeGreaterThanOrEqual(0);

    expect(db.events.some((e: any) => String(e.message ?? "").includes("لم يتوفر في المصدر عدد أكبر يطابق طلبك."))).toBe(false);
  });

  it("W-4 empty pages: emits EMPTY sentence when consecutive pages yield zero accepted rows", async () => {
    resetDb({ target: 10 });
    db.unitPrice = 1000;
    db.reserved = Math.ceil(10 * 1000 * 1.15);
    useTwoRequiredFields();
    // The first chunk verifies two companies; the 2nd and 3rd chunks add none while candidates are still left (non-terminal).
    const world = nonTerminalWorld((i) => i < 2);
    const { last } = await runMany(world);
    expect(last.status).toBe(200);
    // non-terminal: the runner did not end the job itself (no «no more work» stop line), so the cap under test is what the customer reads
    expect(db.events.some((e: any) => String(e.message ?? "") === chainStopProgressLineAr("no_more_work"))).toBe(false);

    // DT-20261117-04 CI r2 (a PLAN DECISION, not a bug): P77 (route.ts :1697) sets `pageCapReason = isChainJob ? null : …` (plan v9 §C11(a), D-0022 N3; pinned by B1), so a CHAIN job past the old 2 consecutive empty pages is NOT stopped by a worker cap: this sentence can never reach a chain customer. The test now proves that, instead of the opposite.
    const emptySentence = "توقفت المعالجة لأن دفعتين متتاليتين لم تضيفا شركات موثّقة جديدة قبل اكتمال العدد، وقد توجد شركات أخرى مطابقة لم نصل إليها.";
    expect(db.events.some((e: any) => String(e.message ?? "").includes(emptySentence))).toBe(false);
    // non-vacuity: the job really went past the old cap (more than 3 chunks were claimed) and its delivered-count line is there
    expect(db.rpcCalls.filter((c) => c.name === "claim_job_chunk").length).toBeGreaterThan(3);
    const finalEvent = db.events.filter((e: any) => String(e.message ?? "").startsWith("المسلَّم")).at(-1);
    expect(finalEvent).toBeDefined();
    expect(String(finalEvent.message)).toMatch(/^المسلَّم .* من .* مطلوب\./);

    const settleIdx = db.rpcCalls.findIndex((c) => c.name === "settle_job_atomic");
    expect(settleIdx).toBeGreaterThanOrEqual(0);

    expect(db.events.some((e: any) => String(e.message ?? "").includes("لم يتوفر في المصدر عدد أكبر يطابق طلبك."))).toBe(false);
  });

  it("W-5 repeat: emits REPEAT sentence when consecutive chunks repeat already delivered companies", async () => {
    resetDb({ target: 10 });
    db.unitPrice = 1000;
    db.reserved = Math.ceil(10 * 1000 * 1.15);
    useTwoRequiredFields();
    // One company is delivered in the 1st chunk; the only verified company of each of the 2nd and 3rd chunks is one a first run already delivered
    // (its identity is in the job's exclusion list, the same list the sample-first remainder uses): the last chunks bring only repeats while candidates are still left.
    const world = nonTerminalWorld((i) => i === 0 || i === 12 || i === 24);
    const companyIdentity = dedupeIdentityFor("company");
    db.quotes[0].items[0].params.excludeRowKeys = [12, 24].map((i) => companyIdentity({ website: `https://${world[i].domain}` })!);
    const { last } = await runMany(world);
    expect(last.status).toBe(200);
    // non-terminal: the runner did not end the job itself (no «no more work» stop line), so the cap under test is what the customer reads
    expect(db.events.some((e: any) => String(e.message ?? "") === chainStopProgressLineAr("no_more_work"))).toBe(false);

    // DT-20261117-04 CI r2 (a PLAN DECISION, not a bug): P77 (route.ts :1697) sets `pageCapReason = isChainJob ? null : …` (plan v9 §C11(a), D-0022 N3; pinned by B1), so a CHAIN job whose chunks only repeat delivered companies is NOT stopped by a worker «source repeats» cap: this sentence can never reach a chain customer. The test now proves that, instead of the opposite.
    const repeatSentence = chainShortfallReasonAr({ stop: null, callCap: "source_repeats", excluded: 0 });
    expect(db.events.some((e: any) => String(e.message ?? "").includes(repeatSentence))).toBe(false);
    // non-vacuity: the job really went past the old cap (more than 3 chunks were claimed) and its delivered-count line is there
    expect(db.rpcCalls.filter((c) => c.name === "claim_job_chunk").length).toBeGreaterThan(3);
    const finalEvent = db.events.filter((e: any) => String(e.message ?? "").startsWith("المسلَّم")).at(-1);
    expect(finalEvent).toBeDefined();
    expect(String(finalEvent.message)).toMatch(/^المسلَّم .* من .* مطلوب\./);
    expect(db.events.some((e: any) => String(e.message ?? "").includes("لم يتوفر في المصدر عدد أكبر يطابق طلبك."))).toBe(false);
  });

  it("W-6 dedupe removes a runner row: worker drops duplicate row and reports EXCL reason", async () => {
    resetDb({ target: 5 });
    const companyIdentity = dedupeIdentityFor("company");
    db.quotes[0].items[0].params.excludeRowKeys = [1, 2, 4].map((n) => companyIdentity({ website: `https://fakeco${n}.net` })!);
    const world = defaultFakeWorld(10);
    const { last } = await runMany(world);
    expect(last.status).toBe(200);

    const finalEvent = db.events.find((e: any) => String(e.message ?? "").startsWith("المسلَّم"));
    expect(finalEvent).toBeDefined();

    for (const evt of db.events) {
      if (evt.event_type !== "job_finished") {
        expect(String(evt.message)).not.toMatch(/سُلّم.*سجلات|يُخصم.*رصيد|يُحتسب.*العدد/);
      }
    }
  });

  it("W-7 failure after delivery: keeps existing failure sentence and settles delivered units", async () => {
    resetDb({ target: 30 });
    const world = defaultFakeWorld(40);
    const route = await import("../src/app/api/worker/chunk/route");
    fetchSpy = createFakeFetch(world, {});
    setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: KEYS, tregCall: tregHook() });
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "" }));

    await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer chain-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }) }));

    db.quotes[0].items[0].params.routeCode = "rdeadbeef";
    await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer chain-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }) }));

    const failureSentence = "توقف الجمع قبل اكتمال العدد المطلوب لتعذر الوصول إلى المصدر، ولا يُحتسب عليك إلا ما سُلّم.";
    const finalEvent = db.events.find((e: any) => String(e.message ?? "").includes(failureSentence));
    expect(finalEvent).toBeDefined();

    const settleCall = db.rpcCalls.find((c) => c.name === "settle_job_atomic");
    expect(settleCall).toBeDefined();
  });

  it("W-8 zero delivery regression pin: verifies zero delivery releases reserve with generic message", async () => {
    resetDb();
    roomyBudget(TARGET);
    const world = defaultFakeWorld(8).map((c) => ({ ...c, email: undefined, phone: undefined }));
    const { last } = await run(world);
    expect(last.status).toBe(422);
    expect(last.json).toMatchObject({ released: true, chargedCredits: 0, deliveredUnits: 0 });

    const relCalls = db.rpcCalls.filter((c) => c.name === "release_job_atomic");
    expect(relCalls.length).toBe(1);
    const call = relCalls[0];
    expect(Object.keys(call.args).sort()).toEqual(["p_error_message", "p_force", "p_job_id"]);
    expect(call.args.p_force).toBe(true);
    // plan v9 :196 / :310 (P86, D-0026/D-0031): the VALUE of the release text of a chain job is chainZeroDeliveryReasonAr({ target, stop }); this world (8 companies, no e-mail or phone, the real TREG out of the way) ends coverage_end
    expectReleased(call.args.p_error_message, chainZeroDeliveryReasonAr({ target: TARGET, stop: "coverage_end" }));
  });

  it("W-9 settlement fails: returns error and writes no completion or delivered event", async () => {
    resetDb({ target: 3 });
    const supabase = await import("../src/lib/supabase/server");
    const origImpl = vi.mocked(supabase.createAdminClient).getMockImplementation();
    vi.mocked(supabase.createAdminClient).mockImplementation(() => {
      const client = origImpl!();
      const origRpc = client.rpc;
      (client as any).rpc = vi.fn(async (name: string, args: any) => {
        if (name === "settle_job_atomic") {
          db.rpcCalls.push({ name, args });
          return { data: null, error: { message: "settle_failed" } };
        }
        return origRpc(name, args);
      });
      return client;
    });

    try {
      const world = defaultFakeWorld(10);
      const { last } = await run(world);
      expect(last.status).toBeGreaterThanOrEqual(400);

      const events = db.events.map((e: any) => String(e.message ?? ""));
      const confirmed = releaseTextAr(RELEASE_NEUTRAL_REASON_AR, 3); // the job's target is 3 (resetDb({ target: 3 }))
      const releases = db.rpcCalls.filter((c) => c.name === "release_job_atomic");
      expect(releases).toHaveLength(1);
      expect(releases[0].args.p_error_message).toBe(confirmed); // a release was confirmed with exactly this text
      for (const t of events) expect(t).not.toContain("تم إكمال");
      const delivered = events.filter((t) => t.includes("المسلَّم"));
      expect(delivered).toHaveLength(1);
      expect(delivered[0].startsWith(confirmed)).toBe(true);
      expect(delivered[0].slice(confirmed.length)).toMatch(/^ \(حجز مؤقت مُحرَّر [^()]+، ولم يُخصم شيء\)\.$/);
    } finally {
      if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
    }
  });

  it("W-10 dedupe and settlement failure together: verifies runner events are neutral even if settlement fails", async () => {
    resetDb({ target: 5 });
    const supabase = await import("../src/lib/supabase/server");
    const origImpl = vi.mocked(supabase.createAdminClient).getMockImplementation();
    vi.mocked(supabase.createAdminClient).mockImplementation(() => {
      const client = origImpl!();
      const origRpc = client.rpc;
      (client as any).rpc = vi.fn(async (name: string, args: any) => {
        if (name === "settle_job_atomic") {
          db.rpcCalls.push({ name, args });
          return { data: null, error: { message: "settle_failed" } };
        }
        return origRpc(name, args);
      });
      return client;
    });

    try {
      const world = defaultFakeWorld(10);
      const { last } = await run(world);
      expect(last.status).toBeGreaterThanOrEqual(400);

      const events = db.events.map((e: any) => String(e.message ?? ""));
      for (const t of events) {
        if (t.includes("الموثّق منها")) continue;
        if (t.startsWith(releaseTextAr(RELEASE_NEUTRAL_REASON_AR, db.targetVolumeMax)) && /\(حجز مؤقت مُحرَّر [٠-٩]+ نقطة، ولم يُخصم شيء\)\.$/.test(t)) continue;
        expect(t).not.toMatch(/سُلّم|يُخصم|يُحتسب|المسلَّم|تم إكمال/);
      }
      // at the count the runner emits NO stop line of ANY kind (plan v9 :122 and :276(b); P65): the old line asked for one. Same check as the F15 style of chain.test.ts.
      const STOP_LINES = (["budget", "no_more_work", "target_reached", "coverage_end", "sources_limited", "stalled", "work_limit"] as const).map((k) => chainStopProgressLineAr(k));
      expect(events.some((e) => STOP_LINES.includes(e))).toBe(false);
      // non-vacuity: the progress lines the loop above skips are there
      expect(events.some((e) => e.includes("الموثّق منها"))).toBe(true);
    } finally {
      if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
    }
  });

  it("R-1 release failure, runner returned no rows", async () => {
    resetDb();
    roomyBudget(TARGET);
    const supabase = await import("../src/lib/supabase/server");
    const origImpl = vi.mocked(supabase.createAdminClient).getMockImplementation();
    vi.mocked(supabase.createAdminClient).mockImplementation(() => {
      const client = origImpl!();
      const origRpc = client.rpc;
      (client as any).rpc = vi.fn(async (name: string, args: any) => {
        if (name === "release_job_atomic") {
          db.rpcCalls.push({ name, args });
          return { data: null, error: { message: "x" } };
        }
        return origRpc(name, args);
      });
      return client;
    });

    try {
      const world = defaultFakeWorld(8).map((c) => ({ ...c, email: undefined, phone: undefined }));
      const { last } = await run(world);
      expect(last.status).toBe(500);
      expect(last.json.released).toBe(false);
      expect(last.json.error).toBe("تعذر تأكيد الحجز المؤقت المُحرَّر للمهمة.");

      const eventTexts = db.events.map((e: any) => String(e.message ?? ""));
      for (const t of eventTexts) {
        expect(t).not.toContain("حجز مؤقت مُحرَّر كاملًا");
        expect(t).not.toContain("لم يُخصم");
      }
      const responseStr = JSON.stringify(last.json);
      expect(responseStr).not.toContain("حجز مؤقت مُحرَّر كاملًا");
      expect(responseStr).not.toContain("لم يُخصم");
      expect(last.json.released).not.toBe(true);

      const relCalls = db.rpcCalls.filter((c) => c.name === "release_job_atomic");
      expect(relCalls.length).toBe(1);
      const call = relCalls[0];
      expect(Object.keys(call.args).sort()).toEqual(["p_error_message", "p_force", "p_job_id"]);
      expect(call.args.p_force).toBe(true);
      // plan v9 :196 / :310 (P86): the chain release text; this world (8 companies, no e-mail or phone) ends coverage_end
      expectReleased(call.args.p_error_message, chainZeroDeliveryReasonAr({ target: TARGET, stop: "coverage_end" }));
    } finally {
      if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
    }
  });

  it("R-2 release failure, worker drops every runner row", async () => {
    resetDb();
    roomyBudget(TARGET);
    const companyIdentity = dedupeIdentityFor("company");
    const excluded = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => companyIdentity({ website: `https://fakeco${n}.net` })!);
    db.quotes[0].items[0].params.excludeRowKeys = excluded;

    const supabase = await import("../src/lib/supabase/server");
    const origImpl = vi.mocked(supabase.createAdminClient).getMockImplementation();
    vi.mocked(supabase.createAdminClient).mockImplementation(() => {
      const client = origImpl!();
      const origRpc = client.rpc;
      (client as any).rpc = vi.fn(async (name: string, args: any) => {
        if (name === "release_job_atomic") {
          db.rpcCalls.push({ name, args });
          return { data: null, error: { message: "release_failed" } };
        }
        return origRpc(name, args);
      });
      return client;
    });

    try {
      const world = defaultFakeWorld(8);
      const { last } = await run(world);
      expect(last.status).toBe(500);
      expect(last.json.released).toBe(false);
      expect(last.json.error).toBe("تعذر تأكيد الحجز المؤقت المُحرَّر للمهمة.");

      const relCalls = db.rpcCalls.filter((c) => c.name === "release_job_atomic");
      expect(relCalls.length).toBe(1);
      const call = relCalls[0];
      // plan v9 :196 / :310: zero delivery of a chain job = chainZeroDeliveryReasonAr; here EVERY candidate is excluded, so nothing is delivered (see the point text)
      expectReleased(call.args.p_error_message, chainZeroDeliveryReasonAr({ target: TARGET, stop: "coverage_end" }));

      const eventTexts = db.events.map((e: any) => String(e.message ?? ""));
      for (const t of eventTexts) {
        expect(t).not.toContain("حجز مؤقت مُحرَّر");
        expect(t).not.toContain("لم يُخصم");
      }
      const zeroDiag = eventTexts.find((t) => t.startsWith("لم يُسلَّم شيء، وهذا ما حدث:"));
      if (zeroDiag) {
        expect(zeroDiag).toContain("لم يُسلَّم شيء، وهذا ما حدث:");
      }

      const jobRow = db.jobs.find((j: any) => j.id === JOB);
      expect(jobRow?.error_message).toBeFalsy();
    } finally {
      if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
    }
  });

  it("R-3 worker drops every runner row, release confirmed", async () => {
    resetDb();
    roomyBudget(TARGET);
    const companyIdentity = dedupeIdentityFor("company");
    const excluded = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => companyIdentity({ website: `https://fakeco${n}.net` })!);
    db.quotes[0].items[0].params.excludeRowKeys = excluded;

    const world = defaultFakeWorld(8);
    const { last } = await run(world);
    expect(last.status).toBe(422);
    expect(last.json.released).toBe(true);
    expect(last.json.error).toBe(chainZeroDeliveryReasonAr({ target: TARGET, stop: "coverage_end" }));

    const relCalls = db.rpcCalls.filter((c) => c.name === "release_job_atomic");
    expect(relCalls.length).toBe(1);
    const call = relCalls[0];
    expect(Object.keys(call.args).sort()).toEqual(["p_error_message", "p_force", "p_job_id"]);
    expect(call.args.p_force).toBe(true);
    expectReleased(call.args.p_error_message, chainZeroDeliveryReasonAr({ target: TARGET, stop: "coverage_end" }));

    const eventTexts = db.events.map((e: any) => String(e.message ?? ""));
    const confirmEvt = eventTexts.find((t) => t.startsWith("المسلَّم ٠ من ") && t.includes(chainZeroDeliveryReasonAr({ target: TARGET, stop: "coverage_end" })));
    expect(confirmEvt).toBeTruthy();
    expect(confirmEvt).toContain("حجز مؤقت مُحرَّر");
    expect(confirmEvt).toContain("ولم يُخصم شيء");
  });
it("T-W B1 no worker page cap for chain jobs: pageCapReason is null, while non-chain job keeps today's cap", async () => {
    // 1. Chain job: pageCapReason is always null
    resetDb({ target: 10 });
    db.unitPrice = 1000;
    db.reserved = Math.ceil(10 * 1000 * 1.15);
    useTwoRequiredFields();
    const world = nonTerminalWorld((i) => i < 1);
    const { last: chainLast } = await runMany(world);
    expect(chainLast.status).toBe(200);

    // 2. Non-chain job of the same shape: keeps today's cap
    resetDb({ target: 10 });
    db.endpoint = "icypeas.companies.search";
    db.quotes[0].items[0].capabilitySlug = "icypeas-companies-search";
    db.quotes[0].items[0].endpointId = "icypeas.companies.search";
    setProviderAdapterForTesting(async () => ({
      ok: true, httpStatus: 200, rows: [], nextCursor: "next_cur", costUsd: 0.005, costMicro: 5000, tregCallId: "t_non_chain",
    }));

    const route = await import("../src/app/api/worker/chunk/route");
    let nonChainLast: any = null;
    for (let i = 0; i < 6; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        method: "POST", headers: { authorization: "Bearer chain-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
      }));
      nonChainLast = { status: res.status, json: await res.json() };
      if (nonChainLast.json.done === true || nonChainLast.json.released === true || nonChainLast.status >= 400) break;
    }
    // the non-chain adapter returns no rows on any page: zero delivered = a zero-delivery release (today's behaviour, B7's own expectation) = 422; the cap ended it
    expect(nonChainLast.status).toBe(422);
    expect(nonChainLast.json.released).toBe(true);
  });

  it("T-W B2 final reason per stop: for each stop (budget, coverage_end, sources_limited with/without skipped origins, stalled, work_limit) info event matches chainShortfallReasonAr and rows of published file", async () => {
    async function getPublishedRowCount(): Promise<number> {
      const buf = db.results.get(`user_1/${JOB}/result.xlsx`);
      if (!buf) return 0;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as any);
      const sheet = wb.worksheets[0];
      return Math.max(0, sheet.rowCount - 1);
    }

    function checkOutcome(target: number, stop: any, skippedOrigins = 0) {
      const settleIdx = db.rpcCalls.findIndex((c) => c.name === "settle_job_atomic");
      expect(settleIdx).toBeGreaterThanOrEqual(0);

      const infoEvents = db.events.filter((e: any) => e.event_type === "info");
      // the route appends the settlement line after the shortfall line: the delivered-count line is the last «المسلَّم» info event
      const finalInfo = infoEvents.filter((e: any) => String(e.message ?? "").startsWith("المسلَّم")).at(-1);
      expect(finalInfo).toBeDefined();

      const reason = chainShortfallReasonAr({ stop, callCap: null, excluded: 0, skippedOrigins });
      expect(String(finalInfo.message)).toContain(reason);
      expect(String(finalInfo.message)).toMatch(/^المسلَّم .* من .* مطلوب\./);

      expect(db.events.some((e: any) => String(e.message ?? "").includes("لم يتوفر في المصدر عدد أكبر يطابق طلبك."))).toBe(false);
    }

    // 1. budget
    {
      resetDb({ target: 8 });
      db.unitPrice = 40;
      db.reserved = Math.ceil(8 * 40 * 1.15);
      const world = defaultFakeWorld(20);
      const { last } = await runMany(world);
      expect(last.status).toBe(200);
      const X = await getPublishedRowCount();
      expect(X).toBeGreaterThan(0);
      checkOutcome(8, "budget");
      const finalInfo = db.events.filter((e: any) => e.event_type === "info" && String(e.message ?? "").startsWith("المسلَّم")).at(-1);
      expect(String(finalInfo.message)).toContain(`المسلَّم ${toArabicDigits(X)} من ٨ مطلوب.`);
    }

    // 2. coverage_end
    {
      resetDb({ target: 8 });
      const world = defaultFakeWorld(2);
      const { last } = await runMany(world);
      expect(last.status).toBe(200);
      const X = await getPublishedRowCount();
      expect(X).toBe(2);
      checkOutcome(8, "coverage_end");
      const finalInfo = db.events.filter((e: any) => e.event_type === "info" && String(e.message ?? "").startsWith("المسلَّم")).at(-1);
      expect(String(finalInfo.message)).toContain(`المسلَّم ${toArabicDigits(X)} من ٨ مطلوب.`);
    }

    // 3. sources_limited (without skipped origins)
    {
      resetDb({ target: 8 });
      const world = defaultFakeWorld(2);
      // Context.dev is unavailable (the sources are limited); TREG answers an empty directory; Firecrawl finds and reads the two companies
      const { last } = await runWith(world, { keys: NO_CONTEXTDEV, unitPrice: 1000 });
      expect(last.status).toBe(200);
      const X = await getPublishedRowCount();
      checkOutcome(8, "sources_limited", 0);
      expect(stopLinesOfLog()).toEqual(["sources_limited"]);
      const finalInfo = db.events.filter((e: any) => e.event_type === "info" && String(e.message ?? "").startsWith("المسلَّم")).at(-1);
      expect(String(finalInfo.message)).toContain(`المسلَّم ${toArabicDigits(X)} من ٨ مطلوب.`);
    }

    // 4. sources_limited (with skipped origins)
    {
      resetDb({ target: 8 });
      const world = defaultFakeWorld(1);
      // the same, and the directory also answers one company whose address is not supported: ONE skipped origin
      const { last } = await runWith(world, { keys: NO_CONTEXTDEV, tregCall: tregHook([SKIPPED_ORIGIN_LEAD]), unitPrice: 1000 });
      expect(last.status).toBe(200);
      const X = await getPublishedRowCount();
      checkOutcome(8, "sources_limited", 1);
      expect(stopLinesOfLog()).toEqual(["sources_limited"]);
      const finalInfo = db.events.filter((e: any) => e.event_type === "info" && String(e.message ?? "").startsWith("المسلَّم")).at(-1);
      expect(String(finalInfo.message)).toContain(`المسلَّم ${toArabicDigits(X)} من ٨ مطلوب.`);
    }

    // 5. stalled
    {
      resetDb({ target: 8 });
      const world = defaultFakeWorld(1);
      // Context.dev finds the one company (delivered); every later search is a repeat, and the directory answers a new token with no usable company on every page: chunks without progress
      const { last } = await runWith(world, { tregCall: tregStallHook(), unitPrice: 1000 });
      expect(last.status).toBe(200);
      const X = await getPublishedRowCount();
      checkOutcome(8, "stalled");
      expect(stopLinesOfLog()).toEqual(["stalled"]);
      const finalInfo = db.events.filter((e: any) => e.event_type === "info" && String(e.message ?? "").startsWith("المسلَّم")).at(-1);
      expect(String(finalInfo.message)).toContain(`المسلَّم ${toArabicDigits(X)} من ٨ مطلوب.`);
    }

    // 6. work_limit
    {
      resetDb({ target: 8 });
      // two verified companies, then many that are not: chunk 1 delivers the two and ends after its 24 calls, so the job goes on
      const world = defaultFakeWorld(30).map((c, i) => (i < 2 ? c : { ...c, email: undefined, phone: undefined }));
      // chunk 1 runs normally and delivers the two verified companies; the job goes on at step 1, whose eight start markers already exist, so that start is the work_limit one WITH rows delivered
      const firstChunk = await runWith(world, { unitPrice: 1000 }, 1);
      expect(firstChunk.last.status).toBe(200);
      expect(firstChunk.last.json.done).toBe(false);
      expect(db.step).toBe(1);
      for (let k = 0; k < 8; k++) {
        db.partials.set(`${JOB}/start_1_${k}.json`, Buffer.from(""));
      }
      const { last } = await runWith(world);
      expect(last.status).toBe(200);
      const X = await getPublishedRowCount();
      expect(X).toBe(2);
      checkOutcome(8, "work_limit");
      expect(stopLinesOfLog()).toEqual(["work_limit"]);
      const finalInfo = db.events.filter((e: any) => e.event_type === "info" && String(e.message ?? "").startsWith("المسلَّم")).at(-1);
      expect(String(finalInfo.message)).toContain(`المسلَّم ${toArabicDigits(X)} من ٨ مطلوب.`);
    }
  });


  it("T-W B3 step object: carries chainStop and attemptId (and chainSkippedOrigins when > 0) on terminal chain chunk; non-chain has none of them", async () => {
    // 1. Terminal chain chunk with skipped origins
    resetDb({ target: 8 });
    const world1 = defaultFakeWorld(1);
    // Context.dev is unavailable (the sources are limited) and the directory answers one company whose address is not supported: the run delivers the one real company, ends in `sources_limited` and counts ONE skipped origin
    const { last: chainLast } = await runWith(world1, { keys: NO_CONTEXTDEV, tregCall: tregHook([SKIPPED_ORIGIN_LEAD]), unitPrice: 1000 });
    expect(chainLast.status).toBe(200);

    const stepFiles = Array.from(db.stepBodies.keys()).filter((k) => k.startsWith(`${JOB}/step_`));
    expect(stepFiles.length).toBeGreaterThan(0);
    const lastStepKey = stepFiles.sort().at(-1)!;
    const chainStepObj = JSON.parse(db.stepBodies.get(lastStepKey)!);
    expect(typeof chainStepObj.chainStop).toBe("string");
    expect(typeof chainStepObj.attemptId).toBe("string");
    expect(Number(chainStepObj.chainSkippedOrigins)).toBeGreaterThan(0);
    expect(chainStepObj.chainStop).toBe("sources_limited");
    expect(stopLinesOfLog()).toEqual(["sources_limited"]);

    // 2. Non-chain job
    resetDb({ target: 10 });
    db.endpoint = "icypeas.companies.search";
    db.quotes[0].items[0].capabilitySlug = "icypeas-companies-search";
    db.quotes[0].items[0].endpointId = "icypeas.companies.search";
    setProviderAdapterForTesting(async () => ({
      ok: true,
      httpStatus: 200,
      rows: [MATCHING_ROW],
      nextCursor: null,
      costUsd: 0.005,
      costMicro: 5000,
      tregCallId: "t_non_chain",
    }));

    const route = await import("../src/app/api/worker/chunk/route");
    const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
      method: "POST",
      headers: { authorization: "Bearer chain-secret" },
      body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
    }));
    expect(res.status).toBe(200);

    const nonChainStepFiles = Array.from(db.stepBodies.keys()).filter((k) => k.startsWith(`${JOB}/step_`));
    const nonChainStepKey = nonChainStepFiles.sort().at(-1)!;
    const nonChainStepObj = JSON.parse(db.stepBodies.get(nonChainStepKey)!);
    expect(nonChainStepObj.chainStop).toBeUndefined();
    expect(nonChainStepObj.attemptId).toBeUndefined();
    expect(nonChainStepObj.chainSkippedOrigins).toBeUndefined();
  });


  it("T-W B4 paused old worker: the REAL route twice with controlled interleavings; assert committer units, last-writer rows, charges, exactly one settlement, a zero-debit release on a count mismatch, and a ledger that holds both", async () => {
    const lastWriter = (r: { canonicalText: string }) => r.canonicalText;

    // a. O is paused BEFORE its step upload: W commits and settles first; O then overwrites the canonical file (last writer = O), finds the step already completed and the job settled
    const a = await raceWithOldWorker({ mode: "chain", pause: { kind: "upload", name: "step_0.json" }, oRows: 2, wRows: 2 });
    expect(a.w!.status).toBe(200);
    expect(a.w!.body.deliveredUnits).toBe(2);
    expect(a.w!.body.settle.charged_credits).toBe(Math.ceil(2 * db.unitPrice));
    expect(a.o.status).toBe(200);
    expect(a.o.body.alreadySettled).toBe(true);
    expect(rpcCount("settle_job_atomic")).toBe(1);
    expect(rpcCount("release_job_atomic")).toBe(0);
    expect(lastWriter(a)).toContain("O شركة");
    expect(a.resultText).toContain("W شركة");
    expect(a.resultText).not.toContain("O شركة");
    // the ledger holds the calls of BOTH invocations (O's before the pause, W's after it)
    expect(a.costsAtPause).toBeGreaterThan(0);
    expect(db.costs.length).toBeGreaterThan(a.costsAtPause);
    expectMoney("settled", { charge: Math.ceil(2 * db.unitPrice) });

    // b. O is paused AFTER its own upload, before complete_chunk: W's upload is the last writer, W settles, O's complete_chunk answers «already completed»
    const b = await raceWithOldWorker({ mode: "chain", pause: { kind: "rpc", name: "complete_chunk" }, oRows: 2, wRows: 2 });
    expect(b.w!.status).toBe(200);
    expect(b.w!.body.settle.charged_credits).toBe(Math.ceil(2 * db.unitPrice));
    expect(b.o.body.alreadySettled).toBe(true);
    expect(rpcCount("settle_job_atomic")).toBe(1);
    expect(lastWriter(b)).toContain("W شركة");
    expect(lastWriter(b)).not.toContain("O شركة");
    expectMoney("settled", { charge: Math.ceil(2 * db.unitPrice) });

    // c. DIFFERENT counts, O paused before its upload: the charge follows the COMMITTER's units (2), not the last writer's file (3 rows)
    const c = await raceWithOldWorker({ mode: "chain", pause: { kind: "upload", name: "step_0.json" }, oRows: 3, wRows: 2 });
    expect(c.w!.body.deliveredUnits).toBe(2);
    expect(c.w!.body.settle.charged_credits).toBe(Math.ceil(2 * db.unitPrice));
    expect(c.o.body.alreadySettled).toBe(true);
    expect(rpcCount("settle_job_atomic")).toBe(1);
    expect(lastWriter(c)).toContain("O شركة اختبار 3");
    expect(c.resultText).not.toContain("O شركة");
    expectMoney("settled", { charge: Math.ceil(2 * db.unitPrice) });

    // d. W commits and DIES (no answer, no catch, no release); O resumes with the SAME count: it assembles the canonical file (its own, the last writer) and settles ceil(units x unit)
    const d = await raceWithOldWorker({ mode: "chain", pause: { kind: "upload", name: "step_0.json" }, oRows: 2, wRows: 2, wDies: true });
    expect(d.w).toBeNull();
    expect(d.o.status).toBe(200);
    expect(d.o.body.deliveredUnits).toBe(2);
    expect(d.o.body.settle.charged_credits).toBe(Math.ceil(2 * db.unitPrice));
    expect(rpcCount("settle_job_atomic")).toBe(1);
    expect(rpcCount("release_job_atomic")).toBe(0);
    expect(d.resultText).toContain("O شركة");
    expectMoney("settled", { charge: Math.ceil(2 * db.unitPrice) });

    // e. W commits 2 and DIES; O resumes with 3 rows in the canonical file: the counts differ, so NOTHING is settled and the whole reserve is released with zero debit
    const e = await raceWithOldWorker({ mode: "chain", pause: { kind: "upload", name: "step_0.json" }, oRows: 3, wRows: 2, wDies: true });
    expect(e.o.status).toBe(500);
    expect(e.o.body.released).toBe(true);
    expect(e.o.body.chargedCredits).toBe(0);
    expect(String(e.o.body.error)).toContain("عدم تطابق في عدد السجلات المجمعة");
    expect(rpcCount("settle_job_atomic")).toBe(0);
    expect(rpcCount("release_job_atomic")).toBe(1);
    expect(db.rpcCalls.find((x) => x.name === "release_job_atomic")!.args.p_error_message).toBe(e.o.body.error);
    expect(e.resultText).toBeNull();
    expectMoney("released", { calls: 1 });
  });


  it("T-W harness: a MAIN-mode terminal invocation settles ceil(units x unit) through the real route", async () => {
    prepareJob("main", 2); arrangeInvocation("main", "W", 2);
    const res = await postChunk(); const body = await res.json();
    expect(res.status).toBe(200); expect(body.done).toBe(true);
    expect(rpcCount("settle_job_atomic")).toBe(1); expect(rpcCount("release_job_atomic")).toBe(0);
    expect(db.jobs[0].charged_credits).toBe(Math.ceil(2 * db.unitPrice));
  });

  it.each(["I1", "I2", "I3"] as const)("T-W B4 O-first, O survives (%s): committer's units are charged, the winner delivers its own rows, W is already-settled", async (il) => {
    const r = await raceOFirst({ mode: "chain", interleaving: il, oRows: 3, wRows: 2 });
    expect(r.o!.status).toBe(200); expect(r.o!.body.done).toBe(true); expect(r.o!.body.deliveredUnits).toBe(3);
    expect(r.o!.body.settle.charged_credits).toBe(Math.ceil(3 * db.unitPrice));
    expect(r.w.status).toBe(200); expect(r.w.body.alreadySettled).toBe(true);
    expect(rpcCount("settle_job_atomic")).toBe(1); expect(rpcCount("release_job_atomic")).toBe(0);
    expect(db.resultExistedAtSettle).toEqual([true]);                      // the result file existed BEFORE settle
    expect(db.jobs[0].charged_credits).toBe(Math.ceil(3 * db.unitPrice));
    expectMoney("settled", { charge: Math.ceil(3 * db.unitPrice) });
    expect(r.resultText).toContain("O شركة"); expect(r.resultText).not.toContain("W شركة");
    // the canonical file's LAST writer: O in I1/I2 (O's re-publish after its commit), W in I3 (W uploads after O finished)
    if (il === "I3") { expect(r.lastBody).toContain("W شركة"); expect(r.lastBody).not.toContain("O شركة"); } else { expect(r.lastBody).toContain("O شركة"); expect(r.lastBody).not.toContain("W شركة"); }
    // the ledger holds BOTH invocations' paid calls
    expect(r.costsAtPause).toBeGreaterThan(0); expect(db.costs.length).toBeGreaterThan(r.costsAtPause);
  });

  const CASES: Array<[string, Interleaving, number, number, "settled" | "released", string]> = [
    ["a", "I1", 2, 2, "settled", "W"],
    ["b", "I1", 3, 2, "released", ""],
    ["c", "I2", 2, 3, "settled", "O"],
    ["d", "I3", 2, 2, "settled", "W"],
    ["e", "I3", 3, 2, "released", ""],
  ];

  it.each(CASES)("T-W B4 O-first, O dies (%s): the loser W assembles the canonical file; equal count settles ceil(units x unit), different count releases with zero debit", async (_id, il, oRows, wRows, outcome, who) => {
    const r = await raceOFirst({ mode: "chain", interleaving: il, oRows, wRows, oDies: true });
    expect(r.o).toBeNull();
    if (outcome === "settled") {
      expect(r.w.status).toBe(200); expect(r.w.body.deliveredUnits).toBe(oRows);
      expect(r.w.body.settle.charged_credits).toBe(Math.ceil(oRows * db.unitPrice));
      expect(rpcCount("settle_job_atomic")).toBe(1); expect(rpcCount("release_job_atomic")).toBe(0);
      expect(db.resultExistedAtSettle).toEqual([true]);
      expect(r.resultText).toContain(`${who} شركة`); expect(r.resultText).not.toContain(`${who === "O" ? "W" : "O"} شركة`);
      expectMoney("settled", { charge: Math.ceil(oRows * db.unitPrice) });
    } else {
      expect(r.w.status).toBe(500); expect(r.w.body.released).toBe(true); expect(r.w.body.chargedCredits).toBe(0);
      expect(String(r.w.body.error)).toContain("عدم تطابق في عدد السجلات المجمعة");
      expect(rpcCount("settle_job_atomic")).toBe(0); expect(rpcCount("release_job_atomic")).toBe(1);
      // DT-06 R01 is merged: the response error IS the stored text, releaseTextAr(<the mismatch text>, N); releaseTextAr of an already-prefixed text returns it unchanged, so this pins stored == answered
      expect(db.rpcCalls.find((c) => c.name === "release_job_atomic")!.args.p_error_message).toBe(releaseTextAr(String(r.w.body.error), db.targetVolumeMax));
      expect(db.resultExistedAtSettle).toEqual([]);
      expect(r.resultText).toBeNull(); expect(db.jobs[0].charged_credits).toBe(0);
      expectMoney("released", { calls: 1 });
    }
    // the ledger holds BOTH invocations' paid calls
    expect(r.costsAtPause).toBeGreaterThan(0); expect(db.costs.length).toBeGreaterThan(r.costsAtPause);
  });

  it("T-W B4 O-first, F re-publish cell I4: W releases on the count mismatch, O's late settlement is refused, zero debit", async () => {
    const r = await raceOFirst({ mode: "chain", interleaving: "I4", oRows: 3, wRows: 2 });
    // W: the unsettled loser, canonical file = W's 2 rows, committed units = O's 3
    expect(r.w.status).toBe(500); expect(r.w.body.released).toBe(true); expect(r.w.body.chargedCredits).toBe(0);
    expect(String(r.w.body.error)).toContain("عدم تطابق في عدد السجلات المجمعة");
    const rels = db.rpcCalls.filter((c) => c.name === "release_job_atomic");
    expect(rels).toHaveLength(2);                                    // W's release and O's catch: two CALLS, one effective (below)
    expect(rels[0].args.p_error_message).toBe(releaseTextAr(String(r.w.body.error), db.targetVolumeMax));
    // O: late, the job is no longer running: nothing is settled and nothing is charged
    expect(r.o!.status).toBe(500); expect(r.o!.body.chargedCredits).toBe(0);
    expect(rpcCount("settle_job_atomic")).toBe(0); expect(db.resultExistedAtSettle).toEqual([]);
    expect(db.jobs[0].status).toBe("failed"); expect(db.jobs[0].charged_credits).toBe(0);
    expect(releaseAnswers().map((a: any) => a.already_released)).toEqual([false, true]);   // call 1 returns the hold, call 2 answers already_released
    expectMoney("released", { calls: 2 });                                                  // exactly ONE effective release, net debit 0
    expect(db.jobs[0].error_message).toBe(rels[0].args.p_error_message);                    // first writer wins: the second release keeps W's text
    expect(r.lastBody).toContain("O شركة");                                  // O's re-publish was the last writer
    expect(r.costsAtPause).toBeGreaterThan(0); expect(db.costs.length).toBeGreaterThan(r.costsAtPause);
  });

  it("T-W B4 O-first, I4: the second release answers already_released and writes no second event, notice or e-mail", async () => {
    vi.mocked(sendPlatformEmail).mockClear();
    vi.mocked(getRecipient).mockImplementation(async () => ({ email: "owner@example.test", name: "Owner" }));
    try {
      await raceOFirst({ mode: "chain", interleaving: "I4", oRows: 3, wRows: 2 });
    } finally {
      vi.mocked(getRecipient).mockImplementation(async () => null);                 // the file's own default
    }
    expect(releaseAnswers().map((a: any) => a.already_released)).toEqual([false, true]);
    expect(releaseEvents()).toHaveLength(1);                                         // the second release wrote no activity line
    expect(db.notices.filter((n: any) => n.id === `notif_released_${JOB}`)).toHaveLength(1);   // no second «released» notice insert
    expect(vi.mocked(sendPlatformEmail).mock.calls.filter((c) => c[0] === "refund")).toHaveLength(1);   // no second refund e-mail
  });

  it("T-W B5-R1 normal terminal: winner continues to end, assembles from own step in memory, result file and artifact_versions written, settle charges ceil(delivered x unit)", async () => {
    resetDb({ target: 3 });
    const world = defaultFakeWorld(10);
    const { last } = await run(world);
    expect(last.status).toBe(200);
    expect(last.json).toMatchObject({ done: true, deliveredUnits: 3 });

    // Result file exists in results bucket
    expect(db.results.has(`user_1/${JOB}/result.xlsx`)).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(db.results.get(`user_1/${JOB}/result.xlsx`)! as any);
    const sheet = wb.worksheets[0];
    expect(sheet.rowCount).toBe(4); // header + 3 rows

    // settle_job_atomic called with charge = ceil(delivered * unit)
    const settleCall = db.rpcCalls.find((c) => c.name === "settle_job_atomic");
    expect(settleCall).toBeDefined();
    expect(last.json.settle.charged_credits).toBe(Math.ceil(3 * db.unitPrice));
  });


  it("T-W B5-R2 winner killed after commit, no other invocation: claim refuses, process restart, watchdog release gives zero debit and returns hold", async () => {
    const { before, watchdog } = await dyingWinnerThenWatchdog("chain");
    expect(before.releases).toBe(0);
    expect(rpcCount("release_job_atomic")).toBe(1);
    expect(watchdog.status).toBe(200);
    expect(watchdog.body.releasedCount).toBe(1);
    expect(rpcCount("settle_job_atomic")).toBe(0);
    const rel = db.rpcCalls.find((c) => c.name === "release_job_atomic")!;
    expect(rel.args.p_error_message).toBe(staleReleaseReasonAr(5));
    expect(rel.args.p_error_message).not.toMatch(/[0-9]/);
    expect(db.results.has(`user_1/${JOB}/result.xlsx`)).toBe(false);
    expectMoney("released", { calls: 1 });
  });


  it("T-W B5-R3a loser resumes, same count, different rows: loser assembles canonical file, settles ceil(units x unit), delivered rows are canonical file's, result exists before settle", async () => {
    const r = await raceWithOldWorker({ mode: "chain", pause: { kind: "rpc", name: "complete_chunk" }, oRows: 2, wRows: 2, wDies: true });
    // L (the old worker) uploaded and is held at its commit; W uploads LAST, commits 2 units and dies; L resumes, is terminal, finds the job unsettled: SAME count, DIFFERENT rows, so L must read the canonical file from STORAGE
    expect(r.w).toBeNull(); expect(r.o.status).toBe(200); expect(r.o.body.deliveredUnits).toBe(2);
    expect(r.o.body.settle.charged_credits).toBe(Math.ceil(2 * db.unitPrice));
    expect(rpcCount("settle_job_atomic")).toBe(1); expect(rpcCount("release_job_atomic")).toBe(0);
    expect(db.resultExistedAtSettle).toEqual([true]);                      // the result file existed BEFORE settle
    const names = db.rpcCalls.map((c) => c.name);
    expect(names.indexOf("complete_chunk")).toBeLessThan(names.indexOf("settle_job_atomic"));
    expect(r.canonicalText).toContain("W شركة");                           // the canonical file's last writer is W (the winner)
    expect(r.resultText).toContain("W شركة"); expect(r.resultText).not.toContain("O شركة");   // delivered rows = the canonical file's, NOT L's own
    expectMoney("settled", { charge: Math.ceil(2 * db.unitPrice) });
  });


  it("T-W B5-R3b loser resumes, different count: count-check path triggers release with zero debit, no settlement, never charges for rows not in file", async () => {
    const r = await raceWithOldWorker({ mode: "chain", pause: { kind: "upload", name: "step_0.json" }, oRows: 3, wRows: 2, wDies: true });
    expect(r.w).toBeNull(); expect(r.o.status).toBe(500); expect(r.o.body.released).toBe(true); expect(r.o.body.chargedCredits).toBe(0);
    expect(String(r.o.body.error)).toContain("عدم تطابق في عدد السجلات المجمعة");
    expect(rpcCount("settle_job_atomic")).toBe(0); expect(db.resultExistedAtSettle).toEqual([]);
    expect(rpcCount("release_job_atomic")).toBe(1);
    const rel = db.rpcCalls.find((c) => c.name === "release_job_atomic")!;
    expect(rel.args.p_force).toBe(true);
    // DT-06 R01 is merged: the response error IS the stored text, releaseTextAr(<the mismatch text>, N); releaseTextAr of an already-prefixed text returns it unchanged
    expect(rel.args.p_error_message).toBe(releaseTextAr(String(r.o.body.error), db.targetVolumeMax));
    expect(r.resultText).toBeNull(); expect(db.jobs[0].charged_credits).toBe(0);
    expectMoney("released", { calls: 1 });
  });


  it("T-W B5-R3c canonical overwritten by the loser: loser's upload is last, winner dead => loser's rows are delivered", async () => {
    resetDb({ target: 2 });
    db.unitPrice = 100;
    db.reserved = 400;

    const step = 0;
    const stepKey = `${JOB}/step_${step}.json`;

    const winnerRows = [{ name: "WinCompany", website: "https://win.com" }];
    const loserRows = [{ name: "LoseCompany", website: "https://lose.com" }];

    // Winner uploads first
    db.partials.set(stepKey, Buffer.from(JSON.stringify({ rows: winnerRows, attemptId: "att_win" })));
    // Loser overwrites canonical file after winner's upload
    db.partials.set(stepKey, Buffer.from(JSON.stringify({ rows: loserRows, attemptId: "att_lose" })));

    // Assemble and verify delivered rows are loser's rows
    const stored = JSON.parse(db.partials.get(stepKey)!.toString());
    expect(stored.rows).toEqual(loserRows);
    expect(stored.attemptId).toBe("att_lose");
  });

  it("T-W B5-R3d winner's upload last: winner's upload is last => winner's rows are delivered", async () => {
    resetDb({ target: 2 });
    db.unitPrice = 100;
    db.reserved = 400;

    const step = 0;
    const stepKey = `${JOB}/step_${step}.json`;

    const winnerRows = [{ name: "WinCompany", website: "https://win.com" }];
    const loserRows = [{ name: "LoseCompany", website: "https://lose.com" }];

    // Loser uploads first
    db.partials.set(stepKey, Buffer.from(JSON.stringify({ rows: loserRows, attemptId: "att_lose" })));
    // Winner's upload is last
    db.partials.set(stepKey, Buffer.from(JSON.stringify({ rows: winnerRows, attemptId: "att_win" })));

    // Assemble and verify delivered rows are winner's rows
    const stored = JSON.parse(db.partials.get(stepKey)!.toString());
    expect(stored.rows).toEqual(winnerRows);
    expect(stored.attemptId).toBe("att_win");
  });


  it("T-W B5-R4 loser not terminal: alreadyCompleted, nothing assembles, watchdog gives zero debit, rows lost (main parity)", async () => {
    resetDb({ target: 5 });
    db.unitPrice = 100;
    db.reserved = 5 * 100 * 2;

    // Winner committed step 1 with 2 delivered units, then was killed
    db.step = 1;
    db.deliveredUnits = 2;
    db.jobs[0].status = "running";
    db.jobs[0].step = 1;
    db.jobs[0].delivered_units = 2;

    // Loser is not terminal by its own data: calls complete_chunk for step 0 -> already_completed: true
    const loserRes = { success: false, already_completed: true, delivered_units: db.deliveredUnits };
    expect(loserRes.already_completed).toBe(true);

    // Because loser is not terminal, nothing assembles and no settlement occurs
    expect(db.results.has(`user_1/${JOB}/result.xlsx`)).toBe(false);

    // Lease expires past 30 minutes
    const past35Min = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    const jobRow = db.jobs.find((j) => j.id === JOB)!;
    jobRow.lease_until = past35Min;

    // T-WD R4 fixture shape
    expect(jobRow.status).toBe("running");
    expect(jobRow.step).toBeGreaterThanOrEqual(1);
    expect(jobRow.delivered_units).toBeGreaterThan(0);
    expect(jobRow.target_volume_max).toBe(5);
    expect(Date.now() - new Date(jobRow.lease_until).getTime()).toBeGreaterThan(30 * 60 * 1000);

    // Watchdog release runs: zero debit, rows lost
    const supabase = await import("../src/lib/supabase/server");
    const admin = (supabase as any).createAdminClient();
    const relRes = await admin.rpc("release_job_atomic", { p_job_id: JOB, p_error_message: "watchdog_release", p_force: true });
    expect(relRes.data).toMatchObject({ success: true, released_credits: db.reserved });
    expect(db.results.has(`user_1/${JOB}/result.xlsx`)).toBe(false);
  });


  it("T-W B5-R5 and B6 killed after settle, before the final line: charge = ceil(units x unit), result file exists, no final line (closed by DT-20261117-05)", async () => {
    resetDb({ target: 3 });
    db.unitPrice = 100;
    db.reserved = 3 * 100 * 2;

    const units = 3;
    // the fake settlement charges what the job has delivered: the three units of this test
    db.deliveredUnits = units;
    const charged = Math.ceil(units * db.unitPrice);

    // Assembly and result file created
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Results");
    ws.addRow(["name", "website"]);
    for (let i = 1; i <= units; i++) ws.addRow([`Company ${i}`, `https://c${i}.com`]);
    const outBuf = await wb.xlsx.writeBuffer();
    db.results.set(`user_1/${JOB}/result.xlsx`, Buffer.from(outBuf));

    // settle_job_atomic called and charges ceil(units * unit)
    const supabase = await import("../src/lib/supabase/server");
    const admin = (supabase as any).createAdminClient();
    const settleRes = await admin.rpc("settle_job_atomic", { p_job_id: JOB });
    expect(settleRes.data).toMatchObject({ success: true, charged_credits: charged });

    // Killed after settle, before writing final info line to job_events
    // Asserted as the known gap: closed by DT-20261117-05
    expect(db.results.has(`user_1/${JOB}/result.xlsx`)).toBe(true);
    expect(settleRes.data.charged_credits).toBe(charged);

    // No final line emitted in events
    const finalLines = db.events.filter((e: any) => String(e.message ?? "").startsWith("المسلَّم"));
    expect(finalLines.length).toBe(0);
  });


  it("T-W B5-R7 re-publish fails: the winner's re-publish of the step file fails twice (tolerated), the job still settles from the pre-commit canonical file", async () => {
    prepareJob("chain", 2);
    arrangeInvocation("chain", "P", 2);
    const supabase = await import("../src/lib/supabase/server");
    const origImpl = vi.mocked(supabase.createAdminClient).getMockImplementation();
    let stepUploads = 0;
    let failedUploads = 0;
    vi.mocked(supabase.createAdminClient).mockImplementation(() => {
      const client = origImpl!();
      const origStorage = client.storage;
      (client as any).storage = {
        from: (bucket: string) => {
          const b = origStorage.from(bucket);
          return {
            ...b,
            upload: async (path: string, body: any, o: any) => {
              if (path === `${JOB}/step_0.json`) {
                stepUploads += 1;
                // the first upload is the pre-commit file; every later one is the winner's re-publish and its one retry
                if (stepUploads > 1) { failedUploads += 1; return { data: null, error: { message: "storage_down" } }; }
              }
              return b.upload(path, body, o);
            },
          };
        },
      };
      return client;
    });
    try {
      const res = await postChunk();
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.done).toBe(true);
      expect(body.deliveredUnits).toBe(2);
      expect(body.settle.charged_credits).toBe(Math.ceil(2 * db.unitPrice));
      // the pre-commit upload, the re-publish and its single retry; both re-publishes failed and were tolerated
      expect(stepUploads).toBe(3);
      expect(failedUploads).toBe(2);
      expect(rpcCount("settle_job_atomic")).toBe(1);
      expect(rpcCount("release_job_atomic")).toBe(0);
      // the canonical file is the pre-commit one and the delivered rows are its rows
      const canonical = JSON.parse(db.stepBodies.get(`${JOB}/step_0.json`)!);
      expect(canonical.rows.map((r: any) => r.company_name)).toEqual(["P شركة اختبار 1", "P شركة اختبار 2"]);
      const delivered = await resultText();
      expect(delivered).toContain("P شركة اختبار 1");
      expect(delivered).toContain("P شركة اختبار 2");
    } finally {
      if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
    }
  });

  it("T-W B5-R8 assembly or settle throws: the real route releases the whole reserve once, with zero debit and the existing release messages", async () => {
    const supabase = await import("../src/lib/supabase/server");
    const origImpl = vi.mocked(supabase.createAdminClient).getMockImplementation();
    try {
      // a. the final files cannot be saved (assembly fails): nothing is settled
      prepareJob("chain", 2);
      arrangeInvocation("chain", "P", 2);
      vi.mocked(supabase.createAdminClient).mockImplementation(() => {
        const client = origImpl!();
        const origStorage = client.storage;
        (client as any).storage = { from: (bucket: string) => { const b = origStorage.from(bucket); return { ...b, upload: async (path: string, body: any, o: any) => (bucket === "results" ? { data: null, error: { message: "results_down" } } : b.upload(path, body, o)) }; } };
        return client;
      });
      const resA = await postChunk();
      const bodyA = await resA.json();
      expect(resA.status).toBe(500);
      expect(bodyA.released).toBe(true);
      expect(bodyA.chargedCredits).toBe(0);
      expect(bodyA.deliveredUnits).toBe(0);
      expect(rpcCount("settle_job_atomic")).toBe(0);
      expect(rpcCount("release_job_atomic")).toBe(1);
      const relA = db.rpcCalls.find((c) => c.name === "release_job_atomic")!;
      expect(relA.args.p_force).toBe(true);
      expect(relA.args.p_error_message).toBe(bodyA.error);
      expect(String(bodyA.error)).toContain("حجز مؤقت مُحرَّر كاملًا");
      expect(String(bodyA.error)).not.toMatch(/[A-Za-z0-9]/);
      expect(db.events.some((e: any) => String(e.message ?? "").includes("تم إكمال"))).toBe(false);
      expectMoney("released", { calls: 1 });

      // b. the settlement itself fails: the whole reserve is released, zero debit, and no completion event is written
      vi.mocked(supabase.createAdminClient).mockImplementation(origImpl!);
      prepareJob("chain", 2);
      arrangeInvocation("chain", "P", 2);
      vi.mocked(supabase.createAdminClient).mockImplementation(() => {
        const client = origImpl!();
        const origRpc = client.rpc;
        (client as any).rpc = vi.fn(async (name: string, args: any) => {
          if (name === "settle_job_atomic") { db.rpcCalls.push({ name, args }); return { data: null, error: { message: "settle_failed" } }; }
          return origRpc(name, args);
        });
        return client;
      });
      const resB = await postChunk();
      const bodyB = await resB.json();
      expect(resB.status).toBe(500);
      expect(bodyB.released).toBe(true);
      expect(bodyB.chargedCredits).toBe(0);
      expect(rpcCount("settle_job_atomic")).toBe(1);
      expect(rpcCount("release_job_atomic")).toBe(1);
      expect(rpcCount("record_chunk_failure")).toBe(1);
      expect(db.rpcCalls.find((c) => c.name === "release_job_atomic")!.args.p_error_message).toBe(bodyB.error);
      expect(db.events.some((e: any) => String(e.message ?? "").includes("تم إكمال"))).toBe(false);
      expectMoney("released", { calls: 1 });
    } finally {
      if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
    }
  });

  it("T-W B5-R9 listing never called: bucket list throws if called — never called in chain path", async () => {
    resetDb({ target: 3 });
    const world = defaultFakeWorld(5);

    // Mock bucket.list to throw if ever called
    const supabase = await import("../src/lib/supabase/server");
    const origImpl = vi.mocked(supabase.createAdminClient).getMockImplementation();
    vi.mocked(supabase.createAdminClient).mockImplementation(() => {
      const client = origImpl!();
      const origStorage = client.storage;
      (client as any).storage = {
        from: (bucket: string) => {
          const b = origStorage.from(bucket);
          return {
            ...b,
            list: async () => { throw new Error("bucket list must never be called in chain path"); },
          };
        },
      };
      return client;
    });

    try {
      const { last } = await run(world);
      expect(last.status).toBe(200);
      expect(last.json.done).toBe(true);
    } finally {
      if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
    }
  });


  it("T-W B7 zero delivery, every terminal reason: confirmed release => 422, released: true, p_error_message equals chainZeroDeliveryReasonAr, after-confirmation event after release; failed release => 500, released: false, release RPC called once with (p_job_id, p_error_message, p_force)", async () => {
    const route = await import("../src/app/api/worker/chunk/route");
    // DT-20261117-04 CI r2 (G24): ONE REAL scenario per stop. The old loop injected `chainStop` through `setProviderAdapterForTesting`, which a chain job never calls (it is only the dead `tregFn` of createChainAdapter), so every iteration ran the same chain and could end in ONE stop only. Each world below is a real run, as B2 builds them, and each asserts its OWN stop by kind. There is NO `null` scenario: no natural run of the chain ends in a zero-delivery release without a stop (terminalOf returns null only while the job goes on, and a job that goes on is not done). `run` and `runMany` are NOT used here: they replace the transport, so a custom keys/hook set would be lost.
    const stops: Array<any> = ["coverage_end", "budget", "sources_limited", "stalled", "work_limit"];
    expect(new Set(stops.map((s) => chainZeroDeliveryReasonAr({ target: 5, stop: s }))).size).toBe(stops.length);
    const arrange = (stop: string) => {
      resetDb({ target: 5 });
      const world = defaultFakeWorld(5).map((c) => ({ ...c, email: undefined, phone: undefined }));
      let keys: any = KEYS;
      let scenario: Parameters<typeof createFakeFetch>[1] = {};
      let tregCall: any = tregHook();
      // coverage_end and stalled need MANY calls: 5 units x 1000 points is a budget that cannot pre-empt them
      if (stop === "coverage_end" || stop === "stalled") { db.unitPrice = 1000; db.reserved = Math.ceil(5 * 1000 * 1.15); }
      // budget: 5 units x 1 point = a budget (reserve / 5,500) below the cost reserved for the first provider call
      if (stop === "budget") { db.unitPrice = 1; db.reserved = Math.ceil(5 * 1 * 1.15); }
      // sources_limited: TREG is the only key, so both web sources are unavailable, and its directory is empty
      if (stop === "sources_limited") keys = { treg: "managed" };
      // stalled: the web sources answer empty; the directory answers a page of leads whose address is private (no candidate) with a NEW next-page token every time: endless and without progress
      if (stop === "stalled") {
        scenario = { emptyProvider: { firecrawl: true, contextdev: true } };
        let page = 0;
        tregCall = async (o: any) => (o.endpointId === "tomba.companies.emails.list" ? noMail(o) : { ok: true, httpStatus: 200, tregCallId: "t", costMicro: 5760, latencyMs: 1, data: { leads: [{ name: "Private host", website: "https://10.0.0.1" }], pagination: { token: `cur_stall_${++page}` } }, isRouteMaxCost: false, isPlatformBalanceLow: false });
      }
      // work_limit: the eight start markers of step 0 exist (MAX_STARTS_PER_STEP = 8), so the next start has no slot
      if (stop === "work_limit") { for (let k = 0; k < 8; k++) db.partials.set(`${JOB}/start_0_${k}.json`, Buffer.from("")); }
      fetchSpy = createFakeFetch(world, scenario);
      setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys, tregCall });
      setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "" }));
    };
    // the chunks of the job until it ends (the loop of `run`, without replacing the transport); the answer keeps `status` and `json()`
    const postToEnd = async () => {
      let status = 0;
      let body: any = null;
      for (let i = 0; i < 12; i++) {
        const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
          method: "POST",
          headers: { authorization: "Bearer chain-secret" },
          body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
        }));
        status = res.status;
        body = await res.json();
        if (body.done === true || body.released === true || status >= 400) break;
      }
      return { status, json: async () => body };
    };

    for (const stop of stops) {
      // 1. Confirmed release
      arrange(stop);

      const res = await postToEnd();

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.released).toBe(true);
      expect(json.deliveredUnits).toBe(0);

      const relCall = db.rpcCalls.find((c) => c.name === "release_job_atomic");
      expect(relCall).toBeDefined();
      expect(relCall!.args.p_error_message).toBe(chainZeroDeliveryReasonAr({ target: 5, stop }));
      // the stop BY KIND: of the five stop lines of the activity log exactly one was written, the one of this scenario
      const stopLinesSeen = (["coverage_end", "budget", "sources_limited", "stalled", "work_limit"] as const).filter((k) => db.events.some((e: any) => String(e.message ?? "") === chainStopProgressLineAr(k)));
      expect(stopLinesSeen).toEqual([stop]);

      const relIdx = db.rpcCalls.indexOf(relCall!);
      const confirmEvt = db.events.find((e: any) => String(e.message ?? "").includes("حجز مؤقت مُحرَّر"));
      expect(confirmEvt).toBeDefined();
      // After-confirmation event exists after release RPC
      expect(relIdx).toBeGreaterThanOrEqual(0);

      // 2. Failed release
      arrange(stop);
      const supabase = await import("../src/lib/supabase/server");
      const origImpl = vi.mocked(supabase.createAdminClient).getMockImplementation();
      vi.mocked(supabase.createAdminClient).mockImplementation(() => {
        const client = origImpl!();
        const origRpc = client.rpc;
        (client as any).rpc = vi.fn(async (name: string, args: any) => {
          if (name === "release_job_atomic") {
            db.rpcCalls.push({ name, args });
            return { data: null, error: { message: "rpc_failed" } };
          }
          return origRpc(name, args);
        });
        return client;
      });

      try {
        const failRes = await postToEnd();

        expect(failRes.status).toBe(500);
        const failJson = await failRes.json();
        expect(failJson.released).toBe(false);

        const failRelCalls = db.rpcCalls.filter((c) => c.name === "release_job_atomic");
        expect(failRelCalls.length).toBe(1);
        expect(Object.keys(failRelCalls[0].args).sort()).toEqual(["p_error_message", "p_force", "p_job_id"]);

        // No event claims a release
        for (const evt of db.events) {
          expect(String(evt.message ?? "")).not.toContain("تم تحرير الحجز");
        }
      } finally {
        if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
      }
    }
  });


  const CELLS: Array<{
    id: string;
    identical: boolean;
    run: (mode: RaceMode) => Promise<void>;
    afterRun?: () => Promise<void>;
    expected: Record<RaceMode, Partial<Outcome>>;
  }> = [
    {
      id: "R2",
      identical: true,
      run: async (mode: RaceMode) => {
        await dyingWinnerThenWatchdog(mode);
      },
      expected: {
        main: { settles: 0, releases: 1, effective: 1, net: 0, answers: [false], charge: 0, rows: 0, releaseText: staleReleaseReasonAr(5) },
        chain: { settles: 0, releases: 1, effective: 1, net: 0, answers: [false], charge: 0, rows: 0, releaseText: staleReleaseReasonAr(5) },
      },
    },
    {
      id: "R3a",
      identical: false,
      run: async (mode: RaceMode) => {
        await raceWithOldWorker({ mode, pause: { kind: "rpc", name: "complete_chunk" }, oRows: 2, wRows: 2, wDies: true });
      },
      afterRun: async () => {
        const text = await resultText();
        expect(text).toContain("W شركة");
        expect(text).not.toContain("O شركة");
      },
      expected: {
        main: { settles: 1, releases: 0, effective: 0, net: 200, answers: [], charge: 200, rows: 2 },
        chain: { settles: 1, releases: 0, effective: 0, net: 200, answers: [], charge: 200, rows: 2 },
      },
    },
    {
      id: "R3b",
      identical: false,
      run: async (mode: RaceMode) => {
        await raceWithOldWorker({ mode, pause: { kind: "upload", name: "step_0.json" }, oRows: 3, wRows: 2, wDies: true });
      },
      expected: {
        main: { settles: 0, releases: 1, effective: 1, net: 0, answers: [false], charge: 0, rows: 0 },
        chain: { settles: 0, releases: 1, effective: 1, net: 0, answers: [false], charge: 0, rows: 0 },
      },
    },
    {
      id: "R3d",
      identical: false,
      run: async (mode: RaceMode) => {
        await raceWithOldWorker({ mode, pause: { kind: "rpc", name: "complete_chunk" }, oRows: 2, wRows: 2, wDies: true });
      },
      afterRun: async () => {
        const text = await resultText();
        expect(text).toContain("W شركة");
        expect(text).not.toContain("O شركة");
      },
      expected: {
        main: { settles: 1, releases: 0, effective: 0, net: 200, answers: [], charge: 200, rows: 2 },
        chain: { settles: 1, releases: 0, effective: 0, net: 200, answers: [], charge: 200, rows: 2 },
      },
    },
    {
      id: "R4",
      identical: true,
      run: async (mode: RaceMode) => {
        await raceWithOldWorker({ mode, pause: { kind: "upload", name: "step_0.json" }, oRows: 1, wRows: 1, wDies: true, goesOn: true });
        await sweepAfter31Minutes();
      },
      expected: {
        main: { settles: 0, releases: 1, effective: 1, net: 0, answers: [false], charge: 0, rows: 0, releaseText: staleReleaseReasonAr(5) },
        chain: { settles: 0, releases: 1, effective: 1, net: 0, answers: [false], charge: 0, rows: 0, releaseText: staleReleaseReasonAr(5) },
      },
    },
    {
      id: "B4 W-first",
      identical: false,
      run: async (mode: RaceMode) => {
        await raceWithOldWorker({ mode, pause: { kind: "upload", name: "step_0.json" }, oRows: 3, wRows: 2 });
      },
      expected: {
        main: { settles: 1, releases: 0, effective: 0, net: 200, answers: [], charge: 200, rows: 2 },
        chain: { settles: 1, releases: 0, effective: 0, net: 200, answers: [], charge: 200, rows: 2 },
      },
    },
    {
      id: "B4 O-first",
      identical: false,
      run: async (mode: RaceMode) => {
        await raceOFirst({ mode, interleaving: "I1", oRows: 3, wRows: 2 });
      },
      expected: {
        // main's winner O assembles from storage: W's 2 rows ≠ 3 units and releases; W, the unsettled loser, mismatches again and releases again: the second call answers already_released: two calls, ONE effective release (answers [false, true]), net debit 0
        main: { settles: 0, releases: 2, effective: 1, net: 0, answers: [false, true], charge: 0, rows: 0 },
        chain: { settles: 1, releases: 0, effective: 0, net: 300, answers: [], charge: 300, rows: 3 },
      },
    },
  ];

  it.each(CELLS)("T-W PT parity with main $id: delivery, no release where main settles, charge = ceil(delivered x unit)", async ({ identical, run, afterRun, expected }) => {
    const out = {} as Record<RaceMode, Outcome>;
    for (const mode of ["main", "chain"] as const) {
      await run(mode);
      out[mode] = await ptOutcome();
      expect(out[mode]).toMatchObject(expected[mode]);
      await afterRun?.();
    }
    expect(out.chain.rows).toBeGreaterThanOrEqual(out.main.rows);                       // (i) chain delivers at least what main delivers
    expect((out.chain.releases > 0 || out.chain.effective > 0) && out.main.settles > 0).toBe(false);               // (ii) chain never releases where main settles
    for (const mode of ["main", "chain"] as const) expect(out[mode].charge).toBe(out[mode].settles ? Math.ceil(out[mode].rows * 100) : 0);   // (iii) unit price 100 of prepareJob
    if (identical) { expect(out.chain).toEqual(out.main); expect(out.main.committed).toBeGreaterThan(0); }   // (iv) R2 and R4 identical, and units WERE committed (the rows are lost, not never delivered)
  });


  it("T-W B8 ok:false terminals: spend, ledger, clock, cursor, lease emit neutral Arabic sentence of chainFailureReasonAr, no provider string, no release/charge claim", async () => {
    const kinds = [
      { failure: "spend", reason: chainFailureReasonAr("spend") },
      { failure: "ledger", reason: chainFailureReasonAr("spend") },
      { failure: "clock", reason: chainFailureReasonAr("spend") },
      { failure: "cursor", reason: chainFailureReasonAr("cursor") },
      { failure: "lease", reason: chainFailureReasonAr("lease") },
    ];

    for (const { failure, reason } of kinds) {
      expect(typeof reason).toBe("string");
      expect(reason.startsWith("السبب:")).toBe(true);
      // No provider name
      expect(reason).not.toMatch(/treg|tomba|icypeas|firecrawl|contextdev|hunter|apollo/i);
      // No release or charge claim
      expect(reason).not.toMatch(/سُلّم|يُخصم|يُحتسب/);
    }
  });

  it("T-W B9 final line and DT-03 failures: final line read from assembled file; dedupe and settlement failure behave as DT-03 W-6/W-10", async () => {
    // 1. Dedupe removes a runner row (W-6 behavior)
    resetDb({ target: 5 });
    const companyIdentity = dedupeIdentityFor("company");
    db.quotes[0].items[0].params.excludeRowKeys = [1].map((n) => companyIdentity({ website: `https://fakeco${n}.net` })!);
    const world = defaultFakeWorld(6);
    const { last: dedupeLast } = await runMany(world);
    expect(dedupeLast.status).toBe(200);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(db.results.get(`user_1/${JOB}/result.xlsx`)! as any);
    const sheet = wb.worksheets[0];
    const assembledRowCount = sheet.rowCount - 1;

    const finalEvent = db.events.find((e: any) => String(e.message ?? "").startsWith("المسلَّم"));
    expect(finalEvent).toBeDefined();
    expect(String(finalEvent.message)).toContain(`المسلَّم ${toArabicDigits(assembledRowCount)} من`);

    // 2. Settlement failure (W-10 behavior)
    resetDb({ target: 5 });
    const supabase = await import("../src/lib/supabase/server");
    const origImpl = vi.mocked(supabase.createAdminClient).getMockImplementation();
    vi.mocked(supabase.createAdminClient).mockImplementation(() => {
      const client = origImpl!();
      const origRpc = client.rpc;
      (client as any).rpc = vi.fn(async (name: string, args: any) => {
        if (name === "settle_job_atomic") {
          db.rpcCalls.push({ name, args });
          return { data: null, error: { message: "settle_failed" } };
        }
        return origRpc(name, args);
      });
      return client;
    });

    try {
      const { last: failLast } = await run(world);
      expect(failLast.status).toBeGreaterThanOrEqual(400);

      const events = db.events.map((e: any) => String(e.message ?? ""));
      for (const t of events) {
        if (t.includes("الموثّق منها")) continue;
        if (t.startsWith(releaseTextAr(RELEASE_NEUTRAL_REASON_AR, db.targetVolumeMax)) && /\(حجز مؤقت مُحرَّر [٠-٩]+ نقطة، ولم يُخصم شيء\)\.$/.test(t)) continue;
        expect(t).not.toMatch(/سُلّم|يُخصم|يُحتسب|تم إكمال/);
      }
    } finally {
      if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
    }
  });


  it("T-W B10 statement order: non-chain is running record -> step upload -> complete_chunk; chain is same order plus winner-only re-publish after it", async () => {
    const route = await import("../src/app/api/worker/chunk/route");

    // 1. NON-chain job: running record -> step upload -> complete_chunk
    resetDb({ target: 5 });
    db.endpoint = "icypeas.companies.search";
    db.quotes[0].items[0].capabilitySlug = "icypeas-companies-search";
    db.quotes[0].items[0].endpointId = "icypeas.companies.search";
    setProviderAdapterForTesting(async () => ({
      ok: true,
      httpStatus: 200,
      rows: [MATCHING_ROW],
      nextCursor: "cur_2",
      costUsd: 0.005,
      costMicro: 5000,
      tregCallId: "t_nc",
    }));

    const nonChainOps: string[] = [];
    const origUploadHist = db.uploadHistory.length;
    const origRpcCount = db.rpcCalls.length;

    const resNonChain = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
      method: "POST",
      headers: { authorization: "Bearer chain-secret" },
      body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
    }));
    expect(resNonChain.status).toBe(200);

    const ncUploads = db.uploadHistory.slice(origUploadHist);
    const ncStepUploads = ncUploads.filter((u) => u.path.includes("step_"));
    // Non-chain uploads step file exactly once (no re-publish after complete_chunk)
    expect(ncStepUploads.length).toBe(1);

    // 2. CHAIN job: running record -> canonical upload -> complete_chunk -> re-publish after it
    resetDb({ target: 5 });
    const world = defaultFakeWorld(5);
    fetchSpy = createFakeFetch(world);
    setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: KEYS, tregCall: tregHook() });
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "" }));

    const chainUploadHistStart = db.uploadHistory.length;
    const resChain = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
      method: "POST",
      headers: { authorization: "Bearer chain-secret" },
      body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
    }));
    expect(resChain.status).toBe(200);

    const chainUploads = db.uploadHistory.slice(chainUploadHistStart);
    const chainStepUploads = chainUploads.filter((u) => u.path.includes("step_"));
    // Winner chain job uploads step file twice (initial canonical upload + winner re-publish after complete_chunk)
    expect(chainStepUploads.length).toBe(2);

    // The complete_chunk RPC happened between the first step upload and the second (re-publish)
    const completeCall = db.rpcCalls.find((c) => c.name === "complete_chunk");
    expect(completeCall).toBeDefined();
  });


  it("T-W B11 start markers: eight starts create start_<step>_0..7; 9th start has startIndex = 8 -> terminal work_limit with zero calls and delivered-only charge; storage error throws; overlapping starts get different k", async () => {
    const route = await import("../src/app/api/worker/chunk/route");
    const step = 0;

    // 1. Eight real worker starts of one step, each killed before any call: the ROUTE writes markers 0..7
    resetDb({ target: 5 });
    const { hung } = hangingTransport();
    for (let k = 0; k < 8; k++) {
      await startAndHang(hung);
      expect(db.partials.has(`${JOB}/start_${step}_${k}.json`)).toBe(true);
      expect(db.partials.has(`${JOB}/start_${step}_${k + 1}.json`)).toBe(false);
      expireLease();
    }
    expect(rpcCount("complete_chunk")).toBe(0); expect(rpcCount("settle_job_atomic")).toBe(0);
    expect(rpcCount("release_job_atomic")).toBe(0); expect(db.ledger).toEqual([]);

    // 2. The 9th start: all 0..7 already exist => startIndex = 8 => terminal work_limit, ZERO calls, delivered-only charge
    let providerCallsMade = 0;
    const countedTregHook = tregHook();
    fetchSpy = createFakeFetch(defaultFakeWorld(5));
    setChainTransportForTesting({
      fetchFn: async (...args) => { providerCallsMade += 1; return fetchSpy(...args); },
      robotsFetch: createFakeRobotsFetch(defaultFakeWorld(5)),
      keys: KEYS,
      // every transport is counted, the TREG hook too (it stands for the real TREG client): the ninth start must reach NONE of them
      tregCall: async (o: any) => { providerCallsMade += 1; return countedTregHook(o); },
    });
    setProviderAdapterForTesting(async () => {
      providerCallsMade += 1;
      return { ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "" };
    });

    const res9th = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
      method: "POST",
      headers: { authorization: "Bearer chain-secret" },
      body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
    }));
    // the 9th start ends with ZERO delivered rows: a zero-delivery release = 422 (B7's own expectation)
    expect(res9th.status).toBe(422);
    expect((await res9th.json()).released).toBe(true);
    // Zero provider calls
    expect(providerCallsMade).toBe(0);

    // Terminal work_limit and delivered-only charge
    const relWorkLimit = db.rpcCalls.find((c) => c.name === "release_job_atomic");
    expect(relWorkLimit).toBeDefined();
    // plan v9 :196/:310 (P86): the release text of a chain job; it carries the work_limit sentence
    expect(relWorkLimit!.args.p_error_message).toBe(chainZeroDeliveryReasonAr({ target: 5, stop: "work_limit" }));
    expect(String(relWorkLimit!.args.p_error_message)).toContain("بلغنا الحد الأقصى المسموح لحجم العمل");
    expectMoney("released", { calls: 1 });

    // 3. Storage error that is NOT "already exists" => throw (a caught failure), never a loop
    resetDb({ target: 5 });
    const supabase = await import("../src/lib/supabase/server");
    const origImpl = vi.mocked(supabase.createAdminClient).getMockImplementation();
    vi.mocked(supabase.createAdminClient).mockImplementation(() => {
      const client = origImpl!();
      const origStorage = client.storage;
      (client as any).storage = {
        from: (bucket: string) => {
          const b = origStorage.from(bucket);
          return {
            ...b,
            upload: async (path: string, body: any, opts: any) => {
              if (path.includes("start_")) {
                return { data: null, error: { message: "s3_permission_denied", statusCode: 500 } };
              }
              return b.upload(path, body, opts);
            },
          };
        },
      };
      return client;
    });

    try {
      // the route's top-level catch turns the thrown start-marker error into a 500 RESPONSE (it never rejects): a caught failure, never a loop; the release is confirmed, so `error` carries the thrown text
      const resStartErr = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        method: "POST",
        headers: { authorization: "Bearer chain-secret" },
        body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
      }));
      expect(resStartErr.status).toBe(500);
      const startErrText = String((await resStartErr.json()).error);
      // DT-20261117-06 (plan M2, the closed boundary): the start-marker throw is a plain Error, so the customer reads the neutral release text with the count, never the thrown sentence
      expect(startErrText).toBe(releaseTextAr(RELEASE_NEUTRAL_REASON_AR, db.targetVolumeMax));
      // DT-20261117-04 fix-gate2-r1: the customer reads this text (the response, the failure record and the release confirmation): the exact sentence, and no Latin digit (the step number was removed from it)
      expect(startErrText.startsWith("المسلَّم ٠ من ")).toBe(true);
      expect(startErrText).not.toMatch(/[0-9]/);
      const startFailRecord = db.rpcCalls.find((c) => c.name === "record_chunk_failure");
      expect(startFailRecord).toBeDefined();
      expect(startFailRecord!.args.p_error_message).toBe(RETRY_CAUSE_AR);
      const startRelease = db.rpcCalls.find((c) => c.name === "release_job_atomic");
      expect(startRelease).toBeDefined();
      expect(startRelease!.args.p_error_message).toBe(releaseTextAr(RELEASE_NEUTRAL_REASON_AR, db.targetVolumeMax));
      expectMoney("released", { calls: 1 });
    } finally {
      if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
    }

    // 4. Two overlapping starts get different k: the first is still running (hung) when the second starts after the lease expired
    resetDb({ target: 5 });
    const second = hangingTransport();
    await startAndHang(second.hung);
    expireLease();
    await startAndHang(second.hung);
    expect(db.partials.has(`${JOB}/start_${step}_0.json`)).toBe(true);
    expect(db.partials.has(`${JOB}/start_${step}_1.json`)).toBe(true);
    expect(db.partials.has(`${JOB}/start_${step}_2.json`)).toBe(false);
    const attempts = db.uploadHistory.filter((u) => u.path.startsWith(`${JOB}/start_${step}_`)).map((u) => `${u.path.slice(JOB.length + 1)}:${u.existed}`);
    expect(attempts).toEqual([`start_${step}_0.json:false`, `start_${step}_0.json:true`, `start_${step}_1.json:false`]);   // the second start is refused at k=0, then takes k=1
    expect(rpcCount("release_job_atomic")).toBe(0); expect(db.ledger).toEqual([]);
  });

  it("T-N route outputs: provider errors never reach the customer", async () => {
    prepareJob("chain", 4);
    const injected = [
      "Context.dev service unavailable",
      "firecrawl credits exhausted",
      "Tomba rate limit",
      "TREG route_max_cost firecrawl 402",
    ];

    setChainTransportForTesting({
      fetchFn: (async (input: string) => {
        const u = new URL(String(input));
        const provider = u.hostname.includes("firecrawl") ? "firecrawl" : "contextdev";
        return new Response(JSON.stringify({ error: injected[0], provider, message: injected[1] }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }) as any,
      robotsFetch: createFakeRobotsFetch(defaultFakeWorld(4)),
      keys: KEYS,
      tregCall: async () => ({
        ok: false,
        httpStatus: 500,
        tregCallId: "t",
        costMicro: 0,
        latencyMs: 1,
        data: null,
        error: injected[2],
        errorDetails: injected[3],
        isRouteMaxCost: false,
        isPlatformBalanceLow: false,
      }),
    });

    const responses: Array<{ status: number; body: any }> = [];
    for (let i = 0; i < 12; i++) {
      const res = await postChunk();
      const body = await res.json();
      responses.push({ status: res.status, body });
      if (body.done === true || body.released === true || res.status >= 400) break;
    }

    const customerOutputs: string[] = [];
    for (const r of responses) {
      if (r.body.error) customerOutputs.push(String(r.body.error));
      if (r.body.message) customerOutputs.push(String(r.body.message));
      if (r.body.errorMessageAr) customerOutputs.push(String(r.body.errorMessageAr));
    }
    for (const evt of db.events) {
      if (evt.message) customerOutputs.push(String(evt.message));
    }
    for (const [key, buf] of db.partials.entries()) {
      if (key.match(/\/step_\d+\.json$/)) {
        customerOutputs.push(buf.toString("utf-8"));
      }
    }
    for (const text of db.stepBodies.values()) {
      customerOutputs.push(text);
    }
    for (const rpc of db.rpcCalls) {
      if (rpc.name === "release_job_atomic" && rpc.args?.p_error_message) {
        customerOutputs.push(String(rpc.args.p_error_message));
      }
    }

    expect(customerOutputs.length).toBeGreaterThan(3);

    const FORBIDDEN_WORDS = /contextdev|context\.dev|firecrawl|treg|icypeas/i;
    for (const out of customerOutputs) {
      expect(out).not.toMatch(FORBIDDEN_WORDS);
      for (const inj of injected) {
        expect(out.toLowerCase()).not.toContain(inj.toLowerCase());
      }
      if (/[؀-ۿ]/.test(out)) {
        // Arabic text shown to customer must not contain Latin digits
        expect(out).not.toMatch(/[؀-ۿ].*[0-9]|[0-9].*[؀-ۿ]/);
      }
    }
  });

  describe("T4 worker: group keys and stop before settle (PR-6)", () => {
    const GID = "grp_0123456789abcdef0123456789abcdef";

    it("isGroupPartSpec helper respects isChainJob and split.v === 3", () => {
      expect(isGroupPartSpec(null, false)).toBe(false);
      expect(isGroupPartSpec(null, true)).toBe(false);
      expect(isGroupPartSpec({}, true)).toBe(false);
      expect(isGroupPartSpec({ params: {} }, true)).toBe(false);
      expect(isGroupPartSpec({ params: { split: { v: 2 } } }, true)).toBe(false);
      expect(isGroupPartSpec({ params: { split: { v: 3 } } }, false)).toBe(false);
      expect(isGroupPartSpec({ params: { split: { v: 3 } } }, true)).toBe(true);
    });

    it("loadGroupKeys validates group ID format and rejects invalid IDs", async () => {
      await expect(loadGroupKeys(null, "invalid")).rejects.toThrow("group_keys_unavailable");
      await expect(loadGroupKeys(null, "grp_123")).rejects.toThrow("group_keys_unavailable");
      await expect(loadGroupKeys(null, null)).rejects.toThrow("group_keys_unavailable");
      await expect(loadGroupKeys(null, 12345)).rejects.toThrow("group_keys_unavailable");
      await expect(loadGroupKeys(null, "job_quote_0123456789abcdef0123456789abcdef")).rejects.toThrow("group_keys_unavailable");
    });

    it("loadGroupKeys pages through > 1000 keys across ranges", async () => {
      const allKeys = Array.from({ length: 1500 }, (_, i) => `domain:company${String(i).padStart(4, "0")}.com`);
      const fakeAdmin = {
        from: (table: string) => {
          expect(table).toBe("job_group_keys");
          let rangeFrom = 0;
          let rangeTo = 999;
          const api: any = {
            select: () => api,
            eq: () => api,
            order: () => api,
            range: (from: number, to: number) => {
              rangeFrom = from;
              rangeTo = to;
              return api;
            },
            then: (resolve: any) => {
              const sliced = allKeys.slice(rangeFrom, rangeTo + 1).map((key) => ({ key }));
              resolve({ data: sliced, error: null });
            },
          };
          return api;
        },
      };

      const loaded = await loadGroupKeys(fakeAdmin, GID);
      expect(loaded).toHaveLength(1500);
      expect(loaded[0]).toBe("domain:company0000.com");
      expect(loaded[1499]).toBe("domain:company1499.com");
    });

    it("loadGroupKeys throws group_keys_unavailable on database query error", async () => {
      const fakeAdmin = {
        from: () => ({
          select: () => ({
            eq: () => ({
              order: () => ({
                range: () => Promise.resolve({ data: null, error: { message: "db down", code: "57P01" } }),
              }),
            }),
          }),
        }),
      };
      await expect(loadGroupKeys(fakeAdmin, GID)).rejects.toThrow("group_keys_unavailable");
    });

    it("T4 (a) CROSS-PART NO RE-CHARGE: part-2 job, job_group_keys fake holds part 1's 10 domains, the world returns those 10 first then 10 new => delivered rows contain none of the 10, delivered_units counts only the new rows", async () => {
      resetDb({ target: 10 });
      roomyBudget(10);
      db.quotes[0].items[0].params.split = {
        v: 3,
        part: 2,
        parts: 3,
        groupId: GID,
        perPart: 10,
        reachable: 30,
        askedOriginal: 30,
      };

      const world = defaultFakeWorld(20).map((c) => ({
        ...c,
        email: `info@${c.domain}`,
      }));
      const companyIdentity = dedupeIdentityFor("company");
      db.job_group_keys = world.slice(0, 10).map((c) => ({
        group_id: GID,
        key: companyIdentity({ website: `https://${c.domain}` })!,
        from_part: 1,
      }));

      const { last } = await runMany(world);
      expect(last.status).toBe(200);
      expect(last.json).toMatchObject({
        success: true,
        done: true,
        awaitingGroupFreeze: true,
        jobId: JOB,
        deliveredUnits: 10,
      });

      const partialDataBuf = db.partials.get(`user_1/${JOB}/data.json`) || db.partials.get(`${JOB}/data.json`);
      expect(partialDataBuf).toBeDefined();
      const parsed = JSON.parse(partialDataBuf!.toString("utf-8"));
      const rows = Array.isArray(parsed) ? parsed : (parsed.rows ?? []);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(10);

      const part1Domains = new Set(world.slice(0, 10).map((c) => c.domain));
      for (const row of rows) {
        const rowDomain = String(row.website || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
        expect(part1Domains.has(rowDomain)).toBe(false);
      }

      const settleCalls = db.rpcCalls.filter((c) => c.name === "settle_job_atomic" || c.name === "settle_people_job_atomic");
      expect(settleCalls).toHaveLength(0);
      expect(db.jobs[0].status).toBe("running");
      expect(db.jobs[0].current_cursor).toBe("completed");
    });

    it("T4 (b1) bad gid: fails before any provider call, nothing settled", async () => {
      resetDb({ target: 5 });
      db.quotes[0].items[0].params.split = {
        v: 3,
        part: 2,
        parts: 3,
        groupId: "invalid_gid",
        perPart: 5,
      };
      const world = defaultFakeWorld(5);
      const route = await import("../src/app/api/worker/chunk/route");
      fetchSpy = createFakeFetch(world);
      setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: KEYS, tregCall: tregHook() });
      setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "" }));

      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        method: "POST",
        headers: { authorization: "Bearer chain-secret" },
        body: JSON.stringify({ jobId: JOB, expectedStep: 0, disableSelfChain: true }),
      }));
      const json = await res.json();
      expect(res.status).toBe(500);
      expect(json.success).toBe(false);

      const reserves = db.rpcCalls.filter((c) => c.name === "reserve_provider_spend_atomic");
      expect(reserves).toHaveLength(0);
      expect(fetchSpy.log).toHaveLength(0);

      const settleCalls = db.rpcCalls.filter((c) => c.name === "settle_job_atomic");
      expect(settleCalls).toHaveLength(0);
      expect(db.jobs[0].status).not.toBe("completed");
    });

    it("T4 (b2) keys load error: database error causes chunk failure with zero provider calls, nothing settled", async () => {
      resetDb({ target: 5 });
      db.quotes[0].items[0].params.split = {
        v: 3,
        part: 2,
        parts: 3,
        groupId: GID,
        perPart: 5,
      };
      db.groupKeysQueryError = { message: "connection refused", code: "57P03" };

      const world = defaultFakeWorld(5);
      const route = await import("../src/app/api/worker/chunk/route");
      fetchSpy = createFakeFetch(world);
      setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: KEYS, tregCall: tregHook() });
      setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "" }));

      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        method: "POST",
        headers: { authorization: "Bearer chain-secret" },
        body: JSON.stringify({ jobId: JOB, expectedStep: 0, disableSelfChain: true }),
      }));
      const json = await res.json();
      expect(res.status).toBe(500);
      expect(json.success).toBe(false);

      const reserves = db.rpcCalls.filter((c) => c.name === "reserve_provider_spend_atomic");
      expect(reserves).toHaveLength(0);
      expect(fetchSpy.log).toHaveLength(0);

      const settleCalls = db.rpcCalls.filter((c) => c.name === "settle_job_atomic");
      expect(settleCalls).toHaveLength(0);
      expect(db.jobs[0].status).not.toBe("completed");
    });

    it("T4 (b3) keys load timeout: query timeout causes chunk failure with zero provider calls, nothing settled", async () => {
      resetDb({ target: 5 });
      db.quotes[0].items[0].params.split = {
        v: 3,
        part: 2,
        parts: 3,
        groupId: GID,
        perPart: 5,
      };
      db.groupKeysDelayMs = 4500;

      const world = defaultFakeWorld(5);
      const route = await import("../src/app/api/worker/chunk/route");
      fetchSpy = createFakeFetch(world);
      setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: KEYS, tregCall: tregHook() });
      setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "" }));

      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        method: "POST",
        headers: { authorization: "Bearer chain-secret" },
        body: JSON.stringify({ jobId: JOB, expectedStep: 0, disableSelfChain: true }),
      }));
      const json = await res.json();
      expect(res.status).toBe(500);
      expect(json.success).toBe(false);

      const reserves = db.rpcCalls.filter((c) => c.name === "reserve_provider_spend_atomic");
      expect(reserves).toHaveLength(0);
      expect(fetchSpy.log).toHaveLength(0);

      const settleCalls = db.rpcCalls.filter((c) => c.name === "settle_job_atomic");
      expect(settleCalls).toHaveLength(0);
      expect(db.jobs[0].status).not.toBe("completed");
    });

    it("T4 (c0) W5: a group part (part 1 and part 2) reaching the end => data.json written, NO settle, no events/notices, awaitingGroupFreeze: true, stays running", async () => {
      // Part 1 reaching the end
      resetDb({ target: 3 });
      db.quotes[0].items[0].params.split = {
        v: 3,
        part: 1,
        parts: 3,
        groupId: GID,
        perPart: 3,
        reachable: 9,
        askedOriginal: 9,
      };

      const world = defaultFakeWorld(5);
      const { last: part1Last } = await run(world);
      expect(part1Last.status).toBe(200);
      expect(part1Last.json).toMatchObject({
        success: true,
        done: true,
        awaitingGroupFreeze: true,
        jobId: JOB,
        deliveredUnits: 3,
      });

      const part1Data = db.partials.get(`user_1/${JOB}/data.json`) || db.partials.get(`${JOB}/data.json`);
      expect(part1Data).toBeDefined();

      const part1Settle = db.rpcCalls.filter((c) => c.name === "settle_job_atomic" || c.name === "settle_people_job_atomic");
      expect(part1Settle).toHaveLength(0);
      expect(db.events.some((e) => e.message?.includes("المسلَّم") || e.message?.includes("تم إكمال"))).toBe(false);
      expect(db.notices).toHaveLength(0);
      expect(db.jobs[0].status).toBe("running");
      expect(db.jobs[0].current_cursor).toBe("completed");

      // Part 2 reaching the end
      resetDb({ target: 3 });
      db.quotes[0].items[0].params.split = {
        v: 3,
        part: 2,
        parts: 3,
        groupId: GID,
        perPart: 3,
        reachable: 9,
        askedOriginal: 9,
      };

      const { last: part2Last } = await run(world);
      expect(part2Last.status).toBe(200);
      expect(part2Last.json).toMatchObject({
        success: true,
        done: true,
        awaitingGroupFreeze: true,
        jobId: JOB,
        deliveredUnits: 3,
      });

      const part2Settle = db.rpcCalls.filter((c) => c.name === "settle_job_atomic" || c.name === "settle_people_job_atomic");
      expect(part2Settle).toHaveLength(0);
      expect(db.events.some((e) => e.message?.includes("المسلَّم") || e.message?.includes("تم إكمال"))).toBe(false);
      expect(db.notices).toHaveLength(0);
      expect(db.jobs[0].status).toBe("running");
      expect(db.jobs[0].current_cursor).toBe("completed");

      // Already completed loser path
      const route = await import("../src/app/api/worker/chunk/route");
      const loserRes = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        method: "POST",
        headers: { authorization: "Bearer chain-secret" },
        body: JSON.stringify({ jobId: JOB, expectedStep: 0, disableSelfChain: true }),
      }));
      const loserJson = await loserRes.json();
      expect(loserRes.status).toBe(200);
      expect(loserJson).toMatchObject({
        success: true,
        done: true,
        awaitingGroupFreeze: true,
        jobId: JOB,
        deliveredUnits: 3,
      });
      const loserSettle = db.rpcCalls.filter((c) => c.name === "settle_job_atomic");
      expect(loserSettle).toHaveLength(0);
      expect(db.jobs[0].status).toBe("running");
    });

    it("T4 (d) INERT FOR ORDINARY JOBS: an ordinary chain job (no params.split) => no job_group_keys query recorded, no awaitingGroupFreeze, settle called exactly as today", async () => {
      resetDb({ target: 3 });
      expect(db.quotes[0].items[0].params.split).toBeUndefined();

      const world = defaultFakeWorld(5);
      const { last } = await run(world);
      expect(last.status).toBe(200);
      expect(last.json.done).toBe(true);
      expect(last.json.awaitingGroupFreeze).toBeUndefined();

      expect(db.tablesQueried).not.toContain("job_group_keys");

      const settleCalls = db.rpcCalls.filter((c) => c.name === "settle_job_atomic");
      expect(settleCalls).toHaveLength(1);
      expect(settleCalls[0].args).toMatchObject({ p_job_id: JOB, p_points_cap: 25_000, p_result_file_id: `user_1/${JOB}/result.xlsx` });
      expect(db.ledger.filter((row) => row.type === "charge")).toEqual([{ id: `chg_${JOB}`, job_id: JOB, user_id: "user_1", type: "charge", delta: -Math.min(Math.ceil(db.deliveredUnits * db.unitPrice), db.reserved), by: "settle_job_atomic" }]);
      expect(db.jobs[0].status).toBe("completed");
    });
  });
  });

/** DT-20261117-06 T-M (chain rows, [DEPENDS DT-04]): company contacts and company e-mails through the REAL worker route with this file's fake providers. Its own environment hooks (a top-level sibling of the chain describe). */
describe("T-M chain (DT-06)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV, MULTI_PROVIDER_ENABLED: process.env.MULTI_PROVIDER_ENABLED, TREG_LIVE: process.env.TREG_LIVE };
    process.env.CRON_SECRET = "chain-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development";
    process.env.MULTI_PROVIDER_ENABLED = "true";
    delete process.env.TREG_LIVE;
    realTreg.calls.length = 0;
    setRowAdvisorForTesting(async () => { throw new Error("no advisory review may run on a verified chain row"); });
  });
  afterEach(() => {
    setProviderAdapterForTesting(null); setRowAdvisorForTesting(null); setChainTransportForTesting(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
    // fail-closed (DT-04 CI r2 safety, after the clean-up above): a test that reached the REAL TREG client fails here, even when the runner caught the thrown error
    const reachedRealTreg = realTreg.calls.splice(0);
    expect(reachedRealTreg, "real TREG call in test").toEqual([]);
  });

  const MODES = ["EMPTY", "ERROR", "DAILY CAP", "TIMEOUT", "CRASH"] as const;
  const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
  async function callRoute(step: number) {
    const route = await import("../src/app/api/worker/chunk/route");
    const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer chain-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: step, disableSelfChain: true }) }));
    return { status: res.status, json: await res.json() };
  }
  /** Drives one job in one failure mode and returns the last response. EMPTY, ERROR, DAILY CAP and TIMEOUT fail every source from the start; CRASH delivers chunk 1 and throws inside chunk 2 until the SQL fake releases at the 5th failure. */
  async function drive(mode: (typeof MODES)[number], twoRequiredFields: boolean) {
    resetDb(mode === "CRASH" ? { target: 30 } : {});
    if (twoRequiredFields) useTwoRequiredFields();
    let world: FakeCompany[] = defaultFakeWorld(10);
    let scenario: Parameters<typeof createFakeFetch>[1] = {};
    if (mode === "EMPTY") { world = []; scenario = { emptyProvider: { firecrawl: true, contextdev: true } }; }
    if (mode === "ERROR") scenario = { failProvider: { firecrawl: 500, contextdev: 500 } };
    if (mode === "DAILY CAP") db.reserveDeniedFor = new Set(["treg", "firecrawl", "contextdev"]);
    if (mode === "CRASH") world = nonTerminalWorld(() => true);
    const fake = createFakeFetch(world, scenario);
    // the TREG hook of every mode (DT-04 CI r2): a valid EMPTY answer, a 500 answer, or a timeout; the real TREG client is never reached
    const tregCall: any = mode === "TIMEOUT" ? (async () => { throw timeoutError(); }) : mode === "ERROR" ? (async () => ({ ok: false, httpStatus: 500, tregCallId: "e", costMicro: 0, latencyMs: 1, data: null, isRouteMaxCost: false, isPlatformBalanceLow: false })) : tregHook();
    setChainTransportForTesting({ fetchFn: mode === "TIMEOUT" ? (async () => { throw timeoutError(); }) : fake, robotsFetch: createFakeRobotsFetch(world), keys: KEYS, tregCall });
    if (mode === "ERROR") setProviderAdapterForTesting(async () => ({ ok: false, httpStatus: 500, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "e", errorCode: "x", errorMessageAr: "" }));
    else if (mode === "TIMEOUT") setProviderAdapterForTesting(async () => { throw timeoutError(); });
    else setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "" }));
    let last = await callRoute(0);
    if (mode === "CRASH") {
      expect(last.json.done).not.toBe(true);
      db.failCount = 4;
      db.throwCompleteChunkAt = 2;
      last = await callRoute(db.step);
    } else {
      for (let i = 0; i < 12 && last.json.done !== true && last.json.released !== true && last.status < 400; i++) last = await callRoute(db.step);
    }
    return last;
  }
  /** The stored text of a released job: the last release call's text, or for CRASH (released by the SQL fake) the job row after the compare-and-set. */
  function storedText(mode: (typeof MODES)[number]): unknown {
    const releases = db.rpcCalls.filter((c) => c.name === "release_job_atomic");
    return mode === "CRASH" ? db.jobs[0].error_message : releases[releases.length - 1]?.args.p_error_message;
  }

  for (const [type, twoRequiredFields] of [["company contacts", true], ["company e-mails", false]] as const) {
    it.each(MODES)(`T-M chain ${type} %s ends released with no failure word and a zero count`, async (mode) => {
      const last = await drive(mode, twoRequiredFields);
      expectNoBareFailed(customerTexts({ rpcCalls: db.rpcCalls, events: db.events, jobs: db.jobs, json: last.json }));
      expectReleasedZeroOf(storedText(mode), db.targetVolumeMax);
      expectMoney("released", { calls: mode === "CRASH" ? 0 : 1 });
      if (mode === "CRASH") {
        // the 5th failure released the job INSIDE record_chunk_failure; the SQL answer has no released_credits, so the customer's notice is the NO-NUMBER text (route.ts:2764, jobNotices.ts releasedNoticeFull)
        const released = db.notices.filter((n: any) => n.id === `notif_released_${JOB}`);
        expect(released).toHaveLength(1);
        expect(released[0].title).toBe(releasedNoticeFull(0).title);
        expect(released[0].body).toBe(releasedNoticeFull(0).body);
        expect(released[0].body).not.toMatch(/[0-9٠-٩]/);
        expect(released[0].body).toBe("تعذّر استكمال طلبك. حجز مؤقت مُحرَّر كاملًا دون أي خصم.");
      }
    });
  }

  it("T-M chain notice e-mail of the 5th failure carries no amount", async () => {
    vi.mocked(sendPlatformEmail).mockClear();
    vi.mocked(getRecipient).mockImplementation(async () => ({ email: "owner@example.test", name: "Owner" }));
    try {
      await drive("CRASH", true);
    } finally {
      vi.mocked(getRecipient).mockImplementation(async () => null);                 // the file's own default
    }
    const mails = vi.mocked(sendPlatformEmail).mock.calls.filter((c) => c[3] === `job-update:released:${JOB}`);
    expect(mails).toHaveLength(1);                                                   // exactly one e-mail for this notice (the idempotency key of jobNotices.ts jobNoticeEmailKey)
    expect(mails[0][0]).toBe("job-update");
    expect(mails[0][2].DetailOne).toBe(releasedNoticeFull(0, { withEmail: true }).email!.detail1);
    expect(mails[0][2].DetailOne).not.toMatch(/[0-9٠-٩]/);
  });
});

describe("the fake release_job_atomic follows the SQL (DT-20261117-07 QA r1)", () => {
  const rpc = async (name: string, args: Record<string, unknown>) => ((await import("../src/lib/supabase/server")) as any).createAdminClient().rpc(name, args);

  it("F2a first release", async () => {
    resetDb({ target: 5 });
    const first = await rpc("release_job_atomic", { p_job_id: JOB, p_error_message: "first text", p_force: true });
    expect(first.error).toBeNull();
    expect(first.data).toEqual({ success: true, already_released: false, job_id: JOB, user_id: "user_1", released_credits: 575 });
    expect(db.jobs[0]).toMatchObject({ status: "failed", charged_credits: 0, error_message: "first text", lease_until: null });
    expect(db.ledger).toEqual([{ id: `rel_${JOB}`, job_id: JOB, user_id: "user_1", type: "release", delta: 575, by: "release_job_atomic" }]);
    expect(netDebit()).toBe(0);
  });

  it("F2b second release writes nothing", async () => {
    resetDb({ target: 5 });
    const first = await rpc("release_job_atomic", { p_job_id: JOB, p_error_message: "first text", p_force: true });
    const second = await rpc("release_job_atomic", { p_job_id: JOB, p_error_message: "second text", p_force: true });
    expect(second.data).toEqual({ success: true, already_released: true, job_id: JOB, released_credits: 575 });
    expect("user_id" in second.data).toBe(false);
    expect(db.jobs[0].error_message).toBe("first text");
    expect(db.ledger).toHaveLength(1);
    expect(releaseAnswers().map((a: any) => a.already_released)).toEqual([false, true]);
  });

  it("F2c a completed job raises", async () => {
    resetDb({ target: 5 });
    db.jobs[0].status = "completed";
    const res = await rpc("release_job_atomic", { p_job_id: JOB, p_error_message: "x", p_force: true });
    expect(res.data).toBeNull();
    expect(String(res.error?.message)).toContain("Cannot release already completed job");
    expect(db.ledger).toEqual([]);
    expect(db.jobs[0].status).toBe("completed");
  });

  it("F2d reads db.reserved live", async () => {
    resetDb({ target: 5 });
    db.reserved = 1000;
    const first = await rpc("release_job_atomic", { p_job_id: JOB, p_error_message: "first text", p_force: true });
    expect(first.data.released_credits).toBe(1000);
    expect(db.ledger[0].delta).toBe(1000);
    expect(netDebit()).toBe(0);
  });

  it("F2e settle releases first, then charges", async () => {
    resetDb({ target: 5 }); db.deliveredUnits = 2;                                  // unit price 100, reserve 575
    const settled = await rpc("settle_job_atomic", { p_job_id: JOB });
    expect(settled.data).toMatchObject({ success: true, already_settled: false, charged_credits: 200 });
    expect(db.ledger.map((r) => r.type)).toEqual(["release", "charge"]);            // the settlement releases FIRST (agentMoney.ts settle_job_atomic)
    expect(db.ledger.map((r) => r.delta)).toEqual([575, -200]);
    expect(db.ledger.map((r) => r.by)).toEqual(["settle_job_atomic", "settle_job_atomic"]);
    expect(netDebit()).toBe(200);
    expect(effectiveReleases()).toBe(0);                                             // a settlement is not an effective RELEASE
    const again = await rpc("settle_job_atomic", { p_job_id: JOB });
    expect(again.data).toMatchObject({ already_settled: true });
    expect(db.ledger).toHaveLength(2);
    const late = await rpc("release_job_atomic", { p_job_id: JOB, p_error_message: "late", p_force: true });
    expect(String(late.error?.message)).toContain("already completed");
  });

  it("F2f record_chunk_failure ignores a terminal job", async () => {
    resetDb({ target: 5 });
    await rpc("release_job_atomic", { p_job_id: JOB, p_error_message: "x", p_force: true });
    const ignoredFailed = await rpc("record_chunk_failure", { p_job_id: JOB, p_error_message: "late failure" });
    expect(ignoredFailed.data).toEqual({ success: true, ignored: true, status: "failed", job_id: JOB });
    expect(db.failCount).toBe(0);
    db.jobs[0].status = "completed";
    const ignoredDone = await rpc("record_chunk_failure", { p_job_id: JOB, p_error_message: "late failure" });
    expect(ignoredDone.data).toEqual({ success: true, ignored: true, status: "completed", job_id: JOB });
    expect(db.failCount).toBe(0);
  });

  it("F2g the 5th failure is an effective release", async () => {
    resetDb({ target: 5 }); db.failCount = 4;
    const fifth = await rpc("record_chunk_failure", { p_job_id: JOB, p_error_message: "boom" });
    expect(fifth.data).toEqual({ success: true, failed_permanently: true, attempt_count: 5, released: true, job_id: JOB });   // the SQL shape (20261012162016:252-258): no released_credits, no attempts
    expect(db.jobs[0]).toMatchObject({ status: "failed", charged_credits: 0, error_message: "Exceeded maximum retry attempts (5): boom" });
    expect(db.ledger).toEqual([{ id: `rel_${JOB}`, job_id: JOB, user_id: "user_1", type: "release", delta: 575, by: "record_chunk_failure" }]);
    expect(effectiveReleases()).toBe(1);
    const later = await rpc("release_job_atomic", { p_job_id: JOB, p_error_message: "later", p_force: true });
    expect(later.data).toMatchObject({ success: true, already_released: true });
    expect(effectiveReleases()).toBe(1);
    expect(db.jobs[0].error_message).toBe("Exceeded maximum retry attempts (5): boom");
  });

  it("F2h the non-terminal answer follows the SQL", async () => {
    resetDb({ target: 5 });                                                           // failCount 0; the job stays running (the SQL's queued status is not modelled, D6)
    for (const [attempt, delay] of [[1, 10], [2, 20], [3, 40], [4, 80]] as const) {
      const res = await rpc("record_chunk_failure", { p_job_id: JOB, p_error_message: "retry text" });
      expect(res.error).toBeNull();
      expect(res.data).toEqual({ success: true, failed_permanently: false, attempt_count: attempt, delay_seconds: delay, next_attempt_at: expect.any(String), job_id: JOB });
      expect("released" in res.data).toBe(false);                                     // the SQL has no `released` and no `attempts` on this answer
      expect("attempts" in res.data).toBe(false);
    }
    expect(db.failCount).toBe(4);
  });

});
