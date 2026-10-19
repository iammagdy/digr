import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { companyActivityKeywords, evidenceText, hasActivityEvidence, keywordPhrases, stemEnglish } from "../src/lib/server/relevanceEvidence";
import { decideCompanyRow, isGroundedEvidence, type CompanyReviewVerdict } from "../src/lib/server/relevanceDecision";
import {
  REVIEW_TOOL_NAME, REVIEW_BATCH_SIZE, callClaudeCompanyReviewer, parseReviewToolInput, runCompanyReview, summarizeCompanyRowForReview,
  type CompanyReviewAttempt, type CompanyReviewRequest, type CompanyReviewerFn,
} from "../src/lib/server/companyRelevanceReview";
import { resetProviderKeyCache } from "../src/lib/server/providerKeys";
import { ELECTRICITY_CONTEXT, contractor, empty, foreign, repair, trader, utility } from "./fixtures/relevance-rows";

const KEYWORDS = ["electrical", "electricity"];
const verdict = (index: number, coreActivity: CompanyReviewVerdict["coreActivity"], evidence = "", extra: Partial<CompanyReviewVerdict> = {}): CompanyReviewVerdict =>
  ({ index, coreActivity, countryOk: "yes", evidence, reasonAr: "سبب قصير", ...extra });

describe("positive evidence of the requested activity (never the source label)", () => {
  it("keywords of the request meet the row's own text across word forms", () => {
    expect(stemEnglish("electrical")).toBe(stemEnglish("electricity"));
    expect(stemEnglish("electric")).toBe(stemEnglish("electrical"));
    expect(stemEnglish("contracting")).toBe(stemEnglish("contractor"));
    expect(keywordPhrases(["electrical engineering"])).toEqual([[stemEnglish("electrical"), stemEnglish("engineering")]]);
  });

  it("a row with the activity in its own text has evidence; a row with only the label or an empty description does not", () => {
    expect(hasActivityEvidence(contractor, KEYWORDS)).toBe(true);
    expect(hasActivityEvidence(utility, KEYWORDS)).toBe(true);
    expect(hasActivityEvidence({ company_name: "Delta Group", industry: "Electrical/Electronic Manufacturing", description: "" }, KEYWORDS)).toBe(false);
    expect(hasActivityEvidence(empty, KEYWORDS)).toBe(false);
    expect(hasActivityEvidence(contractor, [])).toBe(false);
    expect(evidenceText(contractor)).not.toContain("Electrical/Electronic Manufacturing");
  });

  it("keywords come from the planner's query and the detected sector, Latin words only", () => {
    expect(companyActivityKeywords({ query: { keyword: { include: ["electrical", "الكهرباء"] } }, activityKeywords: ["power"] })).toEqual(["electrical", "power"]);
    expect(companyActivityKeywords({})).toEqual([]);
  });
});

describe("the gate on the five-kind fixture: a label alone never delivers", () => {
  const rows = { contractor, utility, trader, repair, empty, foreign };

  it("candidates are the four rows with evidence; the empty row and the foreign row never reach the reviewer", () => {
    const decisions = Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, evaluateResearchRowRelevance(row, ELECTRICITY_CONTEXT).decision]));
    expect(decisions).toEqual({ contractor: "match", utility: "match", trader: "match", repair: "match", empty: "uncertain", foreign: "no_match" });
  });

  it("a row that matched on the source label alone is demoted to review with a code, not delivered", () => {
    const labelOnly = { company_name: "Delta Group", industry: "Utilities", description: "Electric power grid maintenance services", location: "Cairo, Egypt" };
    // text evidence present: stays a candidate
    expect(evaluateResearchRowRelevance(labelOnly, ELECTRICITY_CONTEXT).decision).toBe("match");
    // the same label and nothing in the text: demoted by the evidence rule (here the label-only branch is reached via the sector rule)
    const noText = { company_name: "Atlas Holding", industry: "Electrical/Electronic Manufacturing", description: "Diversified group", location: "Cairo, Egypt" };
    const result = evaluateResearchRowRelevance(noText, ELECTRICITY_CONTEXT);
    expect(result.decision).toBe("uncertain");
  });

  it("without the planner's keywords the sector's own English words are used, so a request that carries only its sector label still judges rows", () => {
    const sectorOnly = { capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", params: { country: "Egypt", industry: "الكهرباء والطاقة الكهربائية" } };
    expect(evaluateResearchRowRelevance(utility, sectorOnly).decision).toBe("match");
  });
});

