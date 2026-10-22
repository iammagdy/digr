/**
 * The line a chunk writes in job_events about what the automatic review of its rows cost, so the owner can read the review spend of any job
 * later (calls and USD, for the chunk and for the job so far). It is an internal row with its own event type (`review_cost`) that the
 * customer's activity list does not show; the customer's own lines are Arabic and never carry an amount.
 */
export { REVIEW_COST_EVENT_TYPE, REVIEW_FAILURE_EVENT_TYPE, REVIEW_FALLBACK_EVENT_TYPE, REVIEW_SAMPLE_EVENT_TYPE, isCustomerVisibleJobEvent } from "../reviewCostEvent";

export function reviewSpendEventMessage(input: {
  step: number;
  callsThisChunk: number;
  usdThisChunk: number;
  callsBefore: number;
  usdBefore: number;
  rowsSeenThisChunk: number;
  stoppedLowYield: boolean;
}): string {
  const usd = (value: number) => Math.max(0, value).toFixed(6);
  return [
    "review_spend",
    `step=${input.step}`,
    `calls=${input.callsThisChunk}`,
    `usd=${usd(input.usdThisChunk)}`,
    `total_calls=${input.callsBefore + input.callsThisChunk}`,
    `total_usd=${usd(input.usdBefore + input.usdThisChunk)}`,
    `rows_seen=${input.rowsSeenThisChunk}`,
    `low_yield_stop=${input.stoppedLowYield ? 1 : 0}`,
  ].join(" ");
}

/** The internal `review_fallback` line: the job took the previous budget rule, and why (no amounts of the customer's, no row content). */
export function reviewFallbackEventMessage(input: { step: number; reason: "daily_ceiling" | "read_failed"; todayUsd: number | null; ceilingUsd: number; capUsd: number }): string {
  return [
    "review_fallback",
    `step=${input.step}`,
    `reason=${input.reason}`,
    `today_usd=${input.todayUsd === null ? "unknown" : Math.max(0, input.todayUsd).toFixed(6)}`,
    `daily_ceiling_usd=${input.ceilingUsd}`,
    `job_cap_usd=${Math.max(0, input.capUsd).toFixed(6)}`,
  ].join(" ");
}

/**
 * The internal `review_sample` line: the first review call of a job, to see why its reply is longer than its verdicts. Numbers and the scrubbed head of
 * the reply (see `replySampleOf`: no run of row or request text survives) only; the head is JSON-quoted so the line stays one line.
 */
export function reviewSampleEventMessage(input: { step: number; rows: number; stopReason: string | null; tokensIn: number; tokensOut: number; replyChars: number | null; sample: { head: string; startsWithJson: boolean; reasonKeys: number } | null }): string {
  return [
    "review_sample",
    `step=${input.step}`,
    `rows=${input.rows}`,
    `stop=${input.stopReason ?? "none"}`,
    `in=${input.tokensIn}`,
    `out=${input.tokensOut}`,
    `reply_chars=${input.replyChars ?? "none"}`,
    `starts_json=${input.sample ? (input.sample.startsWithJson ? 1 : 0) : "none"}`,
    `reason_keys=${input.sample ? input.sample.reasonKeys : "none"}`,
    `head=${JSON.stringify(input.sample ? input.sample.head.slice(0, 500) : "")}`,
  ].join(" ");
}

/** The facts of one review call that failed or left rows without a verdict, as the internal `review_failure` line: no row content, no customer text. */
export interface ReviewCallFacts {
  rows: number;
  failure: string | null;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  maxTokens: number;
  replyChars: number | null;
  retry: boolean;
  missing: number;
}

/** True for a call worth a `review_failure` line: it failed, was cut at the output limit, or left a row without a verdict. */
export const isReviewCallFailure = (call: ReviewCallFacts): boolean => Boolean(call.failure) || call.stopReason === "max_tokens" || call.missing > 0;

export function reviewFailureEventMessage(step: number, call: number, facts: ReviewCallFacts): string {
  return [
    "review_failure",
    `step=${step}`,
    `call=${call}`,
    `retry=${facts.retry ? 1 : 0}`,
    `rows=${facts.rows}`,
    `code=${facts.failure ?? "none"}`,
    `stop=${facts.stopReason ?? "none"}`,
    `in=${facts.usage?.inputTokens ?? 0}`,
    `out=${facts.usage?.outputTokens ?? 0}`,
    `max_tokens=${facts.maxTokens}`,
    `reply_chars=${facts.replyChars ?? "none"}`,
    `missing=${facts.missing}`,
  ].join(" ");
}
