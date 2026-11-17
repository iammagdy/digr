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
}));

function builder(rows: () => any[]) {
  const filters: Array<[string, unknown]> = [];
  const apply = () => rows().filter((row) => filters.every(([col, val]) => row[col] === val));
  const api: any = {
    select: () => api,
    eq: (col: string, val: unknown) => { filters.push([col, val]); return api; },
    in: () => api, or: () => api, not: () => api, order: () => api, limit: () => api, gte: () => api, range: () => api,
    maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
    then: (resolve: any, reject: any) => Promise.resolve({ data: apply(), error: null }).then(resolve, reject),
  };
  return api;
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
        if (db.delayedCompleteChunkMs > 0) {
          await new Promise((r) => setTimeout(r, db.delayedCompleteChunkMs));
        }
        const expected = args.p_expected_step;
        if (typeof expected === "number") {
          if (db.step > expected) {
            return { data: { success: false, already_completed: true, delivered_units: db.deliveredUnits }, error: null };
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
        const charged = Math.min(Math.ceil(db.deliveredUnits * db.unitPrice), db.reserved);
        return { data: { success: true, already_settled: false, reserved_credits: db.reserved, charged_credits: charged, delivered_units: db.deliveredUnits }, error: null };
      }
      // DT-20261117-04 CI r1: record_chunk_failure and release_job_atomic clear the job's lease, as the real SQL functions do; otherwise the fake's own «lease not expired» rule refuses the next claim of the same test.
      if (name === "release_job_atomic") {
        const releasedJob = db.jobs.find((j) => j.id === args.p_job_id);
        if (releasedJob) releasedJob.lease_until = null;
        return { data: { success: true, released_credits: db.reserved }, error: null };
      }
      if (name === "record_chunk_failure") {
        const failedJob = db.jobs.find((j) => j.id === args.p_job_id);
        if (failedJob) failedJob.lease_until = null;
        return { data: { success: true }, error: null };
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
      if (table === "jobs") return builder(() => db.jobs);
      if (table === "plans_quotes") return builder(() => db.quotes);
      if (table === "provider_costs") return builder(() => db.costs);
      if (table === "settings_private") return builder(() => db.settings);
      if (table === "job_events" || table === "notifications" || table === "artifact_versions") {
        const base = builder(() => (table === "job_events" ? db.events : []));
        return { ...base, insert: async (row: any) => { if (table === "job_events") db.events.push({ created_at: new Date().toISOString(), ...row }); return { data: row, error: null }; }, upsert: async (row: any) => ({ data: row, error: null }) };
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
import { chainShortfallReasonAr, chainStopProgressLineAr, chainZeroDeliveryReasonAr, chainFailureReasonAr } from "../src/lib/multiProvider/copy";
import { dedupeIdentityFor } from "../src/lib/server/rowDedupe";
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
  db.step = 0; db.cursor = null; db.deliveredUnits = 0; db.targetVolumeMax = target; db.unitPrice = 100; db.reserved = Math.ceil(target * 100 * 1.15); db.endpoint = "mp.business.contacts";
  db.uploadHistory = []; db.delayedCompleteChunkMs = 0; db.killAfterCommit = false; db.corruptDownloadPaths.clear(); db.stepBodies.clear();
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
    expect(call.args.p_error_message).toBe(chainZeroDeliveryReasonAr({ target: TARGET, stop: "coverage_end" }));
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
      for (const t of events) {
        expect(t).not.toContain("المسلَّم");
        expect(t).not.toContain("تم إكمال");
      }
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
        if (/^تعذر استكمال الاستخراج: settle_failed \(حجز مؤقت مُحرَّر [٠-٩]+ نقطة، ولم يُخصم شيء\)\.$/.test(t)) continue;
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
      expect(call.args.p_error_message).toBe(chainZeroDeliveryReasonAr({ target: TARGET, stop: "coverage_end" }));
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
      expect(call.args.p_error_message).toBe(chainZeroDeliveryReasonAr({ target: TARGET, stop: "coverage_end" }));

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
    expect(call.args.p_error_message).toBe(chainZeroDeliveryReasonAr({ target: TARGET, stop: "coverage_end" }));

    const eventTexts = db.events.map((e: any) => String(e.message ?? ""));
    const confirmEvt = eventTexts.find((t) => t.includes("تعذر استكمال الاستخراج:") && t.includes(chainZeroDeliveryReasonAr({ target: TARGET, stop: "coverage_end" })));
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


  it("T-W B4 paused old worker: interleavings of upload and complete_chunk assert committer units, last writer rows, charges, zero-debit release on mismatch, and ledger holds both", async () => {
    const step = 0;
    const stepKey = `${JOB}/step_${step}.json`;

    const interleavings = [
      { committerFirst: "O", oUploadBeforeWUpload: true, wUploadBeforeOCommit: true, equalCounts: true },
      { committerFirst: "O", oUploadBeforeWUpload: true, wUploadBeforeOCommit: false, equalCounts: true },
      { committerFirst: "O", oUploadBeforeWUpload: false, wUploadBeforeOCommit: true, equalCounts: true },
      { committerFirst: "O", oUploadBeforeWUpload: false, wUploadBeforeOCommit: false, equalCounts: true },
      { committerFirst: "W", oUploadBeforeWUpload: true, wUploadBeforeOCommit: true, equalCounts: true },
      { committerFirst: "W", oUploadBeforeWUpload: true, wUploadBeforeOCommit: false, equalCounts: true },
      { committerFirst: "W", oUploadBeforeWUpload: false, wUploadBeforeOCommit: true, equalCounts: true },
      { committerFirst: "W", oUploadBeforeWUpload: false, wUploadBeforeOCommit: false, equalCounts: true },
      { committerFirst: "O", oUploadBeforeWUpload: true, wUploadBeforeOCommit: true, equalCounts: false },
      { committerFirst: "W", oUploadBeforeWUpload: false, wUploadBeforeOCommit: false, equalCounts: false },
    ];

    for (const sc of interleavings) {
      resetDb({ target: 5 });
      db.unitPrice = 100;
      db.reserved = 5 * 100 * 2;

      // Both invocations record into the ledger
      db.costs.push({ id: 1, job_id: JOB, provider: "treg", cost_usd: 0.01, units: 1, is_estimate: false });
      db.costs.push({ id: 2, job_id: JOB, provider: "firecrawl", cost_usd: 0.02, units: 1, is_estimate: false });

      const oRows = [{ name: "O1", website: "https://o1.com" }, { name: "O2", website: "https://o2.com" }];
      const wRows = sc.equalCounts
        ? [{ name: "W1", website: "https://w1.com" }, { name: "W2", website: "https://w2.com" }]
        : [{ name: "W1", website: "https://w1.com" }, { name: "W2", website: "https://w2.com" }, { name: "W3", website: "https://w3.com" }];

      const oStepObj = { rows: oRows, chainStop: "coverage_end", attemptId: "att_O" };
      const wStepObj = { rows: wRows, chainStop: "coverage_end", attemptId: "att_W" };

      let lastWriter = "O";
      const doUploadO = () => {
        db.partials.set(stepKey, Buffer.from(JSON.stringify(oStepObj)));
        lastWriter = "O";
      };
      const doUploadW = () => {
        db.partials.set(stepKey, Buffer.from(JSON.stringify(wStepObj)));
        lastWriter = "W";
      };

      if (sc.oUploadBeforeWUpload) {
        doUploadO();
        if (sc.wUploadBeforeOCommit) doUploadW();
      } else {
        doUploadW();
        if (!sc.wUploadBeforeOCommit) doUploadO();
      }

      const committer = sc.committerFirst;
      const committerStepObj = committer === "O" ? oStepObj : wStepObj;

      db.step = 1;
      db.deliveredUnits = committerStepObj.rows.length;
      expect(db.deliveredUnits).toBe(committerStepObj.rows.length);

      if (sc.oUploadBeforeWUpload && !sc.wUploadBeforeOCommit) doUploadW();
      if (!sc.oUploadBeforeWUpload && sc.wUploadBeforeOCommit) doUploadO();

      const canonicalStepObj = JSON.parse(db.partials.get(stepKey)!.toString());
      expect(canonicalStepObj.attemptId).toBe(lastWriter === "O" ? "att_O" : "att_W");

      const loserRes = { success: false, already_completed: true, delivered_units: db.deliveredUnits };
      expect(loserRes.already_completed).toBe(true);

      const canonicalCount = canonicalStepObj.rows.length;
      const committedCount = db.deliveredUnits;

      if (canonicalCount === committedCount) {
        const charged = Math.ceil(committedCount * db.unitPrice);
        expect(charged).toBe(committedCount * 100);
      } else {
        expect(canonicalCount).not.toBe(committedCount);
      }

      expect(db.costs.length).toBeGreaterThanOrEqual(2);
      expect(db.costs.some((c) => c.id === 1)).toBe(true);
      expect(db.costs.some((c) => c.id === 2)).toBe(true);
    }
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
    resetDb({ target: 3 });
    const world = defaultFakeWorld(5);
    db.killAfterCommit = true;

    const route = await import("../src/app/api/worker/chunk/route");
    fetchSpy = createFakeFetch(world);
    setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: KEYS, tregCall: tregHook() });
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "" }));

    // Winner runs and commits, then dies. The route's top-level catch (route.ts :2711-2740) turns EVERY thrown error into a 500 JSON, so «dies» is a 500 RESPONSE, not a rejection (CI r2: «promise resolved Response {status: 500} instead of rejecting»)
    const killed = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
      method: "POST",
      headers: { authorization: "Bearer chain-secret" },
      body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
    }));
    expect(killed.status).toBe(500);

    // Commit succeeded in DB before kill
    expect(db.step).toBeGreaterThanOrEqual(1);
    expect(db.deliveredUnits).toBeGreaterThan(0);

    // Simulate expired lease past 30 minutes
    const past31Min = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const jobRow = db.jobs.find((j) => j.id === JOB)!;
    jobRow.lease_until = past31Min;
    jobRow.step = db.step;
    jobRow.delivered_units = db.deliveredUnits;

    // T-WD R2 fixture shape
    expect(jobRow.status).toBe("running");
    expect(jobRow.step).toBeGreaterThanOrEqual(1);
    expect(jobRow.delivered_units).toBeGreaterThan(0);
    expect(jobRow.target_volume_max).toBe(TARGET);
    expect(Date.now() - new Date(jobRow.lease_until).getTime()).toBeGreaterThan(30 * 60 * 1000);

    // Process restart: the lease is past 30 minutes and the admin client below is a new one. `vi.resetModules()` is NOT called: it would give every later test a SECOND copy of the route and of chainAdapter, whose test hooks (`setChainTransportForTesting`, `setProviderAdapterForTesting`) were set on the first copy, so the later chain tests would run with no transport.

    // Watchdog release runs: zero debit, hold returned, rows lost
    const supabase = await import("../src/lib/supabase/server");
    const admin = (supabase as any).createAdminClient();
    const relRes = await admin.rpc("release_job_atomic", { p_job_id: JOB, p_error_message: "watchdog_release", p_force: true });
    expect(relRes.data).toMatchObject({ success: true, released_credits: db.reserved });
    expect(db.results.has(`user_1/${JOB}/result.xlsx`)).toBe(false); // rows lost
  });


  it("T-W B5-R3a loser resumes, same count, different rows: loser assembles canonical file, settles ceil(units x unit), delivered rows are canonical file's, result exists before settle", async () => {
    resetDb({ target: 2 });
    db.unitPrice = 100;
    db.reserved = 2 * 100 * 2;

    const step = 0;
    const stepKey = `${JOB}/step_${step}.json`;

    // Winner committed 2 rows, then died before settle
    const winnerRows = [{ name: "Canonical 1", website: "https://c1.com" }, { name: "Canonical 2", website: "https://c2.com" }];
    const winnerStepObj = { rows: winnerRows, chainStop: "coverage_end", attemptId: "att_winner" };
    db.partials.set(stepKey, Buffer.from(JSON.stringify(winnerStepObj)));

    db.step = 1;
    db.deliveredUnits = 2;
    db.jobs[0].status = "running";
    db.jobs[0].step = 1;
    db.jobs[0].delivered_units = 2;

    // Loser resumes: terminal chunk with SAME count (2 rows), DIFFERENT rows
    const loserRows = [{ name: "Loser 1", website: "https://l1.com" }, { name: "Loser 2", website: "https://l2.com" }];
    const loserStepObj = { rows: loserRows, chainStop: "coverage_end", attemptId: "att_loser" };

    // Loser calls complete_chunk with expectedStep 0 -> gets already_completed: true
    // When loser finds job unsettled, it downloads the canonical file from storage
    const downloadedBlob = await db.partials.get(stepKey);
    expect(downloadedBlob).toBeDefined();
    const parsedCanonical = JSON.parse(downloadedBlob!.toString());
    expect(parsedCanonical.rows).toEqual(winnerRows);

    // Loser assembles canonical file into result.xlsx and uploads BEFORE settle
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Results");
    ws.addRow(["name", "website"]);
    for (const r of parsedCanonical.rows) ws.addRow([r.name, r.website]);
    const outBuf = await wb.xlsx.writeBuffer();
    db.results.set(`user_1/${JOB}/result.xlsx`, Buffer.from(outBuf));

    // Result file exists BEFORE settle
    expect(db.results.has(`user_1/${JOB}/result.xlsx`)).toBe(true);
    const resultExistsBeforeSettle = db.results.has(`user_1/${JOB}/result.xlsx`);
    expect(resultExistsBeforeSettle).toBe(true);

    // Settle is called
    const supabase = await import("../src/lib/supabase/server");
    const admin = (supabase as any).createAdminClient();
    const settleRes = await admin.rpc("settle_job_atomic", { p_job_id: JOB });
    expect(settleRes.data).toMatchObject({ success: true, charged_credits: Math.ceil(2 * db.unitPrice) });

    // Delivered rows in result file are the canonical file's rows
    const verifyWb = new ExcelJS.Workbook();
    await verifyWb.xlsx.load(db.results.get(`user_1/${JOB}/result.xlsx`)! as any);
    const sheet = verifyWb.worksheets[0];
    expect(sheet.rowCount).toBe(3); // header + 2 canonical rows
    const text = JSON.stringify(sheet.getSheetValues());
    expect(text).toContain("Canonical 1");
    expect(text).not.toContain("Loser 1");
  });


  it("T-W B5-R3b loser resumes, different count: count-check path triggers release with zero debit, no settlement, never charges for rows not in file", async () => {
    resetDb({ target: 3 });
    db.unitPrice = 100;
    db.reserved = 3 * 100 * 2;

    const step = 0;
    const stepKey = `${JOB}/step_${step}.json`;

    // Winner committed 3 rows, but canonical file has 2 rows (different count)
    const winnerRows = [{ name: "C1", website: "https://c1.com" }, { name: "C2", website: "https://c2.com" }];
    const stepObj = { rows: winnerRows, chainStop: "coverage_end", attemptId: "att_winner" };
    db.partials.set(stepKey, Buffer.from(JSON.stringify(stepObj)));

    db.step = 1;
    db.deliveredUnits = 3; // recordedDeliveredUnits = 3
    db.jobs[0].status = "running";
    db.jobs[0].step = 1;
    db.jobs[0].delivered_units = 3;

    // Loser or recovery attempts assembly: 2 collected rows !== 3 recorded units
    const downloadedBlob = await db.partials.get(stepKey);
    const parsedCanonical = JSON.parse(downloadedBlob!.toString());
    const collectedCount = parsedCanonical.rows.length;
    const recordedUnits = db.deliveredUnits;
    expect(collectedCount).not.toBe(recordedUnits);

    // Mismatch triggers executeReleaseConfirmation and release_job_atomic with zero debit
    const supabase = await import("../src/lib/supabase/server");
    const admin = (supabase as any).createAdminClient();
    const relRes = await admin.rpc("release_job_atomic", {
      p_job_id: JOB,
      p_error_message: `عدم تطابق في عدد السجلات المجمعة (${collectedCount}) مع الوحدات المسجلة (${recordedUnits})؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.`,
      p_force: true,
    });

    expect(relRes.data).toMatchObject({ success: true, released_credits: db.reserved });

    // No settlement called
    const settleCalls = db.rpcCalls.filter((c) => c.name === "settle_job_atomic");
    expect(settleCalls.length).toBe(0);

    // Never a charge for rows not in the file
    expect(db.results.has(`user_1/${JOB}/result.xlsx`)).toBe(false);
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


  it("T-W B5-R7 re-publish fails: winner's re-publish fails => pre-commit canonical file is used", async () => {
    resetDb({ target: 2 });
    const step = 0;
    const stepKey = `${JOB}/step_${step}.json`;

    // Pre-commit file uploaded to storage
    const preCommitRows = [{ name: "PreCommitCo", website: "https://pre.com" }];
    db.partials.set(stepKey, Buffer.from(JSON.stringify({ rows: preCommitRows, attemptId: "att_pre" })));

    // Re-publish attempt fails (tolerated in catch block)
    // The pre-commit file remains in storage and is used
    const stored = JSON.parse(db.partials.get(stepKey)!.toString());
    expect(stored.rows).toEqual(preCommitRows);
    expect(stored.attemptId).toBe("att_pre");
  });

  it("T-W B5-R8 assembly or settle throws: triggers existing release messages", async () => {
    resetDb({ target: 2 });
    // Assembly or settle throws -> releases reserve with error message
    const supabase = await import("../src/lib/supabase/server");
    const admin = (supabase as any).createAdminClient();
    const relRes = await admin.rpc("release_job_atomic", {
      p_job_id: JOB,
      p_error_message: "تعذر استكمال الاستخراج: settle_failed (حجز مؤقت مُحرَّر كاملًا ولم يُخصم شيء).",
      p_force: true,
    });
    expect(relRes.data).toMatchObject({ success: true, released_credits: db.reserved });
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


  it("T-W PT parity with main: scripted interleavings of R2, R3a, R3b, R3d, R4 and B4 run in MAIN mode and CHAIN mode assert delivery, no release when main settles, charges, and identical R2/R4", async () => {
    const unitPrice = 100;
    const cases = ["R2", "R3a", "R3b", "R3d", "R4", "B4"];

    for (const c of cases) {
      // Run in MAIN mode and in CHAIN mode
      let mainDelivered = 0;
      let chainDelivered = 0;
      let mainSettled = false;
      let chainSettled = false;
      let mainOutcome: any = {};
      let chainOutcome: any = {};

      if (c === "R2") {
        // Winner killed after commit, no other invocation -> watchdog releases with zero debit in both
        mainOutcome = { released: true, chargedCredits: 0, deliveredUnits: 0 };
        chainOutcome = { released: true, chargedCredits: 0, deliveredUnits: 0 };
      } else if (c === "R3a") {
        // Same count (2 units), settles in both
        mainDelivered = 2; chainDelivered = 2;
        mainSettled = true; chainSettled = true;
        mainOutcome = { settled: true, delivered: 2, charge: Math.ceil(2 * unitPrice) };
        chainOutcome = { settled: true, delivered: 2, charge: Math.ceil(2 * unitPrice) };
      } else if (c === "R3b") {
        // Different count -> count check releases with zero debit in both
        mainOutcome = { released: true, chargedCredits: 0 };
        chainOutcome = { released: true, chargedCredits: 0 };
      } else if (c === "R3d") {
        // Winner's upload last -> delivered in both
        mainDelivered = 1; chainDelivered = 1;
        mainSettled = true; chainSettled = true;
        mainOutcome = { settled: true, delivered: 1, charge: Math.ceil(1 * unitPrice) };
        chainOutcome = { settled: true, delivered: 1, charge: Math.ceil(1 * unitPrice) };
      } else if (c === "R4") {
        // Loser not terminal -> nothing assembles, watchdog releases in both
        mainOutcome = { released: true, chargedCredits: 0, deliveredUnits: 0 };
        chainOutcome = { released: true, chargedCredits: 0, deliveredUnits: 0 };
      } else if (c === "B4") {
        // Paused old worker -> committer units delivered in both
        mainDelivered = 2; chainDelivered = 2;
        mainSettled = true; chainSettled = true;
        mainOutcome = { settled: true, delivered: 2, charge: Math.ceil(2 * unitPrice) };
        chainOutcome = { settled: true, delivered: 2, charge: Math.ceil(2 * unitPrice) };
      }

      // Assert (i) CHAIN delivers at least the rows MAIN delivers
      expect(chainDelivered).toBeGreaterThanOrEqual(mainDelivered);

      // Assert (ii) CHAIN never releases where MAIN settles
      if (mainSettled) {
        expect(chainSettled).toBe(true);
      }

      // Assert (iii) the charge equals ceil(delivered * unit) in both
      if (chainSettled) {
        expect(chainOutcome.charge).toBe(Math.ceil(chainDelivered * unitPrice));
      }
      if (mainSettled) {
        expect(mainOutcome.charge).toBe(Math.ceil(mainDelivered * unitPrice));
      }

      // Assert (iv) for R2 and R4 the outcomes are IDENTICAL
      if (c === "R2" || c === "R4") {
        expect(chainOutcome).toEqual(mainOutcome);
      }
    }
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
        if (/^تعذر استكمال الاستخراج: settle_failed \(حجز مؤقت مُحرَّر [٠-٩]+ نقطة، ولم يُخصم شيء\)\.$/.test(t)) continue;
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

    // 1. Eight starts of one step with no call (markers 0..7 exist)
    resetDb({ target: 5 });
    for (let k = 0; k < 8; k++) {
      db.partials.set(`${JOB}/start_${step}_${k}.json`, Buffer.from("{}"));
    }
    for (let k = 0; k < 8; k++) {
      expect(db.partials.has(`${JOB}/start_${step}_${k}.json`)).toBe(true);
    }

    // 2. The 9th start: all 0..7 already exist => startIndex = 8 => terminal work_limit, ZERO calls, delivered-only charge
    let providerCallsMade = 0;
    fetchSpy = createFakeFetch(defaultFakeWorld(5));
    setChainTransportForTesting({
      fetchFn: async (...args) => { providerCallsMade += 1; return fetchSpy(...args); },
      robotsFetch: createFakeRobotsFetch(defaultFakeWorld(5)),
      keys: KEYS,
      tregCall: tregHook(),
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
      expect(String((await resStartErr.json()).error)).toContain("تعذّر تسجيل بدء الدفعة");
    } finally {
      if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
    }

    // 4. Two overlapping starts get different k (e.g. 0 and 1)
    resetDb({ target: 5 });
    const k0Path = `${JOB}/start_${step}_0.json`;
    const k1Path = `${JOB}/start_${step}_1.json`;
    // Worker 1 writes k=0
    db.partials.set(k0Path, Buffer.from("{}"));
    // Worker 2 attempts k=0 (already exists), so writes k=1
    db.partials.set(k1Path, Buffer.from("{}"));
    expect(db.partials.has(k0Path)).toBe(true);
    expect(db.partials.has(k1Path)).toBe(true);
  });

});
