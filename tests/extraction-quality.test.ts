import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * B. Data extraction quality, worker level: page caps for feed sources, partial delivery charging only matching rows,
 * de-duplication across pages, and uncertain rows never counted or charged. Money moves only through the approved RPCs.
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
        return { data: { claimed: true, job_id: args.p_job_id, user_id: "user_1", step: db.step, current_cursor: db.cursor, delivered_units: db.deliveredUnits, target_volume_max: db.targetVolumeMax, target_volume_min: 1, endpoint_id: "scrapecreators.x.v1-twitter-search", unit_price: db.unitPrice }, error: null };
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


import { hasRecognizedProviderResultShape, setProviderAdapterForTesting } from "../src/lib/server/tregAdapter";
import { jobIdForQuote } from "../src/lib/server/retryReuse";
import { evaluateProviderCallCap, maxPagesForJob, FEED_SMALL_JOB_MAX_PAGES } from "../src/lib/server/providerCallCaps";
import ExcelJS from "exceljs";
import { generateExcelReport, REVIEW_SHEET_NOTICE_AR } from "../src/functions/shared/fileGenerators";
import { normalizeSocialRow } from "../src/lib/server/socialRows";
import { dedupeRows, dedupeIdentityFor, companyDedupeIdentity, personDedupeIdentity } from "../src/lib/server/rowDedupe";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { matchTopic, stemToken, topicStems } from "../src/lib/server/topicMatch";

const JOB = jobIdForQuote("quote_extraction");
const hit = (id: string) => ({ tweet_id: id, text: `مباراة كرة السلة رقم ${id}`, lang: "ar" });
const miss = (id: string) => ({ tweet_id: id, text: `مباراة كرة القدم رقم ${id}`, lang: "ar" });
const both = (id: string) => ({ tweet_id: id, text: `كرة السلة وكرة القدم ${id}`, lang: "ar" });

function resetDb(target: number) {
  db.jobs = [{ id: JOB, user_id: "user_1", status: "running", step: 0, current_cursor: null, delivered_units: 0, target_volume_max: target, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  db.quotes = [{ id: "quote_extraction", user_id: "user_1", items: [{ capabilitySlug: "social-x-posts", endpointId: "scrapecreators.x.v1-twitter-search", params: { query: "كرة السلة" }, targetVolumeMax: target, paginationStrategy: "cursor" }], output_formats: ["xlsx"] }];
  db.partials.clear(); db.results.clear(); db.rpcCalls = []; db.events = [];
  db.step = 0; db.cursor = null; db.deliveredUnits = 0; db.targetVolumeMax = target; db.unitPrice = 2; db.reserved = Math.ceil(target * 2 * 1.15); db.spendAllowed = true;
}

describe("B2. pagination policy for feed sources", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "extraction-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development";
  });
  afterEach(() => {
    setProviderAdapterForTesting(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
  });

  async function run(pages: (page: number) => any[], maxCalls = 12) {
    const route = await import("../src/app/api/worker/chunk/route");
    let calls = 0;
    setProviderAdapterForTesting(async () => {
      calls += 1;
      const rows = pages(calls);
      return { ok: true, httpStatus: 200, rows, nextCursor: `cursor_${calls}`, costUsd: 0.001, costMicro: 1000, tregCallId: `call_${calls}` };
    });
    let last: any = null;
    for (let i = 0; i < maxCalls; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer extraction-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }) }));
      last = { status: res.status, json: await res.json() };
      if (last.json.done === true || last.json.released === true || last.status >= 400) break;
    }
    return { calls, last };
  }

  it("the rule: feeds read at most 4 chunks when small and stop after 2 consecutive empty ones", () => {
    expect(maxPagesForJob(3, 50, "feed")).toBe(FEED_SMALL_JOB_MAX_PAGES);
    expect(maxPagesForJob(3, 50, "directory")).toBe(3);
    expect(evaluateProviderCallCap({ pagesDone: 2, acceptedThisPage: 0, priorBatchUnits: [0], targetMax: 3, pageSize: 50, kind: "feed" })).toBe("empty_pages");
    expect(evaluateProviderCallCap({ pagesDone: 4, acceptedThisPage: 1, priorBatchUnits: [1, 0, 0], targetMax: 9, pageSize: 50, kind: "feed" })).toBe("page_cap");
    expect(evaluateProviderCallCap({ pagesDone: 3, acceptedThisPage: 1, priorBatchUnits: [1, 0], targetMax: 9, pageSize: 50, kind: "feed" })).toBeNull();
  });

  it("a feed whose rows never match stops after 2 pages, charges nothing and releases the reserve", async () => {
    resetDb(3);
    const { calls, last } = await run((page) => [miss(`a${page}1`), miss(`a${page}2`), miss(`a${page}3`)]);
    expect(calls).toBe(2);
    expect(last.json.released).toBe(true);
    expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
  });

  it("keeps fetching until the MATCHING count is reached, even when most rows are rejected", async () => {
    resetDb(3);
    const { calls, last } = await run((page) => (page === 1 ? [hit("m1"), miss("x1"), miss("x2")] : page === 2 ? [miss("x3"), hit("m2")] : [hit("m3"), miss("x4")]));
    expect(calls).toBe(3);
    expect(last.json).toMatchObject({ done: true, deliveredUnits: 3 });
    expect(db.rpcCalls.filter((c) => c.name === "settle_job_atomic")).toHaveLength(1);
  });

  it("delivers honestly as partial and charges only the matching rows when the caps stop the job", async () => {
    resetDb(3);
    const { last } = await run((page) => (page === 1 ? [hit("m1"), miss("x1")] : [miss(`y${page}1`), miss(`y${page}2`)]));
    expect(last.json).toMatchObject({ done: true, deliveredUnits: 1 });
    const settle = db.rpcCalls.find((c) => c.name === "settle_job_atomic");
    expect(settle).toBeTruthy();
    expect(db.events.some((e) => /صفحتين متتاليتين من المصدر لم تُضيفا أي سجل مطابق جديد/.test(String(e.message)))).toBe(true);
  });

  it("de-duplicates across pages: a page repeated by the source is neither delivered twice nor counted twice", async () => {
    resetDb(3);
    const first = [hit("r1"), hit("r2")];
    const { last } = await run((page) => (page === 1 ? first : page === 2 ? first : [hit("r3")]));
    expect(last.json).toMatchObject({ done: true, deliveredUnits: 3 });
    expect(db.events.some((e) => /مكرر أو مستبعد ٢/.test(String(e.message)))).toBe(true);
  });

  it("uncertain rows are saved for the review sheet, never counted as delivered and never charged", async () => {
    resetDb(2);
    // First page only: the partial file of that page still exists (it is removed when the job settles).
    const first = await run((page) => (page === 1 ? [hit("m1"), both("u1"), both("u2")] : [hit("m2")]), 1);
    expect(first.last.json).toMatchObject({ done: false, deliveredUnits: 1 });
    const step0 = JSON.parse(db.partials.get(`${JOB}/step_0.json`)!.toString());
    expect(step0.batchUnits).toBe(1);
    expect(step0.uncertainRows).toHaveLength(2);
    expect(step0.uncertainRowsCount).toBe(2);
    expect(step0.uncertainRows[0]._relevance_status).toBe("قيد المراجعة والتدقيق");
    expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
  });
});

