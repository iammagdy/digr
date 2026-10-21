import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { looksLikeFileShapingRequest } from "../src/lib/fileSpec";
import { resetProviderKeyCache } from "../src/lib/server/providerKeys";
import {
  isReviewCallFailure, REVIEW_COST_EVENT_TYPE, REVIEW_FAILURE_EVENT_TYPE, isCustomerVisibleJobEvent, reviewFailureEventMessage,
} from "../src/lib/server/reviewSpendLog";
import {
  applyStrictAdvisory, callClaudeRowAdvisor, parseAdvisoryReply, REVIEW_CALL_COST_ESTIMATE_USD, REVIEW_JOB_CEILING_USD, REVIEW_MIN_BUDGET_USD, RETRY_BATCH_ROWS,
  RETRY_MAX_TOKENS, reviewSocialRows, socialReviewCapUsd, SOCIAL_REVIEW_ROWS_PER_CALL, UNREVIEWED_REASON_AR, VERDICT_ONLY_MAX_TOKENS,
  type AdvisoryResult, type AdvisoryVerdict, type RowAdvisorFn,
} from "../src/lib/server/rowReviewAdvisor";
import { reviewSocialPage } from "../src/lib/server/sampledReview";

const items = (from: number, to: number, verdict = "match") => Array.from({ length: to - from }, (_, i) => `{"index":${from + i},"verdict":"${verdict}"}`);
const rowsOf = (n: number) => Array.from({ length: n }, (_, index) => ({ index, row: { text: `منشور ${index}` } }));
const usage = (costUsd: number) => ({ inputTokens: 3000, outputTokens: 400, costUsd, model: "claude-haiku-5-5", latencyMs: 10 });

describe("a reply that is cut off or damaged keeps the verdicts it completed", () => {
  it("a reply cut by the output limit with 12 of 20 verdicts: the 12 are read, the 8 rows after them have none", () => {
    const text = `{"reviews":[${items(0, 12).join(",")},{"index":12,"verd`;
    const verdicts = parseAdvisoryReply(text, { verdictOnly: true });
    expect([...verdicts.keys()]).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(verdicts.get(11)).toEqual({ verdict: "match", reasonAr: "مطابق لموضوع الطلب" });
    for (let index = 12; index < 20; index += 1) expect(verdicts.has(index), String(index)).toBe(false);
  });

  it("a cut at any point of the text never invents a verdict and never loses a complete one", () => {
    const full = `{"reviews":[${[...items(0, 5, "no_match"), ...items(5, 10)].join(",")}]}`;
    let previous = 0;
    for (let cut = 0; cut <= full.length; cut += 1) {
      const verdicts = parseAdvisoryReply(full.slice(0, cut), { verdictOnly: true });
      expect(verdicts.size).toBeGreaterThanOrEqual(previous);
      previous = verdicts.size;
      for (const [index, verdict] of verdicts) expect(verdict.verdict, `${cut}/${index}`).toBe(index < 5 ? "no_match" : "match");
    }
    expect(previous).toBe(10);
  });

  it("a reply inside a markdown fence, with text around it, or with a damaged item in the middle: every readable item counts", () => {
    const wrapped = "Here is the review:\n```json\n" + `{"reviews":[{"index":0,"verdict":"match"},{"index":1,"verdict":"maybe"},{"index":2,"verdict":"no_match"},{"index":3}` + "\n";
    const verdicts = parseAdvisoryReply(wrapped, { verdictOnly: true });
    expect([...verdicts.entries()].map(([i, v]) => `${i}:${v.verdict}`)).toEqual(["0:match", "2:no_match"]);
  });

  it("a complete valid reply is read exactly as before, and a valid reply that is not a list of reviews still gives nothing", () => {
    const full = `{"reviews":[${items(0, 4).join(",")}]}`;
    expect(parseAdvisoryReply(full, { verdictOnly: true }).size).toBe(4);
    expect(parseAdvisoryReply('{"reviews":"none"}').size).toBe(0);
    expect(parseAdvisoryReply('{"other":[{"index":0,"verdict":"match"}]}').size).toBe(0);
    expect(parseAdvisoryReply("no json at all").size).toBe(0);
    expect(parseAdvisoryReply("").size).toBe(0);
  });

  it("a reason the model adds is ignored on a salvaged reply too (verdict-only), and kept for the other kinds", () => {
    const text = '{"reviews":[{"index":0,"verdict":"no_match","reasonAr":"سبب من النموذج"},{"index":1,"verd';
    expect(parseAdvisoryReply(text, { verdictOnly: true }).get(0)).toEqual({ verdict: "no_match", reasonAr: "غير مطابق لموضوع الطلب" });
    expect(parseAdvisoryReply(text).get(0)).toEqual({ verdict: "no_match", reasonAr: "سبب من النموذج" });
  });
});

