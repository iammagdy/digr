import { numberOfWord } from "../arabicNumberWords";
import { cairoDayOf } from "../cairoTime";
import { placesInText } from "../places";
import { normalizeText } from "../relevance";
import { semanticText } from "./normalizeArabic";

/**
 * PR-1.3: THE CONDITIONS OF A REQUEST, READ FROM THE CUSTOMER'S WORDS: the PERIOD (dates), the COUNTRY and the LANGUAGE. Pure, offline, deterministic: no model, no network, no clock of its own. A reference moment (`nowMs`) is always handed in, and every date is a Cairo calendar day (Africa/Cairo).
 * Used only through the server-controlled flag `semantic_normalization_v1` (OFF by default): `requestContract.ts` and `foundation/ask.ts` call it only when the caller says `semantic: true`. With the flag OFF none of this runs and the parser reads exactly as before.
 *
 * THE RULES
 *   - A range is read as written. «من ١ لـ ١٥ أكتوبر» is 1 to 15 October (never the whole month), «من يناير لحد مارس» is January to March (never January only). A requested day is kept. «آخر ٣٠ يوم» is thirty days (today and the 29 before it), not thirty-one.
 *   - What the words do not settle is NEVER guessed. A month with no year that would lie wholly in the future, a range that crosses a year boundary with no year, a day that does not exist («٣٠ فبراير»), two different periods in one request: each is a CLARIFICATION (`clarify`), asked before any plan or price.
 *   - A country is a geographic TARGET only after a locative word («في مصر», «فمصر», «بمصر», «من مصر», «in Egypt»). «عن مصر» names a TOPIC, so it filters nothing. A city is never read as its country. Two countries are a clarification, not the first of them.
 *   - A language restriction is set only when the words say the CONTENT's language («تعليقات بالعربي», «English posts»). A language said about the REPORT («التقرير بالإنجليزي») or about the chat («رد علي بالعربي») is not a filter of the data; the language of the request itself is never a filter. A language the product cannot filter by («بالفرنسي») is a clarification, never silently read as Arabic.
 * Nothing here knows what a provider can enforce: the plan states what it cannot carry (`foundation/compilePlan.ts`), exactly as it does for the same words typed the old way.
 */
export interface DayRange { from: string; to: string }
export type PeriodRule = "last_n" | "previous" | "current" | "day" | "range" | "month" | "open_end";
export type ClarifyCode = "period_year" | "period_crossing" | "period_invalid" | "period_several" | "country_many" | "language_unsupported";
export type ClarifyField = "period" | "country" | "language";

export type PeriodReading =
  | { status: "none" }
  | ({ status: "resolved"; rule: PeriodRule } & DayRange)
  | { status: "clarify"; code: "period_year" | "period_crossing" | "period_invalid" | "period_several" };
export type CountryReading =
  | { status: "none" }
  | { status: "resolved"; code: string }
  | { status: "any" }
  | { status: "many"; codes: string[] };
export type ContentLanguage = "ar" | "en";
export type LanguageReading = {
  /** The language of the COLLECTED CONTENT the words ask for: a language, `both` / `any` (nothing is filtered out), `unsupported` (a language the product cannot filter by), or `none` (no word about it). */
  content: "none" | ContentLanguage | "both" | "any" | "unsupported";
  /** The language the customer wants the REPORT in. Not a filter of the data. */
  report: ContentLanguage | null;
  /** Some language word was found (so the old regex reading, which cannot tell content from report, is replaced). */
  found: boolean;
};
export interface ConditionsReading {
  period: PeriodReading;
  country: CountryReading;
  language: LanguageReading;
  /** The customer's phrases (normalized tokens) that are conditions and never the research topic. */
  phrases: string[][];
}

