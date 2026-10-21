import { toArabicDigits } from "./arabicDigits";

/**
 * How a date that came as text is SHOWN in the results preview: Arabic words and Arabic-Indic digits. Display only: the files keep
 * the source's own text. «3 weeks ago» becomes «منذ ٣ أسابيع»; a day written 06/08/2026 or «منذ 3 أسابيع» only changes its digits.
 * Text that is not a date of one of these shapes is returned as null so the caller leaves it as it is.
 */

const UNITS: Record<string, { one: string; two: string; few: string; many: string }> = {
  second: { one: "ثانية", two: "ثانيتين", few: "ثوانٍ", many: "ثانية" },
  minute: { one: "دقيقة", two: "دقيقتين", few: "دقائق", many: "دقيقة" },
  hour: { one: "ساعة", two: "ساعتين", few: "ساعات", many: "ساعة" },
  day: { one: "يوم", two: "يومين", few: "أيام", many: "يومًا" },
  week: { one: "أسبوع", two: "أسبوعين", few: "أسابيع", many: "أسبوعًا" },
  month: { one: "شهر", two: "شهرين", few: "أشهر", many: "شهرًا" },
  year: { one: "سنة", two: "سنتين", few: "سنوات", many: "سنة" },
};

const SLASH_DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/;
const ENGLISH_AGO = /^(?:(\d+)|an?|one)\s*(second|minute|hour|day|week|month|year)s?\s+ago$/;
const ARABIC_AGO = /^(?:منذ|قبل)\s/u;

export function relativeDateDisplay(value: string): string | null {
  const text = value.trim();
  if (!text || text.length > 40) return null;
  if (SLASH_DATE.test(text)) return toArabicDigits(text);
  const english = ENGLISH_AGO.exec(text.toLowerCase().replace(/\s+/g, " "));
  if (english) {
    const count = english[1] ? Number(english[1]) : 1;
    const unit = UNITS[english[2]];
    const word = count === 1 ? unit.one : count === 2 ? unit.two : count <= 10 ? unit.few : unit.many;
    return count <= 2 ? `منذ ${word}` : `منذ ${toArabicDigits(count)} ${word}`;
  }
  if (ARABIC_AGO.test(text) && /\d/.test(text)) return toArabicDigits(text);
  return null;
}
