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
        db.step += 1; db.deliveredUnits = args.p_new_delivered_units; db.cursor = args.p_new_cursor;
        const job = db.jobs.find((row) => row.id === args.p_job_id);
        if (job) Object.assign(job, { current_cursor: db.cursor, delivered_units: db.deliveredUnits, status: "running" });
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
          upload: async (path: string, body: any) => { store.set(path, Buffer.isBuffer(body) ? body : Buffer.from(String(body))); return { data: { path }, error: null }; },
          download: async (path: string) => { const buf = store.get(path); return buf ? { data: new Blob([new Uint8Array(buf)]), error: null } : { data: null, error: { message: "not_found" } }; },
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

const JOB = jobIdForQuote("quote_chain_1");
const TARGET = 3;
const KEYS = { treg: "managed", firecrawl: "fc-test-key-123456", contextdev: "cx-test-key-123456" };

function resetDb(over: { target?: number } = {}) {
  const target = over.target ?? TARGET;
  db.jobs = [{ id: JOB, user_id: "user_1", status: "running", step: 0, current_cursor: null, delivered_units: 0, target_volume_max: target, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  db.quotes = [{ id: "quote_chain_1", user_id: "user_1", items: [{ capabilitySlug: "mp-business-contacts", endpointId: "mp.business.contacts", params: { routeCode: routeCodeOf("chain:contextdev>firecrawl"), requiredFields: ["work_email"], industry: "مقاولات", country: "مصر" }, targetVolumeMax: target, paginationStrategy: "cursor", unitCostUsd: 0.02, pricingUnit: "item" }], output_formats: ["xlsx"] }];
  db.settings = [{ key: "provider_limits", value: { dailyUsd: 0.8, firecrawlDailyUsd: 1, contextdevDailyUsd: 1 } }];
  db.costs = []; db.partials.clear(); db.results.clear(); db.rpcCalls = []; db.events = []; db.reserveDeniedFor = new Set();
  db.step = 0; db.cursor = null; db.deliveredUnits = 0; db.targetVolumeMax = target; db.unitPrice = 100; db.reserved = Math.ceil(target * 100 * 1.15); db.endpoint = "mp.business.contacts";
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
});
