import { toArabicDigits } from "../arabicDigits";
import { reviewSocialRows, SOCIAL_REVIEW_ROWS_PER_CALL, type AdvisoryVerdict, type RowAdvisorFn, type SocialReviewAttempt, type SocialReviewStop } from "./rowReviewAdvisor";

/**
 * The review of one page of posts or comments: ONE call covers every row of the page (a page of up to SOCIAL_REVIEW_ROWS_PER_CALL
 * rows; a longer page is split into calls of that size), so no row is delivered without the model's verdict and no call is spent on a
 * small tail. The model answers with a verdict per row only (see `isVerdictOnlyKind`).
 *
 * A page longer than one call is judged by its first call: when more than PAGE_REJECT_ABOVE of the rows of that call are unrelated, the
 * rest of the page is excluded WITHOUT being reviewed (a call per 25 rows that would almost always say «no match»); the rows already
 * reviewed keep their verdicts. All of it inside the job's review budget; a row the budget did not reach is not delivered.
 */
export const PAGE_REJECT_ABOVE = 0.6;
/** The first call must have read at least this many rows for its share to reject a page: a verdict on a handful of rows never throws a page away. */
export const PAGE_REJECT_MIN_REVIEWED = 8;

/** The share of the reviewed rows that is not clearly on topic («no match» or doubt). Null when nothing was reviewed. */
export function estimateOffTopic(indexes: number[], verdicts: Map<number, AdvisoryVerdict>): { size: number; reviewed: number; off: number; rate: number | null } {
  let reviewed = 0;
  let off = 0;
  for (const index of indexes) {
    const verdict = verdicts.get(index);
    if (!verdict) continue;
    reviewed += 1;
    if (verdict.verdict !== "match") off += 1;
  }
  return { size: indexes.length, reviewed, off, rate: reviewed > 0 ? off / reviewed : null };
}

export function pageRejectedEventAr(rate: number, rejected: number): string {
  return `نسبة المحتوى غير المرتبط بموضوعك في هذه الصفحة مرتفعة جداً (نحو ${toArabicDigits(Math.round(rate * 100))}٪ من السجلات المراجَعة)، لذلك استُبعدت بقية سجلاتها (${toArabicDigits(rejected)} سجل) دون مراجعة فردية ولم تُحتسب.`;
}

export const PAGE_REJECTED_REASON_AR = "الصفحة غير مرتبطة بموضوع الطلب في معظم سجلاتها المراجَعة؛ استُبعد السجل دون مراجعة فردية ولم يُحتسب";

/** A failure worth one more try: the call timed out, the network failed, the reply was unreadable, or the service was busy or down. Not a missing key or a disabled reviewer. */
export function isRetryableFailure(failure: string | null | undefined): boolean {
  return failure === "timeout" || failure === "network" || failure === "bad_reply" || failure === "http_429" || /^http_5\d\d$/.test(String(failure || ""));
}

export interface PageReviewOutcome {
  verdicts: Map<number, AdvisoryVerdict>;
  attempts: SocialReviewAttempt[];
  costUsd: number;
  /** Rows nobody reviewed (a failed call, the budget, the deadline): they are not delivered. */
  unreviewed: number[];
  /** The part of `unreviewed` left out only because the review budget was used up (not a failure): they go to the «غير مراجَع» sheet. */
  unreviewedByBudget: number[];
  stoppedBy: SocialReviewStop | null;
  /** The rows of a rejected page that were not reviewed: excluded («no match»), never delivered, never charged. Empty when the page was not rejected. */
  rejected: number[];
  /** What the first call of the page found; null when nothing was asked. */
  firstCall: { size: number; reviewed: number; off: number; rate: number | null; pageRejected: boolean } | null;
}

