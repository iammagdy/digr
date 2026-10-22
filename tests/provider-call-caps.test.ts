import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * 5. Excess provider calls. Replays the two production company-job shapes offline (page sizes, per-page matches and the
 * per-record billing are taken from provider_costs 411-433 and the jobs' progress events of 18 Oct 2026).
 */
const db = vi.hoisted(() => ({
  jobs: [] as any[], quotes: [] as any[],
  partials: new Map<string, Buffer>(), results: new Map<string, Buffer>(),
  rpcCalls: [] as Array<{ name: string; args: any }>, events: [] as any[],
  step: 0, cursor: null as string | null, deliveredUnits: 0, targetVolumeMax: 2, unitPrice: 2, reserved: 6,
}));

function builder(rows: () => any[]) {
  const filters: Array<[string, unknown]> = [];
  const apply = () => rows().filter((row) => filters.every(([col, val]) => row[col] === val));
  const api: any = {
    select: () => api, eq: (c: string, v: unknown) => { filters.push([c, v]); return api; },
    in: () => api, or: () => api, not: () => api, order: () => api, limit: () => api,
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
      if (name === "claim_job_chunk") return { data: { claimed: true, job_id: args.p_job_id, user_id: "user_1", step: db.step, current_cursor: db.cursor, delivered_units: db.deliveredUnits, target_volume_max: db.targetVolumeMax, target_volume_min: 1, endpoint_id: "icypeas.companies.search", unit_price: db.unitPrice }, error: null };
      if (name === "reserve_provider_spend_atomic") return { data: { allowed: true, cost_id: 11 }, error: null };
      if (name === "commit_provider_spend") return { data: { success: true }, error: null };
      if (name === "complete_chunk") {
        db.step += 1; db.deliveredUnits = args.p_new_delivered_units; db.cursor = args.p_new_cursor;
        const job = db.jobs.find((row) => row.id === args.p_job_id);
        if (job) Object.assign(job, { current_cursor: db.cursor, delivered_units: db.deliveredUnits, status: "running" });
        return { data: { success: true, delivered_units: db.deliveredUnits }, error: null };
      }
      if (name === "settle_job_atomic") return { data: { success: true, charged_credits: Math.min(Math.ceil(db.deliveredUnits * db.unitPrice), db.reserved), refunded_credits: 0 }, error: null };
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
      if (table === "job_events" || table === "notifications" || table === "artifact_versions") {
        const base = builder(() => (table === "job_events" ? db.events : []));
        return { ...base, insert: async (row: any) => { if (table === "job_events") db.events.push(row); return { data: row, error: null }; }, upsert: async (row: any) => ({ data: row, error: null }) };
      }
      return builder(() => []);
    },
  })),
}));
vi.mock("../src/lib/server/sendPlatformEmail", () => ({ sendPlatformEmail: vi.fn(async () => undefined), getRecipient: vi.fn(async () => null) }));
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null), searchCatalog: vi.fn(async () => []),
}));

import { jobIdForQuote } from "../src/lib/server/retryReuse";
import { resolveJobExecutionSpec } from "../src/lib/server/jobExecutionSpec";
import { setProviderAdapterForTesting } from "../src/lib/server/tregAdapter";
import {
  ABSOLUTE_MAX_PAGES, SMALL_JOB_MAX_PAGES, estimatePageProviderUsd, evaluateProviderCallCap, isSmallJob, maxPagesForJob, smallJobPageSize, worstCaseJobProviderUsd,
} from "../src/lib/server/providerCallCaps";

const JOB = jobIdForQuote("quote_caps");
const UNIT_COST = 0.00038; // provider price per requested record, as billed in provider_costs

const egyptMatch = (n: number) => ({ id: `eg_${n}`, company_name: `Egypt Electric ${n}`, industry: "Utilities", description: "Electricity and power distribution grid operator", location: "Cairo, Egypt", website: `https://eg-electric-${n}.example.com` });
const foreign = (n: number) => ({ id: `de_${n}`, company_name: `Berlin Gmbh ${n}`, industry: "Software", description: "Software services", location: "Berlin, Germany", website: `https://de-${n}.example.de` });

function quote(target: number, pageSize: number) {
  return {
    id: "quote_caps", user_id: "user_1", output_formats: ["xlsx"],
    items: [{
      capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", targetVolumeMax: target, paginationStrategy: "cursor",
      params: { country: "Egypt", industry: "الكهرباء والطاقة الكهربائية", query: { location: { include: ["Egypt"] } }, pagination: { size: pageSize } },
    }],
  };
}

