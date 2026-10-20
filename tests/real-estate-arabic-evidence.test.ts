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

import { arabicKeywordPhrases, companyActivityKeywords, hasActivityEvidence, stemArabic } from "../src/lib/server/relevanceEvidence";
import { decideCompanyRow } from "../src/lib/server/relevanceDecision";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { evaluateDeterministicRelevance } from "../src/lib/server/relevanceValidationLayer";

/**
 * The live failure: «عايز ٣ شركات تطوير عقاري في السعودية». The quote's params (copied from the stored row) carry English keywords
 * only («real estate») and the Arabic label; the provider's rows were labelled «Real Estate» but their own text was Arabic or
 * used other words. No row had evidence, so none reached the reviewer and the job delivered nothing. The customer's own Arabic
 * activity words are evidence too, read from the row's own text, never from its label.
 */
const QUOTE_PARAMS = {
  query: { keyword: { include: ["real estate"] }, industry: { include: ["Real Estate"] }, location: { include: ["Saudi Arabia"] } },
  search: "التطوير العقاري في المملكة العربية السعودية",
  country: "Saudi Arabia",
  industry: "التطوير العقاري",
  location: "Saudi Arabia",
  pagination: { size: 3 },
};

const arabicDeveloper = { company_name: "شركة الرياض للتطوير العقاري", industry: "Real Estate", description: "شركة سعودية رائدة في التطوير العقاري وتنفيذ المشاريع السكنية والتجارية في الرياض وجدة.", location: "Riyadh, Saudi Arabia" };
const englishDeveloper = { company_name: "Al Noor Development Co.", industry: "Real Estate", description: "Real estate developer delivering residential communities and commercial towers across Saudi Arabia.", location: "Jeddah, Saudi Arabia" };
const arabicBroker = { company_name: "مكتب النخبة للوساطة العقارية", industry: "Real Estate", description: "وساطة عقارية لبيع وتأجير الشقق والفلل وإدارة الأملاك للملاك والمستأجرين.", location: "Riyadh, Saudi Arabia" };
const englishPortal = { company_name: "Bayt Listings", industry: "Real Estate", description: "Online real estate portal that lists properties for sale and rent from agents and owners.", location: "Riyadh, Saudi Arabia" };
const arabicUnrelated = { company_name: "مطاعم الواحة", industry: "Real Estate", description: "سلسلة مطاعم ومأكولات شعبية تقدم الوجبات السريعة والعائلية.", location: "Riyadh, Saudi Arabia" };
const emptyDescription = { company_name: "Gulf Group", industry: "Real Estate", description: "", location: "Riyadh, Saudi Arabia" };
const outsideCountry = { company_name: "Dubai Towers Development", industry: "Real Estate", description: "Real estate developer of towers in Dubai.", location: "Dubai, United Arab Emirates" };

const KEYWORDS = [...companyActivityKeywords(QUOTE_PARAMS), "real estate"];

