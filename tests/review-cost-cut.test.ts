import { describe, expect, it } from "vitest";
import { emptyRunningSet, extendRunningSet, loadRunningSet, rebuildRunningSet, saveRunningSet } from "../src/lib/server/jobRunningSet";
import { isCustomerVisibleJobEvent, REVIEW_COST_EVENT_TYPE, reviewSpendEventMessage } from "../src/lib/server/reviewSpendLog";
import {
  advisoryMaxTokens, isVerdictOnlyKind, LOW_YIELD_ACCEPTED_BELOW, parseAdvisoryReply, REVIEW_CALL_COST_ESTIMATE_USD, reviewStopForLowYield, SOCIAL_REVIEW_ROWS_PER_CALL, UNREVIEWED_BY_BUDGET_REASON_AR,
  type AdvisoryVerdict, type RowAdvisorFn,
} from "../src/lib/server/rowReviewAdvisor";
import { PAGE_REJECT_ABOVE, PAGE_REJECT_MIN_REVIEWED, pageRejectedEventAr, reviewSocialPage } from "../src/lib/server/sampledReview";

const verdict = (v: AdvisoryVerdict["verdict"]): AdvisoryVerdict => ({ verdict: v, reasonAr: "سبب" });
const usage = (costUsd: number) => ({ inputTokens: 1500, outputTokens: 400, costUsd, model: "claude-haiku-5-5", latencyMs: 10 });
const GOOD = (i: number) => `منشور مطابق ${i}`;
const BAD = (i: number) => `منشور غير مرتبط ${i}`;
/** A page of `n` rows whose first `bad` are unrelated (the first call of a long page reads the first 25). */
const page = (n: number, bad: number) => Array.from({ length: n }, (_, i) => ({ index: i, row: { text: i < bad ? BAD(i) : GOOD(i) } }));
const advisor = (calls: number[] = [], cost = 0.004): RowAdvisorFn => async (input) => {
  calls.push(input.rows.length);
  return { verdicts: new Map(input.rows.map(({ index, row }) => [index, verdict(String(row.text).startsWith("منشور مطابق") ? "match" : "no_match")])), usage: usage(cost), failure: null };
};

