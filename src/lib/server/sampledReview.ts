import { toArabicDigits } from "../arabicDigits";
import { reviewSocialRows, type AdvisoryVerdict, type RowAdvisorFn, type SocialReviewAttempt, type SocialReviewStop } from "./rowReviewAdvisor";

/**
 * Posts and comments that came from a topic search are presumed on topic, but a source can answer a topic with plenty of unrelated
 * content (a club of another country, a generic reaction). So a SAMPLE of each page is reviewed to estimate how much is off topic; when
 * more than 40 % of the sample is, the whole page goes through the review before anything of it is delivered (fail closed). The
 * doubtful rows (flagged by the gate) are always reviewed. All of it inside the job's review budget.
 */
export const REVIEW_SAMPLE_ROWS = 15;
export const OFF_TOPIC_STRICT_ABOVE = 0.4;
/**
 * Above this share of unrelated rows in the sample, the whole page is rejected: the rest of its presumed rows are excluded WITHOUT being
 * reviewed one by one (a call per 25 rows that would almost always say «no match»). Between OFF_TOPIC_STRICT_ABOVE and this share the page
 * still goes through the full review. The sample must have been read for at least PAGE_REJECT_MIN_REVIEWED rows, so a verdict on a handful
 * of rows never throws a page away.
 */
export const PAGE_REJECT_ABOVE = 0.6;
export const PAGE_REJECT_MIN_REVIEWED = 8;

let randomForTests: (() => number) | null = null;
/** Test-only: a fixed random source for the sample (null restores Math.random). */
export function setReviewSampleRandomForTesting(random: (() => number) | null): void {
  randomForTests = random;
}

/** A random sample without repeats (partial Fisher–Yates), in no particular order. */
export function pickReviewSample(indexes: number[], size: number = REVIEW_SAMPLE_ROWS, random: () => number = randomForTests ?? Math.random): number[] {
  const pool = [...indexes];
  const out: number[] = [];
  while (out.length < size && pool.length > 0) {
    const at = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    out.push(pool.splice(at, 1)[0]);
  }
  return out;
}

/** The share of the reviewed sample that is not clearly on topic («no match» or doubt). Null when nothing of the sample was reviewed. */
export function estimateOffTopic(sample: number[], verdicts: Map<number, AdvisoryVerdict>): { size: number; reviewed: number; off: number; rate: number | null } {
  let reviewed = 0;
  let off = 0;
  for (const index of sample) {
    const verdict = verdicts.get(index);
    if (!verdict) continue;
    reviewed += 1;
    if (verdict.verdict !== "match") off += 1;
  }
  return { size: sample.length, reviewed, off, rate: reviewed > 0 ? off / reviewed : null };
}

export function highOffTopicEventAr(rate: number): string {
  return `نسبة المحتوى غير المرتبط بموضوعك في هذه الصفحة مرتفعة (نحو ${toArabicDigits(Math.round(rate * 100))}٪ من العيّنة)، لذلك راجعنا كل سجلاتها قبل التسليم.`;
}

export function pageRejectedEventAr(rate: number, rejected: number): string {
  return `نسبة المحتوى غير المرتبط بموضوعك في هذه الصفحة مرتفعة جداً (نحو ${toArabicDigits(Math.round(rate * 100))}٪ من العيّنة)، لذلك استُبعدت بقية سجلاتها (${toArabicDigits(rejected)} سجل) دون مراجعة فردية ولم تُحتسب.`;
}

export const PAGE_REJECTED_REASON_AR = "الصفحة غير مرتبطة بموضوع الطلب في معظم عيّنتها المراجَعة؛ استُبعد السجل دون مراجعة فردية ولم يُحتسب";

/** A failure worth one more try: the call timed out, the network failed, the reply was unreadable, or the service was busy or down. Not a missing key or a disabled reviewer. */
export function isRetryableFailure(failure: string | null | undefined): boolean {
  return failure === "timeout" || failure === "network" || failure === "bad_reply" || failure === "http_429" || /^http_5\d\d$/.test(String(failure || ""));
}

export interface SampledReviewOutcome {
  verdicts: Map<number, AdvisoryVerdict>;
  attempts: SocialReviewAttempt[];
  costUsd: number;
  /** Rows that had to be confirmed and were not (a failed call, the budget, the deadline). */
  unreviewed: number[];
  stoppedBy: SocialReviewStop | null;
  /** Rows delivered only when the review confirms them: the doubtful ones, and the whole page when the sample is mostly off topic. */
  mustConfirm: Set<number>;
  /** Presumed rows that were reviewed as the sample: a «no match» of theirs is respected, a missing verdict is not held against them. */
  sampleOnly: Set<number>;
  sample: { size: number; reviewed: number; off: number; rate: number | null; strictPage: boolean; pageRejected: boolean } | null;
  /** The rows of a rejected page that were not reviewed: excluded («no match»), never delivered, never charged. Empty when the page was not rejected. */
  rejected: number[];
}