describe("decideCompanyRow: code decides, Claude only informs", () => {
  const det = (row: Record<string, any>) => evaluateResearchRowRelevance(row, ELECTRICITY_CONTEXT);
  const decide = (row: Record<string, any>, v: CompanyReviewVerdict | undefined) => decideCompanyRow({ deterministic: det(row), verdict: v, row, keywords: KEYWORDS });

  it("the five fixture kinds end as the request needs", () => {
    expect(decide(contractor, verdict(0, "core", "Electrical contracting")).decision).toBe("match");
    expect(decide(utility, verdict(1, "core", "Distributes electricity")).decision).toBe("match");
    expect(decide(trader, verdict(2, "adjacent", "source electrical equipment")).decision).toBe("uncertain");
    expect(decide(repair, verdict(3, "adjacent", "Repair of washing machines")).decision).toBe("uncertain");
    // empty and foreign were decided by the deterministic gate; a review cannot change them
    expect(decide(empty, verdict(4, "core", "Delta Group")).decision).toBe("uncertain");
    expect(decide(empty, verdict(4, "core", "Delta Group")).reasonCode).toBe("deterministic");
    expect(decide(foreign, verdict(5, "core", "Electrical engineering and power distribution")).decision).toBe("no_match");
  });

  it("Claude never promotes: a deterministic uncertain or no_match stays, whatever the verdict", () => {
    for (const row of [empty, foreign]) {
      const out = decide(row, verdict(0, "core", "Electrical engineering", { countryOk: "yes" }));
      expect(out.decision).not.toBe("match");
    }
  });

  it("no verdict for a candidate fails closed: review sheet, code review_unavailable", () => {
    const out = decide(contractor, undefined);
    expect(out).toMatchObject({ decision: "uncertain", reasonCode: "review_unavailable" });
    expect(out.reasonAr).toContain("تعذّر التحقق الآلي");
  });

  it("an unrelated activity or another country is excluded; adjacent or unknown goes to review", () => {
    expect(decide(contractor, verdict(0, "unrelated")).decision).toBe("no_match");
    expect(decide(contractor, verdict(0, "core", "Electrical contracting", { countryOk: "no" })).decision).toBe("no_match");
    expect(decide(contractor, verdict(0, "unknown")).decision).toBe("uncertain");
    expect(decide(contractor, verdict(0, "adjacent")).decision).toBe("uncertain");
  });

  it("a quote that is not in the row's own text is not evidence (including the source label)", () => {
    const ungrounded = decide(utility, verdict(1, "core", "Electrical contracting"));
    expect(ungrounded).toMatchObject({ decision: "uncertain", reasonCode: "evidence_not_grounded" });
    const label = decide(utility, verdict(1, "core", "Utilities and more"));
    expect(label.decision).toBe("uncertain");
    expect(isGroundedEvidence("Utilities", utility)).toBe(false);
    expect(isGroundedEvidence("short", utility)).toBe(false);
    expect(isGroundedEvidence("distributes ELECTRICITY to residential", utility)).toBe(true);
  });

  it("a grounded quote that does not show the requested activity does not deliver (label-only case)", () => {
    const waterSupply = { company_name: "Aqua Co", industry: "Utilities", description: "Water supply for towns", location: "Cairo, Egypt" };
    const out = decideCompanyRow({ deterministic: { decision: "match", reasonAr: "x" }, verdict: verdict(0, "core", "Water supply for towns"), row: waterSupply, keywords: KEYWORDS });
    expect(out).toMatchObject({ decision: "uncertain", reasonCode: "evidence_not_activity" });
  });

  it("the model's reason is cleaned and never carries a vendor name", () => {
    const out = decide(contractor, verdict(0, "unrelated", "", { reasonAr: "حسب Claude من Anthropic <b>x</b>" }));
    expect(out.reasonAr).not.toMatch(/claude|anthropic|<|>/i);
  });
});

