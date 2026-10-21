/**
 * The line a chunk writes in job_events about what the automatic review of its rows cost, so the owner can read the review spend of any job
 * later (calls and USD, for the chunk and for the job so far). It is an internal row with its own event type (`review_cost`) that the
 * customer's activity list does not show; the customer's own lines are Arabic and never carry an amount.
 */
export { REVIEW_COST_EVENT_TYPE, REVIEW_FAILURE_EVENT_TYPE, isCustomerVisibleJobEvent } from "../reviewCostEvent";

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
