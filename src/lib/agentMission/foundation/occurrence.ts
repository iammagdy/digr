import type { Ask } from "./ask";

/**
 * OWNER DECISION 7 (live round 10, msn_67cafa6747d70356d9cb: a 2019 video was chosen for «نهائي السوبر»): when the topic is a RECURRING EVENT (a final, a cup, a season, an election) and the request gives no year and no period, the customer is asked before approval
 * «تقصد أنهي مرة؟» with three answers: the latest occurrence (the default, the first), every occurrence, or a year they write. The answer ranks the pool (the latest occurrence first) or sets the period (a year); nothing is filtered. Facebook, Instagram and YouTube only
 * (TikTok and X are customers' tools: their behaviour is not changed). Pure: no I/O, no model.
 */
export type Occurrence = { kind: "latest" } | { kind: "all" } | { kind: "year"; year: number };

export const OCCURRENCE_OPTIONS_AR = {
  latest: "آخر مرة (الافتراضي)",
  all: "كل المرات",
  year: "حدد سنة",
} as const;

export type OccurrenceAnswer = Occurrence | { kind: "ask_year" };
const digits = (s: string): string => s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
const norm = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();

/** A calendar year the customer wrote («٢٠٢٤», «سنة 2019»): four digits, 1990 to 2099. */
export function yearOf(text: unknown): number | null {
  const m = /(?:^|[^\d])((?:19[9]\d)|(?:20\d{2}))(?!\d)/.exec(digits(String(text ?? "")));
  return m ? Number(m[1]) : null;
}

/** A year in the customer's REQUEST: never a count («٢٠٢٠ منشور», «أول ٢٠٠٠ تعليق»): not followed by the noun of what is counted, and not after «أول / حتى». */
const COUNTED = /^\s*(?:منشور|بوست|تعليق|كومنت|فيديو|تغريد|ريل|رد|عنصر|صف|سجل|نتيج)/;
export function requestYearOf(text: unknown): number | null {
  const t = digits(String(text ?? ""));
  for (const m of t.matchAll(/(?:^|[^\d])((?:199\d)|(?:20\d{2}))(?!\d)/g)) {
    const after = t.slice((m.index ?? 0) + m[0].length);
    const before = t.slice(0, (m.index ?? 0) + (m[0].length - m[1].length));
    if (COUNTED.test(after) || /(?:أول|اول|حتى|أعلى|اعلى|أحدث|احدث)\s*$/.test(before)) continue;
    return Number(m[1]);
  }
  return null;
}

/** The customer's answer to the question: one of the three ready answers (read by its exact words), or a year they typed. Anything else is null (an amendment of the request). */
export function occurrenceChoiceOf(answer: unknown): OccurrenceAnswer | null {
  const t = norm(answer);
  if (t === OCCURRENCE_OPTIONS_AR.latest) return { kind: "latest" };
  if (t === OCCURRENCE_OPTIONS_AR.all) return { kind: "all" };
  if (t === OCCURRENCE_OPTIONS_AR.year) return { kind: "ask_year" };
  const y = t.length <= 30 ? yearOf(t) : null;
  return y !== null ? { kind: "year", year: y } : null;
}
/** The answer is a ready answer of this question or the year typed for it: the planning reads the request without its words. */
export const isOccurrenceAnswer = (answer: unknown): boolean => occurrenceChoiceOf(answer) !== null;

export const OCCURRENCE_QUESTION_AR = (topic: string): string => `طلبك عن «${topic}»، وهذا حدث يتكرر ولم تحدد سنة أو تاريخًا. تقصد أنهي مرة؟`;
export const OCCURRENCE_YEAR_QUESTION_AR = "اكتب السنة التي تقصدها، مثل ٢٠٢٤.";

/** The words of a recurring event in a topic: a final, a cup, a championship, a league, a season, an election, a super cup, a world cup, an olympiad, a summit, a festival, a derby. */
const RECURRING = /(?:^|\s)(?:ال)?(?:نهائي|نهائيات|كأس|بطولة|دوري|موسم|انتخابات|سوبر|مونديال|أولمبياد|اولمبياد|قمة|مهرجان|ديربي|جولة|مؤتمر)(?:\s|$)/;
const PLATFORMS = new Set(["facebook", "instagram", "youtube"]);
export function isRecurringEvent(ask: Pick<Ask, "topic" | "period" | "platform">, requestText: string): boolean {
  if (!ask.platform || !PLATFORMS.has(ask.platform) || !ask.topic.text || ask.period !== null) return false;
  if (requestYearOf(requestText) !== null) return false;
  const text = norm(requestText);
  if (/العام الماضي|السنة الماضية|هذا العام|هذه السنة|هذا الموسم|الموسم الماضي|الموسم الحالي/.test(text)) return false;
  return RECURRING.test(` ${norm(ask.topic.text)} `);
}

/** The moment a source's relative words give: «7 years ago», «Streamed 6 years ago», «11 months ago», «3 days ago». Approximate (a year is 365 days, a month 30); null when the words are not of that shape. */
const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000 };
export function approxInstantOfRelative(text: unknown, nowMs: number): number | null {
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(String(text ?? ""));
  return m ? nowMs - Number(m[1]) * UNIT_MS[m[2].toLowerCase()] : null;
}
