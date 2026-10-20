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
export function periodWordFlags(tokens: string[]): boolean[] {
  const flags: boolean[] = [];
  let afterLead = false;
  for (const token of tokens) {
    const norm = normalizeWindowText(token).trim();
    const isLead = PERIOD_LEAD_WORDS.has(norm);
    const flagged = isMonthWord(token) || isLead || (afterLead && PERIOD_UNIT_WORDS.has(norm));
    flags.push(flagged);
    afterLead = isLead;
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

const RELATIVE_RE = /(?:اخر|خلال|اخر\s*فتره)\s*(\d+)?\s*(شهرين|اسبوعين|يومين|سنتين|عامين|شهور|اشهر|شهر|سنوات|سنين|سنه|سنة|اعوام|عام|اسابيع|اسبوع|ايام|يوم)(?!\s*(?:19|20)\d{2})/;

function addMonthsClamped(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1));
  const last = daysInMonth(target.getUTCFullYear(), target.getUTCMonth() + 1);
  target.setUTCDate(Math.min(date.getUTCDate(), last));
  return target;
}

export function parseRelativeWindow(text: string, today: Date = new Date()): { from: string; to: string; labelAr: string } | null {
  const norm = normalizeWindowText(text);
  const m = RELATIVE_RE.exec(norm);
  if (!m) return null;
  const unit = m[2];
  const dual = /^(?:شهرين|اسبوعين|يومين|سنتين|عامين)$/.test(unit);
  const count = dual ? 2 : Number(m[1]) || 1;
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

/** The window fields a plan step carries: only dates the customer, a relative phrase or a known event produced. */
export function windowStepParams(window: ResolvedWindow): { dateFrom?: string; dateTo?: string; windowSource?: WindowSource } {
  if (window.status !== "resolved" || !window.dateFrom || !window.dateTo) return {};
  return { dateFrom: window.dateFrom, dateTo: window.dateTo, windowSource: window.source };
}
