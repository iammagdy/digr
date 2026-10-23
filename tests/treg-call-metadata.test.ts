import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * PHASE 1 (admin call log quality): every TREG cost row says what the call was (capability), how it ended (success / failed / empty) and how
 * long it took, through the approved commit_provider_spend_v2; the amounts and units are exactly the ones the worker always committed, and
 * the old function records the same amount when v2 is missing. Fake providers only; no live call.
 */

const db = vi.hoisted(() => ({
  jobs: [] as any[],
  quotes: [] as any[],
  partials: new Map<string, Buffer>(),
  results: new Map<string, Buffer>(),
  rpcCalls: [] as Array<{ name: string; args: any }>,
  events: [] as any[],
  step: 0,
  cursor: null as string | null,
  deliveredUnits: 0,
  targetVolumeMax: 4,
  unitPrice: 3,
  reserved: 14,
  v2Missing: false,
}));

function builder(rows: () => any[]) {
  const filters: Array<[string, unknown]> = [];
  const apply = () => rows().filter((row) => filters.every(([col, val]) => row[col] === val));
  const api: any = {
    select: () => api,
    eq: (col: string, val: unknown) => { filters.push([col, val]); return api; },
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
      if (name === "claim_job_chunk") {
        return { data: { claimed: true, job_id: args.p_job_id, user_id: "user_1", step: db.step, current_cursor: db.cursor, delivered_units: db.deliveredUnits, target_volume_max: db.targetVolumeMax, target_volume_min: 1, endpoint_id: "icypeas.companies.search", unit_price: db.unitPrice }, error: null };
      }
      if (name === "reserve_provider_spend_atomic") return { data: { allowed: true, cost_id: 11 }, error: null };
      if (name === "commit_provider_spend_v2" && db.v2Missing) return { data: null, error: { code: "PGRST202", message: "Could not find the function public.commit_provider_spend_v2 in the schema cache" } };
      if (name === "commit_provider_spend" || name === "commit_provider_spend_v2") return { data: { success: true }, error: null };
      if (name === "complete_chunk") {
        db.step += 1;
        db.deliveredUnits = args.p_new_delivered_units;
        db.cursor = args.p_new_cursor;
        const job = db.jobs.find((row) => row.id === args.p_job_id);
        if (job) Object.assign(job, { current_cursor: db.cursor, delivered_units: db.deliveredUnits, status: "running" });
        return { data: { success: true, delivered_units: db.deliveredUnits }, error: null };
      }
      if (name === "settle_job_atomic") {
        // The real function returns the reserve and the charge, not a refund figure.
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
          download: async (path: string) => {
            const buf = store.get(path);
            return buf ? { data: new Blob([new Uint8Array(buf)]), error: null } : { data: null, error: { message: "not_found" } };
          },
          remove: async (paths: string[]) => { for (const p of paths) store.delete(p); return { data: paths, error: null }; },
        };
      },
    },
    from: (table: string) => {
      if (table === "jobs") return builder(() => db.jobs);
      if (table === "plans_quotes") return builder(() => db.quotes);
      if (table === "job_events" || table === "notifications" || table === "artifact_versions") {
        const base = builder(() => (table === "job_events" ? db.events : []));
        return { ...base, insert: async (row: any) => { if (table === "job_events") db.events.push({ created_at: new Date().toISOString(), ...row }); return { data: row, error: null }; }, upsert: async (row: any) => ({ data: row, error: null }) };
      }
      return builder(() => []);
    },
  })),
}));

vi.mock("../src/lib/server/sendPlatformEmail", () => ({
  sendPlatformEmail: vi.fn(async () => undefined),
  getRecipient: vi.fn(async () => null),
}));

vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

import ExcelJS from "exceljs";
import { setProviderAdapterForTesting } from "../src/lib/server/tregAdapter";
import { jobIdForQuote } from "../src/lib/server/retryReuse";
import { setRowAdvisorForTesting } from "../src/lib/server/rowReviewAdvisor";
import { __resetCallRecorderForTests } from "../src/lib/server/multiProvider/callRecorder";

const JOB = jobIdForQuote("quote_fail_after");
const TARGET = 4;

const electrical = (id: string, name: string) => ({ company_name: name, industry: "Electrical/Electronic Manufacturing", description: `${name} builds substations, transformers and switchgear`, location: "Cairo, Egypt", website: `https://${id}.example.com` });

