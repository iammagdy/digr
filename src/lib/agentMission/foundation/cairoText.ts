import { toArabicDigits } from "../../arabicDigits";
import { CAIRO_TZ } from "../cairoTime";

/** A moment in Cairo time, in words: «٣ نوفمبر ٢٠٢٦ الساعة ١٣:١٩» (Arabic month, Arabic-Indic digits). Dates are Cairo's, never UTC's. */
const MONTH_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const parts = new Intl.DateTimeFormat("en-GB", { timeZone: CAIRO_TZ, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function cairoMomentAr(ms: number): string {
  const p = Object.fromEntries(parts.formatToParts(ms).map((x) => [x.type, x.value]));
  return `${toArabicDigits(Number(p.day))} ${MONTH_AR[Number(p.month) - 1]} ${toArabicDigits(Number(p.year))} الساعة ${toArabicDigits(`${p.hour}:${p.minute}`)}`;
}
