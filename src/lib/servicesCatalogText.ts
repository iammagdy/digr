import { formatAr } from "./arabicDigits";

/** Counted nouns in Arabic: one, two, 3-10 plural, 11+ singular accusative. Digits are Arabic-Indic. */
function counted(n: number, one: string, two: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  return `${formatAr(n)} ${n >= 3 && n <= 10 ? few : many}`;
}

export const servicesCountAr = (n: number): string => counted(n, "خدمة واحدة", "خدمتان", "خدمات", "خدمة");
export const platformsCountAr = (n: number): string => counted(n, "منصة واحدة", "منصتان", "منصات", "منصة");
export const sectorsCountAr = (n: number): string => counted(n, "قطاع واحد", "قطاعان", "قطاعات", "قطاعًا");

/** Arabic text for search: no marks, no tatweel, one spelling of alef, ya and ta marbuta, Arabic-Indic digits to ASCII, lower case. */
export function normalizeArabicSearch(input: string): string {
  return String(input || "")
    .replace(/[\u064B-\u065F\u0670\u0640]/gu, "")
    .replace(/[أإآ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/ة/gu, "ه")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}