describe("the structured review request and reply", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, ANTHROPIC_API_KEY: "test-anthropic-key" };
    delete process.env.LLM_PROVIDER; delete process.env.LLM_ENABLED; delete process.env.LLM_LIVE; delete process.env.LLM_MODEL; delete process.env.ANTHROPIC_MODEL;
    resetProviderKeyCache();
  });
  afterEach(() => {
    process.env = originalEnv;
    resetProviderKeyCache();
    vi.unstubAllGlobals();
  });

  const request: CompanyReviewRequest = { customerRequest: "عايز شركتين كهرباء في مصر", activityKeywords: KEYWORDS, country: "Egypt", rows: [{ index: 0, row: contractor }, { index: 3, row: trader }] };
  const okReply = (reviews: unknown[]) => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", name: REVIEW_TOOL_NAME, input: { reviews } }], usage: { input_tokens: 700, output_tokens: 90 } }) });

  it("uses the chat client's proven shape: headers, one forced tool, no sampling parameters, no strict flag", async () => {
    let call: { url: string; init: any } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { call = { url, init }; return okReply([]); }));
    await callClaudeCompanyReviewer(request, { timeoutMs: 5000 });
    expect(call!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call!.init.method).toBe("POST");
    expect(call!.init.headers).toEqual({ "Content-Type": "application/json", "x-api-key": "test-anthropic-key", "anthropic-version": "2023-06-01" });
    const body = JSON.parse(call!.init.body);
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "system", "tool_choice", "tools"]);
    for (const forbidden of ["temperature", "top_p", "top_k"]) expect(body).not.toHaveProperty(forbidden);
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.tool_choice).toEqual({ type: "tool", name: "submit_reviews" });
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe("submit_reviews");
    expect(body.tools[0]).not.toHaveProperty("strict");
    expect(body.tools[0].input_schema.properties.reviews.items.required).toEqual(["index", "coreActivity", "countryOk", "evidence", "reasonAr"]);
    expect(body.messages).toHaveLength(1);
    const user = JSON.parse(body.messages[0].content);
    expect(user.rows.map((r: any) => r.index)).toEqual([0, 3]);
    // the source's category is labelled as such and never passed as a plain "industry" field
    expect(user.rows[0].source_label).toBe("Electrical/Electronic Manufacturing");
    expect(user.rows[0]).not.toHaveProperty("industry");
    expect(body.system).toContain("source_label");
    expect(body.system).toContain("NOT evidence");
  });

  it("reads the forced tool's input into verdicts for the rows asked about only, and reports the usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okReply([
      { index: 0, coreActivity: "core", countryOk: "yes", evidence: "Electrical contracting", reasonAr: "مقاول كهرباء" },
      { index: 3, coreActivity: "adjacent", countryOk: "yes", evidence: "source electrical equipment", reasonAr: "تاجر معدات" },
      { index: 9, coreActivity: "core", countryOk: "yes", evidence: "x", reasonAr: "صف لم يُطلب" },
      { index: 0, coreActivity: "unrelated", countryOk: "yes", evidence: "", reasonAr: "تكرار" },
      { index: 1, coreActivity: "maybe", countryOk: "yes", evidence: "", reasonAr: "قيمة غير صالحة" },
    ])));
    const result = await callClaudeCompanyReviewer(request, { timeoutMs: 5000 });
    expect(result.failure).toBeNull();
    expect([...result.verdicts.keys()].sort()).toEqual([0, 3]);
    expect(result.verdicts.get(0)!.coreActivity).toBe("core");
    expect(result.usage).toMatchObject({ inputTokens: 700, outputTokens: 90, model: "claude-haiku-5-5" });
    expect(result.usage!.costUsd).toBeGreaterThan(0);
  });

  it("failures are returned as codes, never thrown: http status, timeout, network, missing key, disabled, unusable reply (billed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, text: async () => "bad" })));
    expect((await callClaudeCompanyReviewer(request, { timeoutMs: 5000 })).failure).toBe("http_400");
    vi.stubGlobal("fetch", vi.fn(async () => { const e: any = new Error("aborted"); e.name = "AbortError"; throw e; }));
    expect((await callClaudeCompanyReviewer(request, { timeoutMs: 5000 })).failure).toBe("timeout");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket"); }));
    expect((await callClaudeCompanyReviewer(request, { timeoutMs: 5000 })).failure).toBe("network");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "no tool" }], usage: { input_tokens: 500, output_tokens: 20 } }) })));
    const bad = await callClaudeCompanyReviewer(request, { timeoutMs: 5000 });
    expect(bad.failure).toBe("bad_reply");
    expect(bad.usage).toMatchObject({ inputTokens: 500, outputTokens: 20 });

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    process.env.LLM_ENABLED = "false";
    expect((await callClaudeCompanyReviewer(request, { timeoutMs: 5000 })).failure).toBe("disabled");
    process.env.LLM_ENABLED = "true"; process.env.LLM_PROVIDER = "fake";
    expect((await callClaudeCompanyReviewer(request, { timeoutMs: 5000 })).failure).toBe("disabled");
    delete process.env.LLM_PROVIDER; process.env.LLM_LIVE = "false";
    expect((await callClaudeCompanyReviewer(request, { timeoutMs: 5000 })).failure).toBe("disabled");
    delete process.env.LLM_LIVE; delete process.env.ANTHROPIC_API_KEY; resetProviderKeyCache();
    expect((await callClaudeCompanyReviewer(request, { timeoutMs: 5000 })).failure).toBe("no_key");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parseReviewToolInput: a reply without a reviews array is unusable", () => {
    expect(parseReviewToolInput({ foo: 1 }, new Set([0]))).toBeNull();
    expect(parseReviewToolInput(null, new Set([0]))).toBeNull();
    expect(parseReviewToolInput({ reviews: [] }, new Set([0]))!.size).toBe(0);
  });

  it("the row summary is short, secret-free and labels the source category", () => {
    const summary = summarizeCompanyRowForReview({ ...contractor, description: "x".repeat(900), website: "https://a.example", token: "SECRET" } as any);
    expect(summary.description.length).toBeLessThanOrEqual(300);
    expect(summary.source_label).toBe("Electrical/Electronic Manufacturing");
    expect(JSON.stringify(summary)).not.toContain("SECRET");
  });
});

