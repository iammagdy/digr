import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Relevance gate, worker level, for a company job: Claude's advisory review plus the deterministic gate decide what is
 * delivered, what goes to the review sheet and what is excluded; only delivered rows are counted and charged.
 * Money moves only through the approved RPCs (here: the same fakes the other worker tests use).
 */

const db = vi.hoisted(() => ({
  jobs: [] as any[],
  quotes: [] as any[],
  partials: new Map<string, Buffer>(),
  results: new Map<string, Buffer>(),
  rpcCalls: [] as Array<{ name: string; args: any }>,
  events: [] as any[],
  // state of the job being worked
  step: 0,
  cursor: null as string | null,
  deliveredUnits: 0,
  targetVolumeMax: 10,
  unitPrice: 2,
  reserved: 30,
  spendAllowed: true,
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
      if (name === "reserve_provider_spend_atomic") return { data: { allowed: db.spendAllowed, cost_id: db.spendAllowed ? 11 : null }, error: null };
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
        return { data: { success: true, charged_credits: charged, refunded_credits: db.reserved - charged }, error: null };
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
import { setRowAdvisorForTesting, applyAdvisoryToReviews, parseAdvisoryReply, summarizeRowForReview } from "../src/lib/server/rowReviewAdvisor";

const JOB = jobIdForQuote("quote_gate");

const electrical = (id: string, name: string) => ({ company_name: name, industry: "Electrical/Electronic Manufacturing", description: `${name} builds substations, transformers and switchgear`, location: "Cairo, Egypt", website: `https://${id}.example.com` });
const foreign = { company_name: "Berlin Power GmbH", industry: "Electrical/Electronic Manufacturing", description: "transformers and switchgear", location: "Berlin, Germany", website: "https://berlin-power.example.de" };
const unrelated = { company_name: "Nile Water Treatment", industry: "Utilities", description: "water treatment plants", location: "Giza, Egypt", website: "https://nile-water.example.com" };
const broad = { company_name: "Delta Services", industry: "Utilities", description: "facility services", location: "Alexandria, Egypt", website: "https://delta-services.example.com" };

function resetDb(target: number, unitPrice = 3) {
  db.jobs = [{ id: JOB, user_id: "user_1", status: "running", step: 0, current_cursor: null, delivered_units: 0, target_volume_max: target, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  db.quotes = [{ id: "quote_gate", user_id: "user_1", items: [{ capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", params: { count: target, query: { keyword: { include: ["electrical", "electricity"] }, location: { include: ["Egypt"] } }, country: "مصر", industry: "كهرباء" }, targetVolumeMax: target, paginationStrategy: "cursor", unitCostUsd: 0.00038, pricingUnit: "item" }], output_formats: ["xlsx"] }];
  db.partials.clear(); db.results.clear(); db.rpcCalls = []; db.events = [];
  db.step = 0; db.cursor = null; db.deliveredUnits = 0; db.targetVolumeMax = target; db.unitPrice = unitPrice; db.reserved = Math.ceil(target * unitPrice * 1.15); db.spendAllowed = true;
}

describe("relevance gate: Claude advises, deterministic code decides, only matching rows are charged", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "gate-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development";
  });
  afterEach(() => {
    setProviderAdapterForTesting(null);
    setRowAdvisorForTesting(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
  });

  async function run(rows: Record<string, any>[]) {
    const route = await import("../src/app/api/worker/chunk/route");
    let calls = 0;
    setProviderAdapterForTesting(async () => {
      calls += 1;
      return { ok: true, httpStatus: 200, rows: calls === 1 ? rows : [], nextCursor: null, costUsd: 0.00228, costMicro: 2280, tregCallId: `call_${calls}` };
    });
    let last: any = null;
    for (let i = 0; i < 6; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer gate-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }) }));
      last = { status: res.status, json: await res.json() };
      if (last.json.done === true || last.json.released === true || last.status >= 400) break;
    }
    return { calls, last };
  }

  async function sheets(): Promise<{ names: string[]; wb: ExcelJS.Workbook }> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(db.results.get(`user_1/${JOB}/result.xlsx`)! as any);
    return { names: wb.worksheets.map((s) => s.name), wb };
  }

  it("matching rows are delivered and charged; foreign and unrelated rows are excluded; broad ones go to review (no advisor)", async () => {
    resetDb(3);
    setRowAdvisorForTesting(async () => ({ verdicts: new Map(), usage: null }));
    const { last } = await run([electrical("a1", "Alpha Electric"), electrical("a2", "Beta Power"), foreign, unrelated, broad]);
    // 2 matched, 2 excluded (country, unrelated activity), 1 uncertain
    expect(last.json).toMatchObject({ done: true, deliveredUnits: 2 });
    expect(db.rpcCalls.find((c) => c.name === "settle_job_atomic")).toBeTruthy();
    expect(db.rpcCalls.some((c) => c.name === "release_job_atomic")).toBe(false);
    // ceil(2 matching rows x 3 points) = 6, never above the reserve (11); the rest is refunded
    expect(last.json.settle).toMatchObject({ charged_credits: 6, refunded_credits: 5 });
    expect(db.events.some((e) => /غير مطابق ٢/.test(String(e.message)))).toBe(true);
    const { names, wb } = await sheets();
    expect(names[0]).toBe("بيانات الشركات");
    expect(names.length).toBe(2); // data + one review sheet because there is an uncertain row
    const data = wb.getWorksheet("بيانات الشركات")!;
    expect(data.rowCount).toBe(3); // header + the two matching rows
    const names1 = [data.getRow(2).getCell(2).value, data.getRow(3).getCell(2).value];
    expect(names1).toEqual(expect.arrayContaining(["Alpha Electric", "Beta Power"]));
    const review = wb.worksheets[1];
    let reviewText = "";
    review.eachRow((row) => row.eachCell((cell) => { reviewText += ` ${String(cell.value)}`; }));
    expect(reviewText).toContain("Delta Services");
    expect(reviewText).not.toContain("Berlin Power");
    expect(reviewText).not.toContain("Nile Water");
  });

  it("when Claude doubts a row the gate matched, it goes to the review sheet: not delivered, not charged", async () => {
    resetDb(3);
    setRowAdvisorForTesting(async (input) => {
      const verdicts = new Map<number, { verdict: "match" | "no_match" | "uncertain"; reasonAr: string }>();
      for (const { index, row } of input.rows) {
        if (row.company_name === "Gamma Fans") verdicts.set(index, { verdict: "no_match", reasonAr: "الشركة تصنع مراوح لا معدات كهرباء" });
      }
      return { verdicts, usage: null };
    });
    const { last } = await run([electrical("a1", "Alpha Electric"), electrical("a2", "Beta Power"), electrical("a3", "Gamma Fans")]);
    expect(last.json).toMatchObject({ done: true, deliveredUnits: 2 });
    expect(last.json.settle).toMatchObject({ charged_credits: 6, refunded_credits: 5 });
    const { names, wb } = await sheets();
    expect(names.length).toBe(2);
    const review = wb.worksheets[1];
    let reviewText = "";
    review.eachRow((row) => row.eachCell((cell) => { reviewText += ` ${String(cell.value)}`; }));
    expect(reviewText).toContain("Gamma Fans");
    expect(reviewText).toContain("مراوح");
    // The honest partial count, in plain Arabic, with the reason.
    expect(db.events.some((e) => /المسلَّم ٢ من ٣ مطلوب/.test(String(e.message)))).toBe(true);
  });

  it("Claude can never promote: a row the gate excluded or put in review stays there even if Claude says match", async () => {
    resetDb(3);
    setRowAdvisorForTesting(async (input) => ({ verdicts: new Map(input.rows.map(({ index }) => [index, { verdict: "match" as const, reasonAr: "مطابق" }])), usage: null }));
    const { last } = await run([electrical("a1", "Alpha Electric"), foreign, unrelated, broad]);
    expect(last.json).toMatchObject({ done: true, deliveredUnits: 1 });
  });

  it("zero matching rows: the whole reserve is released, nothing is charged", async () => {
    resetDb(2);
    setRowAdvisorForTesting(async () => ({ verdicts: new Map(), usage: null }));
    const { last } = await run([foreign, unrelated]);
    expect(last.json.released).toBe(true);
    expect(db.rpcCalls.some((c) => c.name === "release_job_atomic")).toBe(true);
    expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
  });

  it("a failing or throwing advisor changes nothing: the deterministic result is delivered and charged as before", async () => {
    resetDb(2);
    setRowAdvisorForTesting(async () => { throw new Error("advisor down"); });
    const { last } = await run([electrical("a1", "Alpha Electric"), electrical("a2", "Beta Power")]);
    expect(last.json).toMatchObject({ done: true, deliveredUnits: 2 });
  });

  it("the provider is called within the existing caps even when most rows are rejected", async () => {
    resetDb(2);
    setRowAdvisorForTesting(async () => ({ verdicts: new Map(), usage: null }));
    const route = await import("../src/app/api/worker/chunk/route");
    let calls = 0;
    setProviderAdapterForTesting(async () => { calls += 1; return { ok: true, httpStatus: 200, rows: [foreign, unrelated], nextCursor: `c_${calls}`, costUsd: 0.00228, costMicro: 2280, tregCallId: `call_${calls}` }; });
    for (let i = 0; i < 12; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer gate-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }) }));
      const json: any = await res.json();
      if (json.done === true || json.released === true || res.status >= 400) break;
    }
    expect(calls).toBeLessThanOrEqual(3);
  });
});

