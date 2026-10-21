/**
 * The line a chunk writes in job_events about what the automatic review of its rows cost, so the owner can read the review spend of any job
 * later (calls and USD, for the chunk and for the job so far). It is an internal row with its own event type (`review_cost`) that the
 * customer's activity list does not show; the customer's own lines are Arabic and never carry an amount.
 */
export { REVIEW_COST_EVENT_TYPE, isCustomerVisibleJobEvent } from "../reviewCostEvent";

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