describe("the advisor call: the 4,000-token room, the compact prompt and what is recorded", () => {
  const originalFetch = globalThis.fetch;
  const saved = { key: process.env.ANTHROPIC_API_KEY, provider: process.env.LLM_PROVIDER, enabled: process.env.LLM_ENABLED, live: process.env.LLM_LIVE };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    delete process.env.LLM_PROVIDER; delete process.env.LLM_ENABLED; delete process.env.LLM_LIVE;
    resetProviderKeyCache();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [["ANTHROPIC_API_KEY", saved.key], ["LLM_PROVIDER", saved.provider], ["LLM_ENABLED", saved.enabled], ["LLM_LIVE", saved.live]] as const) {
      if (value === undefined) delete (process.env as any)[name]; else (process.env as any)[name] = value;
    }
    resetProviderKeyCache();
  });

  const input = { customerRequest: "الأسعار في مصر", kind: "social-x-posts", rows: rowsOf(20) };

  it("asks for 4,000 tokens of room (6,000 on a retry), tells the model to answer with the compact JSON and nothing else", async () => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: `{"reviews":[${items(0, 20).join(",")}]}` }], stop_reason: "end_turn", usage: { input_tokens: 3000, output_tokens: 320 } }) } as any;
    });
    await callClaudeRowAdvisor(input);
    await callClaudeRowAdvisor({ ...input, maxTokens: RETRY_MAX_TOKENS });
    expect(VERDICT_ONLY_MAX_TOKENS).toBe(4000);
    expect(RETRY_MAX_TOKENS).toBe(6000);
    expect(bodies.map((body) => body.max_tokens)).toEqual([4000, 6000]);
    const prompt = String(bodies[0].messages[0].content);
    expect(prompt).toContain("no spaces, no markdown fence, nothing before it and nothing after it");
    expect(prompt).toContain("no reasons, no notes, no other text");
    expect(prompt).not.toContain("reasonAr");
  });

  it("a reply cut at the output limit: the complete verdicts come back, with the stop reason, the tokens and the reply length; no failure", async () => {
    const text = `{"reviews":[${items(0, 12).join(",")},{"index":12,"verdict":"no_ma`;
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text }], stop_reason: "max_tokens", usage: { input_tokens: 3325, output_tokens: 4000 } }) }) as any);
    const result = await callClaudeRowAdvisor(input);
    expect(result.verdicts.size).toBe(12);
    expect(result.failure).toBeNull();
    expect(result.stopReason).toBe("max_tokens");
    expect(result.usage).toMatchObject({ inputTokens: 3325, outputTokens: 4000 });
    expect(result.replyChars).toBe(text.length);
  });

  it("a reply with no complete item at all is still a bad_reply, with the reply length recorded", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "I looked at the rows and" }], stop_reason: "max_tokens", usage: { input_tokens: 3325, output_tokens: 4000 } }) }) as any);
    const result = await callClaudeRowAdvisor(input);
    expect(result.verdicts.size).toBe(0);
    expect(result.failure).toBe("bad_reply");
    expect(result.detail).toBe("reply_chars=24");
    expect(result.replyChars).toBe(24);
  });
});

