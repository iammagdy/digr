import { toArabicDigits } from "../arabicDigits";
import type { RowDateSummary } from "./dateRangeFilter";

/** Said when every row of a page has a date and every date is outside the window the customer set. */
export const OUTSIDE_WINDOW_SENTENCE_AR = "المصدر أعاد منشورات خارج الفترة التي حددتها";

/** Said when the source gives no date for the comments themselves and the window was applied to the date of their video. */
export const VIDEO_DATE_BASIS_SENTENCE_AR = "المصدر لا يعرض تاريخ كتابة التعليقات، فطبّقنا الفترة المطلوبة على تاريخ نشر الفيديو الذي كُتبت عليه";

/** Said when some dates were read from a «منذ …» text: they are real but coarse, so the window is applied to them approximately. */
export const APPROXIMATE_DATES_SENTENCE_AR = "بعض التواريخ تقريبية لأن المصدر يعرضها بصيغة «منذ …»، لذلك تُطبَّق الفترة عليها بشكل تقريبي";

/** Said after the outside-the-window sentence when YouTube's search was told to prefer recent uploads and still found no video inside the window. */
export const YOUTUBE_RECENCY_TRIED_SENTENCE_AR = "طلبنا من يوتيوب الفيديوهات الأحدث أولاً ولم نجد فيديوهات داخل الفترة؛ ننصح بإرسال روابط الفيديوهات أو اسم القناة";

/** Said in the same place when the search could not be asked for the newest videos, so it returned the most relevant ones of any date. */
export const YOUTUBE_RECENCY_UNSUPPORTED_SENTENCE_AR = "تعذّر ترتيب نتائج بحث يوتيوب بالأحدث لهذه الفترة فجاءت فيديوهات أقدم منها؛ ننصح بإرسال روابط الفيديوهات أو اسم القناة";

export function youtubeRecencySentenceAr(hint: "recency_applied" | "recency_unsupported" | undefined): string {
  return hint === "recency_applied" ? YOUTUBE_RECENCY_TRIED_SENTENCE_AR : hint === "recency_unsupported" ? YOUTUBE_RECENCY_UNSUPPORTED_SENTENCE_AR : "";
}

/** True when the page returned rows, each with a readable date, and none of them is inside the window. */
export function allRowsOutsideWindow(summary: RowDateSummary, returned: number): boolean {
  return returned > 0 && summary.missing === 0 && summary.outside === returned && summary.inside === 0;
}

/**
 * One plain line per page of a feed job: how many rows are inside, outside and without a date, and the oldest/newest date
 * the source returned. The three numbers always add up to the rows returned, because they come from the classification
 * the filter itself uses; "inside" is only ever claimed for rows the filter kept.
 */
export function dateWindowPageEventAr(summary: RowDateSummary, returned: number, options: { videoBasis?: number; approximate?: number } = {}): string {
  const dropped = summary.missing + summary.outside;
  const range = summary.oldest && summary.newest
    ? `أقدم تاريخ نشر ${toArabicDigits(summary.oldest)} وأحدث تاريخ ${toArabicDigits(summary.newest)}`
    : "لم يظهر تاريخ نشر في أي سجل";
  const basis = options.videoBasis && options.videoBasis > 0
    ? ` ${VIDEO_DATE_BASIS_SENTENCE_AR} (${toArabicDigits(options.videoBasis)} تعليق).`
    : "";
  const approximate = options.approximate && options.approximate > 0
    ? ` ${APPROXIMATE_DATES_SENTENCE_AR} (${toArabicDigits(options.approximate)} سجل).`
    : "";
  if (dropped === 0) {
    return `فحصنا تواريخ ${toArabicDigits(returned)} سجل من هذه الصفحة وكلها داخل الفترة المطلوبة (${range}).${basis}${approximate}`;
  }
  const parts: string[] = [];
  if (summary.outside > 0) parts.push(`${toArabicDigits(summary.outside)} خارج الفترة المطلوبة`);
  if (summary.missing > 0) parts.push(`${toArabicDigits(summary.missing)} بلا تاريخ نشر يمكن التحقق منه`);
  const remaining = summary.inside > 0 ? `، وبقي ${toArabicDigits(summary.inside)} داخلها` : "";
  const verdict = allRowsOutsideWindow(summary, returned) ? ` ${OUTSIDE_WINDOW_SENTENCE_AR}.` : "";
  return `تم استبعاد ${toArabicDigits(dropped)} سجل من هذه الصفحة بسبب التاريخ: ${parts.join(" و")}${remaining}. ${range}.${verdict}${basis}${approximate}`;
}