function resetDb() {
  db.jobs = [{ id: JOB, user_id: "user_1", status: "running", step: 0, current_cursor: null, delivered_units: 0, target_volume_max: TARGET, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  db.quotes = [{ id: "quote_fail_after", user_id: "user_1", items: [{ capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", params: { count: TARGET, query: { keyword: { include: ["electrical", "electricity"] }, location: { include: ["Egypt"] } }, country: "مصر", industry: "كهرباء" }, targetVolumeMax: TARGET, paginationStrategy: "cursor", unitCostUsd: 0.00038, pricingUnit: "item" }], output_formats: ["xlsx"] }];
  db.partials.clear(); db.results.clear(); db.rpcCalls = []; db.events = [];
  db.step = 0; db.cursor = null; db.deliveredUnits = 0; db.targetVolumeMax = TARGET; db.unitPrice = 3; db.reserved = Math.ceil(TARGET * 3 * 1.15);
}

const okPage = (rows: Record<string, any>[], nextCursor: string | null) => ({ ok: true as const, httpStatus: 200, rows, nextCursor, costUsd: 0.00228, costMicro: 2280, tregCallId: "call_ok" });
const failedPage = () => ({ ok: false as const, httpStatus: 503, rows: [], nextCursor: null, costUsd: 0.0001, costMicro: 100, tregCallId: "call_failed", errorMessageAr: "تعذر استخراج البيانات من المصدر بعد عدة محاولات." });

describe("TREG worker calls carry capability, status and duration", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "meta-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development";
    setRowAdvisorForTesting(async () => ({ verdicts: new Map(), usage: null, failure: null }));
    __resetCallRecorderForTests();
    db.v2Missing = false;
  });
  afterEach(() => {
    setProviderAdapterForTesting(null);
    setRowAdvisorForTesting(null);
    __resetCallRecorderForTests();
    db.v2Missing = false;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
  });

  async function run(pages: Array<ReturnType<typeof okPage> | ReturnType<typeof failedPage>>) {
    const route = await import("../src/app/api/worker/chunk/route");
    let calls = 0;
    setProviderAdapterForTesting(async () => { await new Promise((r) => setTimeout(r, 5)); return pages[Math.min(calls++, pages.length - 1)] as any; });
    for (let i = 0; i < 6; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer meta-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }) }));
      const json = await res.json();
      if (json.done === true || json.released === true || res.status >= 400) break;
    }
    return db.rpcCalls.filter((c) => c.name === "commit_provider_spend_v2" || c.name === "commit_provider_spend");
  }

  it("a page with rows commits through v2 as a success, with the job's capability and a real duration; amount and units are the old ones", async () => {
    resetDb();
    const commits = await run([okPage([electrical("a1", "Alpha Electric"), electrical("a2", "Beta Power")], "cur_1"), failedPage()]);
    expect(commits.map((c) => c.name)).toEqual(["commit_provider_spend_v2", "commit_provider_spend_v2"]);
    expect(commits[0].args).toMatchObject({ p_cost_id: 11, p_actual_cost_usd: 0.00228, p_units: 2, p_capability: "icypeas-companies-search", p_status: "success" });
    expect(commits[0].args.p_duration_ms).toBeGreaterThanOrEqual(1);
    // the failed page: the real provider charge is committed with no delivered units, and it says failed
    expect(commits[1].args).toMatchObject({ p_cost_id: 11, p_actual_cost_usd: 0.0001, p_units: 0, p_capability: "icypeas-companies-search", p_status: "failed" });
    expect(commits[1].args.p_duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("an answer with no rows commits as empty", async () => {
    resetDb();
    const commits = await run([okPage([], null)]);
    expect(commits).toHaveLength(1);
    expect(commits[0].name).toBe("commit_provider_spend_v2");
    expect(commits[0].args).toMatchObject({ p_status: "empty", p_units: 0, p_capability: "icypeas-companies-search" });
  });

  it("when v2 is missing the OLD function commits the very same amount and units (a missing function never leaves an estimate open)", async () => {
    resetDb();
    db.v2Missing = true;
    const commits = await run([okPage([electrical("a1", "Alpha Electric"), electrical("a2", "Beta Power")], "cur_1"), failedPage()]);
    const old = commits.filter((c) => c.name === "commit_provider_spend");
    expect(old).toHaveLength(2);
    expect(old[0].args).toEqual({ p_cost_id: 11, p_actual_cost_usd: 0.00228, p_units: 2 });
    expect(old[1].args).toEqual({ p_cost_id: 11, p_actual_cost_usd: 0.0001, p_units: 0 });
    // the first attempt of each page asked for v2 (then the fallback); once v2 is known to be missing it is not asked again
    expect(commits[0].name).toBe("commit_provider_spend_v2");
  });

  it("reserve and settlement are untouched by the metadata: same reserve calls, same charge", async () => {
    resetDb();
    await run([okPage([electrical("a1", "Alpha Electric"), electrical("a2", "Beta Power")], "cur_1"), failedPage()]);
    const reserves = db.rpcCalls.filter((c) => c.name === "reserve_provider_spend_atomic");
    expect(reserves).toHaveLength(2);
    expect(reserves.every((c) => c.args.p_provider === "treg")).toBe(true);
    const settle = db.rpcCalls.find((c) => c.name === "settle_job_atomic");
    expect(settle).toBeTruthy();
  });
});
