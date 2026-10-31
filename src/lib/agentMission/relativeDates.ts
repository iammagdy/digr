import { normalizeText } from "./relevance";
import { cairoText, parseMoment } from "./dateCells";

/**
 * A SOURCE THAT GIVES ONLY A RELATIVE TIME («قبل ٤ أيام», «4 days ago», «Streamed 2 weeks ago», «1 month ago»). The live YouTube retest of 2026-10-29: every video the search gave had a relative publish time, the period filter («آخر ٣ شهور») found no moment in it
 * and left out all 16 new videos, so 0 of 90 were delivered.
 *
 * Code converts such a value to an APPROXIMATE date from the moment the item was read:
 *   - «N units ago» means the item is N units old, less than N+1: its age lies in [N units, N+1 units). That is the RANGE an item stands for; a period filter accepts the item when the range OVERLAPS the period (the item may be inside it);
 *   - the date the file shows is the day N units back (a day, never a made-up time of day), and the item is flagged as approximate so the file says so.
 * Only a text that is a relative age and nothing else is read («قبل ٤ أيام» yes, a sentence that mentions days no). A value that is a real moment is never touched. Pure: no I/O.
 */
export interface RelativeAge {
  /** The age the source states, in ms (N units). */
  ageMs: number;
  /** The oldest the item can be (N+1 units) and the newest (N units), as moments. */
  fromMs: number;
  toMs: number;
  /** The approximate moment the file shows (N units back). */
  approxMs: number;
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const UNIT_MS: Record<string, number> = { second: 1000, minute: MIN, hour: HOUR, day: DAY, week: 7 * DAY, month: 30.4375 * DAY, year: 365.25 * DAY };

/** Arabic unit words as normalizeText writes them (no hamza, «ة» → «ه»): every singular, dual and plural form a source writes. */
const AR_UNITS: ReadonlyArray<readonly [RegExp, keyof typeof UNIT_MS]> = [
  [/^(?:ثانيه|ثانيتين|ثواني|ثوان)$/, "second"],
  [/^(?:دقيقه|دقيقتين|دقايق|دقائق|دقاءق)$/, "minute"],
  [/^(?:ساعه|ساعتين|ساعات)$/, "hour"],
  [/^(?:يوم|يومين|ايام|أيام|يوما)$/, "day"],
  [/^(?:اسبوع|اسبوعين|اسابيع|أسابيع|اسبوعا)$/, "week"],
  [/^(?:شهر|شهرين|اشهر|أشهر|شهور|شهرا)$/, "month"],
  [/^(?:سنه|سنتين|سنوات|سنين|عام|عامين|اعوام|أعوام)$/, "year"],
];
/** Dual forms carry their own number. */
const AR_DUAL = new Set(["يومين", "اسبوعين", "شهرين", "سنتين", "عامين", "ساعتين", "دقيقتين", "ثانيتين"]);
const EN_UNITS: Record<string, keyof typeof UNIT_MS> = { second: "second", sec: "second", secs: "second", minute: "minute", min: "minute", mins: "minute", hour: "hour", hr: "hour", hrs: "hour", day: "day", week: "week", wk: "week", wks: "week", month: "month", mo: "month", mos: "month", year: "year", yr: "year", yrs: "year" };

/** The words a source puts in front of a relative time: «Streamed», «Premiered», «Published», «Updated», «تم البث», «نُشر». */
const LEAD_EN = /^(?:streamed|premiered|published|posted|updated|edited|uploaded|live streamed|last updated)\s+/;
const LEAD_AR = /^(?:تم\s+)?(?:البث|بث|النشر|نشر|التحميل|رفع|تحديث|تحديثه|التحديث)\s+/;

const asNumber = (word: string): number | null => {
  if (/^\d+$/.test(word)) return Number(word);
  if (word === "a" || word === "an" || word === "one") return 1;
  return null;
};

/** The number and unit of a relative text, or null. */
function readAge(raw: string): { n: number; unit: keyof typeof UNIT_MS } | null {
  let t = normalizeText(raw).replace(/[​-‏‪-‮﻿]/g, "").replace(/[.,;:!]+$/g, "").trim();
  if (!t || t.length > 48) return null;
  t = t.replace(LEAD_EN, "").replace(LEAD_AR, "").trim();
  if (/^(?:just now|now|الان|حالا|منذ لحظات|قبل لحظات)$/.test(t)) return { n: 0, unit: "minute" };
  if (/^(?:today|اليوم)$/.test(t)) return { n: 0, unit: "day" };
  if (/^(?:yesterday|امس|البارح|البارحه)$/.test(t)) return { n: 1, unit: "day" };
  // English: «3 days ago», «a week ago», «about 2 hours ago», «1 month ago»
  const en = /^(?:about |over |almost |nearly |around |more than |less than )?(\d+|an?|one)\s+(second|sec|secs|minute|min|mins|hour|hr|hrs|day|week|wk|wks|month|mo|mos|year|yr|yrs)s?\s+ago$/.exec(t);
  if (en) { const n = asNumber(en[1]); return n === null ? null : { n, unit: EN_UNITS[en[2]] }; }
  // Arabic: «قبل ٣ أيام», «قبل يومين», «قبل شهر», «منذ ٥ ساعات», «قبل حوالي ٣ أسابيع»
  const ar = /^(?:قبل|منذ)\s+(?:حوالي\s+|نحو\s+|تقريبا\s+|اكثر من\s+|اقل من\s+)?(?:(\d+)\s+)?(\S+)$/.exec(t);
  if (ar) {
    const word = ar[2];
    const unit = AR_UNITS.find(([re]) => re.test(word))?.[1];
    if (!unit) return null;
    const n = ar[1] !== undefined ? Number(ar[1]) : AR_DUAL.has(word) ? 2 : 1;
    return { n, unit };
  }
  return null;
}

/** The age range a relative text stands for, read at `now`; null when the value is not a relative age. */
export function parseRelativeAge(value: unknown, now: number): RelativeAge | null {
  if (typeof value !== "string") return null;
  const age = readAge(value);
  if (!age || !Number.isFinite(age.n) || age.n < 0 || age.n > 1000) return null;
  const unitMs = UNIT_MS[age.unit];
  const ageMs = age.n * unitMs;
  // «just now» / «today» / «yesterday» are not «N units»: the range of «today» is the day, of «just now» the last minutes
  const upper = (age.n + 1) * unitMs;
  return { ageMs, fromMs: now - upper, toMs: now - ageMs, approxMs: now - ageMs };
}

/** True when a value is a relative age («قبل ٤ أيام», «4 days ago»). */
export const isRelativeAge = (value: unknown): boolean => parseRelativeAge(value, 0) !== null;

/** The day the file shows for a relative age: the approximate moment's calendar day in Cairo («2026-10-25»). A day, never a time of day. */
export const approxDayOf = (age: RelativeAge): string => cairoText(new Date(age.approxMs)).slice(0, 10);

/** How far a date may be from «the moment of the read minus the age in words» and still be that computed date (the call itself takes seconds, a page may be mapped minutes later). */
const DERIVED_TOLERANCE_MS = 10 * MIN;

/**
 * A DATE THE SOURCE COMPUTED FROM A RELATIVE TIME (live: a comment «6 years ago» next to a field `publishedTime` of «2020-10-31T16:42:29Z», the minute of the call minus six years). It looks like an exact moment with a time of day and is not one: the
 * source only knows «6 years ago». When `value` is a moment within a few minutes of (the read moment minus the age that `relativeText` states), it is that computed date and the day it stands for is returned, to be written as an approximate day;
 * null for a real timestamp (it differs from the computed one by more than the tolerance) or when the text is not a relative age. Pure.
 */
export function derivedRelativeDay(value: unknown, relativeText: unknown, now: number): string | null {
  const age = parseRelativeAge(relativeText, now);
  if (!age) return null;
  const moment = parseMoment(value);
  if (!moment) return null;
  return Math.abs(moment.getTime() - age.approxMs) <= DERIVED_TOLERANCE_MS ? approxDayOf(age) : null;
}

/** True when the range of a relative age overlaps the span [fromMs, toMs]: the item MAY be inside it. */
export const rangeOverlaps = (age: RelativeAge, fromMs: number, toMs: number): boolean => age.toMs >= fromMs && age.fromMs <= toMs;

/** The key an item's row carries (internal, never a column of the file) listing the columns whose date is approximate. */
export const APPROX_DATES_KEY = "_approx_dates";

/** The columns of a row whose date is approximate (read from the internal mark). */
export function approxColumnsOf(row: Record<string, unknown>): string[] {
  const v = row[APPROX_DATES_KEY];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Shown in the file where a date is approximate. */
export const APPROX_WORD_AR = "تقريبًا";
export const APPROX_DATE_NUMBER_FORMAT = `"${APPROX_WORD_AR} "yyyy-mm-dd`;

/** The sentence on the first sheet when any date of the file is approximate (the source gave only «قبل ٣ أيام» and the like). */
export const APPROX_DATES_NOTE_AR = `بعض التواريخ تقريبية لأن المصدر يذكر وقت النشر نسبيًا فقط (مثل «قبل ٣ أيام»)، فحُسبت من وقت جلبها وتظهر مسبوقة بكلمة «${APPROX_WORD_AR}»، ويُقبل في الفترة المطلوبة كل عنصر يحتمل أن يقع داخلها.`;

/** The line on the plan card when the source gives only relative times for the date the period is checked on. */
export const APPROX_DATES_CARD_LINE_AR = "هذا المصدر يذكر وقت النشر نسبيًا فقط (مثل «قبل ٣ أيام»)، فتُحسب التواريخ تقريبيًا من وقت الجلب ويُفحص الشرط الزمني بها، وتظهر في الملف مسبوقة بكلمة «تقريبًا».";

const DATE_FIELD = /(^|_)(date|time|datetime|timestamp|created|createdat|created_at|createtime|create_time|published|publishedat|published_at|posted|postedat|posted_at|publish_time|updated|updated_at|when)(_|$)|(_at|time|date)$/i;

/**
 * WHAT THE CATALOG SAYS ABOUT AN ENDPOINT'S DATES, from the example values of its own date fields: «relative» when every date field it lists gives a relative time («10 days ago»), «absolute» when one gives a real moment, null when it lists none or an example that is neither.
 * The planner sees it next to the price: a source whose dates are relative gives APPROXIMATE dates in the file, so when the request has a period and a source of the same job costs about the same with absolute dates, that one is the better choice.
 */
export function catalogDateKind(endpoint: { item_fields: Record<string, { example?: unknown }> | null }): "relative" | "absolute" | null {
  let relative = false;
  for (const [key, field] of Object.entries(endpoint.item_fields ?? {})) {
    if (!DATE_FIELD.test(key)) continue;
    const example = field?.example;
    if (isRelativeAge(example)) { relative = true; continue; }
    if (typeof example === "string" && (/^\d{4}-\d{2}-\d{2}/.test(example) || /^\d{9,13}$/.test(example.trim()) || /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} /.test(example))) return "absolute";
  }
  return relative ? "relative" : null;
}