describe("advisory policy (pure)", () => {
  const reviews = [
    { index: 0, decision: "match" as const, reasonAr: "مطابق" },
    { index: 1, decision: "match" as const, reasonAr: "مطابق" },
    { index: 2, decision: "uncertain" as const, reasonAr: "للمراجعة" },
    { index: 3, decision: "no_match" as const, reasonAr: "مستبعد" },
  ];

  it("only a deterministic match can change, and only to review", () => {
    const verdicts = new Map([
      [0, { verdict: "no_match" as const, reasonAr: "نشاط مختلف" }],
      [1, { verdict: "match" as const, reasonAr: "مطابق" }],
      [2, { verdict: "match" as const, reasonAr: "مطابق" }],
      [3, { verdict: "match" as const, reasonAr: "مطابق" }],
    ]);
    const { reviews: out, demoted } = applyAdvisoryToReviews(reviews, verdicts);
    expect(demoted).toBe(1);
    expect(out.map((r) => r.decision)).toEqual(["uncertain", "match", "uncertain", "no_match"]);
    expect(out[0].reasonAr).toContain("نشاط مختلف");
    // delivered (and charged) rows can only go down
    expect(out.filter((r) => r.decision === "match").length).toBeLessThanOrEqual(reviews.filter((r) => r.decision === "match").length);
  });

  it("an uncertain verdict from Claude also moves a matched row to review", () => {
    const { reviews: out } = applyAdvisoryToReviews(reviews, new Map([[1, { verdict: "uncertain" as const, reasonAr: "غير كافٍ" }]]));
    expect(out[1].decision).toBe("uncertain");
  });

  it("a malformed or empty reply gives no verdicts, so nothing changes", () => {
    expect(parseAdvisoryReply("not json").size).toBe(0);
    expect(parseAdvisoryReply('{"reviews":[{"index":"x"}]}').size).toBe(0);
    expect(parseAdvisoryReply("").size).toBe(0);
    const ok = parseAdvisoryReply('نص {"reviews":[{"index":2,"verdict":"no_match","reasonAr":"سبب <b>"}]}');
    expect(ok.get(2)).toEqual({ verdict: "no_match", reasonAr: "سبب b" });
    expect(applyAdvisoryToReviews(reviews, new Map()).demoted).toBe(0);
  });

  it("the row summary carries only the fields a reviewer needs, each cut short", () => {
    const summary = summarizeRowForReview({ company_name: "A", industry: "X", description: "د".repeat(500), api_key: "sk-secret", email: "a@b.c" });
    expect(Object.keys(summary).sort()).toEqual(["company_name", "description", "industry"]);
    expect(summary.description.length).toBeLessThanOrEqual(220);
  });
});