function reset(target: number, planPageSize: number) {
  db.jobs = [{ id: JOB, user_id: "user_1", status: "running", current_cursor: null, target_volume_max: target, delivered_units: 0, created_at: new Date().toISOString() }];
  db.quotes = [quote(target, planPageSize)];
  db.partials.clear(); db.results.clear(); db.rpcCalls = []; db.events = [];
  db.step = 0; db.cursor = null; db.deliveredUnits = 0; db.targetVolumeMax = target; db.unitPrice = 2; db.reserved = target * 3;
}

describe("provider call caps: the rules", () => {
  it("small jobs get at most 3 pages and a page sized from the wanted count, never 2 rows per page", () => {
    expect(isSmallJob(2)).toBe(true);
    expect(isSmallJob(10)).toBe(true);
    expect(isSmallJob(11)).toBe(false);
    expect(SMALL_JOB_MAX_PAGES).toBe(3);
    expect(maxPagesForJob(2, 6)).toBe(3);
    expect(maxPagesForJob(10, 10)).toBe(3);
    expect([1, 2, 3, 4, 10].map(smallJobPageSize)).toEqual([5, 6, 9, 10, 10]);
  });

  it("larger jobs may use up to 6x the pages they would need, never above the hard ceiling", () => {
    expect(maxPagesForJob(100, 50, "feed")).toBe(12);
    expect(maxPagesForJob(500, 50, "feed")).toBe(60);
    expect(maxPagesForJob(600, 10, "feed")).toBe(300);
    expect(maxPagesForJob(100000, 10, "feed")).toBe(ABSOLUTE_MAX_PAGES);
    expect(ABSOLUTE_MAX_PAGES).toBe(300);
  });

  it("stops after 2 (small job) or 3 (large job) consecutive pages with no new matching record", () => {
    expect(evaluateProviderCallCap({ pagesDone: 1, acceptedThisPage: 0, priorBatchUnits: [], targetMax: 2, pageSize: 6 })).toBeNull();
    expect(evaluateProviderCallCap({ pagesDone: 2, acceptedThisPage: 0, priorBatchUnits: [0], targetMax: 2, pageSize: 6 })).toBe("empty_pages");
    expect(evaluateProviderCallCap({ pagesDone: 2, acceptedThisPage: 0, priorBatchUnits: [1], targetMax: 2, pageSize: 6 })).toBeNull();
    expect(evaluateProviderCallCap({ pagesDone: 3, acceptedThisPage: 1, priorBatchUnits: [0, 0], targetMax: 2, pageSize: 6 })).toBe("page_cap");
    expect(evaluateProviderCallCap({ pagesDone: 3, acceptedThisPage: 0, priorBatchUnits: [0, 0], targetMax: 100, pageSize: 50 })).toBe("empty_pages");
    expect(evaluateProviderCallCap({ pagesDone: 2, acceptedThisPage: 0, priorBatchUnits: [0], targetMax: 100, pageSize: 50 })).toBeNull();
    // an unreadable earlier page is never counted as empty
    expect(evaluateProviderCallCap({ pagesDone: 2, acceptedThisPage: 0, priorBatchUnits: [null], targetMax: 2, pageSize: 6 })).toBeNull();
  });

  it("the spend estimate is the whole page for a directory search, and the worst case of a job is known up front", () => {
    expect(estimatePageProviderUsd(UNIT_COST, 10, true)).toBeCloseTo(0.0038, 6);
    expect(estimatePageProviderUsd(UNIT_COST, 10, false)).toBeCloseTo(0.00038, 6);
    // 2 wanted: 3 pages x 6 records x 0.00038 = 0.00684 worst case (was 19 pages x 2 = 0.01444 and unbounded)
    expect(worstCaseJobProviderUsd(UNIT_COST, 2, smallJobPageSize(2))).toBeCloseTo(0.00684, 6);
  });
});