describe("early page rejection: a long page whose first call is mostly unrelated is rejected without reviewing the rest", () => {
  it("the limits: rejection above 60% of the first call's rows, at least eight of them read", () => {
    expect(PAGE_REJECT_ABOVE).toBe(0.6);
    expect(PAGE_REJECT_MIN_REVIEWED).toBe(8);
  });

  it("16 of the first 25 rows unrelated (64%): ONE call, the other 15 rows of the page are rejected unreviewed, the reviewed rows keep their verdicts", async () => {
    const calls: number[] = [];
    const outcome = await reviewSocialPage({ advisor: advisor(calls), customerRequest: "x", kind: "social-x-posts", rows: page(40, 16), budgetUsd: 0.05 });
    expect(calls).toEqual([25]);
    expect(outcome.firstCall).toMatchObject({ size: 25, reviewed: 25, off: 16, pageRejected: true });
    expect(outcome.rejected).toEqual(Array.from({ length: 15 }, (_, i) => 25 + i));
    // the 25 rows reviewed were answered: nine matches among them are still confirmed, the others are not
    expect(outcome.verdicts.size).toBe(25);
    expect([...outcome.verdicts].filter(([, v]) => v.verdict === "match").map(([i]) => i)).toEqual(Array.from({ length: 9 }, (_, i) => 16 + i));
    expect(outcome.unreviewed).toEqual([]);
    expect(outcome.costUsd).toBeCloseTo(0.004, 6);
  });

  it("exactly 60% (15 of 25) is NOT rejected: the rest of the page is reviewed (a second call)", async () => {
    const calls: number[] = [];
    const outcome = await reviewSocialPage({ advisor: advisor(calls), customerRequest: "x", kind: "social-x-posts", rows: page(40, 15), budgetUsd: 0.05 });
    expect(calls).toEqual([25, 15]);
    expect(outcome.firstCall).toMatchObject({ off: 15, pageRejected: false });
    expect(outcome.rejected).toEqual([]);
    expect(outcome.verdicts.size).toBe(40);
  });

  it("a first call read for fewer than eight rows never rejects a page (the rest is reviewed as before)", async () => {
    const calls: number[] = [];
    // the reviewer answers only the first row of each call, «no match»: every row it read is unrelated, but only four were read in all (25 rows: 1, then the retry of 24 rows in calls of 10, 10 and 4: 1 each)
    const partial: RowAdvisorFn = async (input) => {
      calls.push(input.rows.length);
      return { verdicts: new Map(input.rows.slice(0, 1).map(({ index }) => [index, verdict("no_match")])), usage: usage(0.004), failure: null };
    };
    const outcome = await reviewSocialPage({ advisor: partial, customerRequest: "x", kind: "social-x-posts", rows: page(40, 40), budgetUsd: 0.05 });
    expect(outcome.firstCall).toMatchObject({ size: 25, reviewed: 4, off: 4, pageRejected: false });
    expect(outcome.rejected).toEqual([]);
    // the first 25 rows (1 answered) and their retry of 24 rows in calls of 10, 10 and 4; then the rest of the page (15 rows) and its retry in calls of 8 and 6
    expect(calls).toEqual([25, 10, 10, 4, 15, 8, 6]);
  });

  it("a page of up to 25 rows is never rejected: every row has its own verdict, however unrelated the page is", async () => {
    const calls: number[] = [];
    const outcome = await reviewSocialPage({ advisor: advisor(calls), customerRequest: "x", kind: "social-x-posts", rows: page(20, 20), budgetUsd: 0.05 });
    expect(calls).toEqual([20]);
    expect(outcome.firstCall).toMatchObject({ size: 20, reviewed: 20, off: 20, pageRejected: false });
    expect(outcome.rejected).toEqual([]);
    expect(outcome.verdicts.size).toBe(20);
  });

  it("a failed review is still held, never rejected: the fail-closed rule is untouched", async () => {
    let calls = 0;
    const failing: RowAdvisorFn = async () => { calls += 1; return { verdicts: new Map(), usage: usage(0.001), failure: "bad_reply" }; };
    const outcome = await reviewSocialPage({ advisor: failing, customerRequest: "x", kind: "social-x-posts", rows: page(40, 0), budgetUsd: 0.05 });
    expect(calls).toBe(2);
    expect(outcome.firstCall).toMatchObject({ reviewed: 0, rate: null, pageRejected: false });
    expect(outcome.rejected).toEqual([]);
    expect(outcome.unreviewed).toHaveLength(40);
    expect(outcome.unreviewedByBudget).toEqual([]);
  });

  it("a mostly on-topic long page is untouched: two calls (25 and 15 rows), nothing rejected", async () => {
    const calls: number[] = [];
    const outcome = await reviewSocialPage({ advisor: advisor(calls), customerRequest: "x", kind: "social-x-posts", rows: page(40, 3), budgetUsd: 0.05 });
    expect(calls).toEqual([25, 15]);
    expect(outcome.firstCall).toMatchObject({ pageRejected: false });
    expect(outcome.rejected).toEqual([]);
  });

  it("the customer's sentence is Arabic only, with Arabic-Indic digits and no amount", () => {
    expect(pageRejectedEventAr(0.7333, 7)).toBe("نسبة المحتوى غير المرتبط بموضوعك في هذه الصفحة مرتفعة جداً (نحو ٧٣٪ من السجلات المراجَعة)، لذلك استُبعدت بقية سجلاتها (٧ سجل) دون مراجعة فردية ولم تُحتسب.");
    expect(pageRejectedEventAr(0.7333, 7)).not.toMatch(/[A-Za-z$]/);
  });
});

describe("a row the review budget did not reach is never delivered", () => {
  it("with no budget left every row of the page is unreviewed by budget, and no call is made", async () => {
    const calls: number[] = [];
    const outcome = await reviewSocialPage({ advisor: advisor(calls), customerRequest: "x", kind: "social-x-posts", rows: page(20, 0), budgetUsd: 0 });
    expect(calls).toEqual([]);
    expect(outcome.unreviewedByBudget).toHaveLength(20);
    expect(outcome.unreviewed).toHaveLength(20);
    expect(outcome.verdicts.size).toBe(0);
  });

  it("the standard Arabic reason for such a row says why, with no amount", () => {
    expect(UNREVIEWED_BY_BUDGET_REASON_AR).toBe("لم تتم مراجعة هذا السجل آلياً لأن التحقق بلغ الحد المسموح لهذا الطلب؛ لم يُحتسب ولم يدخل ضمن الملف المُسلَّم");
  });
});