describe("B3. de-duplication identities", () => {
  it("a company repeated under another record id is caught by its website; a person by profile or name and company", () => {
    const a = { id: "1", company_name: "Delta Power", website: "https://www.delta-power.example.eg/" };
    const b = { id: "2", company_name: "Delta Power Co", website: "delta-power.example.eg" };
    expect(companyDedupeIdentity(a)).toBe(companyDedupeIdentity(b));
    expect(companyDedupeIdentity({ id: "1", website: "https://www.linkedin.com/company/x" })).toBe("id:1");
    const p1 = { id: "p1", full_name: "Sami Example", company_name: "Desert Energy", linkedin_url: "https://www.linkedin.com/in/sami/" };
    const p2 = { id: "p2", full_name: "Someone Else", company_name: "X", linkedin_url: "https://www.linkedin.com/in/sami" };
    expect(personDedupeIdentity(p1)).toBe(personDedupeIdentity(p2));
    expect(personDedupeIdentity({ id: "p3", full_name: "Sami  Example", company_name: "Desert Energy." })).toBe(personDedupeIdentity({ id: "p4", contact_name: "sami example", company_name: "desert energy" }));
    expect(personDedupeIdentity({ id: "p5", full_name: "Different Person", company_name: "Desert Energy" })).not.toBe(personDedupeIdentity(p1));
  });

  it("the shared set drops repeats across pages and across kinds of identity", () => {
    const seen = new Set<string>();
    const identity = dedupeIdentityFor("social");
    const page1 = dedupeRows([{ tweet_id: "1" }, { tweet_id: "2" }], identity, seen);
    const page2 = dedupeRows([{ tweet_id: "2" }, { tweet_id: "3" }], identity, seen);
    expect(page1.duplicates).toBe(0);
    expect(page2.duplicates).toBe(1);
    expect(page2.rows).toEqual([{ tweet_id: "3" }]);
  });
});