describe("provider call caps: the production job shapes replayed through the worker", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "caps-test-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development";
  });
  afterEach(() => {
    setProviderAdapterForTesting(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
  });

  /** One worker call per page, the way the chain runs it; stops when the worker says done. */
  async function runJob(pageRows: (page: number, size: number) => any[], maxCalls = 40) {
    const route = await import("../src/app/api/worker/chunk/route");
    const asked: number[] = [];
    let calls = 0;
    setProviderAdapterForTesting(async (input) => {
      calls += 1;
      asked.push(input.pageSize);
      const rows = pageRows(calls, input.pageSize);
      return { ok: true, httpStatus: 200, rows, nextCursor: `cursor_${calls}`, costUsd: rows.length * UNIT_COST, costMicro: Math.round(rows.length * UNIT_COST * 1e6), tregCallId: `call_${calls}` };
    });
    let last: any = null;
    for (let i = 0; i < maxCalls; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        method: "POST", headers: { authorization: "Bearer caps-test-secret" },
        body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
      }));
      last = { status: res.status, json: await res.json() };
      if (last.json.done === true || last.json.released === true || last.status >= 400) break;
    }
    return { calls, asked, last };
  }

  it("shape 1: 2 wanted, pages almost never match (17 of 19 pages empty in production) -> 2 calls, not 19; nothing charged", async () => {
    reset(2, 2);
    const spec = await resolveJobExecutionSpec((await import("../src/lib/supabase/server")).createAdminClient(), JOB, "user_1", "icypeas.companies.search", 2);
    expect(spec.pageSize).toBe(6); // not the 2 the plan carried
    const { calls, asked, last } = await runJob((page, size) => Array.from({ length: size }, (_, i) => foreign(page * 100 + i)));
    expect(calls).toBe(2);
    expect(asked).toEqual([6, 6]);
    expect(last.json.released).toBe(true);
    expect(db.rpcCalls.filter((c) => c.name === "reserve_provider_spend_atomic")).toHaveLength(2);
    expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
    // provider spend: 12 records requested (0.00456 USD) instead of the measured 0.01444 USD
    const spent = db.rpcCalls.filter((c) => c.name === "commit_provider_spend").length;
    expect(spent).toBe(2);
    expect(calls * 6 * UNIT_COST).toBeLessThan(0.0145 / 3);
  });

  it("shape 1 with a late match: a match on page 2 keeps going, and the job never exceeds 3 pages; delivered rows are charged", async () => {
    reset(2, 2);
    const { calls, last } = await runJob((page, size) => (page === 2 ? [egyptMatch(1), ...Array.from({ length: size - 1 }, (_, i) => foreign(200 + i))] : Array.from({ length: size }, (_, i) => foreign(page * 100 + i))));
    expect(calls).toBe(3);
    expect(last.json.done).toBe(true);
    expect(last.json.deliveredUnits).toBe(1);
    const settle = db.rpcCalls.find((c) => c.name === "settle_job_atomic");
    expect(settle).toBeTruthy();
    expect(db.events.some((e) => /الحد الأقصى لعدد الصفحات/.test(String(e.message)))).toBe(true);
  });

  it("shape 2: 3 wanted, 2 pages of full candidates deliver 3 -> still 2 calls, unchanged behaviour when matches arrive", async () => {
    reset(3, 3);
    const { calls, asked, last } = await runJob((page, size) => {
      const matches = page === 1 ? [egyptMatch(1), egyptMatch(2)] : [egyptMatch(3)];
      return [...matches, ...Array.from({ length: size - matches.length }, (_, i) => foreign(page * 100 + i))];
    });
    expect(calls).toBe(2);
    expect(asked).toEqual([9, 9]);
    expect(last.json.done).toBe(true);
    expect(last.json.deliveredUnits).toBe(3);
  });

  it("the spend gate is asked for the whole page, not only the records still wanted", async () => {
    reset(3, 3);
    await runJob((page, size) => [egyptMatch(page * 10 + 1), egyptMatch(page * 10 + 2), egyptMatch(page * 10 + 3), ...Array.from({ length: size - 3 }, (_, i) => foreign(page * 100 + i))]);
    const reserve = db.rpcCalls.find((c) => c.name === "reserve_provider_spend_atomic")!;
    const spec = await resolveJobExecutionSpec((await import("../src/lib/supabase/server")).createAdminClient(), JOB, "user_1", "icypeas.companies.search", 2);
    expect(reserve.args.p_estimated_cost_usd).toBeCloseTo(spec.pageSize * spec.unitCostUsd, 5);
    expect(reserve.args.p_estimated_cost_usd).toBeGreaterThan(3 * spec.unitCostUsd);
  });

  it("customer prices and caps are untouched by this change", async () => {
    const { readFileSync } = await import("node:fs");
    const pricing = readFileSync("src/lib/calculatorPricing.ts", "utf8");
    expect(pricing).toContain("DEFAULT_PROVIDER_DAILY_SPEND_CAP_USD = 0.80");
    // the job cap is one shared constant (600); providerSpend reads it from there
    expect(readFileSync("src/functions/shared/providerSpend.ts", "utf8")).toContain("DEFAULT_JOB_POINTS_CAP = JOB_MAX_POINTS_CAP");
    expect(readFileSync("src/lib/jobPointsCap.ts", "utf8")).toContain("JOB_MAX_POINTS_CAP = 600");
  });
});