describe("verdict-only replies: the model returns {index, verdict}, the code writes the Arabic reason", () => {
  it("a reply with a reason in it is read on the verdict alone; the reason is the standard one", () => {
    const reply = '{"reviews":[{"index":0,"verdict":"no_match","reasonAr":"سبب طويل من النموذج"},{"index":1,"verdict":"match"},{"index":2,"verdict":"uncertain"}]}';
    const verdicts = parseAdvisoryReply(reply, { verdictOnly: true });
    expect(verdicts.get(0)).toEqual({ verdict: "no_match", reasonAr: "غير مطابق لموضوع الطلب" });
    expect(verdicts.get(1)).toEqual({ verdict: "match", reasonAr: "مطابق لموضوع الطلب" });
    expect(verdicts.get(2)).toEqual({ verdict: "uncertain", reasonAr: "غير مؤكد من نص السجل وحده" });
    // other kinds keep the reason the model wrote
    expect(parseAdvisoryReply(reply).get(0)).toEqual({ verdict: "no_match", reasonAr: "سبب طويل من النموذج" });
  });

  it("posts, comments and videos are reviewed on the verdict alone; companies and people keep their reasons", () => {
    for (const kind of ["social-x-posts", "social-tiktok-comments", "social-youtube-comments-video-list", "posts", "comments"]) expect(isVerdictOnlyKind(kind), kind).toBe(true);
    for (const kind of ["companies", "people"]) expect(isVerdictOnlyKind(kind), kind).toBe(false);
  });

  it("the reply room of a verdict-only call is 4,000 tokens whatever the number of rows (a live call of 20 rows used 1,000 and was cut at the old limit of 1,000)", () => {
    for (const rows of [1, 20, 25, 1000]) expect(advisoryMaxTokens(rows, true), String(rows)).toBe(4000);
    // the other kinds keep the old room
    expect(advisoryMaxTokens(25)).toBeGreaterThanOrEqual(4000);
  });
});

describe("the low-yield stop: the review budget is used up AND fewer than 10% of the rows seen were accepted", () => {
  const perRow = REVIEW_CALL_COST_ESTIMATE_USD / SOCIAL_REVIEW_ROWS_PER_CALL;

  it("stops when the budget is used up and 5% were accepted", () => {
    expect(reviewStopForLowYield({ spentUsd: 0.0363, budgetUsd: 0.0363, rowsSeen: 100, accepted: 5 })).toBe(true);
    expect(reviewStopForLowYield({ spentUsd: 0.04, budgetUsd: 0.0363, rowsSeen: 100, accepted: 0 })).toBe(true);
  });

  it("does not stop while the budget can still pay for a row, however low the acceptance", () => {
    expect(reviewStopForLowYield({ spentUsd: 0.0363 - perRow * 2, budgetUsd: 0.0363, rowsSeen: 100, accepted: 0 })).toBe(false);
    expect(reviewStopForLowYield({ spentUsd: 0, budgetUsd: 0.0047, rowsSeen: 100, accepted: 0 })).toBe(false);
  });

  it("does not stop a job that accepts 10% or more of what it sees, even with the budget used up", () => {
    expect(LOW_YIELD_ACCEPTED_BELOW).toBe(0.1);
    expect(reviewStopForLowYield({ spentUsd: 1, budgetUsd: 0.0363, rowsSeen: 100, accepted: 10 })).toBe(false);
    expect(reviewStopForLowYield({ spentUsd: 1, budgetUsd: 0.0363, rowsSeen: 100, accepted: 9 })).toBe(true);
  });

  it("never stops on unknown history: no rows seen yet, or a running record from before the count was kept", () => {
    expect(reviewStopForLowYield({ spentUsd: 1, budgetUsd: 0.0363, rowsSeen: 0, accepted: 0 })).toBe(false);
    expect(reviewStopForLowYield({ spentUsd: 1, budgetUsd: 0.0363, rowsSeen: undefined, accepted: 0 })).toBe(false);
  });
});