describe("a retry asks only for the rows still without a verdict, in smaller calls with more room, and never repeats the request", () => {
  /** The first call of a page answers `answered` rows (a cut reply); every later call answers all the rows it is given. */
  const cutThenGood = (answered: number, seen: Array<{ indexes: number[]; maxTokens: number | undefined }>): RowAdvisorFn => async (input) => {
    seen.push({ indexes: input.rows.map((entry) => entry.index), maxTokens: input.maxTokens });
    const rows = seen.length === 1 ? input.rows.slice(0, answered) : input.rows;
    return {
      verdicts: new Map<number, AdvisoryVerdict>(rows.map((entry) => [entry.index, { verdict: "match", reasonAr: "x" }])),
      usage: usage(0.004), failure: null, stopReason: seen.length === 1 && answered < input.rows.length ? "max_tokens" : "end_turn", replyChars: 1000,
    } satisfies AdvisoryResult;
  };

  it("20 rows, a first reply with 12 verdicts: the retry is ONE call for the 8 missing rows, with more room; the 12 are never asked again", async () => {
    const seen: Array<{ indexes: number[]; maxTokens: number | undefined }> = [];
    const outcome = await reviewSocialRows({ advisor: cutThenGood(12, seen), customerRequest: "x", kind: "social-x-posts", rows: rowsOf(20), budgetUsd: 1 });
    expect(seen).toEqual([
      { indexes: Array.from({ length: 20 }, (_, i) => i), maxTokens: undefined },
      { indexes: [12, 13, 14, 15, 16, 17, 18, 19], maxTokens: 6000 },
    ]);
    expect(outcome.verdicts.size).toBe(20);
    expect(outcome.unreviewed).toEqual([]);
    expect(outcome.stoppedBy).toBeNull();
    expect(outcome.attempts.map((attempt) => [attempt.rows, attempt.retry, attempt.missing, attempt.stopReason])).toEqual([[20, false, 8, "max_tokens"], [8, true, 0, "end_turn"]]);
    expect(outcome.attempts.map((attempt) => attempt.maxTokens)).toEqual([4000, 6000]);
  });

  it("the retry is in calls of at most 10 rows, and smaller than the call that failed", async () => {
    expect(RETRY_BATCH_ROWS).toBe(10);
    for (const [failedRows, expected] of [[25, [10, 10, 5]], [20, [10, 10]], [10, [5, 5]], [4, [2, 2]], [1, [1]]] as Array<[number, number[]]>) {
      const seen: Array<{ indexes: number[]; maxTokens: number | undefined }> = [];
      const failing: RowAdvisorFn = async (input) => {
        seen.push({ indexes: input.rows.map((entry) => entry.index), maxTokens: input.maxTokens });
        if (seen.length === 1) return { verdicts: new Map(), usage: null, failure: "timeout" };
        return { verdicts: new Map(input.rows.map((entry) => [entry.index, { verdict: "match" as const, reasonAr: "x" }])), usage: usage(0.002), failure: null };
      };
      await reviewSocialRows({ advisor: failing, customerRequest: "x", kind: "social-x-posts", rows: rowsOf(failedRows), budgetUsd: 1 });
      // the first call is the whole page (a page of 25 or fewer); the retry calls follow, each smaller than it (a page of one row asks again with more room)
      expect(seen[0].indexes).toHaveLength(failedRows);
      expect(seen.slice(1).map((call) => call.indexes.length), String(failedRows)).toEqual(expected);
      expect(seen.slice(1).every((call) => call.maxTokens === 6000)).toBe(true);
    }
  });

  it("a retry is never the same request as the call that failed: other rows or other room, whatever the size of the page", async () => {
    for (const rows of [1, 2, 3, 7, 10, 11, 20, 25, 26, 60]) {
      const seen: Array<{ indexes: number[]; maxTokens: number | undefined }> = [];
      const failing: RowAdvisorFn = async (input) => { seen.push({ indexes: input.rows.map((entry) => entry.index), maxTokens: input.maxTokens }); return { verdicts: new Map(), usage: null, failure: "bad_reply" }; };
      await reviewSocialRows({ advisor: failing, customerRequest: "x", kind: "social-x-posts", rows: rowsOf(rows), budgetUsd: 1 });
      const signature = (call: { indexes: number[]; maxTokens: number | undefined }) => `${call.indexes.join(",")}|${call.maxTokens ?? "default"}`;
      expect(new Set(seen.map(signature)).size, `${rows} rows`).toBe(seen.length);
      // one retry call at most, because the reviewer answered nothing readable twice: it is not asked a third time
      expect(seen.length, `${rows} rows`).toBe(2);
    }
  });

  it("a row that has a verdict is never asked again, across every call of a page", async () => {
    const asked = new Map<number, number>();
    const flaky: RowAdvisorFn = async (input) => {
      for (const entry of input.rows) asked.set(entry.index, (asked.get(entry.index) ?? 0) + 1);
      // answers the even rows only, on every call
      return { verdicts: new Map(input.rows.filter((entry) => entry.index % 2 === 0).map((entry) => [entry.index, { verdict: "match" as const, reasonAr: "x" }])), usage: usage(0.003), failure: null, stopReason: "max_tokens" };
    };
    const outcome = await reviewSocialRows({ advisor: flaky, customerRequest: "x", kind: "social-x-posts", rows: rowsOf(20), budgetUsd: 1 });
    for (const [index, times] of asked) expect(times, `row ${index}`).toBe(index % 2 === 0 ? 1 : 2);
    expect(outcome.verdicts.size).toBe(10);
    expect(outcome.unreviewed).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);
  });

  it("FAIL CLOSED: rows with no verdict after the retry are not delivered, and 0 rows without a verdict are delivered", async () => {
    const seen: Array<{ indexes: number[]; maxTokens: number | undefined }> = [];
    // the first reply has 12 verdicts (8 match, 4 no match); the retry gets nothing readable
    const advisor: RowAdvisorFn = async (input) => {
      seen.push({ indexes: input.rows.map((entry) => entry.index), maxTokens: input.maxTokens });
      if (seen.length > 1) return { verdicts: new Map(), usage: usage(0.002), failure: "bad_reply", stopReason: "max_tokens" };
      return { verdicts: new Map(input.rows.slice(0, 12).map((entry) => [entry.index, entry.index < 8 ? { verdict: "match" as const, reasonAr: "مطابق لموضوع الطلب" } : { verdict: "no_match" as const, reasonAr: "غير مطابق لموضوع الطلب" }])), usage: usage(0.004), failure: null, stopReason: "max_tokens" };
    };
    const outcome = await reviewSocialPage({ advisor, customerRequest: "x", kind: "social-x-posts", rows: rowsOf(20), budgetUsd: 1 });
    expect(seen).toHaveLength(2);
    expect(outcome.unreviewed).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
    expect(outcome.unreviewedByBudget).toEqual([]);
    expect(outcome.firstCall).toMatchObject({ size: 20, reviewed: 12, off: 4, pageRejected: false });
    const reviews = rowsOf(20).map(({ index }) => ({ index, decision: "match" as const, reasonAr: "يتضمن نص السجل موضوع البحث" }));
    const applied = applyStrictAdvisory(reviews, outcome.verdicts);
    const delivered = applied.reviews.filter((review) => review.decision === "match").map((review) => review.index);
    expect(delivered).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(delivered.every((index) => outcome.verdicts.has(index))).toBe(true);
    expect(applied.unreviewed).toBe(8);
    for (const review of applied.reviews.filter((entry) => entry.index >= 12)) expect(review).toMatchObject({ decision: "uncertain", reasonAr: UNREVIEWED_REASON_AR });
    // the 4 «no match» rows are held with the standard reason of their verdict
    for (const review of applied.reviews.filter((entry) => entry.index >= 8 && entry.index < 12)) expect(review).toMatchObject({ decision: "uncertain", reasonAr: expect.stringContaining("غير مطابق") });
  });

  it("a missing key, a disabled reviewer and a refused request are not retried", async () => {
    for (const failure of ["no_key", "disabled", "http_400", "http_401"] as const) {
      let calls = 0;
      const refusing: RowAdvisorFn = async () => { calls += 1; return { verdicts: new Map(), usage: null, failure }; };
      const outcome = await reviewSocialRows({ advisor: refusing, customerRequest: "x", kind: "social-x-posts", rows: rowsOf(20), budgetUsd: 1 });
      expect(calls, failure).toBe(1);
      expect(outcome.unreviewed, failure).toHaveLength(20);
    }
    for (const failure of ["timeout", "network", "bad_reply", "http_429", "http_503"] as const) {
      let calls = 0;
      const flaky: RowAdvisorFn = async () => { calls += 1; return { verdicts: new Map(), usage: null, failure }; };
      await reviewSocialRows({ advisor: flaky, customerRequest: "x", kind: "social-x-posts", rows: rowsOf(20), budgetUsd: 1 });
      expect(calls, failure).toBe(2);
    }
  });

  it("the retry stays inside the budget: a retry the budget cannot pay for is not made, and its rows are left out because of the budget", async () => {
    const seen: number[] = [];
    // 20 rows; a call costs 0.00666; the budget 0.0083 pays for the first call and not for another
    const advisor: RowAdvisorFn = async (input) => { seen.push(input.rows.length); return { verdicts: new Map(input.rows.slice(0, 12).map((entry) => [entry.index, { verdict: "match" as const, reasonAr: "x" }])), usage: usage(0.00666), failure: null, stopReason: "max_tokens" }; };
    const outcome = await reviewSocialRows({ advisor, customerRequest: "x", kind: "social-x-posts", rows: rowsOf(20), budgetUsd: 0.0083, callCostEstimateUsd: REVIEW_CALL_COST_ESTIMATE_USD });
    expect(seen).toEqual([20]);
    expect(outcome.unreviewed).toHaveLength(8);
    expect(outcome.unreviewedByCap).toHaveLength(8);
    expect(outcome.stoppedBy).toBe("cap");
    expect(outcome.costUsd).toBeCloseTo(0.00666, 6);
  });
});