export async function reviewSocialPage(input: {
  advisor: RowAdvisorFn;
  customerRequest: string;
  kind: string;
  rows: Array<{ index: number; row: Record<string, any> }>;
  suspicious: Set<number>;
  budgetUsd: number;
  /** See `reviewSocialRows`: when set, the budget is a ceiling no call may cross. */
  callCostEstimateUsd?: number;
  deadlineMs?: number;
  random?: () => number;
  sampleSize?: number;
  /** The share of unrelated rows above which a page is rejected unreviewed (default PAGE_REJECT_ABOVE). `Infinity` switches the rejection off: the simulation of the old behaviour uses it. */
  rejectPageAbove?: number;
}): Promise<SampledReviewOutcome> {
  const byIndex = new Map(input.rows.map((entry) => [entry.index, entry]));
  const presumed = input.rows.map((entry) => entry.index).filter((index) => !input.suspicious.has(index));
  const sample = pickReviewSample(presumed, input.sampleSize ?? REVIEW_SAMPLE_ROWS, input.random);
  const firstRows = [...input.rows.filter((entry) => input.suspicious.has(entry.index)), ...sample.map((index) => byIndex.get(index)!)];

  const outcome: SampledReviewOutcome = {
    verdicts: new Map(), attempts: [], costUsd: 0, unreviewed: [], stoppedBy: null,
    mustConfirm: new Set(input.suspicious), sampleOnly: new Set(sample), sample: null, rejected: [],
  };
  if (firstRows.length === 0) return outcome;

  const review = (rows: typeof firstRows, budgetUsd: number) => reviewSocialRows({ advisor: input.advisor, customerRequest: input.customerRequest, kind: input.kind, rows, budgetUsd, callCostEstimateUsd: input.callCostEstimateUsd, deadlineMs: input.deadlineMs });
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
  // Only the doubtful rows have to be confirmed at this point; an unreviewed row of the sample is simply not part of the estimate.
  outcome.unreviewed.push(...first.unreviewed.filter((index) => input.suspicious.has(index)));

  const estimate = estimateOffTopic(sample, first.verdicts);
  // FAIL CLOSED: when the review of the sample failed (no verdict for any sampled row, after the one retry), the page is treated as strict: no row
  // of it is delivered on the deterministic gate alone. Not being able to check is never read as «on topic». (A review that did not run because
  // the budget or the time was used up is a different case and is left as it was.)
  const reviewFailed = sample.length > 0 && estimate.reviewed === 0 && attempts.some((attempt) => attempt.failure);
  const strictPage = reviewFailed || (estimate.rate !== null && estimate.rate > OFF_TOPIC_STRICT_ABOVE);
  // EARLY PAGE REJECTION: a sample that is mostly unrelated (and was read for enough rows) rejects the page; its other presumed rows are not reviewed.
  const pageRejected = !reviewFailed && estimate.rate !== null && estimate.reviewed >= PAGE_REJECT_MIN_REVIEWED && estimate.rate > (input.rejectPageAbove ?? PAGE_REJECT_ABOVE);
  if (sample.length > 0) outcome.sample = { ...estimate, strictPage, pageRejected };

  if (reviewFailed) {
    // The reviewer is unavailable: no second call for the rest of the page; every presumed row waits in the review sheet, not delivered, not charged.
    for (const index of presumed) outcome.mustConfirm.add(index);
    outcome.unreviewed.push(...presumed);
    outcome.sampleOnly.clear();
    return outcome;
  }

  if (pageRejected) {
    const rest = presumed.filter((index) => !sample.includes(index));
    for (const index of presumed) outcome.mustConfirm.add(index);
    outcome.rejected.push(...rest);
    // The sampled rows keep the verdicts they got; one the review never answered stays out, as on any strict page.
    for (const index of sample) if (!outcome.verdicts.has(index)) outcome.unreviewed.push(index);
    outcome.sampleOnly.clear();
    return outcome;
  }

  if (strictPage) {
    const rest = presumed.filter((index) => !sample.includes(index));
    for (const index of presumed) outcome.mustConfirm.add(index);
    if (rest.length > 0) {
      const second = await reviewSocialRows({
        advisor: input.advisor, customerRequest: input.customerRequest, kind: input.kind,
        rows: rest.map((index) => byIndex.get(index)!), budgetUsd: Math.max(0, input.budgetUsd - first.costUsd), callCostEstimateUsd: input.callCostEstimateUsd, deadlineMs: input.deadlineMs,
      });
      for (const [index, verdict] of second.verdicts) outcome.verdicts.set(index, verdict);
      outcome.attempts.push(...second.attempts);
      outcome.costUsd += second.costUsd;
      outcome.stoppedBy ||= second.stoppedBy;
      outcome.unreviewed.push(...second.unreviewed);
    }
    // The sample rows of a strict page must be confirmed like the others (a missing verdict keeps them out).
    for (const index of sample) if (!outcome.verdicts.has(index)) outcome.unreviewed.push(index);
    outcome.sampleOnly.clear();
  }
  return outcome;
}
