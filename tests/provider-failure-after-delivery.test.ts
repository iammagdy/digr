import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * A provider page that fails AFTER rows were delivered ends the collection and settles what was collected (the existing
 * settlement charges only those rows); a failure before anything was delivered still releases the whole reserve.
 * Money moves only through the approved RPCs (here: the same kind of fakes the other worker tests use).
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
      if (name === "commit_provider_spend") return { data: { success: true }, error: null };
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
import { refundedPointsFromSettle } from "../src/lib/server/settleRefund";

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

describe("a provider page that fails after rows were delivered", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "fail-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development";
    setRowAdvisorForTesting(async () => ({ verdicts: new Map(), usage: null, failure: null }));
  });
  afterEach(() => {
    setProviderAdapterForTesting(null);
    setRowAdvisorForTesting(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
  });

  async function run(pages: Array<ReturnType<typeof okPage> | ReturnType<typeof failedPage>>) {
    const route = await import("../src/app/api/worker/chunk/route");
    let calls = 0;
    setProviderAdapterForTesting(async () => pages[Math.min(calls++, pages.length - 1)] as any);
    const responses: Array<{ status: number; json: any }> = [];
    for (let i = 0; i < 6; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer fail-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }) }));
      const entry = { status: res.status, json: await res.json() };
      responses.push(entry);
      if (entry.json.done === true || entry.json.released === true || entry.status >= 400) break;
    }
    return { calls, responses, last: responses[responses.length - 1] };
  }

  it("page 1 delivers 2 rows, page 2 fails: the 2 rows are settled and charged ceil(2 x 3) = 6, nothing is released", async () => {
    resetDb();
    const { last, calls } = await run([okPage([electrical("a1", "Alpha Electric"), electrical("a2", "Beta Power")], "cur_1"), failedPage()]);
    expect(calls).toBe(2);
    expect(last.status).toBe(200);
    expect(last.json).toMatchObject({ done: true, deliveredUnits: 2 });
    const names = db.rpcCalls.map((c) => c.name);
    expect(names).toContain("settle_job_atomic");
    expect(names).not.toContain("release_job_atomic");
    expect(names).not.toContain("record_chunk_failure");
    // ceil(2 matching rows x 3 points) = 6, never above the reserve (14)
    expect(last.json.settle).toMatchObject({ charged_credits: 6, reserved_credits: 14 });
    // the failed page's real provider cost is still committed, with no delivered units
    const commits = db.rpcCalls.filter((c) => c.name === "commit_provider_spend" || c.name === "commit_provider_spend_v2");
    expect(commits).toHaveLength(2);
    expect(commits[1].args).toMatchObject({ p_actual_cost_usd: 0.0001, p_units: 0 });
  });

  it("the customer is told in plain Arabic what happened, and the refund notice is computed from the reserve and the charge", async () => {
    resetDb();
    await run([okPage([electrical("a1", "Alpha Electric"), electrical("a2", "Beta Power")], "cur_1"), failedPage()]);
    const messages = db.events.map((e) => String(e.message));
    expect(messages.some((m) => m.includes("توقف جلب صفحات إضافية لتعذر الوصول إلى المصدر") && m.includes("مع تسليم السجلات المطابقة التي جُمعت"))).toBe(true);
    expect(messages.some((m) => m.includes("المسلَّم ٢ من ٤ مطلوب") && m.includes("لا يُحتسب عليك إلا ما سُلّم"))).toBe(true);
    // 14 reserved - 6 charged = 8 released
    expect(messages.some((m) => m.includes("حجز مؤقت مُحرَّر كاملًا (١٤ نقطة)، ثم خُصم ثمن ما سُلّم فقط (٦ نقاط)، فيبقى في رصيدك ٨ نقاط من هذا الحجز"))).toBe(true);
    for (const m of messages) expect(m).not.toMatch(/treg|icypeas|http|503|USD|\$/i);
  });

  it("the workbook holds exactly the delivered rows", async () => {
    resetDb();
    await run([okPage([electrical("a1", "Alpha Electric"), electrical("a2", "Beta Power")], "cur_1"), failedPage()]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(db.results.get(`user_1/${JOB}/result.xlsx`)! as any);
    expect(wb.worksheets.map((s) => s.name)).toEqual(["بيانات الشركات"]);
    expect(wb.getWorksheet("بيانات الشركات")!.rowCount).toBe(3); // header + 2 delivered rows
  });

  it("nothing delivered yet and the page fails: the whole reserve is released, nothing is charged, nothing is settled", async () => {
    resetDb();
    const { last } = await run([failedPage()]);
    expect(last.status).toBe(500);
    expect(last.json).toMatchObject({ released: true, chargedCredits: 0 });
    const names = db.rpcCalls.map((c) => c.name);
    expect(names).toContain("release_job_atomic");
    expect(names).not.toContain("settle_job_atomic");
  });
});

describe("refundedPointsFromSettle", () => {
  it("is reserve minus charge when the settle reply carries both", () => {
    expect(refundedPointsFromSettle({ reserved_credits: 14, charged_credits: 6 })).toBe(8);
    expect(refundedPointsFromSettle({ reserved_credits: "7", charged_credits: "6" })).toBe(1);
  });
  it("an explicit figure wins; an already-settled or empty reply gives 0; never negative", () => {
    expect(refundedPointsFromSettle({ refunded_credits: 5, reserved_credits: 11, charged_credits: 6 })).toBe(5);
    expect(refundedPointsFromSettle({ already_settled: true, charged_credits: 6 })).toBe(0);
    expect(refundedPointsFromSettle(null)).toBe(0);
    expect(refundedPointsFromSettle(undefined)).toBe(0);
    expect(refundedPointsFromSettle({ reserved_credits: 4, charged_credits: 9 })).toBe(0);
  });
});
