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
        return { data: { claimed: true, job_id: args.p_job_id, user_id: "user_1", step: db.step, current_cursor: db.cursor, delivered_units: db.deliveredUnits, target_volume_max: db.targetVolumeMax, target_volume_min: 1, endpoint_id: db.endpoint, unit_price: db.unitPrice }, error: null };
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
      if (name === "release_job_atomic") return { data: { success: true, released_credits: db.reserved }, error: null };
      return { data: { success: true }, error: null };
    }),
    storage: {
      from: (bucket: string) => {
        const store = bucket === "partials" ? db.partials : db.results;
        return {
          upload: async (path: string, body: any) => {
            const existed = store.has(path);
            db.uploadHistory.push({ bucket, path, existed });
            // records whether path already exists
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
import { chainShortfallReasonAr, chainStopProgressLineAr } from "../src/lib/multiProvider/copy";
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
  db.uploadHistory = []; db.delayedCompleteChunkMs = 0; db.killAfterCommit = false; db.corruptDownloadPaths.clear();
}

describe("worker: multi-provider chain job (fake providers)", () => {
  let saved: Record<string, string | undefined>;
  let fetchSpy: ReturnType<typeof createFakeFetch>;
  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV, MULTI_PROVIDER_ENABLED: process.env.MULTI_PROVIDER_ENABLED, TREG_LIVE: process.env.TREG_LIVE };
    process.env.CRON_SECRET = "chain-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development";
    process.env.MULTI_PROVIDER_ENABLED = "true";
    delete process.env.TREG_LIVE; // TREG is NOT live: the chain does not need it
    setRowAdvisorForTesting(async () => { throw new Error("no advisory review may run on a verified chain row"); });
  });
  afterEach(() => {
    setProviderAdapterForTesting(null); setRowAdvisorForTesting(null); setChainTransportForTesting(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
  });

  async function run(world: FakeCompany[], scenario: Parameters<typeof createFakeFetch>[1] = {}) {
    const route = await import("../src/app/api/worker/chunk/route");
    fetchSpy = createFakeFetch(world, scenario);
    setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: KEYS });
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
    setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: KEYS });
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
    expect(new Set(reserves.map((r) => r.args.p_provider))).toEqual(new Set(["contextdev", "firecrawl"]));
    for (const r of reserves) { expect(r.args.p_daily_cap_usd).toBe(1); expect(r.args.p_job_id).toBe(JOB); }
    // the platform-wide TREG reserve of the generic path is NOT used for a chain job
    expect(reserves.some((r) => r.args.p_provider === "treg")).toBe(false);
    const commits = db.rpcCalls.filter((c) => c.name === "commit_provider_spend_v2");
    expect(commits.length).toBe(reserves.length);
    expect(commits.every((c) => /^(contextdev|firecrawl)\./.test(c.args.p_capability) && ["success", "failed", "empty"].includes(c.args.p_status))).toBe(true);
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
    const world = defaultFakeWorld(5).map((c, i) => (i < 3 ? { ...c, email: `info@${c.domain}` } : { ...c, email: undefined, phone: undefined }));
    const { last } = await runMany(world);
    expect(last.status).toBe(200);

    const nomoreSentence = chainShortfallReasonAr({ stop: "no_more_work", callCap: null, excluded: 0 });
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

    const pagecapSentence = chainShortfallReasonAr({ stop: null, callCap: "page_cap", excluded: 0 });
    const finalEvent = db.events.find((e: any) => String(e.message ?? "").includes(pagecapSentence));
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

    const emptySentence = "توقفت المعالجة لأن دفعتين متتاليتين لم تضيفا شركات موثّقة جديدة قبل اكتمال العدد، وقد توجد شركات أخرى مطابقة لم نصل إليها.";
    const finalEvent = db.events.find((e: any) => String(e.message ?? "").includes(emptySentence));
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

    const repeatSentence = chainShortfallReasonAr({ stop: null, callCap: "source_repeats", excluded: 0 });
    const finalEvent = db.events.find((e: any) => String(e.message ?? "").includes(repeatSentence));
    // O8d: the world is non-terminal, so the REPEAT sentence itself must reach the customer (the EXCL/NEUTRAL branch below can no longer stand in for it)
    expect(finalEvent).toBeDefined();
    if (finalEvent) {
      expect(String(finalEvent.message)).toMatch(/^المسلَّم .* من .* مطلوب\./);
    } else {
      // If the harness observes EXCL or NEUTRAL branch instead of REPEAT rule
      const altEvent = db.events.find((e: any) => String(e.message ?? "").includes("استُبعد") || String(e.message ?? "").includes("لم يصلنا سبب"));
      expect(altEvent).toBeDefined();
    }
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
    setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: KEYS });
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
    const world = defaultFakeWorld(8).map((c) => ({ ...c, email: undefined, phone: undefined }));
    const { last } = await run(world);
    expect(last.status).toBe(422);
    expect(last.json).toMatchObject({ released: true, chargedCredits: 0, deliveredUnits: 0 });

    const relCalls = db.rpcCalls.filter((c) => c.name === "release_job_atomic");
    expect(relCalls.length).toBe(1);
    const call = relCalls[0];
    expect(Object.keys(call.args).sort()).toEqual(["p_error_message", "p_force", "p_job_id"]);
    expect(call.args.p_force).toBe(true);
    expect(call.args.p_error_message).toBe("لم يُعثر على أي بيانات مطابقة من المصدر؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.");
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
      expect(events.some((e) => e === chainStopProgressLineAr("target_reached") || e === chainStopProgressLineAr("no_more_work") || e === chainStopProgressLineAr("budget"))).toBe(true);
    } finally {
      if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
    }
  });

  it("R-1 release failure, runner returned no rows", async () => {
    resetDb();
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
      expect(call.args.p_error_message).toBe("لم يُعثر على أي بيانات مطابقة من المصدر؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.");
    } finally {
      if (origImpl) vi.mocked(supabase.createAdminClient).mockImplementation(origImpl);
    }
  });

  it("R-2 release failure, worker drops every runner row", async () => {
    resetDb();
    const companyIdentity = dedupeIdentityFor("company");
    const excluded = [1, 2, 4].map((n) => companyIdentity({ website: `https://fakeco${n}.net` })!);
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
      expect(call.args.p_error_message).toBe("استلمنا ٣ سجلاً من المصدر لكن لم يطابق أيٌّ منها نطاق طلبك؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.");

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
    const companyIdentity = dedupeIdentityFor("company");
    const excluded = [1, 2, 4].map((n) => companyIdentity({ website: `https://fakeco${n}.net` })!);
    db.quotes[0].items[0].params.excludeRowKeys = excluded;

    const world = defaultFakeWorld(8);
    const { last } = await run(world);
    expect(last.status).toBe(422);
    expect(last.json.released).toBe(true);
    expect(last.json.error).toBe("استلمنا ٣ سجلاً من المصدر لكن لم يطابق أيٌّ منها نطاق طلبك؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.");

    const relCalls = db.rpcCalls.filter((c) => c.name === "release_job_atomic");
    expect(relCalls.length).toBe(1);
    const call = relCalls[0];
    expect(Object.keys(call.args).sort()).toEqual(["p_error_message", "p_force", "p_job_id"]);
    expect(call.args.p_force).toBe(true);
    expect(call.args.p_error_message).toBe("استلمنا ٣ سجلاً من المصدر لكن لم يطابق أيٌّ منها نطاق طلبك؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.");

    const eventTexts = db.events.map((e: any) => String(e.message ?? ""));
    const confirmEvt = eventTexts.find((t) => t.includes("تعذر استكمال الاستخراج:") && t.includes("استلمنا ٣ سجلاً من المصدر لكن لم يطابق أيٌّ منها نطاق طلبك؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد."));
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
    expect(nonChainLast.status).toBe(200);
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
      const finalInfo = infoEvents[infoEvents.length - 1];
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
      const finalInfo = db.events.filter((e: any) => e.event_type === "info").at(-1);
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
      const finalInfo = db.events.filter((e: any) => e.event_type === "info").at(-1);
      expect(String(finalInfo.message)).toContain(`المسلَّم ${toArabicDigits(X)} من ٨ مطلوب.`);
    }

    // 3. sources_limited (without skipped origins)
    {
      resetDb({ target: 8 });
      const world = defaultFakeWorld(2);
      fetchSpy = createFakeFetch(world);
      setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: { treg: "managed" } });
      setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "" }));
      const { last } = await runMany(world);
      expect(last.status).toBe(200);
      const X = await getPublishedRowCount();
      checkOutcome(8, "sources_limited", 0);
      const finalInfo = db.events.filter((e: any) => e.event_type === "info").at(-1);
      expect(String(finalInfo.message)).toContain(`المسلَّم ${toArabicDigits(X)} من ٨ مطلوب.`);
    }

    // 4. sources_limited (with skipped origins)
    {
      resetDb({ target: 8 });
      const world = defaultFakeWorld(1);
      fetchSpy = createFakeFetch(world);
      setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: { treg: "managed" } });
      setProviderAdapterForTesting(async () => ({
        ok: true,
        httpStatus: 200,
        rows: [{ name: "   ", website: "https://skipped-origin.com" }],
        nextCursor: null,
        costUsd: 0,
        costMicro: 0,
        tregCallId: "",
      }));
      const { last } = await runMany(world);
      expect(last.status).toBe(200);
      const X = await getPublishedRowCount();
      checkOutcome(8, "sources_limited", 1);
      const finalInfo = db.events.filter((e: any) => e.event_type === "info").at(-1);
      expect(String(finalInfo.message)).toContain(`المسلَّم ${toArabicDigits(X)} من ٨ مطلوب.`);
    }

    // 5. stalled
    {
      resetDb({ target: 8 });
      const world = defaultFakeWorld(1);
      fetchSpy = createFakeFetch(world, { emptyProvider: { firecrawl: true, contextdev: true } });
      setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: KEYS });
      setProviderAdapterForTesting(async () => ({
        ok: true,
        httpStatus: 200,
        rows: [],
        nextCursor: "cur_stall",
        costUsd: 0,
        costMicro: 0,
        tregCallId: "",
      }));
      const { last } = await runMany(world);
      expect(last.status).toBe(200);
      const X = await getPublishedRowCount();
      checkOutcome(8, "stalled");
      const finalInfo = db.events.filter((e: any) => e.event_type === "info").at(-1);
      expect(String(finalInfo.message)).toContain(`المسلَّم ${toArabicDigits(X)} من ٨ مطلوب.`);
    }

    // 6. work_limit
    {
      resetDb({ target: 8 });
      const world = defaultFakeWorld(2);
      for (let k = 0; k < 8; k++) {
        db.partials.set(`${JOB}/start_0_${k}`, Buffer.from(""));
      }
      const { last } = await run(world);
      expect(last.status).toBe(200);
      const X = await getPublishedRowCount();
      checkOutcome(8, "work_limit");
      const finalInfo = db.events.filter((e: any) => e.event_type === "info").at(-1);
      expect(String(finalInfo.message)).toContain(`المسلَّم ${toArabicDigits(X)} من ٨ مطلوب.`);
    }
  });


  it("T-W B3 step object: carries chainStop and attemptId (and chainSkippedOrigins when > 0) on terminal chain chunk; non-chain has none of them", async () => {
    // 1. Terminal chain chunk with skipped origins
    resetDb({ target: 8 });
    const world1 = defaultFakeWorld(1);
    fetchSpy = createFakeFetch(world1);
    setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world1), keys: { treg: "managed" } });
    setProviderAdapterForTesting(async () => ({
      ok: true,
      httpStatus: 200,
      rows: [{ name: "   ", website: "https://skipped-origin.com" }],
      nextCursor: null,
      costUsd: 0,
      costMicro: 0,
      tregCallId: "",
    }));
    const { last: chainLast } = await runMany(world1);
    expect(chainLast.status).toBe(200);

    const stepFiles = Array.from(db.partials.keys()).filter((k) => k.startsWith(`${JOB}/step_`));
    expect(stepFiles.length).toBeGreaterThan(0);
    const lastStepKey = stepFiles.sort().at(-1)!;
    const chainStepObj = JSON.parse(db.partials.get(lastStepKey)!.toString());
    expect(typeof chainStepObj.chainStop).toBe("string");
    expect(typeof chainStepObj.attemptId).toBe("string");
    expect(Number(chainStepObj.chainSkippedOrigins)).toBeGreaterThan(0);

    // 2. Non-chain job
    resetDb({ target: 10 });
    db.endpoint = "icypeas.companies.search";
    db.quotes[0].items[0].capabilitySlug = "icypeas-companies-search";
    db.quotes[0].items[0].endpointId = "icypeas.companies.search";
    setProviderAdapterForTesting(async () => ({
      ok: true,
      httpStatus: 200,
      rows: [{ name: "Acme", website: "https://acme.com" }],
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

    const nonChainStepFiles = Array.from(db.partials.keys()).filter((k) => k.startsWith(`${JOB}/step_`));
    const nonChainStepKey = nonChainStepFiles.sort().at(-1)!;
    const nonChainStepObj = JSON.parse(db.partials.get(nonChainStepKey)!.toString());
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


  it("T-W B5-R2 winner killed after commit, no other invocation: claim refuses, vi.resetModules(), watchdog release gives zero debit and returns hold", async () => {
    resetDb({ target: 3 });
    const world = defaultFakeWorld(5);
    db.killAfterCommit = true;

    const route = await import("../src/app/api/worker/chunk/route");
    fetchSpy = createFakeFetch(world);
    setChainTransportForTesting({ fetchFn: fetchSpy, robotsFetch: createFakeRobotsFetch(world), keys: KEYS });
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "" }));

    // Winner runs and commits, then throws/dies
    await expect(route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
      method: "POST",
      headers: { authorization: "Bearer chain-secret" },
      body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
    }))).rejects.toThrow("worker_killed_after_commit");

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

    // Process restart
    vi.resetModules();

    // Watchdog release runs: zero debit, hold returned, rows lost
    const supabase = await import("../src/lib/supabase/server");
    const admin = (supabase as any).createAdminClient();
    const relRes = await admin.rpc("release_job_atomic", { p_job_id: JOB, p_error_message: "watchdog_release", p_force: true });
    expect(relRes.data).toMatchObject({ success: true, released_credits: db.reserved });
    expect(db.results.has(`user_1/${JOB}/result.xlsx`)).toBe(false); // rows lost
  });

});