describe("runCompanyReview: retry on the SAME rows, 2/4/8 s backoff, only while time allows", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ index: i, row: contractor }));
  const okAttempt = (indexes: number[]): CompanyReviewAttempt => ({
    verdicts: new Map(indexes.map((i) => [i, verdict(i, "core", "Electrical contracting")])),
    usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.0001, model: "claude-haiku-5-5", latencyMs: 5 },
    failure: null,
  });
  const failed = (failure: string): CompanyReviewAttempt => ({ verdicts: new Map(), usage: null, failure });
  const base = (reviewer: CompanyReviewerFn, n = 2) => {
    const sleeps: number[] = [];
    const attempts: CompanyReviewAttempt[] = [];
    const retries: number[] = [];
    return {
      sleeps, attempts, retries,
      options: {
        reviewer, request: { customerRequest: "x", activityKeywords: KEYWORDS, country: "Egypt", rows: rows(n) },
        deadlineMs: 1_000_000, now: () => 0, sleep: async (ms: number) => { sleeps.push(ms); },
        onAttempt: (a: CompanyReviewAttempt) => { attempts.push(a); }, onRetry: (nextAttempt: number) => { retries.push(nextAttempt); },
      },
    };
  };

  it("first attempt succeeds: one call, no sleep, no retry note", async () => {
    const reviewer = vi.fn(async (req: CompanyReviewRequest) => okAttempt(req.rows.map((r) => r.index)));
    const t = base(reviewer);
    const outcome = await runCompanyReview(t.options);
    expect(outcome).toMatchObject({ failure: null, attempts: 1 });
    expect(outcome.verdicts.size).toBe(2);
    expect(t.sleeps).toEqual([]);
    expect(t.retries).toEqual([]);
    expect(t.attempts).toHaveLength(1);
  });

  it("two timeouts then success: 3 calls on the same rows, sleeps 2 s then 4 s, a retry note before each retry, every attempt reported", async () => {
    const seen: number[][] = [];
    let n = 0;
    const reviewer: CompanyReviewerFn = async (req) => { seen.push(req.rows.map((r) => r.index)); n += 1; return n < 3 ? failed("timeout") : okAttempt(req.rows.map((r) => r.index)); };
    const t = base(reviewer);
    const outcome = await runCompanyReview(t.options);
    expect(outcome).toMatchObject({ failure: null, attempts: 3 });
    expect(seen).toEqual([[0, 1], [0, 1], [0, 1]]);
    expect(t.sleeps).toEqual([2000, 4000]);
    expect(t.retries).toEqual([2, 3]);
    expect(t.attempts).toHaveLength(3);
  });

  it("always failing with a retryable code: 3 calls, then the failure is returned (the caller fails closed)", async () => {
    const t = base(async () => failed("http_529"));
    const outcome = await runCompanyReview(t.options);
    expect(outcome).toMatchObject({ failure: "http_529", attempts: 3 });
    expect(outcome.verdicts.size).toBe(0);
  });

  it("a failure that cannot change (a rejected request, no key, disabled) is not retried", async () => {
    for (const code of ["http_400", "http_401", "no_key", "disabled"]) {
      const t = base(async () => failed(code));
      const outcome = await runCompanyReview(t.options);
      expect(outcome).toMatchObject({ failure: code, attempts: 1 });
      expect(t.sleeps).toEqual([]);
    }
  });

  it("no time left for another attempt: no further call is made", async () => {
    const reviewer = vi.fn(async () => failed("timeout"));
    const t = base(reviewer);
    // 10 s per attempt + 2 s backoff must fit before the deadline; here only the first attempt fits
    const outcome = await runCompanyReview({ ...t.options, deadlineMs: 11_000 });
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(outcome.attempts).toBe(1);
    expect(outcome.failure).toBe("timeout");
    const none = await runCompanyReview({ ...t.options, deadlineMs: 5_000 });
    expect(none).toMatchObject({ attempts: 0, failure: "time_budget" });
  });

  it("a reply that leaves rows out is followed by a call about those rows only", async () => {
    const seen: number[][] = [];
    let n = 0;
    const reviewer: CompanyReviewerFn = async (req) => { seen.push(req.rows.map((r) => r.index)); n += 1; return n === 1 ? okAttempt([0]) : okAttempt(req.rows.map((r) => r.index)); };
    const outcome = await runCompanyReview(base(reviewer).options);
    expect(seen).toEqual([[0, 1], [1]]);
    expect(outcome.verdicts.size).toBe(2);
    expect(outcome.failure).toBeNull();
  });

  it("rows are reviewed in batches of 25, at most 50 rows; the rest is reported as not reviewed", async () => {
    const sizes: number[] = [];
    const reviewer: CompanyReviewerFn = async (req) => { sizes.push(req.rows.length); return okAttempt(req.rows.map((r) => r.index)); };
    const outcome = await runCompanyReview(base(reviewer, 60).options);
    expect(REVIEW_BATCH_SIZE).toBe(25);
    expect(sizes.sort((a, b) => a - b)).toEqual([25, 25]);
    expect(outcome.verdicts.size).toBe(50);
    expect(outcome.failure).toBe("too_many_rows");
  });

  it("a reviewer that throws is a failed attempt, not a crash", async () => {
    const t = base(async () => { throw new Error("boom"); });
    const outcome = await runCompanyReview(t.options);
    expect(outcome.failure).toBe("network");
    expect(outcome.attempts).toBe(3);
  });
});
