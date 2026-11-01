import { CONDITION_CLASSES, type ConditionClass } from "./toolProfile";

/**
 * WHICH CONDITIONS THE CUSTOMER'S WORDS ASK FOR, by code (S1 item 1.5). Only the CLASSES (a period, a language, a country, a named account, a number, replies), never their values: the ranking by coverage needs to know that a date is wanted to prefer a tool
 * that has a date input. The values come from the plan's own typed filters when the request is built (toolInput.ts). Deliberately conservative: a class is reported only when a clear phrase says so. Pure; Arabic with Arabic-Indic or ASCII digits.
 */
const MONTHS = "يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر";
const UNITS = "أسبوع|اسبوع|أسابيع|اسابيع|شهر|شهور|أشهر|اشهر|يوم|أيام|ايام|ساعة|ساعات|سنة|سنوات|سنين";
const COUNTRIES = "مصر|السعودية|الإمارات|الامارات|الكويت|قطر|البحرين|عمان|الأردن|الاردن|لبنان|سوريا|العراق|فلسطين|اليمن|السودان|ليبيا|تونس|الجزائر|المغرب|الخليج|المنطقة العربية|الوطن العربي";

const digits = (s: string): string => s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

export function conditionsOfRequest(textIn: unknown): ConditionClass[] {
  const raw = String(textIn ?? "");
  const text = digits(raw);
  const found = new Set<ConditionClass>();
  if (new RegExp(`آخر\\s+(?:\\d+\\s+)?(?:${UNITS})|(?:الأسبوع|الاسبوع|الشهر|السنة|العام)\\s+(?:الماضي|الحالي)|(?:^|\\s)(?:اليوم|أمس|امبارح)(?:\\s|$)|(?:في|خلال)\\s+(?:${MONTHS})|(?:${MONTHS})\\s+\\d{4}|\\bمنذ\\s+\\d+`).test(text)) found.add("date");
  if (/بالعربي|باللغة\s+العربية|(?:عربي|عربية)\s+فقط|بالإنجليزي|بالانجليزي|باللغة\s+الإنجليزية|باللغة\s+الانجليزية|بالفرنسي/.test(raw)) found.add("language");
  if (new RegExp(`(?:^|\\s)(?:في|من|داخل)\\s+(?:${COUNTRIES})`).test(raw)) found.add("country");
  if (/@[A-Za-z0-9_.]{2,}/.test(raw)) found.add("account");
  // a number that counts items: not a year, not the number of a period unit
  for (const m of text.matchAll(new RegExp(`(?:^|\\s)(\\d{1,6})\\s+(?!(?:${UNITS})(?:\\s|$|،))[\\p{L}«]`, "gu"))) {
    const n = Number(m[1]);
    if (n >= 1 && !(n >= 1900 && n <= 2100)) { found.add("count"); break; }
  }
  if (/(?:الردود|ردود|الريبلاي)/.test(raw)) found.add("replies");
  return CONDITION_CLASSES.filter((c) => found.has(c));
}