describe("the running record keeps the rows seen and the review calls", () => {
  const identityOf = (row: any) => row.id;

  it("rows seen and review calls add up chunk by chunk", () => {
    const first = extendRunningSet(emptyRunningSet(), 0, { rows: [{ id: "a" }], batchUnits: 1, reviewUsd: 0.02, reviewCallCount: 2, rowsSeen: 20 }, identityOf);
    const second = extendRunningSet(first, 1, { rows: [], batchUnits: 0, reviewUsd: 0.01, reviewCallCount: 1, rowsSeen: 11 }, identityOf);
    expect(first).toMatchObject({ rowsSeen: 20, reviewCallCount: 2, reviewUsd: 0.02 });
    expect(second).toMatchObject({ rowsSeen: 31, reviewCallCount: 3, reviewUsd: 0.03 });
  });

  it("a chunk that did not record its rows seen leaves the count unknown from then on (no stop is built on a partial count)", () => {
    const first = extendRunningSet(emptyRunningSet(), 0, { rows: [], batchUnits: 0 }, identityOf);
    const second = extendRunningSet(first, 1, { rows: [], batchUnits: 0, rowsSeen: 20 }, identityOf);
    expect(first.rowsSeen).toBeUndefined();
    expect(second.rowsSeen).toBeUndefined();
  });

  it("a rebuild that cannot read one chunk leaves the count unknown; a rebuild of readable chunks gives the same count as the running record", async () => {
    const steps = [{ rows: [], batchUnits: 0, rowsSeen: 20 }, { rows: [], batchUnits: 0, rowsSeen: 11 }];
    const rebuilt = await rebuildRunningSet(2, identityOf, async (step) => steps[step]);
    expect(rebuilt.rowsSeen).toBe(31);
    const damaged = await rebuildRunningSet(2, identityOf, async (step) => (step === 0 ? null : steps[step]));
    expect(damaged.rowsSeen).toBeUndefined();
  });

  it("a record written before the counts existed still loads; one with the counts round-trips", async () => {
    const files = new Map<string, Buffer>();
    const bucket = {
      upload: async (path: string, body: Buffer) => { files.set(path, body); return {}; },
      download: async (path: string) => (files.has(path) ? { data: new Blob([new Uint8Array(files.get(path)!)]), error: null } : { data: null, error: { message: "missing" } }),
    };
    files.set("job/seen_0.json", Buffer.from(JSON.stringify({ step: 0, identities: [], cursors: [], batchUnits: [0] })));
    expect(await loadRunningSet(bucket, "job", 0)).toMatchObject({ step: 0 });
    const set = extendRunningSet(emptyRunningSet(), 0, { rows: [], batchUnits: 3, reviewCallCount: 2, rowsSeen: 20 }, identityOf);
    await saveRunningSet(bucket, "job", set);
    expect(await loadRunningSet(bucket, "job", 0)).toMatchObject({ rowsSeen: 20, reviewCallCount: 2 });
  });
});

describe("the review spend row in job_events", () => {
  it("one internal line: calls and USD of the chunk and of the job so far", () => {
    expect(reviewSpendEventMessage({ step: 1, callsThisChunk: 1, usdThisChunk: 0.010298, callsBefore: 1, usdBefore: 0.007514, rowsSeenThisChunk: 20, stoppedLowYield: false }))
      .toBe("review_spend step=1 calls=1 usd=0.010298 total_calls=2 total_usd=0.017812 rows_seen=20 low_yield_stop=0");
    expect(reviewSpendEventMessage({ step: 2, callsThisChunk: 0, usdThisChunk: 0, callsBefore: 2, usdBefore: 0.017812, rowsSeenThisChunk: 11, stoppedLowYield: true }))
      .toBe("review_spend step=2 calls=0 usd=0.000000 total_calls=2 total_usd=0.017812 rows_seen=11 low_yield_stop=1");
  });

  it("has its own event type and the customer's activity list leaves it out", () => {
    expect(REVIEW_COST_EVENT_TYPE).toBe("review_cost");
    expect(isCustomerVisibleJobEvent("review_cost")).toBe(false);
    for (const kind of ["info", "progress", "warning", "error", undefined, null]) expect(isCustomerVisibleJobEvent(kind)).toBe(true);
  });
});