/** The question asked for each clarification (Arabic, one sentence, an answer in the customer's own words is enough). */
export const CLARIFY_QUESTION_AR: Readonly<Record<ClarifyCode, string>> = {
  period_year: "أي سنة تقصد؟ اكتب السنة، مثل ٢٠٢٥.",
  period_crossing: "الفترة بتعدّي من سنة لأخرى. اكتبها كاملة بالسنتين، مثل: من نوفمبر ٢٠٢٥ إلى فبراير ٢٠٢٦.",
  period_invalid: "ما قدرنا نفهم تاريخ البداية والنهاية. اكتب الفترة بشكل واضح، مثل: من ١ إلى ١٥ أكتوبر ٢٠٢٦.",
  period_several: "ذكرت أكثر من فترة. اكتب الفترة الواحدة التي تريدها، مثل: من ١ إلى ١٥ أكتوبر ٢٠٢٦.",
  country_many: "ذكرت أكثر من دولة. اكتب اسم دولة واحدة، أو اكتب «أي دولة».",
  language_unsupported: "نقدر نفلتر المحتوى بالعربية أو الإنجليزية فقط. اكتب «بالعربي» أو «بالإنجليزي» أو «أي لغة».",
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// DATES

const MONTH_KEYS: ReadonlyArray<[string, number]> = [
  ["يناير", 1], ["فبراير", 2], ["مارس", 3], ["ابريل", 4], ["مايو", 5], ["يونيو", 6], ["يونيه", 6], ["يوليو", 7], ["يوليه", 7], ["اغسطس", 8], ["سبتمبر", 9], ["اكتوبر", 10], ["نوفمبر", 11], ["ديسمبر", 12],
  ["january", 1], ["february", 2], ["march", 3], ["april", 4], ["may", 5], ["june", 6], ["july", 7], ["august", 8], ["september", 9], ["october", 10], ["november", 11], ["december", 12],
];
const MONTH = new Map<string, number>(MONTH_KEYS);
/** «may» and «march» are also ordinary English words: a month only after a preposition or beside a year or a day. */
const AMBIGUOUS_MONTH_WORDS: ReadonlySet<string> = new Set(["may", "march"]);
const MONTH_LEAD: ReadonlySet<string> = new Set(["in", "from", "to", "until", "till", "of", "between", "and", "during", "since", "في", "من", "خلال", "الي", "لحد", "ل", "حتي", "شهر"]);

type Unit = "day" | "week" | "month" | "year";
const UNIT: ReadonlyMap<string, { unit: Unit; dual: boolean }> = new Map([
  ["يوم", { unit: "day", dual: false }], ["يوما", { unit: "day", dual: false }], ["ايام", { unit: "day", dual: false }], ["يومين", { unit: "day", dual: true }], ["day", { unit: "day", dual: false }], ["days", { unit: "day", dual: false }],
  ["اسبوع", { unit: "week", dual: false }], ["اسابيع", { unit: "week", dual: false }], ["اسبوعين", { unit: "week", dual: true }], ["week", { unit: "week", dual: false }], ["weeks", { unit: "week", dual: false }],
  ["شهر", { unit: "month", dual: false }], ["شهور", { unit: "month", dual: false }], ["اشهر", { unit: "month", dual: false }], ["شهرين", { unit: "month", dual: true }], ["month", { unit: "month", dual: false }], ["months", { unit: "month", dual: false }],
  ["سنه", { unit: "year", dual: false }], ["سنين", { unit: "year", dual: false }], ["سنوات", { unit: "year", dual: false }], ["سنتين", { unit: "year", dual: true }], ["عام", { unit: "year", dual: false }], ["اعوام", { unit: "year", dual: false }], ["عامين", { unit: "year", dual: true }], ["year", { unit: "year", dual: false }], ["years", { unit: "year", dual: false }],
]);
const LAST_WORDS: ReadonlySet<string> = new Set(["اخر", "last", "past"]);
const RANGE_STARTS: ReadonlySet<string> = new Set(["من", "from", "بين", "between"]);
const RANGE_JOINS: ReadonlySet<string> = new Set(["الي", "لحد", "لغايه", "لغايت", "حتي", "ل", "to", "until", "till", "through", "thru"]);
const NOW_WORDS: ReadonlySet<string> = new Set(["النهارده", "انهارده", "دلوقتي", "دلوقت", "الان", "حاليا", "now", "today"]);
/** The word in front of a bare month or day that makes it a period («في أكتوبر», «during October»). */
const SINGLE_LEAD: ReadonlySet<string> = new Set(["في", "خلال", "بتاريخ", "during", "in", "on"]);
const PART_FILLERS: ReadonlySet<string> = new Set(["يوم", "شهر", "تاريخ", "of", "the"]);
const CURRENT_WORDS: ReadonlySet<string> = new Set(["ده", "دا", "دي", "هذا", "هذه", "الحالي", "الحاليه", "الجاري", "الجاريه", "this", "current"]);
const PAST_WORDS: ReadonlySet<string> = new Set(["الماضي", "الماضيه", "السابق", "السابقه", "الفايت", "الفايته", "previous"]);

interface Part { d?: number; m?: number; y?: number; eom?: boolean; today?: boolean }
type Draft =
  | { k: "last"; n: number; unit: Unit }
  | { k: "previous"; unit: "month" | "year" }
  | { k: "current"; unit: "month" | "year" }
  | { k: "day"; offset: 0 | -1 }
  | { k: "range"; a: Part; b: Part | null }
  | { k: "single"; p: Part };
interface Found { draft: Draft; start: number; end: number }

const pad = (n: number): string => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const validDay = (y: number, m: number, d: number): boolean => Number.isInteger(y) && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
const shiftDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** The same calendar day `months` months earlier (the last day of a shorter month when the day does not exist there): the product's own rule for «آخر ٣ شهور». */
function monthsBack(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return iso(ny, nm, Math.min(d, daysIn(ny, nm)));
}

const numberAt = (keys: readonly string[], tokens: readonly string[], i: number): number | null => {
  const k = keys[i];
  if (k === undefined) return null;
  if (/^\d{1,4}$/.test(k)) return Number(k);
  return numberOfWord(tokens[i]) ?? numberOfWord(k);
};
const monthAt = (keys: readonly string[], i: number): number | null => {
  const k = keys[i];
  const m = k === undefined ? undefined : MONTH.get(k);
  if (m === undefined) return null;
  if (AMBIGUOUS_MONTH_WORDS.has(k)) {
    const nextIsNumber = keys[i + 1] !== undefined && /^\d{1,4}$/.test(keys[i + 1]);
    const prevIsNumber = i > 0 && /^\d{1,2}$/.test(keys[i - 1]);
    if (!(MONTH_LEAD.has(keys[i - 1] ?? "") || nextIsNumber || prevIsNumber)) return null;
  }
  return m;
};
const isYear = (k: string | undefined): boolean => k !== undefined && /^20\d\d$/.test(k);
const isDay = (k: string | undefined): boolean => k !== undefined && /^\d{1,2}$/.test(k) && Number(k) >= 1 && Number(k) <= 31;

/** One side of a range: any of a day, a month, a year, «أول السنة», «أول الشهر», «النهارده». Null when nothing of a date is there. */
function partAt(keys: readonly string[], j: number, endAt: number): { part: Part; next: number } | null {
  const part: Part = {};
  let i = j;
  let any = false;
  while (i < endAt) {
    const k = keys[i];
    if (PART_FILLERS.has(k)) {
      const nx = keys[i + 1];
      if (nx !== undefined && (monthAt(keys, i + 1) !== null || isDay(nx) || isYear(nx) || nx === "اول")) { i += 1; continue; }
      break;
    }
    if (NOW_WORDS.has(k)) { part.today = true; any = true; i += 1; break; }
    if ((k === "اول" || k === "اخر") && part.d === undefined) {
      const nx = keys[i + 1];
      if (nx !== undefined && (nx === "السنه" || nx === "العام") && k === "اول") { part.y = part.y ?? -1; part.m = 1; part.d = 1; any = true; i += 2; continue; }
      if (nx !== undefined && nx === "الشهر" && k === "اول") { part.m = -1; part.d = 1; any = true; i += 2; continue; }
      if (nx !== undefined && monthAt(keys, i + 1) !== null) { if (k === "اول") part.d = 1; else part.eom = true; any = true; i += 1; continue; }
      break;
    }
    if (isDay(k) && part.d === undefined && !part.eom) { part.d = Number(k); any = true; i += 1; continue; }
    if (isYear(k) && part.y === undefined) { part.y = Number(k); any = true; i += 1; continue; }
    const m = monthAt(keys, i);
    if (m !== null && part.m === undefined) { part.m = m; any = true; i += 1; continue; }
    break;
  }
  return any ? { part, next: i } : null;
}

function findPeriods(keys: readonly string[], tokens: readonly string[]): Found[] {
  const found: Found[] = [];
  let i = 0;
  while (i < keys.length) {
    const k = keys[i];
    // a RANGE: «من ... إلى ...», «from ... to ...», «between ... and ...»
    if (RANGE_STARTS.has(k)) {
      const between = k === "بين" || k === "between";
      const a = partAt(keys, i + 1, keys.length);
      if (a) {
        const join = keys[a.next];
        if (join !== undefined && (RANGE_JOINS.has(join) || (between && (join === "و" || join === "and")))) {
          const b = partAt(keys, a.next + 1, keys.length);
          if (b && (a.part.m !== undefined || b.part.m !== undefined)) { found.push({ draft: { k: "range", a: a.part, b: b.part }, start: i, end: b.next }); i = b.next; continue; }
        } else if (!between && a.part.m !== undefined && a.part.d !== undefined && (a.part.y !== undefined || a.part.m === -1)) {
          // «من أول السنة», «من أول الشهر», «من ١٥ أكتوبر ٢٠٢٥»: a start with its year and no end runs to today (the plan's sentence says the two days). «من ٦ أكتوبر» alone is not read: it may be a city («شركات من ٦ أكتوبر»)
          found.push({ draft: { k: "range", a: a.part, b: null }, start: i, end: a.next }); i = a.next; continue;
        }
      }
    }
    // «آخر ٣ شهور», «اخر تلات شهور», «آخر أسبوعين», «last 30 days», «past 3 months»
    if (LAST_WORDS.has(k)) {
      const n = numberAt(keys, tokens, i + 1);
      const u = UNIT.get(keys[n === null ? i + 1 : i + 2] ?? "");
      if (u) {
        const count = n !== null ? n : u.dual ? 2 : 1;
        const end = n !== null ? i + 3 : i + 2;
        if (!(n === null && !u.dual && /^(?:ايام|شهور|اشهر|اسابيع|سنين|سنوات|اعوام|days|weeks|months|years)$/.test(keys[i + 1]))) { found.push({ draft: { k: "last", n: count, unit: u.unit }, start: i, end }); i = end; continue; }
      }
    }
    // «الشهر اللي فات», «الشهر الماضي», «السنة اللي فاتت», «الشهر ده», «السنة دي»
    if (k === "الشهر" || k === "السنه" || k === "العام" || k === "this" || k === "previous") {
      const unit: "month" | "year" | null = k === "الشهر" ? "month" : k === "السنه" || k === "العام" ? "year" : keys[i + 1] === "month" ? "month" : keys[i + 1] === "year" ? "year" : null;
      const at = k === "this" || k === "previous" ? i + 2 : i + 1;
      if (unit) {
        const w = keys[at];
        if (w !== undefined && (PAST_WORDS.has(w) || ((w === "اللي" || w === "الي") && /^(?:فات|فاتت|فايت|فايته|فاته)$/.test(keys[at + 1] ?? "")))) { const end = PAST_WORDS.has(w) ? at + 1 : at + 2; found.push({ draft: { k: "previous", unit }, start: i, end }); i = end; continue; }
        if (k !== "previous" && w !== undefined && CURRENT_WORDS.has(w)) { found.push({ draft: { k: "current", unit }, start: i, end: at + 1 }); i = at + 1; continue; }
        if (k === "previous") { found.push({ draft: { k: "previous", unit }, start: i, end: at }); i = at; continue; }
        if (k === "this") { found.push({ draft: { k: "current", unit }, start: i, end: at }); i = at; continue; }
      }
    }
    if (k === "امبارح" || k === "امس" || k === "yesterday") { found.push({ draft: { k: "day", offset: -1 }, start: i, end: i + 1 }); i += 1; continue; }
    // a single month or day: «في أكتوبر ٢٠٢٦», «في ١٥ أكتوبر», «october 2026». A month name with nothing before it that says «a period» is a NAME («حرب أكتوبر», «ثورة ٢٥ يناير», «شركات ٦ أكتوبر»), not a period: it needs a year, «في / خلال / شهر / يوم / in / during», or a day word.
    if (keys[i] !== "اول" && keys[i] !== "اخر") {
      const one = partAt(keys, i, keys.length);
      const named = one !== null && one.part.y === undefined && !PART_FILLERS.has(keys[i]) && !SINGLE_LEAD.has(keys[i - 1] ?? "");
      if (one && !named && one.part.m !== undefined && one.part.m > 0) { found.push({ draft: { k: "single", p: one.part }, start: i, end: one.next }); i = one.next; continue; }
    }
    i += 1;
  }
  return found;
}

type Resolve = ({ status: "resolved"; rule: PeriodRule } & DayRange) | { status: "clarify"; code: "period_year" | "period_crossing" | "period_invalid" };

function resolveDraft(draft: Draft, today: string, yearGiven?: number): Resolve {
  const [ty, tm] = today.split("-").map(Number);
  switch (draft.k) {
    case "last": {
      const { n, unit } = draft;
      if (n < 1 || (unit === "day" && n > 3660) || (unit === "week" && n > 520) || (unit === "month" && n > 120) || (unit === "year" && n > 10)) return { status: "clarify", code: "period_invalid" };
      if (unit === "day") return { status: "resolved", rule: "last_n", from: shiftDays(today, -(n - 1)), to: today };
      if (unit === "week") return { status: "resolved", rule: "last_n", from: shiftDays(today, -(7 * n - 1)), to: today };
      if (unit === "month") return { status: "resolved", rule: "last_n", from: monthsBack(today, n), to: today };
      return { status: "resolved", rule: "last_n", from: monthsBack(today, 12 * n), to: today };
    }
    case "previous": {
      if (draft.unit === "year") return { status: "resolved", rule: "previous", from: iso(ty - 1, 1, 1), to: iso(ty - 1, 12, 31) };
      const py = tm === 1 ? ty - 1 : ty;
      const pm = tm === 1 ? 12 : tm - 1;
      return { status: "resolved", rule: "previous", from: iso(py, pm, 1), to: iso(py, pm, daysIn(py, pm)) };
    }
    case "current": return { status: "resolved", rule: "current", from: draft.unit === "year" ? iso(ty, 1, 1) : iso(ty, tm, 1), to: today };
    case "day": { const d = shiftDays(today, draft.offset); return { status: "resolved", rule: "day", from: d, to: d }; }
    case "single": {
      const p = { ...draft.p };
      if (p.y === undefined && yearGiven !== undefined) p.y = yearGiven;
      const implicit = p.y === undefined;
      const y = p.y ?? ty;
      const m = p.m!;
      const d = p.d;
      if (d !== undefined) {
        if (!validDay(y, m, d)) return { status: "clarify", code: "period_invalid" };
        const day = iso(y, m, d);
        if (implicit && day > today) return { status: "clarify", code: "period_year" };
        return { status: "resolved", rule: "day", from: day, to: day };
      }
      if (implicit && iso(y, m, 1) > today) return { status: "clarify", code: "period_year" };
      return { status: "resolved", rule: "month", from: iso(y, m, 1), to: iso(y, m, daysIn(y, m)) };
    }
    case "range": {
      const a: Part = { ...draft.a };
      const b: Part | null = draft.b ? { ...draft.b } : null;
      // «أول السنة» and «أول الشهر» name the current year / month; they are explicit
      if (a.m === -1) { a.m = tm; a.y = ty; }
      if (a.y === -1) a.y = ty;
      if (yearGiven !== undefined) { if (a.y === undefined) a.y = yearGiven; if (b && b.y === undefined) b.y = yearGiven; }
      if (b === null || b.today) {
        const m1 = a.m;
        if (m1 === undefined) return { status: "clarify", code: "period_invalid" };
        const y1 = a.y ?? ty;
        const d1 = a.d ?? 1;
        if (!validDay(y1, m1, d1)) return { status: "clarify", code: "period_invalid" };
        const from = iso(y1, m1, d1);
        if (a.y === undefined && from > today) return { status: "clarify", code: "period_year" };
        if (from > today) return { status: "clarify", code: "period_invalid" };
        return { status: "resolved", rule: "open_end", from, to: today };
      }
      const m1 = a.m ?? b.m;
      const m2 = b.m ?? a.m;
      if (m1 === undefined || m2 === undefined) return { status: "clarify", code: "period_invalid" };
      const d1 = a.d ?? 1;
      let y1 = a.y;
      let y2 = b.y;
      // the end day: given, the month's last day («أخر الشهر» or none)
      const lastOf = (y: number, m: number): number => daysIn(y, m);
      const crossing = (m1 > m2) || (m1 === m2 && b.d !== undefined && d1 > b.d);
      const implicit = y1 === undefined && y2 === undefined;
      if (y1 === undefined && y2 === undefined) { if (crossing) return { status: "clarify", code: "period_crossing" }; y1 = ty; y2 = ty; }
      else if (y1 === undefined) y1 = crossing ? y2! - 1 : y2!;
      else if (y2 === undefined) y2 = crossing ? y1 + 1 : y1;
      const d2 = b.d ?? lastOf(y2!, m2);
      if (!validDay(y1!, m1, d1) || !validDay(y2!, m2, d2)) return { status: "clarify", code: "period_invalid" };
      const from = iso(y1!, m1, d1);
      const to = iso(y2!, m2, d2);
      if (from > to) return { status: "clarify", code: "period_invalid" };
      if (implicit && from > today) return { status: "clarify", code: "period_year" };
      return { status: "resolved", rule: "range", from, to };
    }
  }
}

const sameRange = (a: DayRange, b: DayRange): boolean => a.from === b.from && a.to === b.to;

function periodOf(keys: readonly string[], tokens: readonly string[], today: string, yearGiven?: number): { reading: PeriodReading; spans: Array<[number, number]> } {
  const found = findPeriods(keys, tokens);
  if (found.length === 0) return { reading: { status: "none" }, spans: [] };
  const results = found.map((f) => resolveDraft(f.draft, today, yearGiven));
  const spans = found.map((f): [number, number] => [f.start, f.end]);
  const clarify = results.find((r) => r.status === "clarify");
  if (clarify && clarify.status === "clarify") return { reading: clarify, spans };
  const ranges = results.filter((r): r is Extract<Resolve, { status: "resolved" }> => r.status === "resolved");
  const first = ranges[0];
  if (ranges.some((r) => !sameRange(r, first))) return { reading: { status: "clarify", code: "period_several" }, spans };
  return { reading: first, spans };
}

/** Whether the words name a period at all (clarification or resolved): needs no reference day, so the contract can say «a period was asked» without a clock. */
export function periodAskedIn(text: unknown): boolean {
  const t = semanticText(text);
  return findPeriods(t.keys, t.tokens).length > 0;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// COUNTRIES

const LOCATIVE: ReadonlySet<string> = new Set(["في", "من", "داخل", "جوه", "بداخل", "in", "from", "within", "inside", "across"]);
const ANY_COUNTRY_WORDS: ReadonlyArray<ReadonlyArray<string>> = [["اي", "دوله"], ["اي", "بلد"], ["كل", "الدول"], ["any", "country"], ["all", "countries"]];
const placeNames = (entry: { names: readonly string[] }): Set<string> => new Set(entry.names.map((n) => normalizeText(n)).filter((n) => n.length >= 3));

/** The place a span of words EXACTLY names: a country (its code), a city (null: a city is never read as its country), or nothing (undefined). */
function exactPlace(span: string): { code: string | null } | undefined {
  const text = normalizeText(span);
  if (text.length < 3) return undefined;
  for (const entry of placesInText(span)) if (placeNames(entry).has(text)) return { code: entry.kind === "country" ? entry.country : null };
  return undefined;
}

function countryOf(keys: readonly string[], tokens: readonly string[]): { reading: CountryReading; spans: Array<[number, number]> } {
  const codes: string[] = [];
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < keys.length) {
    const k = keys[i];
    let startAt = -1;
    // a locative word in front («في مصر», «in Egypt»), or a fused one («فمصر», «بمصر», «بالسعودية»)
    if (LOCATIVE.has(k) || (k.length > 2 && k.startsWith("و") && LOCATIVE.has(k.slice(1)))) startAt = i + 1;
    let hit: { code: string | null; len: number; from: number } | null = null;
    if (startAt >= 0) {
      for (let len = Math.min(4, keys.length - startAt); len >= 1 && !hit; len -= 1) {
        const place = exactPlace(keys.slice(startAt, startAt + len).join(" "));
        if (place) hit = { code: place.code, len, from: startAt };
      }
    } else if (/^[فب]/.test(k) && k.length > 3) {
      const rest = k.slice(1);
      const place = exactPlace(rest);
      if (place) hit = { code: place.code, len: 1, from: i };
    }
    if (hit) {
      if (hit.code !== null && !codes.includes(hit.code)) codes.push(hit.code);
      if (hit.code !== null) spans.push([Math.max(0, hit.from - (startAt >= 0 ? 1 : 0)), hit.from + hit.len]);
      i = hit.from + hit.len;
      // «في مصر والسعودية»: a place joined by «و»
      while (i < keys.length && /^و.{3,}/.test(keys[i])) {
        const rest = keys[i].slice(1);
        const place = exactPlace(rest);
        if (!place) break;
        if (place.code !== null && !codes.includes(place.code)) codes.push(place.code);
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  for (let j = 0; j < keys.length; j += 1) if (ANY_COUNTRY_WORDS.some((w) => w.every((x, o) => keys[j + o] === x))) return { reading: codes.length === 0 ? { status: "any" } : codes.length === 1 ? { status: "resolved", code: codes[0] } : { status: "many", codes }, spans };
  if (codes.length === 0) return { reading: { status: "none" }, spans };
  return { reading: codes.length === 1 ? { status: "resolved", code: codes[0] } : { status: "many", codes }, spans };
}

/** An answer that is only a country («مصر», «في مصر», «Egypt»): the answer to «أي دولة؟». */
function bareCountryAnswer(keys: readonly string[]): CountryReading {
  const codes: string[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    for (let len = Math.min(4, keys.length - i); len >= 1; len -= 1) {
      const place = exactPlace(keys.slice(i, i + len).join(" "));
      if (place) { if (place.code !== null && !codes.includes(place.code)) codes.push(place.code); i += len - 1; break; }
    }
  }
  return codes.length === 1 ? { status: "resolved", code: codes[0] } : { status: "none" };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// LANGUAGES

const AR_STRONG: ReadonlySet<string> = new Set(["بالعربي", "بالعربيه", "بعربي", "بالعربى"]);
const AR_WORDS: ReadonlySet<string> = new Set(["عربي", "عربيه", "العربي", "العربيه", "arabic"]);
const EN_STRONG: ReadonlySet<string> = new Set(["بالانجليزي", "بالانجليزيه", "بالانكليزي", "بانجليزي", "بالانجليزى", "بالانكليزيه"]);
const EN_WORDS: ReadonlySet<string> = new Set(["انجليزي", "انجليزيه", "الانجليزيه", "الانجليزي", "انكليزي", "الانكليزيه", "english"]);
const OTHER_STRONG: ReadonlySet<string> = new Set(["بالفرنسي", "بالفرنسيه", "بالتركي", "بالتركيه", "بالالماني", "بالالمانيه", "بالاسباني", "بالاسبانيه", "بالروسي", "بالروسيه", "بالايطالي", "بالايطاليه", "بالصيني", "بالصينيه"]);
const OTHER_WORDS: ReadonlySet<string> = new Set(["فرنسي", "الفرنسيه", "french", "german", "spanish", "turkish", "russian", "italian", "chinese"]);
const LANG_WORD: ReadonlySet<string> = new Set(["باللغه", "اللغه", "لغه", "بلغه", "language", "in", "لغتها"]);
const ONLY_WORDS: ReadonlySet<string> = new Set(["فقط", "بس", "only"]);
const CONTENT_NOUN = /^(?:تعليق|تعليقات|كومنت|كومنتات|كومنتس|منشور|منشورات|بوست|بوستات|فيديو|فيديوهات|تغريد|تغريده|تغريدات|ردود|ريبلاي|محتوي|نتائج|comments?|posts?|videos?|tweets?|replies|reviews?|content)$/;
const REPORT_CUES: ReadonlySet<string> = new Set(["تقرير", "التقرير", "تقارير", "ملخص", "الملخص", "تلخيص", "تحليل", "التحليل", "ريبورت", "report", "summary", "analysis", "summarize", "summarise"]);
const CHAT_CUES: ReadonlySet<string> = new Set(["رد", "ردي", "كلمني", "كلمنا", "خاطبني", "جاوبني", "اتكلم", "respond", "answer", "speak", "talk", "reply"]);

function languageOf(keys: readonly string[]): { reading: LanguageReading; spans: Array<[number, number]> } {
  const content = new Set<ContentLanguage>();
  const reports = new Set<ContentLanguage>();
  let unsupported = false;
  let any = false;
  let found = false;
  const spans: Array<[number, number]> = [];
  const bare = (w: string | undefined): string => { const x = w ?? ""; return x.length > 3 && x.startsWith("و") ? x.slice(1) : x; };
  const qualifies = (i: number): boolean => LANG_WORD.has(keys[i - 1] ?? "") || ONLY_WORDS.has(keys[i + 1] ?? "") || CONTENT_NOUN.test(bare(keys[i + 1])) || CONTENT_NOUN.test(bare(keys[i - 1])) || REPORT_CUES.has(bare(keys[i + 1]));
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if ((k === "اي" && (keys[i + 1] === "لغه")) || (k === "any" && keys[i + 1] === "language") || ((k === "كل" || k === "بكل") && keys[i + 1] === "اللغات")) { any = true; found = true; spans.push([i, i + 2]); continue; }
    let lang: ContentLanguage | "other" | null = null;
    if (AR_STRONG.has(k) || (AR_WORDS.has(k) && qualifies(i))) lang = "ar";
    else if (EN_STRONG.has(k) || (EN_WORDS.has(k) && qualifies(i))) lang = "en";
    else if (OTHER_STRONG.has(k) || (OTHER_WORDS.has(k) && qualifies(i))) lang = "other";
    if (lang === null) continue;
    found = true;
    const start = LANG_WORD.has(keys[i - 1] ?? "") ? i - 1 : i;
    spans.push([start, i + 1]);
    // the cue stands in front of an Arabic-script marker («التقرير بالإنجليزي»), and may stand after a Latin one («english report»)
    const around = [...keys.slice(Math.max(0, i - 3), i), ...(/^[a-z]+$/.test(k) ? keys.slice(i + 1, i + 2) : [])].map(bare);
    if (around.some((w) => REPORT_CUES.has(w))) { if (lang !== "other") reports.add(lang); continue; }
    if (around.some((w) => CHAT_CUES.has(w))) continue;
    if (lang === "other") unsupported = true; else content.add(lang);
  }
  let contentReading: LanguageReading["content"] = "none";
  if (any) contentReading = "any";
  else if (unsupported) contentReading = "unsupported";
  else if (content.size === 2) contentReading = "both";
  else if (content.size === 1) contentReading = [...content][0];
  return { reading: { content: contentReading, report: reports.size === 1 ? [...reports][0] : null, found }, spans };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const lonelyYear = (keys: readonly string[]): number | undefined => { const ys = keys.filter(isYear); return ys.length === 1 ? Number(ys[0]) : undefined; };

/**
 * What the customer's words say about the period, the country and the language. `answer` is what they typed to the one question asked before the plan: when it says one of the three it wins over the request («٢٠٢٥» answers «أي سنة؟», «مصر» answers «أي دولة؟», «بالعربي» answers the language question);
 * a request that says nothing about one of them leaves it to the old reading. `nowMs` is the reference moment (the mission's creation), and every day is a Cairo day.
 */
export function readConditions(request: unknown, answer: unknown, nowMs: number): ConditionsReading {
  const today = cairoDayOf(Number.isFinite(nowMs) ? nowMs : 0);
  const req = semanticText(request);
  const ans = semanticText(answer);
  const reqPeriod = periodOf(req.keys, req.tokens, today);
  const ansPeriod = periodOf(ans.keys, ans.tokens, today);
  let period: PeriodReading = ansPeriod.reading.status !== "none" ? ansPeriod.reading : reqPeriod.reading;
  // «٢٠٢٥» alone answers «أي سنة؟»: the year joins the period the request named
  if (ansPeriod.reading.status === "none" && reqPeriod.reading.status === "clarify" && reqPeriod.reading.code === "period_year") {
    const y = lonelyYear(ans.keys);
    if (y !== undefined) {
      const found = findPeriods(req.keys, req.tokens);
      if (found.length === 1) { const r = resolveDraft(found[0].draft, today, y); period = r; }
    }
  }
  const reqCountry = countryOf(req.keys, req.tokens);
  const ansCountry = countryOf(ans.keys, ans.tokens);
  let country: CountryReading = ansCountry.reading.status !== "none" ? ansCountry.reading : reqCountry.reading;
  if (ansCountry.reading.status === "none" && ans.keys.length > 0 && (reqCountry.reading.status === "many" || reqCountry.reading.status === "resolved")) {
    const bare = bareCountryAnswer(ans.keys);
    if (bare.status === "resolved") country = bare;
  }
  const reqLang = languageOf(req.keys);
  const ansLang = languageOf(ans.keys);
  const language = ansLang.reading.found ? ansLang.reading : reqLang.reading;
  const phrases: string[][] = [];
  for (const [s, e] of reqPeriod.spans) phrases.push(req.tokens.slice(s, e));
  for (const [s, e] of reqLang.spans) phrases.push(req.tokens.slice(s, e));
  for (const [s, e] of reqCountry.spans) phrases.push(req.tokens.slice(s, e));
  return { period, country, language, phrases };
}

/** The clarification (if any) a reading leaves open, one per condition. */
export function clarifyOf(reading: ConditionsReading): Array<{ code: ClarifyCode; field: ClarifyField }> {
  const out: Array<{ code: ClarifyCode; field: ClarifyField }> = [];
  if (reading.period.status === "clarify") out.push({ code: reading.period.code, field: "period" });
  if (reading.country.status === "many") out.push({ code: "country_many", field: "country" });
  if (reading.language.content === "unsupported") out.push({ code: "language_unsupported", field: "language" });
  return out;
}
