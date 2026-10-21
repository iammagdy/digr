import { scaleValue } from "../scaleConfig";

/**
 * Caps on provider pages per job. The provider bills per record REQUESTED on every page (a page of 10 costs 10 units
 * of the provider price whether 0 or 10 rows survive our relevance gate), so a search whose pages are mostly rejected
 * must stop instead of paging until the source is exhausted.
 *
 * Measured on the production company jobs of 18 Oct 2026 (provider_costs 415-433, job_events):
 *  - 2 requested, 19 pages of 2 records, 17 pages with zero matches (geographic gate), 0.01444 USD against 0.00076 quoted;
 *  - 3 requested, 2 pages of 10 records, 0.0076 USD against 0.00114 quoted.
 * These caps never change a customer price: the customer is charged only for delivered rows.
 */

/** A job asking for this many records or fewer is "small". */
export const SMALL_JOB_RECORDS = 10;
/** Small jobs fetch at most this many provider pages. */
export const SMALL_JOB_MAX_PAGES = 3;
/** Stop after this many CONSECUTIVE pages that produced no new matching record. */
export const MAX_CONSECUTIVE_EMPTY_PAGES_SMALL = 2;
export const MAX_CONSECUTIVE_EMPTY_PAGES_LARGE = 3;
/** Larger jobs may use up to this multiple of the pages they would need if every record matched. */
export const LARGE_JOB_PAGE_ALLOWANCE = 3;
/** Hard ceiling on pages for any capped job. */
export const ABSOLUTE_MAX_PAGES = 300;
/** Small company jobs request a page of 3x the wanted records, between these bounds, instead of exactly the wanted count. */
export const SMALL_JOB_MIN_PAGE_SIZE = 5;
export const SMALL_JOB_MAX_PAGE_SIZE = 10;

/** Feed-style sources (comments, posts, videos): a small job reads at most this many chunks of candidates. */
export const FEED_SMALL_JOB_MAX_PAGES = 4;
/** What a page is: a directory search bills every requested record; a feed (social) bills per call. */
export type CapKind = "directory" | "feed";

export const isSmallJob = (targetMax: number): boolean => targetMax > 0 && targetMax <= SMALL_JOB_RECORDS;

/** Page size for a small directory job: enough candidates per page to find a few matches, never 2 rows per page. */
export function smallJobPageSize(targetMax: number): number {
  return Math.min(SMALL_JOB_MAX_PAGE_SIZE, Math.max(SMALL_JOB_MIN_PAGE_SIZE, Math.floor(targetMax) * 3));
}

/** The two constants above are the defaults; the values in force come from the scale configuration (same numbers unless the owner sets them). */
export function maxPagesForJob(targetMax: number, pageSize: number, kind: CapKind = "directory"): number {
  if (isSmallJob(targetMax)) return kind === "feed" ? FEED_SMALL_JOB_MAX_PAGES : SMALL_JOB_MAX_PAGES;
  const needed = Math.max(1, Math.ceil(targetMax / Math.max(1, pageSize)));
  return Math.min(scaleValue("absoluteMaxPages"), needed * scaleValue("largeJobPageAllowance"));
}

/** `review_unavailable` and `review_low_yield` are set by the worker (not by evaluateProviderCallCap): the automatic relevance review could not run, or its budget is used up and almost nothing it saw was accepted. */
export type CallCapReason = "page_cap" | "empty_pages" | "review_unavailable" | "review_low_yield" | "review_budget";

/**
 * Decides whether to stop fetching after the page that was just processed.
 * `priorBatchUnits` are the accepted-row counts of the earlier pages (null when a page's record could not be read: unknown
 * pages never count as empty, so a storage hiccup cannot stop a job early).
 */
export function evaluateProviderCallCap(input: {
  pagesDone: number;
  acceptedThisPage: number;
  priorBatchUnits: Array<number | null>;
  targetMax: number;
  pageSize: number;
  kind?: CapKind;
}): CallCapReason | null {
  const limit = isSmallJob(input.targetMax) ? MAX_CONSECUTIVE_EMPTY_PAGES_SMALL : MAX_CONSECUTIVE_EMPTY_PAGES_LARGE;
  let streak = input.acceptedThisPage === 0 ? 1 : 0;
  if (streak > 0) {
    for (let i = input.priorBatchUnits.length - 1; i >= 0 && input.priorBatchUnits[i] === 0; i--) streak++;
  }
  if (streak >= limit) return "empty_pages";
  if (input.pagesDone >= maxPagesForJob(input.targetMax, input.pageSize, input.kind)) return "page_cap";
  return null;
}

/** Provider spend one page can cost: directory searches bill every requested record. */
export function estimatePageProviderUsd(unitCostUsd: number, pageSize: number, billsPerRequestedRecord: boolean): number {
  return Math.max(0.0001, Number((unitCostUsd * (billsPerRequestedRecord ? Math.max(1, pageSize) : 1)).toFixed(6)));
}

/** Worst-case provider spend of one job under these caps (what the spend estimate and the daily cap gate must allow for). */
export function worstCaseJobProviderUsd(unitCostUsd: number, targetMax: number, pageSize: number): number {
  return Number((maxPagesForJob(targetMax, pageSize) * Math.max(1, pageSize) * unitCostUsd).toFixed(6));
}

export const CALL_CAP_NOTE_AR: Record<CallCapReason, string> = {
  page_cap: "توقف الجمع عند الحد الأقصى لعدد الصفحات المسموح لهذا الطلب، مع تسليم السجلات المطابقة التي جُمعت فقط",
  empty_pages: "توقف الجمع لأن الصفحات الأخيرة لم تُنتج سجلات مطابقة جديدة، مع تسليم السجلات المطابقة التي جُمعت فقط",
  review_unavailable: "توقف الجمع لأن التحقق الآلي من ملاءمة السجلات تعذّر الآن، ولم يُحتسب عليك إلا ما سُلّم",
  review_budget: "توقف الجمع لأن التحقق الآلي بلغ الحد المسموح لهذا الطلب؛ وُضعت السجلات التي لم تُراجَع في ورقة «غير مراجَع» ولم يُحتسب عليك إلا ما سُلّم",
  review_low_yield: "توقف الجمع لأن نسبة السجلات المطابقة لموضوعك بقيت منخفضة جداً وبلغ التحقق الآلي حدّه المسموح لهذا الطلب، ولم يُحتسب عليك إلا ما سُلّم",
};
