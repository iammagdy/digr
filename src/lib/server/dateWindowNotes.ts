import { toArabicDigits } from "../arabicDigits";
import type { RowDateSummary } from "./dateRangeFilter";

/** Said when every row of a page has a date and every date is outside the window the customer set. */
export const OUTSIDE_WINDOW_SENTENCE_AR = "المصدر أعاد منشورات خارج الفترة التي حددتها";

/** True when the page returned rows, each with a readable date, and none of them is inside the window. */
export function allRowsOutsideWindow(summary: RowDateSummary, returned: number): boolean {
  return returned > 0 && summary.missing === 0 && summary.outside === returned;
}

/** One plain line per page of a feed job: what the date window dropped and the oldest/newest date the source returned. */
export function dateWindowPageEventAr(summary: RowDateSummary, returned: number): string {
  const dropped = summary.missing + summary.outside;
  const range = summary.oldest && summary.newest
    ? `أقدم تاريخ نشر ${toArabicDigits(summary.oldest)} وأحدث تاريخ ${toArabicDigits(summary.newest)}`
    : "لم يظهر تاريخ نشر في أي سجل";
  if (dropped === 0) {
    return `فحصنا تواريخ ${toArabicDigits(returned)} سجل من هذه الصفحة وكلها داخل الفترة المطلوبة (${range}).`;
  }
  const parts: string[] = [];
  if (summary.outside > 0) parts.push(`${toArabicDigits(summary.outside)} خارج الفترة المطلوبة`);
  if (summary.missing > 0) parts.push(`${toArabicDigits(summary.missing)} بلا تاريخ نشر يمكن التحقق منه`);
  const verdict = allRowsOutsideWindow(summary, returned) ? ` ${OUTSIDE_WINDOW_SENTENCE_AR}.` : "";
  return `تم استبعاد ${toArabicDigits(dropped)} سجل من هذه الصفحة: ${parts.join(" و")}. ${range}.${verdict}`;
}
