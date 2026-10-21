import { describe, expect, it } from "vitest";
import { emptyRunningSet, extendRunningSet, loadRunningSet, rebuildRunningSet, saveRunningSet } from "../src/lib/server/jobRunningSet";
import { isCustomerVisibleJobEvent, REVIEW_COST_EVENT_TYPE, reviewSpendEventMessage } from "../src/lib/server/reviewSpendLog";
import {
  LOW_YIELD_ACCEPTED_BELOW, REVIEW_CALL_COST_ESTIMATE_USD, reviewStopForLowYield, SOCIAL_REVIEW_ROWS_PER_CALL,
  type AdvisoryVerdict, type RowAdvisorFn,
} from "../src/lib/server/rowReviewAdvisor";
import { OFF_TOPIC_STRICT_ABOVE, PAGE_REJECT_ABOVE, PAGE_REJECT_MIN_REVIEWED, pageRejectedEventAr, reviewSocialPage } from "../src/lib/server/sampledReview";

const verdict = (v: AdvisoryVerdict["verdict"]): AdvisoryVerdict => ({ verdict: v, reasonAr: "سبب" });
const firstOf = () => 0;
const usage = (costUsd: number) => ({ inputTokens: 1500, outputTokens: 400, costUsd, model: "claude-haiku-5-5", latencyMs: 10 });
const GOOD = (i: number) => `منشور مطابق ${i}`;
const BAD = (i: number) => `منشور غير مرتبط ${i}`;
/** A page of `n` presumed rows whose first `bad` are unrelated; the fixed random source makes the sample the first rows. */
const page = (n: number, bad: number) => Array.from({ length: n }, (_, i) => ({ index: i, row: { text: i < bad ? BAD(i) : GOOD(i) } }));
const advisor = (calls: number[] = [], cost = 0.004): RowAdvisorFn => async (input) => {
  calls.push(input.rows.length);
  return { verdicts: new Map(input.rows.map(({ index, row }) => [index, verdict(String(row.text).startsWith("منشور مطابق") ? "match" : "no_match")])), usage: usage(cost), failure: null };
};

