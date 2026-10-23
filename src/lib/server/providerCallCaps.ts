import { LARGE_JOB_PAGE_ALLOWANCE as SCALE_LARGE_JOB_PAGE_ALLOWANCE, scaleValue } from "../scaleConfig";

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
/** Larger jobs may use up to this multiple of the pages they would need if every record matched (defined once, in scaleConfig; 6 since 22 Oct 2026, it was 3). */
export const LARGE_JOB_PAGE_ALLOWANCE = SCALE_LARGE_JOB_PAGE_ALLOWANCE;
/** Hard ceiling on pages for any capped job. */
export const ABSOLUTE_MAX_PAGES = 300;
/**
 * A directory search (companies) bills every requested record on every page, and its source has a bounded answer: it may use up to this
 * multiple of the pages it would need if every record matched, and never more than DIRECTORY_MAX_PAGES (22 Oct 2026: a company job ran
 * 175 pages with no stop at all). Feeds keep LARGE_JOB_PAGE_ALLOWANCE and ABSOLUTE_MAX_PAGES.
 */
export const DIRECTORY_PAGE_ALLOWANCE = 3;
export const DIRECTORY_MAX_PAGES = 30;
/** ANY job that has delivered nothing after this many pages stops, however the earlier pages are recorded. */
export const NO_PROGRESS_PAGES = 5;
export const DIRECTORY_NO_PROGRESS_PAGES = NO_PROGRESS_PAGES;
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
export function maxPagesForJob(targetMax: number, pageSize: number, kind: CapKind = "directory", allowance: number = scaleValue("largeJobPageAllowance")): number {
  if (isSmallJob(targetMax)) return kind === "feed" ? FEED_SMALL_JOB_MAX_PAGES : SMALL_JOB_MAX_PAGES;
  const needed = Math.max(1, Math.ceil(targetMax / Math.max(1, pageSize)));
  if (kind === "directory") return Math.min(DIRECTORY_MAX_PAGES, needed * DIRECTORY_PAGE_ALLOWANCE);
  return Math.min(scaleValue("absoluteMaxPages"), needed * allowance);
}

/** `review_unavailable` and `review_low_yield` are set by the worker (not by evaluateProviderCallCap): the automatic relevance review could not run, or its budget is used up and almost nothing it saw was accepted. */
export type CallCapReason = "page_cap" | "empty_pages" | "no_progress" | "source_repeats" | "review_unavailable" | "review_low_yield" | "review_budget";

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
  /** Rows accepted by the whole job so far, this page included (every kind of job). */
  deliveredTotal?: number;
  /** Every row this page returned was one the job already delivered: the source repeats itself (a Facebook page's three posts, read again as «page 2» and «page 3»). */
  pageRepeatedOnly?: boolean;
}): CallCapReason | null {
  // A page made only of rows already delivered, right after a page that brought nothing new either: the source has no more new items. This is the same
  // «two empty pages in a row» rule the small jobs already follow, held for every job size when the cause is a repeat (large jobs waited for three).
  // ONE repeated page followed by new rows stays allowed: a source may repeat a page and then go on.
  if (input.pageRepeatedOnly && input.acceptedThisPage === 0 && input.priorBatchUnits[input.priorBatchUnits.length - 1] === 0) return "source_repeats";
  const limit = isSmallJob(input.targetMax) ? MAX_CONSECUTIVE_EMPTY_PAGES_SMALL : MAX_CONSECUTIVE_EMPTY_PAGES_LARGE;
  let streak = input.acceptedThisPage === 0 ? 1 : 0;
  if (streak > 0) {
    for (let i = input.priorBatchUnits.length - 1; i >= 0 && input.priorBatchUnits[i] === 0; i--) streak++;
  }
  if (streak >= limit) return "empty_pages";
  if (input.deliveredTotal === 0 && input.pagesDone >= NO_PROGRESS_PAGES) return "no_progress";
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

/** The review budget ran out while the posts of a topic search were being chosen: no comment of a post nobody reviewed is read, and nothing is charged for it. One sentence, said instead of the row-level one (no sheet is involved). */
export const POST_REVIEW_BUDGET_NOTE_AR = "توقف الجمع لأن التحقق الآلي من المنشورات بلغ الحد المسموح لهذا الطلب قبل بلوغ العدد المطلوب؛ لم تُقرأ تعليقات أي منشور لم يُراجَع، ولم يُحتسب عليك إلا ما سُلّم وحُرّر الباقي من الحجز المؤقت";

export const CALL_CAP_NOTE_AR: Record<CallCapReason, string> = {
  page_cap: "توقف الجمع عند الحد الأقصى لعدد الصفحات المسموح لهذا الطلب، مع تسليم السجلات المطابقة التي جُمعت فقط",
  no_progress: "توقف الجمع لأن عدة صفحات متتالية لم تُنتج أي سجل مطابق، ولم يُحتسب عليك إلا ما سُلّم",
  source_repeats: "توقف الجمع لأن المصدر لا يحتوي على عناصر جديدة أخرى؛ أعاد السجلات نفسها التي سُلّمت، ولم يُحتسب عليك إلا ما سُلّم وحُرّر الباقي من الحجز المؤقت",
  empty_pages: "توقف الجمع لأن الصفحات الأخيرة لم تُنتج سجلات مطابقة جديدة، مع تسليم السجلات المطابقة التي جُمعت فقط",
  review_unavailable: "توقف الجمع لأن التحقق الآلي من ملاءمة السجلات تعذّر الآن، ولم يُحتسب عليك إلا ما سُلّم",
  review_budget: "توقف الجمع لأن التحقق الآلي بلغ الحد المسموح لهذا الطلب؛ وُضعت السجلات التي لم تُراجَع في ورقة «غير مراجَع» ولم يُحتسب عليك إلا ما سُلّم",
  review_low_yield: "توقف الجمع لأن نسبة السجلات المطابقة لموضوعك بقيت منخفضة جداً وبلغ التحقق الآلي حدّه المسموح لهذا الطلب، ولم يُحتسب عليك إلا ما سُلّم",
};
