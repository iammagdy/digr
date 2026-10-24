import { normalizeDigits, toArabicDigits } from "./arabicDigits";

/**
 * Time windows for feed-type requests (posts, comments, videos on X, TikTok, YouTube, Facebook), decided by code.
 *
 * Rules (owner's brief):
 *  - dates the customer wrote are used; an invalid day (31/9) is corrected to the last valid day of that month, with a
 *    plain Arabic note, never rolled into the next month and never widened to a whole year;
 *  - a clearly identified known event (for example the 2026 World Cup) gets a proposed window with a one-line reason;
 *    the plan shows it and the customer can edit it;
 *  - a topic with no time frame gets ONE question (آخر شهر / آخر ٣ شهور / آخر ٦ شهور / آخر سنة) with a plain warning;
 *  - a window is NEVER applied silently: every window that reaches a plan has a source the plan can show.
 * No model call, no network.
 */

export const WINDOW_OPTIONS_AR = ["آخر شهر", "آخر ٣ شهور", "آخر ٦ شهور", "آخر سنة"] as const;

export const WINDOW_LONG_RANGE_WARNING_AR =
  "كلما طالت الفترة زاد حجم البيانات وقد يصل إلى أعداد كبيرة جدًا، لذلك يفضّل تحديد سقف للنقاط في الخطة.";

export type WindowSource = "stated" | "relative" | "event" | "open_scope" | "default";

export type ResolvedWindow =
  | {
      status: "resolved";
      source: WindowSource;
      /** ISO dates (yyyy-mm-dd), inclusive. Absent only for an open scope (no date filter). */
      dateFrom?: string;
      dateTo?: string;
      /** The window as the plan shows it, Arabic digits. */
      labelAr: string;
      /** One line explaining a proposal made by code (known event) or an open scope. */
      reasonAr?: string;
      /** A plain note when the customer's date was corrected. */
      noteAr?: string;
    }
  | { status: "missing"; question: WindowQuestion; noteAr?: string }
  | { status: "not_needed" };

export interface WindowQuestion {
  id: "time_window_required";
  text: string;
  type: "single";
  options: string[];
  allowOther: true;
  warningAr: string;
}

export function windowQuestion(): WindowQuestion {
  return {
    id: "time_window_required",
    text: "ما الفترة الزمنية التي تهمّك؟",
    type: "single",
    options: [...WINDOW_OPTIONS_AR],
    allowOther: true,
    warningAr: WINDOW_LONG_RANGE_WARNING_AR,
  };
}

/* ---------------------------------------------------------------- text helpers */

const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

/** Normalised spellings (no diacritics, أ/إ/آ -> ا, ى -> ي) to month number. Longest first so «تشرين الاول» wins over «تشرين». */
const MONTH_WORDS: Array<[string, number]> = [
  ["كانون الثاني", 1], ["كانون الاول", 12], ["تشرين الثاني", 11], ["تشرين الاول", 10],
  ["يناير", 1], ["فبراير", 2], ["مارس", 3], ["ابريل", 4], ["مايو", 5], ["يونيو", 6], ["يوليو", 7], ["اغسطس", 8],
  ["سبتمبر", 9], ["اكتوبر", 10], ["نوفمبر", 11], ["ديسمبر", 12],
  ["شباط", 2], ["اذار", 3], ["نيسان", 4], ["ايار", 5], ["حزيران", 6], ["تموز", 7], ["ايلول", 9],
];
const MONTH_ALT = MONTH_WORDS.map(([w]) => w).sort((a, b) => b.length - a.length).join("|");
const MONTH_NUMBER = new Map<string, number>(MONTH_WORDS);