describe("B1. the gate understands Arabic and the request", () => {
  const ctx = (params: Record<string, any>, capabilitySlug = "social-x-posts") => ({ capabilitySlug, endpointId: "scrapecreators.x.v1", params });

  it("article, plural, feminine ending and word order do not hide the topic", () => {
    expect(topicStems("الطاقة الشمسية")).toEqual(topicStems("طاقة شمسية"));
    expect(stemToken("المشروعات")).toBe(stemToken("مشاريع"));
    expect(matchTopic(topicStems("مشروع صغير"), "أفضل مشاريع صغيرة 2026")).toEqual({ matched: 2, total: 2 });
    expect(matchTopic(topicStems("الذهب"), "الدهب عيار ٢١ بكام")).toEqual({ matched: 1, total: 1 });
    expect(matchTopic(topicStems("الطاقة الشمسية"), "solar energy is the future")).toEqual({ matched: 2, total: 2 });
  });

  it("a feed with no source-side topic filter (an account): a topic of several words that appears only in part goes to review, not delivery", () => {
    const params = { query: "الطاقة الشمسية", channel: "@energy_page" };
    expect(evaluateResearchRowRelevance({ text: "طاقة شمسية للمنازل بتوفر كتير" }, ctx(params)).decision).toBe("match");
    expect(evaluateResearchRowRelevance({ text: "الطاقة الكهربائية غالية في مصر" }, ctx(params)).decision).toBe("uncertain");
    expect(evaluateResearchRowRelevance({ text: "صباح الخير" }, ctx(params)).decision).toBe("no_match");
  });

  it("a topic search (the source filtered by the topic itself): the rows it returned are presumed on topic, with no review for ordinary text", () => {
    const params = { query: "الطاقة الشمسية" };
    expect(evaluateResearchRowRelevance({ text: "طاقة شمسية للمنازل بتوفر كتير" }, ctx(params))).toMatchObject({ decision: "match" });
    expect(evaluateResearchRowRelevance({ text: "الطاقة الكهربائية غالية في مصر" }, ctx(params))).toEqual({ decision: "match", reasonAr: "من نتائج البحث بالموضوع المطلوب" });
    // no word of the topic and no country asked: excluded by code before any review (it was presumed on topic before)
    expect(evaluateResearchRowRelevance({ text: "صباح الخير" }, ctx(params))).toEqual({ decision: "no_match", reasonAr: "لا يذكر السجل كلمات من موضوع البحث" });
  });

  it("language: only when the request names one and the row states its own; a topic miss still wins", () => {
    const params = { query: "كرة السلة", language: "ar" };
    expect(evaluateResearchRowRelevance({ text: "basketball tonight", lang: "en" }, ctx(params)).decision).toBe("uncertain");
    expect(evaluateResearchRowRelevance({ text: "مباراة كرة السلة", lang: "ar" }, ctx(params)).decision).toBe("match");
    expect(evaluateResearchRowRelevance({ text: "basketball tonight" }, ctx(params)).decision).toBe("match");
    expect(evaluateResearchRowRelevance({ text: "football tonight", lang: "en" }, ctx(params)).decision).toBe("no_match");
    expect(evaluateResearchRowRelevance({ text: "basketball tonight", lang: "en" }, ctx({ query: "كرة السلة" })).decision).toBe("match");
  });

  it("region: an explicit foreign country on a tweet or comment is rejected; missing metadata is not evidence", () => {
    const params = { query: "كرة السلة", region: "EG" };
    expect(evaluateResearchRowRelevance({ text: "كرة السلة", country_code: "SA" }, ctx(params)).decision).toBe("no_match");
    expect(evaluateResearchRowRelevance({ text: "كرة السلة", country: "Egypt" }, ctx(params)).decision).toBe("match");
    expect(evaluateResearchRowRelevance({ text: "كرة السلة" }, ctx(params)).decision).toBe("match");
  });

  it("people: a person located in another country is rejected, one with no location is kept", () => {
    const params = { country: "Saudi Arabia" };
    const peopleCtx = ctx(params, "professional-people-search");
    expect(evaluateResearchRowRelevance({ full_name: "A B", location: "Cairo, Egypt" }, peopleCtx).decision).toBe("no_match");
    expect(evaluateResearchRowRelevance({ full_name: "A B", location: "Riyadh, Saudi Arabia" }, peopleCtx).decision).toBe("match");
    expect(evaluateResearchRowRelevance({ full_name: "A B" }, peopleCtx).decision).toBe("match");
  });

  it("companies: an energy-adjacent label with the company's own electrical text is delivered; HVAC under it is reviewed", () => {
    const industry = "الكهرباء والطاقة الكهربائية";
    const base = { location: "Cairo, Egypt", country: "Egypt" };
    const c = (row: Record<string, any>) => evaluateResearchRowRelevance({ ...base, ...row }, { capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", params: { country: "Egypt", industry } });
    expect(c({ industry: "Oil & Energy", description: "High voltage substations and power transmission" }).decision).toBe("match");
    expect(c({ industry: "Oil & Energy", description: "Oilfield services" }).decision).toBe("uncertain");
    expect(c({ industry: "Oil & Energy", description: "HVAC and air conditioning contractor" }).decision).toBe("uncertain");
    expect(c({ industry: "Retail", description: "Electrical appliances shop" }).decision).toBe("uncertain");
  });
});

describe("B4/B5. Arabic columns, readable dates, numbers as numbers, verification column", () => {
  const payloadFor = (kind: "posts" | "comments" | "videos", rows: any[], uncertain: any[] = []) => ({
    metadata: { platform: "x", socialKind: kind, title: "نتائج", jobId: "j", collectedAt: "2026-10-17T10:00:00.000Z", rowsCount: rows.length, targetRequested: rows.length },
    rows: rows.map((r) => normalizeSocialRow(kind, r)), uncertainRows: uncertain, profile: null,
  });
  const load = async (payload: any) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await generateExcelReport(payload)) as any); return wb; };

  it("a post sheet has Arabic headers only, the date AND time of the post, numeric counts, and the verified column only when the source returned it", async () => {
    const wb = await load(payloadFor("posts", [{ tweet_id: "1", text: "مباراة كرة السلة", author_username: "a", created_at: "2026-10-15T09:00:00Z", likes: "1.2K", retweets: 3, is_blue_verified: true }]));
    const sheet = wb.worksheets[0];
    const headers = (sheet.getRow(1).values as any[]).slice(1).map(String);
    expect(headers.every((h) => !/[A-Za-z]/.test(h))).toBe(true);
    expect(headers).toContain("حساب موثّق");
    const row = sheet.getRow(2);
    expect(row.getCell(headers.indexOf("تاريخ ووقت النشر") + 1).value).toBe("2026-10-15 09:00");
    expect(row.getCell(headers.indexOf("عدد الإعجابات") + 1).value).toBe(1200);
    expect(row.getCell(headers.indexOf("حساب موثّق") + 1).value).toBe("نعم");
    const noFlag = await load(payloadFor("posts", [{ tweet_id: "2", text: "نص", created_at: "2026-10-15" }]));
    expect(((noFlag.worksheets[0].getRow(1).values as any[]).slice(1).map(String))).not.toContain("حساب موثّق");
  });

  it("social uncertain rows get a review sheet that says plainly they were not charged", async () => {
    const wb = await load(payloadFor("comments", [{ cid: "1", text: "كرة السلة", user_nickname: "a" }], [{ cid: "9", text: "كرة السلة وكرة القدم", _relevance_reason: "يذكر السجل كرة السلة وكرة القدم معاً" }]));
    const review = wb.getWorksheet("سجلات تحتاج مراجعة")!;
    expect(String(review.getRow(1).getCell(1).value)).toBe(REVIEW_SHEET_NOTICE_AR);
    expect(String(review.getRow(3).getCell(2).value)).toContain("كرة السلة وكرة القدم");
    expect(String(review.getRow(3).getCell(4).value)).toContain("كرة السلة وكرة القدم");
  });

  it("with no uncertain rows there is no review sheet", async () => {
    const wb = await load(payloadFor("videos", [{ video_id: "1", title: "فيديو", views: "12K views" }]));
    expect(wb.worksheets.map((s) => s.name)).not.toContain("سجلات تحتاج مراجعة");
  });

  it("people: the review sheet lists reviewed people with the same plain notice", async () => {
    const wb = await load({
      metadata: { platform: "people", entityType: "people", title: "صناع القرار", jobId: "j", collectedAt: "2026-10-17T10:00:00.000Z" },
      rows: [{ id: "p1", full_name: "A B", job_title: "Director", company_name: "Co", work_email: "a@co.example" }],
      uncertainRows: [{ id: "p2", full_name: "C D", job_title: "Manager", company_name: "Co2", linkedin_url: "https://www.linkedin.com/in/cd", _relevance_reason: "مراجعة" }],
    });
    const review = wb.getWorksheet("سجلات تحتاج مراجعة")!;
    expect(String(review.getRow(1).getCell(1).value)).toBe(REVIEW_SHEET_NOTICE_AR);
    expect(String(review.getRow(3).getCell(2).value)).toContain("C D");
  });
});
