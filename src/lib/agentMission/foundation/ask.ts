import { buildRequestContract, type ChildAsk, type ParentKind } from "../requestContract";
import { countryOfRequestText } from "../places";
import { topicMeaningOf } from "../topicMeaning";
import { cairoDayEndExclusiveMs, cairoDayOf, cairoDayStartMs } from "../cairoTime";
import type { SocialPlatform } from "../redesignFlagTypes";

/**
 * F1, THE ASK (docs/FOUNDATION-PLAN.md section 3.1): what the customer asked, built ONCE by code from their words, their answer to the one question and their edit of the
 * card, and read by everything the compiler does. It extends the request contract of #345 (`requestContract.ts`, kept as it is) with the VALUES the contract only flags:
 * the period as Cairo days and instants, the country code, the language, the order, the topic and its relation, and the numbers of an edit. Pure: no I/O, no model.
 * A value code cannot read stays null; nothing here guesses.
 */
export type AskSourceKind = "named" | "official" | "none";
export type TopicRelation = "about" | "made_with" | "ambiguous" | "none";
export type AskOrder = "most_commented" | "newest";

export interface AskPeriod {
  /** Cairo calendar days, inclusive (YYYY-MM-DD). */
  from: string;
  to: string;
  /** The first moment of `from` in Cairo and the first moment after `to` (ms, UTC). */
  startMs: number;
  endExclusiveMs: number;
}

/** The customer's numbers from the card edit (Stage 2 recompiles the plan with them). Absent: the request's own words decide. */
export interface AskEdits { count?: number; comments?: number; replies?: number }

export interface Ask {
  platform: SocialPlatform | null;
  parentKind: ParentKind | null;
  /** The number of top-level items (parents), or null when the request gives none. */
  count: number | null;
  source: { kind: AskSourceKind; text: string | null };
  topic: { text: string | null; relation: TopicRelation };
  period: AskPeriod | null;
  /** ISO 3166 alpha-2 code of the country the customer named («من مصر» → EG), or null. */
  country: string | null;
  language: "ar" | "en" | null;
  /** The owner's order: the most commented items, unless the customer asked for the newest (or asked for no comments at all: then the newest). */
  order: AskOrder;
  comments: ChildAsk;
  replies: ChildAsk;
  edits: AskEdits;
}

const digits = (s: string): string => s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
const MONTHS: ReadonlyArray<[RegExp, number]> = [
  [/يناير/, 1], [/فبراير/, 2], [/مارس/, 3], [/[أا]بريل/, 4], [/مايو/, 5], [/يوني[وه]/, 6], [/يولي[وه]/, 7], [/[أا]غسطس/, 8], [/سبتمبر/, 9], [/[أا]كتوبر/, 10], [/نوفمبر/, 11], [/ديسمبر/, 12],
];
const pad = (n: number): string => String(n).padStart(2, "0");
const dayOf = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The same Cairo day `months` months earlier (the last day of a shorter month when the day does not exist there). */
function monthsBack(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return dayOf(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}
const shiftDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const periodOf = (from: string, to: string): AskPeriod => ({ from, to, startMs: cairoDayStartMs(from), endExclusiveMs: cairoDayEndExclusiveMs(to) });

/** The period of the customer's words, as Cairo days: «في شهر أكتوبر ٢٠٢٦» (that month), «آخر ٣ شهور / أسبوعين / ١٠ أيام / سنة» (back from the day of the request, that day included). Null when none is named. */
export function periodOfRequest(text: string, requestedAtMs: number): AskPeriod | null {
  const t = digits(text);
  const today = cairoDayOf(requestedAtMs);
  for (const [re, month] of MONTHS) {
    const m = new RegExp(`(?:${re.source})\\s*(\\d{4})?`).exec(t);
    if (!m) continue;
    const year = m[1] ? Number(m[1]) : Number(today.slice(0, 4));
    return periodOf(dayOf(year, month, 1), dayOf(year, month, daysInMonth(year, month)));
  }
  const last = /(?:آخر|اخر)\s+(\d{1,3})?\s*(شهرين|شهر|شهور|أشهر|اشهر|أسبوعين|اسبوعين|أسبوع|اسبوع|أسابيع|اسابيع|يومين|يوم|أيام|ايام|سنة|سنتين|سنوات|سنين)/.exec(t);
  if (!last) return null;
  const unit = last[2];
  const n = last[1] ? Number(last[1]) : /ين$/.test(unit) ? 2 : 1;
  if (/شهر|شهور|أشهر|اشهر/.test(unit)) return periodOf(monthsBack(today, n), today);
  if (/سن/.test(unit)) return periodOf(monthsBack(today, 12 * n), today);
  if (/سبوع|سابيع/.test(unit)) return periodOf(shiftDays(today, -7 * n), today);
  return periodOf(shiftDays(today, -n), today);
}

const NEWEST = /(?:^|\s)(?:ال)?[أا]حدث(?:\s|$)|الأخيرة|الاخيرة|latest|newest/i;
const MADE_WITH = /(?:معمول|مصنوع|متعمل|مولد|مصمم)\w*\s*(?:ب|بال)/;
const ABOUT = /(?:^|\s)(?:عن|حول|بخصوص|فيها|فيه|تذكر)\s/;

/** The Ask of a request (and of the customer's answer and edit). `requestedAtMs` is the moment the mission was created: «آخر ٣ شهور» counts back from that Cairo day. */
export function buildAsk(request: unknown, answer: unknown, requestedAtMs: number, edits: AskEdits = {}): Ask {
  const text = `${String(request ?? "")} ${String(answer ?? "")}`.replace(/\s+/g, " ").trim();
  const c = buildRequestContract(request, answer);
  const meaning = topicMeaningOf(text);
  const topicText = c.topic ?? meaning.topic ?? null;
  // «عن / حول / فيها X» is about X, «معمول بـ X» is made with X; a topic named with neither, that one can make content with, is ambiguous (asked before planning)
  const relation: TopicRelation = topicText === null ? "none" : MADE_WITH.test(text) ? "made_with" : ABOUT.test(text) ? "about" : meaning.kind === "ambiguous" ? "ambiguous" : "about";
  const sourceKind: AskSourceKind = c.source.named ? "named" : c.source.official ? "official" : "none";
  const language: Ask["language"] = c.language ? (/بالإنجليزي|بالانجليزي|الإنجليزية|الانجليزية|english/i.test(text) ? "en" : "ar") : null;
  return {
    platform: c.platform,
    parentKind: c.parentKind,
    count: edits.count ?? c.count,
    source: { kind: sourceKind, text: c.source.text },
    topic: { text: topicText, relation },
    period: c.period ? periodOfRequest(text, requestedAtMs) : null,
    country: c.country ? countryOfRequestText(text) : null,
    language,
    order: NEWEST.test(text) || c.comments === "none" ? "newest" : "most_commented",
    comments: c.comments,
    replies: c.replies,
    edits: { ...edits },
  };
}