describe("early page rejection: a sample that is mostly unrelated rejects the page without reviewing its other rows", () => {
  it("the limits: rejection above 60%, the strict full review above 40%; at least eight sampled rows must have been read", () => {
    expect(PAGE_REJECT_ABOVE).toBe(0.6);
    expect(OFF_TOPIC_STRICT_ABOVE).toBe(0.4);
    expect(PAGE_REJECT_MIN_REVIEWED).toBe(8);
  });

  it("11 of 15 sampled rows unrelated (73%): ONE call, the rest of the page is rejected unreviewed, the sampled rows keep their verdicts", async () => {
    const calls: number[] = [];
    const rows = page(22, 11);
    const outcome = await reviewSocialPage({ advisor: advisor(calls), customerRequest: "x", kind: "social-x-posts", rows, suspicious: new Set(), budgetUsd: 0.05, random: firstOf });
    expect(calls).toEqual([15]);
    expect(outcome.sample).toMatchObject({ size: 15, reviewed: 15, off: 11, strictPage: true, pageRejected: true });
    expect(outcome.rejected).toEqual([15, 16, 17, 18, 19, 20, 21]);
    // the sampled rows were answered: four matches among them are still confirmed, the others are not
    expect(outcome.verdicts.size).toBe(15);
    expect([...outcome.verdicts].filter(([, v]) => v.verdict === "match").map(([i]) => i)).toEqual([11, 12, 13, 14]);
    expect(outcome.unreviewed).toEqual([]);
    expect(outcome.costUsd).toBeCloseTo(0.004, 6);
    // none of the rejected rows can be delivered on the gate alone
    expect(outcome.mustConfirm.size).toBe(22);
    expect(outcome.sampleOnly.size).toBe(0);
  });

  it("exactly 60% (9 of 15) is NOT rejected: it stays a strict page and the rest is reviewed (a second call)", async () => {
    const calls: number[] = [];
    const outcome = await reviewSocialPage({ advisor: advisor(calls), customerRequest: "x", kind: "social-x-posts", rows: page(22, 9), suspicious: new Set(), budgetUsd: 0.05, random: firstOf });
    expect(calls).toEqual([15, 7]);
    expect(outcome.sample).toMatchObject({ off: 9, strictPage: true, pageRejected: false });
    expect(outcome.rejected).toEqual([]);
    expect(outcome.verdicts.size).toBe(22);
  });

  it("a sample read for fewer than eight rows never rejects a page (the full review runs as before)", async () => {
    const calls: number[] = [];
    // the reviewer answers only the first five rows of each call, all «no match»: 5 of 5 unrelated, but only five read
    const partial: RowAdvisorFn = async (input) => {
      calls.push(input.rows.length);
      return { verdicts: new Map(input.rows.slice(0, 5).map(({ index }) => [index, verdict("no_match")])), usage: usage(0.004), failure: null };
    };
    const outcome = await reviewSocialPage({ advisor: partial, customerRequest: "x", kind: "social-x-posts", rows: page(22, 22), suspicious: new Set(), budgetUsd: 0.05, random: firstOf });
    expect(outcome.sample).toMatchObject({ reviewed: 5, off: 5, strictPage: true, pageRejected: false });
    expect(outcome.rejected).toEqual([]);
    expect(calls).toEqual([15, 7]);
  });

  it("the doubtful rows are always reviewed with the sample, even on a rejected page; only the other presumed rows are rejected unreviewed", async () => {
    const calls: number[] = [];
    const rows = page(23, 11);
    const outcome = await reviewSocialPage({ advisor: advisor(calls), customerRequest: "x", kind: "social-x-posts", rows, suspicious: new Set([22]), budgetUsd: 0.05, random: firstOf });
    expect(calls).toEqual([16]);
    expect(outcome.verdicts.has(22)).toBe(true);
    expect(outcome.rejected).toEqual([15, 16, 17, 18, 19, 20, 21]);
  });

  it("a failed review is still held, never rejected: the fail-closed rule is untouched", async () => {
    let calls = 0;
    const failing: RowAdvisorFn = async () => { calls += 1; return { verdicts: new Map(), usage: usage(0.001), failure: "bad_reply" }; };
    const outcome = await reviewSocialPage({ advisor: failing, customerRequest: "x", kind: "social-x-posts", rows: page(20, 0), suspicious: new Set(), budgetUsd: 0.05, random: firstOf });
    expect(calls).toBe(2);
    expect(outcome.sample).toMatchObject({ reviewed: 0, rate: null, strictPage: true, pageRejected: false });
    expect(outcome.rejected).toEqual([]);
    expect(outcome.unreviewed).toHaveLength(20);
    expect(outcome.mustConfirm.size).toBe(20);
  });

  it("a mostly on-topic page is untouched: one call on the sample, nothing rejected", async () => {
    const calls: number[] = [];
    const outcome = await reviewSocialPage({ advisor: advisor(calls), customerRequest: "x", kind: "social-x-posts", rows: page(20, 3), suspicious: new Set(), budgetUsd: 0.05, random: firstOf });
    expect(calls).toEqual([15]);
    expect(outcome.sample).toMatchObject({ strictPage: false, pageRejected: false });
    expect(outcome.rejected).toEqual([]);
  });

  it("the customer's sentence is Arabic only, with Arabic-Indic digits and no amount", () => {
    expect(pageRejectedEventAr(0.7333, 7)).toBe("نسبة المحتوى غير المرتبط بموضوعك في هذه الصفحة مرتفعة جداً (نحو ٧٣٪ من العيّنة)، لذلك استُبعدت بقية سجلاتها (٧ سجل) دون مراجعة فردية ولم تُحتسب.");
    expect(pageRejectedEventAr(0.7333, 7)).not.toMatch(/[A-Za-z$]/);
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
