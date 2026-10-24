import { formatAr, toArabicDigits } from "../arabicDigits";

/** A count with its Arabic noun in the right number form: «منشور واحد», «منشوران», «٣ منشورات», «١١ منشورًا». Digits are Arabic-Indic, thousands grouped. */
export function countAr(n: number, forms: { one: string; two: string; few: string; many: string }): string {
  const value = Math.max(0, Math.floor(Number(n) || 0));
  if (value === 0) return `٠ ${forms.many}`;
  if (value === 1) return forms.one;
  if (value === 2) return forms.two;
  return `${formatAr(value)} ${value <= 10 ? forms.few : forms.many}`;
}

export const postsAr = (n: number): string => countAr(n, { one: "منشور واحد", two: "منشوران", few: "منشورات", many: "منشورًا" });
export const commentsAr = (n: number): string => countAr(n, { one: "تعليق واحد", two: "تعليقان", few: "تعليقات", many: "تعليقًا" });
export const pagesAr = (n: number): string => countAr(n, { one: "صفحة واحدة", two: "صفحتان", few: "صفحات", many: "صفحة" });

/** A percentage with Arabic-Indic digits and the Arabic percent sign, one decimal at most: ٢٠٪, ١٢٫٨٪. */
export function percentAr(share: number): string {
  const value = Math.round(Math.max(0, share) * 1000) / 10;
  return `${toArabicDigits(Number.isInteger(value) ? String(value) : value.toFixed(1).replace(".", "٫"))}٪`.replace(/\./g, "٫");
}

/** A day (YYYY-MM-DD) as the customer reads it: «٢٤ يوليو ٢٠٢٦». */
const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
export function dayAr(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return "غير متاح";
  return `${toArabicDigits(Number(m[3]))} ${MONTHS_AR[Number(m[2]) - 1]} ${toArabicDigits(m[1])}`;
}

export { formatAr, toArabicDigits };