describe("Arabic activity words are evidence, read from the row's own text", () => {
  it("the live cause: English keywords alone find nothing in an Arabic description; the customer's Arabic label does", () => {
    expect(hasActivityEvidence(arabicDeveloper, ["real estate"])).toBe(false);
    expect(companyActivityKeywords(QUOTE_PARAMS)).toEqual(["real estate", "التطوير العقاري"]);
    expect(hasActivityEvidence(arabicDeveloper, companyActivityKeywords(QUOTE_PARAMS))).toBe(true);
  });

  it("stems meet across the normal Arabic variants: definite article, plural, feminine, relative, agent noun, spelling", () => {
    expect(stemArabic("العقارات")).toBe(stemArabic("عقاري"));
    expect(stemArabic("العقارية")).toBe(stemArabic("عقار"));
    expect(stemArabic("التطوير")).toBe(stemArabic("المطورين"));
    expect(stemArabic("مطوّر")).toBe(stemArabic("تطوير"));
    expect(stemArabic("إنشاءات")).toBe(stemArabic("الانشاء"));
    expect(stemArabic("مدينة")).toBe(stemArabic("مدينه"));
  });

  it("every word of the phrase is needed: a broker is not evidence of a developer; a developer in another wording is", () => {
    expect(arabicKeywordPhrases(["التطوير العقاري"])).toEqual([[stemArabic("تطوير"), stemArabic("عقار")]]);
    expect(hasActivityEvidence(arabicBroker, KEYWORDS)).toBe(false);
    expect(hasActivityEvidence({ description: "مطورون عقاريون ننفذ مجمعات سكنية" }, KEYWORDS)).toBe(true);
    expect(hasActivityEvidence({ description: "نطور العقارات السكنية والتجارية" }, KEYWORDS)).toBe(false);
  });

  it("a conjunction starts a new phrase, so «الأدوية والرعاية الصحية» does not need both halves in one row", () => {
    expect(arabicKeywordPhrases(["الأدوية والرعاية الصحية"]).length).toBe(2);
    expect(hasActivityEvidence({ description: "مصنع أدوية في الدمام" }, ["الأدوية والرعاية الصحية"])).toBe(true);
  });

  it("the industry label is never evidence, whatever the language", () => {
    expect(hasActivityEvidence({ industry: "التطوير العقاري", company_name: "X", description: "" }, KEYWORDS)).toBe(false);
    expect(hasActivityEvidence({ industry: "Real Estate", company_name: "Y", description: "" }, KEYWORDS)).toBe(false);
  });

  it("the gate on the stored params: Arabic and English developers match, brokers, portal-less rows and empty text wait for review", () => {
    const context = { capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", params: QUOTE_PARAMS as any };
    const decide = (row: Record<string, any>) => evaluateResearchRowRelevance(row, context);
    expect(decide(arabicDeveloper).decision).toBe("match");
    expect(decide(englishDeveloper).decision).toBe("match");
    expect(decide(englishPortal).decision).toBe("match"); // reaches the reviewer, which must say adjacent
    expect(decide(arabicBroker)).toMatchObject({ decision: "uncertain", reasonCode: "no_evidence" });
    expect(decide(arabicUnrelated)).toMatchObject({ decision: "uncertain", reasonCode: "no_evidence" });
    expect(decide(emptyDescription)).toMatchObject({ decision: "uncertain", reasonCode: "no_evidence" });
    expect(decide(outsideCountry).decision).toBe("no_match");
  });

  it("the reviewer's quote in Arabic counts as activity evidence, and a quote that shows nothing does not", () => {
    const deterministic = { decision: "match" as const, reasonAr: "x" };
    const verdict = (evidence: string) => ({ index: 0, coreActivity: "core" as const, countryOk: "yes" as const, evidence, reasonAr: "تقدير آلي" });
    expect(decideCompanyRow({ deterministic, verdict: verdict("التطوير العقاري وتنفيذ المشاريع"), row: arabicDeveloper, keywords: KEYWORDS })).toMatchObject({ decision: "match", reasonCode: "reviewed_match" });
    expect(decideCompanyRow({ deterministic, verdict: verdict("شركة سعودية رائدة"), row: arabicDeveloper, keywords: KEYWORDS })).toMatchObject({ decision: "uncertain", reasonCode: "evidence_not_activity" });
    expect(decideCompanyRow({ deterministic, verdict: verdict("التطوير العقاري في دبي"), row: arabicDeveloper, keywords: KEYWORDS })).toMatchObject({ decision: "uncertain", reasonCode: "evidence_not_grounded" });
  });

  it("the reviewer is told the rows may be Arabic and that brokers, agents and portals are adjacent", async () => {
    const source = (await import("fs")).readFileSync("src/lib/server/companyRelevanceReview.ts", "utf8");
    expect(source).toContain("may be in Arabic or English");
    expect(source).toContain("broker, agent, marketplace, listing portal, supplier or service provider");
    expect(source).toContain("the developer that plans, builds and sells its own projects is core");
  });
});

describe("every sector's Arabic label is read back as the sector it names", () => {
  it("detectIndustryFromText(label) gives the sector's taxonomy for every label that has one (the live cause for «التطوير العقاري»)", async () => {
    const { readFileSync } = await import("fs");
    const { detectIndustryFromText } = await import("../src/lib/planParameters");
    const source = readFileSync("src/lib/planParameters.ts", "utf8");
    const labels = [...source.matchAll(/arabicLabel:\s*"([^"]+)",\s*(?:\/\/[^\n]*\n\s*)*exactTaxonomy/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThanOrEqual(15);
    expect(labels).toContain("التطوير العقاري");
    for (const label of labels) expect((detectIndustryFromText(label).exactTaxonomy || []).length, label).toBeGreaterThan(0);
    expect(detectIndustryFromText("التطوير العقاري").exactTaxonomy).toEqual(["Real Estate"]);
    expect(detectIndustryFromText("شركات تطوير عقاري").exactTaxonomy).toEqual(["Real Estate"]);
  });

  it("the deterministic layer has a rule for the stored label: a row filed under «Real Estate» is a candidate, a row filed elsewhere is not", () => {
    const row = { company_name: "X", description: "d", location: "Riyadh, Saudi Arabia" };
    expect(evaluateDeterministicRelevance({ ...row, industry: "Real Estate" }, "Saudi Arabia", "التطوير العقاري").decision).toBe("match");
    expect(evaluateDeterministicRelevance({ ...row, industry: "Restaurants" }, "Saudi Arabia", "التطوير العقاري").decision).toBe("uncertain");
  });
});

const JOB = jobIdForQuote("quote_realestate");
const usage = { inputTokens: 900, outputTokens: 120, costUsd: 0.0009, model: "claude-haiku-5-5", latencyMs: 40 };

function resetDb(target = 3) {
  db.jobs = [{ id: JOB, user_id: "user_1", status: "running", step: 0, current_cursor: null, delivered_units: 0, target_volume_max: target, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  db.quotes = [{ id: "quote_realestate", user_id: "user_1", items: [{ capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", params: QUOTE_PARAMS, targetVolumeMax: target, paginationStrategy: "none", unitCostUsd: 0.00038, pricingUnit: "item" }], output_formats: ["xlsx"] }];
  db.partials.clear(); db.results.clear(); db.rpcCalls = []; db.events = []; db.llmUsage = [];
  db.step = 0; db.cursor = null; db.deliveredUnits = 0; db.targetVolumeMax = target; db.unitPrice = 3; db.reserved = Math.ceil(target * 3 * 1.15);
}

describe("worker, the stored real-estate quote: developers are delivered with grounded evidence", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV, LLM_ENABLED: process.env.LLM_ENABLED, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    process.env.CRON_SECRET = "re-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    delete process.env.LLM_ENABLED;
    resetProviderKeyCache();
    setCompanyReviewTimingForTesting({ sleep: async () => {} });
    setRowAdvisorForTesting(async () => { throw new Error("the legacy advisor must not run"); });
  });
  afterEach(() => {
    setProviderAdapterForTesting(null);
    setCompanyReviewerForTesting(null);
    setCompanyReviewTimingForTesting(null);
    setRowAdvisorForTesting(null);
    resetProviderKeyCache();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
  });

  async function run(rows: Record<string, any>[]) {
    const route = await import("../src/app/api/worker/chunk/route");
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows, nextCursor: null, costUsd: 0.00342, costMicro: 3420, tregCallId: "call_1" }));
    let last: any = null;
    for (let i = 0; i < 4; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer re-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }) }));
      last = { status: res.status, json: await res.json() };
      if (last.json.done === true || last.json.released === true || last.status >= 400) break;
    }
    return last;
  }
  async function workbook() {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(db.results.get(`user_1/${JOB}/result.xlsx`)! as any);
    return wb;
  }
  const textOf = (sheet: ExcelJS.Worksheet) => { let text = ""; sheet.eachRow((row) => row.eachCell((cell) => { text += ` ${String(cell.value)}`; })); return text; };
  const names = () => db.rpcCalls.map((c) => c.name);

  const reviewer: CompanyReviewerFn = async (request) => ({
    verdicts: new Map(request.rows.map(({ index, row }) => {
      const developer = row.company_name === arabicDeveloper.company_name || row.company_name === englishDeveloper.company_name;
      const evidence = row.company_name === arabicDeveloper.company_name ? "التطوير العقاري وتنفيذ المشاريع" : row.company_name === englishDeveloper.company_name ? "Real estate developer delivering residential communities" : "lists properties for sale and rent";
      return [index, { index, coreActivity: developer ? "core" as const : "adjacent" as const, countryOk: "yes" as const, evidence, reasonAr: "تقدير آلي" }];
    })),
    usage,
    failure: null,
  });

  it("the Arabic and the English developer are delivered and charged; brokers, portal, unrelated and empty rows go to review; the foreign row is excluded", async () => {
    resetDb(3);
    const asked: number[][] = [];
    setCompanyReviewerForTesting(async (request, options) => { asked.push(request.rows.map((r) => r.index)); return reviewer(request, options); });
    const result = await run([arabicDeveloper, englishDeveloper, arabicBroker, englishPortal, arabicUnrelated, emptyDescription, outsideCountry]);
    // only rows with evidence in their own text and the right country reach the reviewer: the two developers and the portal
    expect(asked).toEqual([[0, 1, 3]]);
    expect(result.json).toMatchObject({ done: true, deliveredUnits: 2 });
    expect(names()).toContain("settle_job_atomic");
    expect(names()).not.toContain("release_job_atomic");
    expect(result.json.settle).toMatchObject({ charged_credits: 6, reserved_credits: 11 });
    const wb = await workbook();
    const delivered = textOf(wb.getWorksheet("بيانات الشركات")!);
    expect(wb.getWorksheet("بيانات الشركات")!.rowCount).toBe(3); // header + 2
    expect(delivered).toContain("شركة الرياض للتطوير العقاري");
    expect(delivered).toContain("Al Noor Development");
    const review = textOf(wb.getWorksheet("سجلات تحتاج مراجعة")!);
    for (const name of ["مكتب النخبة", "Bayt Listings", "مطاعم الواحة", "Gulf Group"]) expect(review).toContain(name);
    expect(review).not.toContain("Dubai Towers");
    expect(delivered).not.toContain("Bayt Listings");
    expect(db.llmUsage).toHaveLength(1);
    expect(db.llmUsage[0]).toMatchObject({ reason: "relevance_review", tokens_in: 900 });
  });

  it("a page with only brokers and rows without evidence delivers nothing, releases the whole reserve and charges nothing", async () => {
    resetDb(3);
    const asked: number[][] = [];
    setCompanyReviewerForTesting(async (request, options) => { asked.push(request.rows.map((r) => r.index)); return reviewer(request, options); });
    const result = await run([arabicBroker, arabicUnrelated, emptyDescription]);
    expect(asked).toEqual([]);
    expect(result.json.released).toBe(true);
    expect(result.json.chargedCredits).toBe(0);
    expect(names()).not.toContain("settle_job_atomic");
  });

  it("the reviewer cannot promote a row the gate sent to review: an Arabic broker stays out even if it says core", async () => {
    resetDb(3);
    setCompanyReviewerForTesting(async (request) => ({
      verdicts: new Map(request.rows.map(({ index, row }) => [index, { index, coreActivity: "core" as const, countryOk: "yes" as const, evidence: row === englishDeveloper ? "Real estate developer delivering residential communities" : "وساطة عقارية لبيع وتأجير الشقق", reasonAr: "تقدير آلي" }])),
      usage, failure: null,
    }));
    const result = await run([arabicBroker, englishDeveloper]);
    expect(result.json).toMatchObject({ done: true, deliveredUnits: 1 });
    expect(textOf((await workbook()).getWorksheet("بيانات الشركات")!)).not.toContain("مكتب النخبة");
    expect(db.llmUsage[0]).toMatchObject({ reason: "relevance_review" });
  });
});
