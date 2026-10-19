import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Worker level, company job: a deterministic match is delivered and charged only when Claude's structured review says the
 * company itself does the requested activity and quotes its own text. A doubt, a failure, a timeout or a disabled reviewer
 * sends the row to the labelled review sheet (never charged); a review that cannot run stops paging, and a job with
 * nothing delivered releases the whole reserve. Money moves only through the approved RPCs (here: fakes).
 */

const db = vi.hoisted(() => ({
  jobs: [] as any[],
  quotes: [] as any[],
  partials: new Map<string, Buffer>(),
  results: new Map<string, Buffer>(),
  rpcCalls: [] as Array<{ name: string; args: any }>,
  events: [] as any[],
  llmUsage: [] as any[],
  step: 0,
  cursor: null as string | null,
  deliveredUnits: 0,
  targetVolumeMax: 3,
  unitPrice: 3,
  reserved: 11,
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
      if (table === "llm_usage") return { insert: async (row: any) => { db.llmUsage.push(row); return { data: row, error: null }; } };
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
import { callClaudeCompanyReviewer, setCompanyReviewTimingForTesting, setCompanyReviewerForTesting, type CompanyReviewAttempt, type CompanyReviewRequest, type CompanyReviewerFn } from "../src/lib/server/companyRelevanceReview";
import { resetProviderKeyCache } from "../src/lib/server/providerKeys";
import { contractor, empty, foreign, repair, trader, utility } from "./fixtures/relevance-rows";

const JOB = jobIdForQuote("quote_strict");
const RETRY_NOTE = "جاري إعادة التحقق من ملاءمة السجلات";
const RELEASE_MESSAGE = "تعذّر التحقق الآلي الآن، ولم يُخصم أي رصيد. حاول مرة أخرى بعد قليل.";

function resetDb(target = 3) {
  db.jobs = [{ id: JOB, user_id: "user_1", status: "running", step: 0, current_cursor: null, delivered_units: 0, target_volume_max: target, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  db.quotes = [{ id: "quote_strict", user_id: "user_1", items: [{ capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", params: { count: target, query: { keyword: { include: ["electrical", "electricity"] }, location: { include: ["Egypt"] } }, country: "مصر", industry: "كهرباء" }, targetVolumeMax: target, paginationStrategy: "cursor", unitCostUsd: 0.00038, pricingUnit: "item" }], output_formats: ["xlsx"] }];
  db.partials.clear(); db.results.clear(); db.rpcCalls = []; db.events = []; db.llmUsage = [];
  db.step = 0; db.cursor = null; db.deliveredUnits = 0; db.targetVolumeMax = target; db.unitPrice = 3; db.reserved = Math.ceil(target * 3 * 1.15);
}

const usage = { inputTokens: 700, outputTokens: 90, costUsd: 0.00071, model: "claude-haiku-5-5", latencyMs: 40 };
const coreFor = (request: CompanyReviewRequest, decide: (row: Record<string, any>) => "core" | "adjacent" | "unrelated" | "unknown", evidence: (row: Record<string, any>) => string): CompanyReviewAttempt => ({
  verdicts: new Map(request.rows.map(({ index, row }) => [index, { index, coreActivity: decide(row), countryOk: "yes" as const, evidence: evidence(row), reasonAr: "تقدير آلي" }])),
  usage,
  failure: null,
});
const failedAttempt = (failure: string): CompanyReviewAttempt => ({ verdicts: new Map(), usage: null, failure });

describe("company job: strict review of the rows the gate matched", () => {
  let saved: Record<string, string | undefined>;
  let sleeps: number[];
  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV, LLM_ENABLED: process.env.LLM_ENABLED, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    process.env.CRON_SECRET = "strict-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    delete process.env.LLM_ENABLED;
    resetProviderKeyCache();
    sleeps = [];
    setCompanyReviewTimingForTesting({ sleep: async (ms) => { sleeps.push(ms); } });
    // the legacy advisor must stay out of company jobs once the strict review is in charge
    setRowAdvisorForTesting(async () => { throw new Error("the legacy advisor must not run for a strictly reviewed company job"); });
  });
  afterEach(() => {
    setProviderAdapterForTesting(null);
    setCompanyReviewerForTesting(null);
    setCompanyReviewTimingForTesting(null);
    setRowAdvisorForTesting(null);
    resetProviderKeyCache();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
  });

  async function run(pages: Record<string, any>[][]) {
    const route = await import("../src/app/api/worker/chunk/route");
    let calls = 0;
    setProviderAdapterForTesting(async () => {
      const rows = pages[Math.min(calls, pages.length - 1)] ?? [];
      const hasMore = calls < pages.length - 1;
      calls += 1;
      return { ok: true, httpStatus: 200, rows, nextCursor: hasMore ? `cur_${calls}` : null, costUsd: 0.00228, costMicro: 2280, tregCallId: `call_${calls}` };
    });
    let last: any = null;
    for (let i = 0; i < 6; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer strict-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }) }));
      last = { status: res.status, json: await res.json() };
      if (last.json.done === true || last.json.released === true || last.status >= 400) break;
    }
    return { get calls() { return calls; }, last };
  }

  async function workbook() {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(db.results.get(`user_1/${JOB}/result.xlsx`)! as any);
    return wb;
  }
  const textOf = (sheet: ExcelJS.Worksheet) => { let text = ""; sheet.eachRow((row) => row.eachCell((cell) => { text += ` ${String(cell.value)}`; })); return text; };
  const names = () => db.rpcCalls.map((c) => c.name);

  it("a mixed page: only the real operator is delivered and charged; trader and repair shop go to the review sheet; the reviewer is asked only about candidates", async () => {
    resetDb(3);
    const asked: number[][] = [];
    setCompanyReviewerForTesting(async (request) => {
      asked.push(request.rows.map((r) => r.index));
      return coreFor(request, (row) => (row.company_name === contractor.company_name ? "core" : "adjacent"), (row) => (row.company_name === contractor.company_name ? "Electrical contracting" : "x"));
    });
    const result = await run([[contractor, trader, repair, empty, foreign]]);
    // empty (no evidence) and foreign (wrong country) never reach the reviewer: indexes 0,1,2 only
    expect(asked).toEqual([[0, 1, 2]]);
    expect(result.last.json).toMatchObject({ done: true, deliveredUnits: 1 });
    expect(names()).toContain("settle_job_atomic");
    expect(names()).not.toContain("release_job_atomic");
    // charge = ceil(1 delivered x 3) = 3, never above the reserve (11), the reserve itself unchanged
    expect(result.last.json.settle).toMatchObject({ charged_credits: 3, reserved_credits: 11 });
    const wb = await workbook();
    expect(wb.worksheets.map((s) => s.name)).toEqual(["بيانات الشركات", "سجلات تحتاج مراجعة"]);
    expect(wb.getWorksheet("بيانات الشركات")!.rowCount).toBe(2); // header + the one delivered row
    expect(textOf(wb.getWorksheet("بيانات الشركات")!)).toContain("Nile Electrical Contracting");
    const review = textOf(wb.getWorksheet("سجلات تحتاج مراجعة")!);
    expect(review).toContain("Alpha Sourcing");
    expect(review).toContain("QuickFix");
    expect(review).toContain("Delta Group");
    expect(review).not.toContain("Berlin Power");
    expect(db.events.some((e) => /المسلَّم ١ من ٣ مطلوب/.test(String(e.message)))).toBe(true);
    // the call is logged: one success row with its tokens
    expect(db.llmUsage).toHaveLength(1);
    expect(db.llmUsage[0]).toMatchObject({ user_id: "user_1", reason: "relevance_review", tokens_in: 700, tokens_out: 90, model: "claude-haiku-5-5" });
  });

  it("a quote that is not in the company's own text does not deliver it, even when the review says core", async () => {
    resetDb(3);
    setCompanyReviewerForTesting(async (request) => coreFor(request, () => "core", () => "builds nuclear reactors"));
    const result = await run([[contractor, utility]]);
    expect(result.last.json.released).toBe(true);
    expect(result.last.json.chargedCredits).toBe(0);
    expect(names()).not.toContain("settle_job_atomic");
  });

  it("the review fails on every attempt: 3 calls on the same rows with 2 s and 4 s waits, a note for the customer, nothing charged, the whole reserve released, no more provider pages", async () => {
    resetDb(3);
    const asked: number[][] = [];
    setCompanyReviewerForTesting(async (request) => { asked.push(request.rows.map((r) => r.index)); return failedAttempt("timeout"); });
    const result = await run([[contractor, utility, trader], [contractor, utility, trader]]);
    expect(asked).toEqual([[0, 1, 2], [0, 1, 2], [0, 1, 2]]);
    expect(sleeps).toEqual([2000, 4000]);
    expect(result.calls).toBe(1); // the circuit breaker: no second provider page for rows nobody can check
    expect(result.last.status).toBe(422);
    expect(result.last.json).toMatchObject({ released: true, chargedCredits: 0, deliveredUnits: 0 });
    expect(result.last.json.error).toBe(RELEASE_MESSAGE);
    expect(names()).toContain("release_job_atomic");
    expect(names()).not.toContain("settle_job_atomic");
    // every attempt leaves a usage row, none of them a success
    expect(db.llmUsage).toHaveLength(3);
    expect(db.llmUsage.every((row) => row.reason === "relevance_review_failed" && row.cost_usd === 0)).toBe(true);
    const messages = db.events.map((e) => String(e.message));
    expect(messages.filter((m) => m === RETRY_NOTE)).toHaveLength(2);
    expect(messages.some((m) => /تعذّر التحقق الآلي من ملاءمة ٣ سجل الآن/.test(m) && m.includes("وُضعت في شيت المراجعة ولم تُحتسب"))).toBe(true);
    for (const m of messages) expect(m).not.toMatch(/claude|anthropic|treg|icypeas|timeout|http|USD/i);
  });

  it("a failure that cannot change (the assistant is switched off) is not retried and still fails closed", async () => {
    resetDb(3);
    process.env.LLM_ENABLED = "false";
    setCompanyReviewerForTesting(callClaudeCompanyReviewer);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await run([[contractor, utility], [contractor, utility]]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sleeps).toEqual([]);
      expect(result.calls).toBe(1);
      expect(result.last.json).toMatchObject({ released: true, chargedCredits: 0 });
      expect(result.last.json.error).toBe(RELEASE_MESSAGE);
      expect(db.llmUsage).toHaveLength(1);
      expect(db.llmUsage[0].reason).toBe("relevance_review_failed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a reviewer that throws is a failed attempt: the job still fails closed instead of crashing", async () => {
    resetDb(3);
    setCompanyReviewerForTesting((async () => { throw new Error("boom"); }) as CompanyReviewerFn);
    const result = await run([[contractor, utility]]);
    expect(result.last.json).toMatchObject({ released: true, chargedCredits: 0 });
    expect(names()).not.toContain("settle_job_atomic");
  });

  it("page 1 reviewed and delivered, page 2 cannot be reviewed: the delivered row is settled and charged, paging stops, nothing more is bought", async () => {
    resetDb(3);
    let call = 0;
    setCompanyReviewerForTesting(async (request) => {
      call += 1;
      return call === 1 ? coreFor(request, () => "core", (row) => (row.description as string).slice(0, 24)) : failedAttempt("http_529");
    });
    const result = await run([[contractor], [utility, trader], [contractor]]);
    expect(result.calls).toBe(2);
    expect(result.last.json).toMatchObject({ done: true, deliveredUnits: 1 });
    expect(names()).toContain("settle_job_atomic");
    expect(names()).not.toContain("release_job_atomic");
    expect(result.last.json.settle).toMatchObject({ charged_credits: 3 });
    const wb = await workbook();
    expect(wb.getWorksheet("بيانات الشركات")!.rowCount).toBe(2);
    expect(textOf(wb.getWorksheet("سجلات تحتاج مراجعة")!)).toContain("Delta Electricity");
    // 1 success row for page 1, 3 failed attempts for page 2
    expect(db.llmUsage.map((row) => row.reason)).toEqual(["relevance_review", "relevance_review_failed", "relevance_review_failed", "relevance_review_failed"]);
    expect(db.events.some((e) => /توقف الجمع لأن التحقق الآلي من ملاءمة السجلات تعذّر الآن/.test(String(e.message)))).toBe(true);
  });

  it("the reviewer cannot raise the count: rows the gate already excluded or held stay out whatever the review says", async () => {
    resetDb(5);
    setCompanyReviewerForTesting(async (request) => coreFor(request, () => "core", (row) => (row.description as string).slice(0, 20)));
    const result = await run([[contractor, empty, foreign]]);
    expect(result.last.json).toMatchObject({ done: true, deliveredUnits: 1 });
  });
});