export async function reviewSocialPage(input: {
  advisor: RowAdvisorFn;
  customerRequest: string;
  kind: string;
  rows: Array<{ index: number; row: Record<string, any> }>;
  budgetUsd: number;
  /** See `reviewSocialRows`: when set, the budget is a ceiling no call may cross. */
  callCostEstimateUsd?: number;
  deadlineMs?: number;
  /** The share of unrelated rows above which the rest of a long page is rejected unreviewed (default PAGE_REJECT_ABOVE). `Infinity` switches the rejection off: the simulation of the old behaviour uses it. */
  rejectPageAbove?: number;
}): Promise<PageReviewOutcome> {
  const outcome: PageReviewOutcome = { verdicts: new Map(), attempts: [], costUsd: 0, unreviewed: [], unreviewedByBudget: [], stoppedBy: null, rejected: [], firstCall: null };
  if (input.rows.length === 0) return outcome;

  const review = (rows: typeof input.rows, budgetUsd: number) => reviewSocialRows({ advisor: input.advisor, customerRequest: input.customerRequest, kind: input.kind, rows, budgetUsd, callCostEstimateUsd: input.callCostEstimateUsd, deadlineMs: input.deadlineMs });
  const firstRows = input.rows.slice(0, SOCIAL_REVIEW_ROWS_PER_CALL);
  const restRows = input.rows.slice(SOCIAL_REVIEW_ROWS_PER_CALL);

  let first = await review(firstRows, input.budgetUsd);
  const attempts = [...first.attempts];
  let firstCostUsd = first.costUsd;
  // A review whose call failed (a timeout, an error, an unreadable reply) and produced no verdict at all is tried ONCE more, inside the same
  // budget and deadline; two failures in a row are not tried a third time.
  if (first.verdicts.size === 0 && first.stoppedBy === "failed" && first.attempts.some((attempt) => isRetryableFailure(attempt.failure))) {
    const retry = await review(firstRows, Math.max(0, input.budgetUsd - first.costUsd));
    attempts.push(...retry.attempts);
    firstCostUsd += retry.costUsd;
    first = { ...retry, attempts, costUsd: firstCostUsd };
  }
  for (const [index, verdict] of first.verdicts) outcome.verdicts.set(index, verdict);
  outcome.attempts.push(...attempts);
  outcome.costUsd += firstCostUsd;
  outcome.stoppedBy = first.stoppedBy;
  outcome.unreviewed.push(...first.unreviewed);
  outcome.unreviewedByBudget.push(...first.unreviewedByCap);

  const estimate = estimateOffTopic(firstRows.map((entry) => entry.index), first.verdicts);
  // FAIL CLOSED: when the review of the first call failed (no verdict for any row, after the one retry), no row of the page is delivered and no
  // second call is made. Not being able to check is never read as «on topic». (A review that did not run because the budget or the time was
  // used up is a different case: its rows are not delivered either, but they are not a failure.)
  const reviewFailed = estimate.reviewed === 0 && attempts.some((attempt) => attempt.failure);
  const pageRejected = !reviewFailed && restRows.length > 0 && estimate.rate !== null && estimate.reviewed >= PAGE_REJECT_MIN_REVIEWED && estimate.rate > (input.rejectPageAbove ?? PAGE_REJECT_ABOVE);
  outcome.firstCall = { size: estimate.size, reviewed: estimate.reviewed, off: estimate.off, rate: estimate.rate, pageRejected };
  if (restRows.length === 0) return outcome;

  if (reviewFailed) {
    outcome.unreviewed.push(...restRows.map((entry) => entry.index));
    return outcome;
  }
  if (pageRejected) {
    outcome.rejected.push(...restRows.map((entry) => entry.index));
    return outcome;
  }
  const rest = await review(restRows, Math.max(0, input.budgetUsd - firstCostUsd));
  for (const [index, verdict] of rest.verdicts) outcome.verdicts.set(index, verdict);
  outcome.attempts.push(...rest.attempts);
  outcome.costUsd += rest.costUsd;
  outcome.stoppedBy ||= rest.stoppedBy;
  outcome.unreviewed.push(...rest.unreviewed);
  outcome.unreviewedByBudget.push(...rest.unreviewedByCap);
  return outcome;
}