export function normalizeWindowText(text: string): string {
  return normalizeDigits(String(text || ""))
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[،؛]/g, " ")
    .toLowerCase();
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function formatDateAr(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${toArabicDigits(d)} ${MONTHS_AR[m - 1]} ${toArabicDigits(y)}`;
}

function windowLabelAr(from: string, to: string): string {
  return from === to ? formatDateAr(from) : `من ${formatDateAr(from)} إلى ${formatDateAr(to)}`;
}

/** A word that names a month («سبتمبر»), in any alef/ya spelling: part of a period, never a search subject. */
export function isMonthWord(word: string): boolean {
  return MONTH_NUMBER.has(normalizeWindowText(word).trim());
}

const PERIOD_LEAD_WORDS = new Set(["اخر", "خلال", "الفتره", "فتره", "بدايه", "بداية", "نهايه", "نهاية", "لحد", "لغايه", "لغاية", "حتي"]);
const PERIOD_UNIT_WORDS = new Set(["شهر", "شهرين", "شهور", "اشهر", "اسبوع", "اسبوعين", "اسابيع", "يوم", "يومين", "ايام", "سنه", "سنة", "سنتين", "سنوات", "سنين", "عام", "عامين", "اعوام"]);

/**
 * The words of a request that only state its period («آخر ٣ شهور», «من يناير لحد سبتمبر»), so a subject reader can leave them out:
 * a month name anywhere, a period lead word («آخر», «خلال», «لحد»), and a unit word only right after such a lead word.
 */
const PERIOD_UNIT_WITH_AL = new Set(["الشهر", "الاسبوع", "السنه", "السنة", "العام"]);
const PERIOD_PAST_WORDS = new Set(["الماضي", "الماضيه", "الماضية", "السابق", "السابقه", "السابقة", "المنصرم", "الحالي", "الحاليه", "الحالية"]);
const PERIOD_THIS_WORDS = new Set(["هذا", "هذه", "هاذا", "هاذه"]);

export function periodWordFlags(tokens: string[]): boolean[] {
  const flags: boolean[] = [];
  let afterLead: boolean = false;
  for (const token of tokens) {
    const norm = normalizeWindowText(token).trim();
    const isLead = PERIOD_LEAD_WORDS.has(norm);
    // «آخر ثلاثة شهور»: a count written in words right after the lead word is part of the period, and the unit after it is too
    const isCountWord: boolean = afterLead && WORD_COUNT_VALUE.has(norm);
    const flagged = isMonthWord(token) || isLead || isCountWord || (afterLead && PERIOD_UNIT_WORDS.has(norm));
    flags.push(flagged);
    afterLead = isLead || isCountWord;
  }
  // «الشهر الماضي», «هذا الشهر», «الشهر اللي فات»: the unit with «ال» and the word that makes it a period are the period too, only when they come together.
  const norms = tokens.map((token) => normalizeWindowText(token).trim());
  for (let i = 0; i < norms.length; i++) {
    if (!PERIOD_UNIT_WITH_AL.has(norms[i])) continue;
    const next = norms[i + 1] ?? "";
    const next2 = norms[i + 2] ?? "";
    const prev = norms[i - 1] ?? "";
    const pastNext = PERIOD_PAST_WORDS.has(next);
    const pastFat = (next === "اللي" || next === "الي" || next === "الذي" || next === "التي") && (next2 === "فات" || next2 === "فاتت");
    const thisPrev = PERIOD_THIS_WORDS.has(prev);
    if (!pastNext && !pastFat && !thisPrev) continue;
    flags[i] = true;
    if (pastNext) flags[i + 1] = true;
    if (pastFat) { flags[i + 1] = true; flags[i + 2] = true; }
    if (thisPrev) flags[i - 1] = true;
  }
  return flags;
}

/* ---------------------------------------------------------------- explicit dates */

interface DateToken {
  index: number;
  end: number;
  y?: number;
  m?: number;
  /** undefined: the token names a month (or a year) without a day */
  d?: number;
  /** «آخر سبتمبر», «نهاية سبتمبر»: the last day of the month; «بداية يناير»: the first */
  edge?: "end" | "start";
  yearOnly?: boolean;
}

const DMY_RE = /(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?![\d])/g;
const ISO_RE = /(?<![\d/.-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d])/g;
const DAY_MONTH_RE = new RegExp(`(?<![\\d])(\\d{1,2})\\s*(?:من\\s*)?(?:شهر\\s*)?(${MONTH_ALT})(?:\\s*(\\d{4}))?`, "g");
const EDGE_MONTH_RE = new RegExp(`(اخر|نهايه|نهاية|بدايه|بداية|اول)\\s*(?:شهر\\s*)?(${MONTH_ALT})(?:\\s*(\\d{4}))?`, "g");
const MONTH_YEAR_RE = new RegExp(`(?:شهر\\s*)?(${MONTH_ALT})\\s*(?:من\\s*)?(?:سنه|عام)?\\s*(\\d{4})`, "g");
const MONTH_ONLY_RE = new RegExp(`(?:شهر|من|بين|الي|لحد|حتي|لغايه|لغاية)\\s+(${MONTH_ALT})(?![\\p{L}\\d])`, "gu");
const YEAR_EDGE_RE = /(بدايه|بداية|اول|نهايه|نهاية|اخر)\s*(?:سنه|عام)?\s*(\d{4})/g;

function collectDateTokens(norm: string): DateToken[] {
  const tokens: DateToken[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (start: number, end: number) => taken.some(([a, b]) => start < b && end > a);
  const take = (match: RegExpExecArray, token: DateToken) => {
    const start = match.index;
    const end = start + match[0].length;
    if (overlaps(start, end)) return;
    taken.push([start, end]);
    tokens.push({ ...token, index: start, end });
  };

  for (const m of norm.matchAll(ISO_RE)) take(m as RegExpExecArray, { index: 0, end: 0, y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) });
  for (const m of norm.matchAll(DMY_RE)) take(m as RegExpExecArray, { index: 0, end: 0, d: Number(m[1]), m: Number(m[2]), y: Number(m[3]) });
  for (const m of norm.matchAll(YEAR_EDGE_RE)) {
    const edge = /^(?:بدايه|بداية|اول)$/.test(m[1]) ? "start" : "end";
    take(m as RegExpExecArray, { index: 0, end: 0, y: Number(m[2]), edge, yearOnly: true });
  }
  for (const m of norm.matchAll(EDGE_MONTH_RE)) {
    const edge = /^(?:بدايه|بداية|اول)$/.test(m[1]) ? "start" : "end";
    take(m as RegExpExecArray, { index: 0, end: 0, m: MONTH_NUMBER.get(m[2]), y: m[3] ? Number(m[3]) : undefined, edge });
  }
  for (const m of norm.matchAll(DAY_MONTH_RE)) take(m as RegExpExecArray, { index: 0, end: 0, d: Number(m[1]), m: MONTH_NUMBER.get(m[2]), y: m[3] ? Number(m[3]) : undefined });
  for (const m of norm.matchAll(MONTH_YEAR_RE)) take(m as RegExpExecArray, { index: 0, end: 0, m: MONTH_NUMBER.get(m[1]), y: Number(m[2]) });
  for (const m of norm.matchAll(MONTH_ONLY_RE)) take(m as RegExpExecArray, { index: 0, end: 0, m: MONTH_NUMBER.get(m[1]) });
  return tokens.sort((a, b) => a.index - b.index);
}

interface ResolvedDay {
  date: string;
  note?: string;
}

/** One token as the FIRST (role "from") or LAST (role "to") day it stands for, with the correction note for an impossible day. */
function tokenToDay(token: DateToken, role: "from" | "to", year: number, correctionYear: number): ResolvedDay | null {
  const y = token.y ?? year;
  if (token.yearOnly) {
    const startOfYear = token.edge === "start" ? true : token.edge === "end" ? false : role === "from";
    return { date: startOfYear ? iso(y, 1, 1) : iso(y, 12, 31) };
  }
  const m = token.m;
  if (!m || m < 1 || m > 12) return null;
  const last = daysInMonth(y, m);
  if (token.edge === "end") return { date: iso(y, m, last) };
  if (token.edge === "start") return { date: iso(y, m, 1) };
  if (token.d === undefined) return { date: role === "from" ? iso(y, m, 1) : iso(y, m, last) };
  if (token.d < 1) return null;
  if (token.d > last) {
    const monthName = MONTHS_AR[m - 1];
    return {
      date: iso(y, m, last),
      note: `شهر ${monthName} ${toArabicDigits(correctionYear || y)} ليس فيه يوم ${toArabicDigits(token.d)}، فاعتمدت ${toArabicDigits(last)} ${monthName} آخر يوم في الشهر.`,
    };
  }
  return { date: iso(y, m, token.d) };
}

/** Explicit dates in the text: one day, a month, a year, or a range. Null when the text states none. */
export function parseStatedDates(text: string, today: Date = new Date()): { from: string; to: string; noteAr?: string } | { conflictNoteAr: string } | null {
  const norm = normalizeWindowText(text);
  const tokens = collectDateTokens(norm);
  if (tokens.length === 0) return null;

  const currentYear = today.getUTCFullYear();
  const firstTwo = tokens.slice(0, 2);
  // A token without a year takes the year of the other token, otherwise this year.
  const yearOf = (index: number) => firstTwo[index]?.y ?? firstTwo[1 - index]?.y ?? currentYear;
  const isRange = firstTwo.length === 2 && /(?:الي|حتي|لحد|لغايه|لغاية|وحتي|-|–|—)/.test(norm.slice(firstTwo[0].end, firstTwo[1].index));

  if (firstTwo.length === 2 && isRange) {
    const from = tokenToDay(firstTwo[0], "from", yearOf(0), yearOf(0));
    const to = tokenToDay(firstTwo[1], "to", yearOf(1), yearOf(1));
    if (!from || !to) return null;
    const notes = [from.note, to.note].filter(Boolean).join(" ");
    if (from.date > to.date) {
      return { conflictNoteAr: `تاريخ البداية (${formatDateAr(from.date)}) بعد تاريخ النهاية (${formatDateAr(to.date)}).` };
    }
    return { from: from.date, to: to.date, ...(notes ? { noteAr: notes } : {}) };
  }

  const only = tokens[0];
  const asFrom = tokenToDay(only, "from", yearOf(0), yearOf(0));
  const asTo = tokenToDay(only, "to", yearOf(0), yearOf(0));
  if (!asFrom || !asTo) return null;
  return { from: asFrom.date, to: asTo.date, ...(asFrom.note ? { noteAr: asFrom.note } : {}) };
}

/* ---------------------------------------------------------------- relative windows */

/**
 * A count written in words («آخر ثلاث شهور», «تلات شهور»), in the spellings customers use, after `normalizeWindowText`. Before this a period written in
 * words was not read at all: the request fell through to the proposed last month with «لم تحدد فترة», although the customer HAD stated a period.
 */
const WORD_COUNTS: Array<[string, number]> = [
  ["ثلاثه", 3], ["ثلاثة", 3], ["ثلاث", 3], ["تلاته", 3], ["تلاتة", 3], ["تلات", 3], ["ثلات", 3],
  ["اربعه", 4], ["اربعة", 4], ["اربع", 4],
  ["خمسه", 5], ["خمسة", 5], ["خمس", 5],
  ["سته", 6], ["ستة", 6], ["ست", 6],
  ["سبعه", 7], ["سبعة", 7], ["سبع", 7],
  ["ثمانيه", 8], ["ثمانية", 8], ["ثماني", 8], ["ثمان", 8], ["تمانيه", 8], ["تمانية", 8], ["تمن", 8],
  ["تسعه", 9], ["تسعة", 9], ["تسع", 9],
  ["عشره", 10], ["عشرة", 10], ["عشر", 10],
];
const WORD_COUNT_ALT = WORD_COUNTS.map(([w]) => w).sort((a, b) => b.length - a.length).join("|");
const WORD_COUNT_VALUE = new Map<string, number>(WORD_COUNTS);
const PERIOD_UNITS_RE = "شهرين|اسبوعين|يومين|سنتين|عامين|شهور|اشهر|شهر|سنوات|سنين|سنه|سنة|اعوام|عام|اسابيع|اسبوع|ايام|يوم";
const RELATIVE_RE = new RegExp(`(?:اخر|خلال|اخر\\s*فتره)\\s*(\\d+|${WORD_COUNT_ALT})?\\s*(${PERIOD_UNITS_RE})(?!\\s*(?:19|20)\\d{2})`);
/** «٣ شهور الماضية», «ثلاث شهور أخيرة», «منذ ٣ شهور», «من ٣ شهور»: a count and a unit with the word that makes it the period behind us. */
const RELATIVE_BACK_RE = new RegExp(`(?:(?:منذ|مند|من)\\s*(\\d+|${WORD_COUNT_ALT})\\s*(${PERIOD_UNITS_RE})|(\\d+|${WORD_COUNT_ALT})\\s*(${PERIOD_UNITS_RE})\\s*(?:ال)?(?:ماضي\\S*|اخير\\S*|فات\\S*|سابق\\S*))(?![\\p{L}\\d])(?!\\s*(?:19|20)\\d{2})`, "u");
/** The count words as a pattern for TEXT THAT IS NOT NORMALISED yet (hamza, taa marbuta and alef maqsura in any spelling): for the readers that look at a customer's raw sentence. */
export const RELATIVE_COUNT_WORDS_ALT = [...WORD_COUNTS].sort((a, b) => b[0].length - a[0].length).map(([w]) => w.replace(/ا/g, "[اأإ]").replace(/[هة]/g, "[هة]").replace(/ي/g, "[يى]")).join("|");
const countOf = (raw: string | undefined): number => (raw === undefined || raw === "" ? 1 : /^\d+$/.test(raw) ? Number(raw) : WORD_COUNT_VALUE.get(raw) ?? 1);

function addMonthsClamped(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1));
  const last = daysInMonth(target.getUTCFullYear(), target.getUTCMonth() + 1);
  target.setUTCDate(Math.min(date.getUTCDate(), last));
  return target;
}

/** «الشهر الماضي», «الأسبوع اللي فات», «السنة السابقة»: the period just gone, read like «آخر شهر». */
const PAST_PERIOD_RE = /(?:^|\s)ال(شهر|اسبوع|سنه|سنة|عام)\s*(?:ال(?:ماضي|ماضيه|ماضية|سابق|سابقه|سابقة|منصرم|منصرمه|منصرمة)|(?:اللي|الي|الذي|التي)\s*فات(?:ت)?|فات)(?![\p{L}\d])/u;
/** «هذا الشهر», «هذه السنة», «الشهر الحالي»: the current calendar period, from its first day to today. */
const THIS_PERIOD_RE = /(?:(?:هذا|هذه|هاذا|هاذه)\s*(?:ال)?(شهر|اسبوع|سنه|سنة|عام)|(?:^|\s)ال(شهر|اسبوع|سنه|سنة|عام)\s*ال(?:حالي|حاليه|حالية))(?![\p{L}\d])/u;
const PERIOD_UNIT_KIND: Record<string, "month" | "week" | "year"> = { شهر: "month", اسبوع: "week", سنه: "year", سنة: "year", عام: "year" };
const PAST_AS_RELATIVE: Record<"month" | "week" | "year", string> = { month: "آخر شهر", week: "آخر أسبوع", year: "آخر سنة" };
/** The Arab week starts on Saturday. */
const WEEK_START_DAY = 6;

function currentPeriodWindow(kind: "month" | "week" | "year", today: Date): { from: string; to: string; labelAr: string } {
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  let start: Date;
  let phrase: string;
  if (kind === "month") { start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)); phrase = "هذا الشهر"; }
  else if (kind === "year") { start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1)); phrase = "هذه السنة"; }
  else {
    const back = (end.getUTCDay() - WEEK_START_DAY + 7) % 7;
    start = new Date(end.getTime() - back * 86400000);
    phrase = "هذا الأسبوع";
  }
  const from = start.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  return { from, to, labelAr: `${phrase} (${windowLabelAr(from, to)})` };
}

export function parseRelativeWindow(text: string, today: Date = new Date()): { from: string; to: string; labelAr: string } | null {
  const norm = normalizeWindowText(text);
  const back = RELATIVE_RE.test(norm) ? null : RELATIVE_BACK_RE.exec(norm);
  const m = back ? ([back[0], back[1] ?? back[3], back[2] ?? back[4]] as unknown as RegExpExecArray) : RELATIVE_RE.exec(norm);
  if (!m) {
    const past = PAST_PERIOD_RE.exec(norm);
    if (past) return parseRelativeWindow(PAST_AS_RELATIVE[PERIOD_UNIT_KIND[past[1]]], today);
    const current = THIS_PERIOD_RE.exec(norm);
    if (current) return currentPeriodWindow(PERIOD_UNIT_KIND[current[1] || current[2]], today);
    return null;
  }
  const unit = m[2];
  const dual = /^(?:شهرين|اسبوعين|يومين|سنتين|عامين)$/.test(unit);
  const count = dual ? 2 : countOf(m[1]);
  if (count < 1 || count > 120) return null;
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  let start: Date;
  let phrase: string;
  if (/^(?:شهر|شهرين|شهور|اشهر)$/.test(unit)) {
    start = addMonthsClamped(end, -count);
    phrase = count === 1 ? "آخر شهر" : count === 2 ? "آخر شهرين" : `آخر ${toArabicDigits(count)} ${count <= 10 ? "شهور" : "شهرًا"}`;
  } else if (/^(?:سنه|سنة|سنتين|سنوات|سنين|عام|عامين|اعوام)$/.test(unit)) {
    start = addMonthsClamped(end, -12 * count);
    phrase = count === 1 ? "آخر سنة" : count === 2 ? "آخر سنتين" : `آخر ${toArabicDigits(count)} ${count <= 10 ? "سنوات" : "سنة"}`;
  } else if (/^(?:اسبوع|اسبوعين|اسابيع)$/.test(unit)) {
    start = new Date(end.getTime() - count * 7 * 86400000);
    phrase = count === 1 ? "آخر أسبوع" : count === 2 ? "آخر أسبوعين" : `آخر ${toArabicDigits(count)} ${count <= 10 ? "أسابيع" : "أسبوعًا"}`;
  } else {
    start = new Date(end.getTime() - count * 86400000);
    phrase = count === 1 ? "آخر يوم" : count === 2 ? "آخر يومين" : `آخر ${toArabicDigits(count)} ${count <= 10 ? "أيام" : "يومًا"}`;
  }
  const from = start.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  return { from, to, labelAr: `${phrase} (${windowLabelAr(from, to)})` };
}

/* ---------------------------------------------------------------- recency and popularity words */

/**
 * What a request without dates asks for by its own words:
 *  - "recent": «ترند / أحدث / الأحدث / trending / latest»: what is happening NOW. A rolling window ending today is proposed, never the dates of an event.
 *  - "popular": «الأكثر انتشارًا / مشاهدة / تفاعلًا / فيرال»: a ranking over every item the source can show; a one-month window would drop the very
 *    videos asked for (an old viral video is still the most viral). The scope is open and the plan says so.
 * «ترند» wins over a popularity word in the same request (a trend is about now). Dates the customer wrote always win over both.
 */
export type RecencyIntent = "recent" | "popular";

const RECENT_WORDS_RE = /(?:^|[\s(])(?:ال)?(?:ترند|تريند|تراند|ترندنج|تريندنج|تراندنج|ستراندنج|استراندنج|سترندنج|ستريندنج|رائج|رايج|احدث|trending|trends?|latest|newest|recent)(?![\p{L}\d])/u;
const POPULAR_WORDS_RE = /(?:ال)?(?:اكثر|اعلي)\s*(?:مشاهد[هة]|مشاهدات|تفاعل|انتشار|رواج|شعبي[هة])|فيرال|\bviral\b|most\s+(?:viewed|popular|viral|watched)/u;

export function requestRecencyIntent(text: string): RecencyIntent | null {
  const norm = normalizeWindowText(text);
  if (RECENT_WORDS_RE.test(norm)) return "recent";
  if (POPULAR_WORDS_RE.test(norm)) return "popular";
  return null;
}

export const RECENT_WINDOW_REASON_AR = "طلبك عن الأحدث أو الرائج الآن ولم تذكر فترة، فاقترحت آخر ٣٠ يومًا حتى اليوم وتقدر تعدّلها في الخطة.";
export const POPULAR_SCOPE_REASON_AR = "طلبك عن الأكثر انتشارًا ولم تذكر فترة، فلم أقيّد الطلب بفترة حتى لا تُستبعد الفيديوهات الأعلى مشاهدة لأنها أقدم؛ وتقدر تحدد فترة من الخطة.";

/* ---------------------------------------------------------------- known events */

export interface KnownEvent {
  id: string;
  nameAr: string;
  from: string;
  to: string;
  /** Matched against the normalised text */
  re: RegExp;
}

/** Events with fixed, published dates. Add an entry only with a source-confirmed range; the window is a proposal the customer can edit. */
export const KNOWN_EVENTS: readonly KnownEvent[] = [
  { id: "world_cup_2026", nameAr: "كأس العالم ٢٠٢٦", from: "2026-06-11", to: "2026-07-19", re: /(?:كاس\s*العالم|مونديال|world\s*cup)\s*(?:ل|لسنه|لعام)?\s*(?:سنه|عام)?\s*2026|2026\s*world\s*cup/ },
  // «كأس العالم» with no year and no other tournament word after it («للأندية», «للشباب», «لكرة اليد»): the latest edition, said so in the reason.
  { id: "world_cup_latest", nameAr: "كأس العالم (أحدث نسخة، ٢٠٢٦)", from: "2026-06-11", to: "2026-07-19", re: /(?:كاس\s*العالم|مونديال|world\s*cup)(?!\s*ل(?!سنه|عام)\p{L}+)(?!\s*(?:ل|لسنه|لعام)?\s*(?:سنه|عام)?\s*(?:19|20)\d\d)(?!\s*(?:club|youth|women))/u },
  { id: "afcon_2025", nameAr: "كأس الأمم الأفريقية ٢٠٢٥", from: "2025-12-21", to: "2026-01-18", re: /(?:كاس\s*(?:الامم|امم)\s*(?:الافريقيه|افريقيا)|afcon|africa\s*cup\s*of\s*nations)\s*(?:ل|لسنه|لعام)?\s*(?:سنه|عام)?\s*2025/ },
];

export function knownEventWindow(text: string, today: Date = new Date()): { from: string; to: string; labelAr: string; reasonAr: string } | null {
  const norm = normalizeWindowText(text);
  const event = KNOWN_EVENTS.find((e) => e.re.test(norm));
  if (!event) return null;
  const todayIso = today.toISOString().slice(0, 10);
  // «ترند كأس العالم», «أحدث ...»: a request about what is happening now is not about the dates of an event that is over. An event still
  // running (or to come) keeps its window; a finished one is dropped and the caller's rolling window or open scope applies.
  if (requestRecencyIntent(text) && event.to < todayIso) return null;
  const verb = event.to < todayIso ? "جرت" : "تُقام";
  return {
    from: event.from,
    to: event.to,
    labelAr: windowLabelAr(event.from, event.to),
    reasonAr: `${event.nameAr} ${verb} من ${formatDateAr(event.from)} إلى ${formatDateAr(event.to)}، فاقترحت هذه الفترة وتقدر تعدّلها في الخطة.`,
  };
}

/* ---------------------------------------------------------------- proposed default */

/**
 * The window a plan proposes when the customer gave none (a skipped question, or a request that does not ask for one): the last month,
 * with a one-line reason the plan shows, so it can be edited. Never applied without the plan saying so.
 */
export function proposedDefaultWindow(today: Date = new Date()): Extract<ResolvedWindow, { status: "resolved" }> {
  const relative = parseRelativeWindow("آخر شهر", today)!;
  return {
    status: "resolved",
    source: "default",
    dateFrom: relative.from,
    dateTo: relative.to,
    labelAr: relative.labelAr,
    reasonAr: "لم تحدد فترة، فاقترحت آخر شهر وتقدر تعدّلها في الخطة.",
  };
}

/** A window the customer's words produced, or else the proposed default (for the plan, never for deciding whether to ask). */
export function windowOrProposedDefault(window: ResolvedWindow, today: Date = new Date()): ResolvedWindow {
  return window.status === "missing" ? proposedDefaultWindow(today) : window;
}

/* ---------------------------------------------------------------- year only */

const YEAR_ONLY_RE = /(?:^|\s)(?:في|سنه|سنة|عام|خلال|منذ|during|in|year)\s+((?:19|20)\d{2})(?![\d])/;

function parseYearOnly(text: string): { from: string; to: string } | null {
  const m = YEAR_ONLY_RE.exec(normalizeWindowText(text));
  if (!m) return null;
  return { from: `${m[1]}-01-01`, to: `${m[1]}-12-31` };
}

/* ---------------------------------------------------------------- resolution */

export interface ResolveWindowOptions {
  today?: Date;
  /** Whether this kind of request needs a window at all (a feed search); directories (companies, people) do not. */
  needsWindow: boolean;
  /**
   * The request ranks existing items («أعلى ١٠ فيديوهات مشاهدة لكل قناة»): with no stated window the scope is every available
   * item, shown on the plan as an open scope the customer can narrow. It is a visible scope, never a hidden default.
   */
  rankingRequest?: boolean;
}

export function resolveTimeWindow(text: string, options: ResolveWindowOptions): ResolvedWindow {
  if (!options.needsWindow) return { status: "not_needed" };
  const today = options.today ?? new Date();

  const stated = parseStatedDates(text, today);
  if (stated && "conflictNoteAr" in stated) return { status: "missing", question: windowQuestion(), noteAr: stated.conflictNoteAr };
  if (stated) {
    return { status: "resolved", source: "stated", dateFrom: stated.from, dateTo: stated.to, labelAr: windowLabelAr(stated.from, stated.to), ...(stated.noteAr ? { noteAr: stated.noteAr } : {}) };
  }

  const relative = parseRelativeWindow(text, today);
  if (relative) return { status: "resolved", source: "relative", dateFrom: relative.from, dateTo: relative.to, labelAr: relative.labelAr };

  const event = knownEventWindow(text, today);
  if (event) return { status: "resolved", source: "event", dateFrom: event.from, dateTo: event.to, labelAr: event.labelAr, reasonAr: event.reasonAr };

  const year = parseYearOnly(text);
  if (year) return { status: "resolved", source: "stated", dateFrom: year.from, dateTo: year.to, labelAr: windowLabelAr(year.from, year.to) };

  const intent = requestRecencyIntent(text);
  if (intent === "recent") {
    const rolling = parseRelativeWindow("آخر شهر", today)!;
    return { status: "resolved", source: "default", dateFrom: rolling.from, dateTo: rolling.to, labelAr: rolling.labelAr, reasonAr: RECENT_WINDOW_REASON_AR };
  }
  if (intent === "popular") {
    return { status: "resolved", source: "open_scope", labelAr: "كل الفترة المتاحة", reasonAr: POPULAR_SCOPE_REASON_AR };
  }

  if (options.rankingRequest) {
    return {
      status: "resolved",
      source: "open_scope",
      labelAr: "كل الفترة المتاحة",
      reasonAr: "الترتيب يشمل كل ما هو متاح على القناة، وتقدر تحدد فترة من الخطة.",
    };
  }
  return { status: "missing", question: windowQuestion() };
}

/** True when the customer's own words state the period (dates, a relative period, a known event): not a proposal the plan makes («ترند», «الأكثر انتشارًا»). */
export function windowIsStatedByCustomer(window: ResolvedWindow): boolean {
  return window.status === "resolved" && (window.source === "stated" || window.source === "relative" || window.source === "event");
}

/** The window fields a plan step carries: only dates the customer, a relative phrase or a known event produced. */
export function windowStepParams(window: ResolvedWindow): { dateFrom?: string; dateTo?: string; windowSource?: WindowSource } {
  if (window.status !== "resolved" || !window.dateFrom || !window.dateTo) return {};
  return { dateFrom: window.dateFrom, dateTo: window.dateTo, windowSource: window.source };
}