describe("the review budget guard matches the measured cost of a call", () => {
  it("a 25-row call is estimated at 0.0083 USD (a live 20-row call cost 0.00666 USD), and the one-call floor follows", () => {
    expect(REVIEW_CALL_COST_ESTIMATE_USD).toBe(0.0083);
    expect(REVIEW_MIN_BUDGET_USD).toBe(0.0083);
    expect(REVIEW_JOB_CEILING_USD).toBe(0.15);
    expect(Math.abs((REVIEW_CALL_COST_ESTIMATE_USD * 20) / SOCIAL_REVIEW_ROWS_PER_CALL - 0.00666)).toBeLessThan(0.00005);
    // the budget reviews every row the job can collect, up to the ceiling (the 20% share of the revenue is gone)
    expect(socialReviewCapUsd(30, 0.11715)).toBe(0.03984);
    expect(socialReviewCapUsd(300, 0.11715)).toBe(0.15);
    expect(socialReviewCapUsd(1000, 0.11715)).toBe(0.15);
  });
});

describe("the owner's review_failure row", () => {
  const facts = { rows: 20, failure: "bad_reply", stopReason: "max_tokens", usage: { inputTokens: 3325, outputTokens: 4000 }, maxTokens: 4000, replyChars: 9120, retry: false, missing: 20 };

  it("one internal line: code, stop reason, tokens in and out, the room asked for, the reply length and the rows missing; no row content", () => {
    expect(reviewFailureEventMessage(0, 1, facts)).toBe("review_failure step=0 call=1 retry=0 rows=20 code=bad_reply stop=max_tokens in=3325 out=4000 max_tokens=4000 reply_chars=9120 missing=20");
    expect(reviewFailureEventMessage(2, 3, { ...facts, failure: null, usage: null, replyChars: null, retry: true, missing: 3 }))
      .toBe("review_failure step=2 call=3 retry=1 rows=20 code=none stop=max_tokens in=0 out=0 max_tokens=4000 reply_chars=none missing=3");
  });

  it("is written for a failed call, a call cut at the output limit and a call that left rows without a verdict, and for no other", () => {
    expect(isReviewCallFailure(facts)).toBe(true);
    expect(isReviewCallFailure({ ...facts, failure: null, missing: 0 })).toBe(true);
    expect(isReviewCallFailure({ ...facts, failure: null, stopReason: "end_turn", missing: 2 })).toBe(true);
    expect(isReviewCallFailure({ ...facts, failure: null, stopReason: "end_turn", missing: 0 })).toBe(false);
  });

  it("is hidden from the customer's activity list, like the spend row", () => {
    expect(REVIEW_FAILURE_EVENT_TYPE).toBe("review_failure");
    expect(isCustomerVisibleJobEvent(REVIEW_FAILURE_EVENT_TYPE)).toBe(false);
    expect(isCustomerVisibleJobEvent(REVIEW_COST_EVENT_TYPE)).toBe(false);
    for (const kind of ["info", "progress", "warning", "error"]) expect(isCustomerVisibleJobEvent(kind)).toBe(true);
  });
});

describe("customer wording", () => {
  it("«شيت» is still recognised in a customer's file-shaping request", () => {
    for (const text of ["قسّم الملف شيت لكل محافظة", "شيت لكل محافظة", "ورقة لكل محافظة"]) expect(looksLikeFileShapingRequest(text), text).toBe(true);
  });
});
