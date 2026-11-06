import { buildRequestContract, type ChildAsk, type ParentKind } from "../requestContract";
import { countryOfValue } from "../places";
import { topicMeaningOf } from "../topicMeaning";
import { cairoDayEndExclusiveMs, cairoDayOf, cairoDayStartMs } from "../cairoTime";
import type { SocialPlatform } from "../redesignFlagTypes";
import { occurrenceChoiceOf, requestYearOf, type Occurrence } from "./occurrence";
import { NUMBER_WORDS_SRC, numberOfToken } from "../arabicNumberWords";

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
export interface AskEdits {
  count?: number; comments?: number; replies?: number;
  /** YouTube, an official source: the names to look the channels up by (the understanding step of Stage 2 gives them; absent, they are read from the topic: `officialChannelQueriesOf`). */
  channels?: string[];
  /** Decision 7, a recurring event: which occurrence the customer means (the planning keeps it across the questions that follow). */
  occurrence?: Occurrence;
  /** Part B (round 14): the budget in points, a hard ceiling on the hold (said in the request, or chosen at the count question). */
  budget?: number;
}

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
  /** ROUND 35: the customer asked for REELS (Instagram): the parent tool must prove the media type (a reels-only tool, or the tool's own media-type filter) or the plan says it cannot. Absent: no reels asked. */
  media?: "reels";
  /** ROUND 36: the deliverable fields the customer named (dates, the account, views, likes): they take part in the source's choice and in the plan's review. Absent: none named. */
  wants?: ReadonlyArray<import("../requestContract").WantedField>;
  /** The customer's number of top-level comments FOR EACH parent («١٠٠ تعليق من كل فيديو»), or null when the words give none per parent. */
  commentsPerParent: number | null;
  /** ROUND 19: a number of comments the words give with no «each» and no «total» after it («مع ١٠ تعليقات») while the request has several parents or none counted yet: asked once before the plan. Null when the number is per parent, a total, or absent. */
  commentsBare: number | null;
  /** The customer's number of replies FOR EACH comment («٣ ردود على كل تعليق»), or null. */
  repliesPerComment: number | null;
  /** X: the customer's number of replies FOR EACH TWEET («ردين على كل منشور»). Absent: none named (every reply the source shows, within the stage's cap). */
  repliesPerTweet?: number;
  /** Decision 7: the occurrence of a recurring event the customer chose («آخر مرة» / «كل المرات» / a year), or null when none was chosen or asked. */
  occurrence?: Occurrence;
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

/** «الشهر الماضي» (also written with ى), «الشهر اللي فات» / «الشهر الي فات» / «الشهر اللى فات»: the month before the request's month. */
const PREVIOUS_MONTH = /(?:^|\s)(?:ال)?شهر\s+(?:الماضي|الماضى|(?:اللي|اللى|الي|الى)\s+فات)(?:\s|$|[.،,!؟?])/;

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
  // «الشهر الماضي» / «الشهر اللي فات» is the previous CALENDAR month in Cairo time (a request on 3 Nov 2026: 1 to 31 Oct 2026); «آخر شهر» below stays the last 30 days
  if (PREVIOUS_MONTH.test(t)) {
    const [y, m] = today.split("-").map(Number);
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    return periodOf(dayOf(py, pm, 1), dayOf(py, pm, daysInMonth(py, pm)));
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

/** The country the customer named after «من / في / داخل» (the request contract's own phrase for a country), as its ISO code: never a nationality word, never a row filter. */
const COUNTRY_PHRASE = /(?:^|\s)(?:في|من|داخل)\s+((?:ال)?[\u0621-\u064A]+)/g;
function countryNamedIn(text: string): string | null {
  for (const m of text.matchAll(COUNTRY_PHRASE)) { const code = countryOfValue(m[1]); if (code) return code; }
  return null;
}

/**
 * THE NUMBER OF COMMENTS FOR EACH PARENT («١٠٠ تعليق من كل فيديو», «٥٠ تعليق لكل فيديو», «أول ٢٠ تعليق على كل منشور», «خمس تعليقات لكل واحد», «١٠ تعليقات للفيديو الواحد»): a number (digits of either script, or words) before the child's noun, then a word that says «each».
 * ROUND 19: a number with NO «each» after it is not per parent by itself: with ONE parent («فيديو واحد ... مع ١٠ تعليقات») it is that parent's number; with several it is a bare count (`commentsBare`), asked once («كم تعليقًا تريد من كل فيديو؟») unless the words say it is a total («في المجموع», «إجمالي»).
 */
const PARENT_NOUN = "(?:فيديوهات|فيديو|منشورات|منشور|بوستات|بوست|تغريدات|تغريدة|تغريده|ريلز|ريل|مقطع|عنصر|واحد|واحدة)";
const NUM = `(\\d+|${NUMBER_WORDS_SRC})`;
const COMMENT_NOUN = "(?:تعليقات|تعليقًا|تعليقا|تعليق|كومنتات|كومنت)";
const REPLY_NOUN = "(?:ردود|ردًا|ردا|ردّ|رد)";
const EACH = `(?:(?:(?:من|على|في|عن|تحت)\\s+)?ل?كل\\s+${PARENT_NOUN}|(?:على|في|من|ل)\\s*(?:ال)?(?:فيديو|منشور|بوست|تغريدة|ريل|مقطع)\\s+(?:ال)?(?:واحد|واحدة))`;
const PER_PARENT_COMMENTS = new RegExp(`(?:^|\\s)(?:و|ب|بـ)?${NUM}\\s*${COMMENT_NOUN}\\s+${EACH}`);
const PER_COMMENT_REPLIES = new RegExp(`(?:^|\\s)(?:و|ب|بـ)?${NUM}\\s*${REPLY_NOUN}\\s+(?:(?:من|على|في|عن)\\s+)?ل?كل\\s+(?:تعليق|كومنت)`);
/**
 * NOV 6 2026 CAMPAIGN: THE DUAL is a number. «مع تعليقين حقيقيين على كل منشور» (Facebook, TikTok, YouTube) and «مع ردين حقيقيين على كل منشور» (X) named 2 per parent; neither was read (the per-parent rules needed a digit or a number
 * word), so the Facebook mission asked «كم تعليقًا تريد من كل فيديو؟» and the X mission lost its replies. Up to two describing words may sit between the noun and «each» («حقيقيين», «عامين»).
 */
const DESCRIBED = "(?:\\s+[ء-ي]+(?:ين|ان|ة|ه)){0,2}";
const DUAL_COMMENTS = new RegExp(`(?:^|\\s)(?:مع\\s+|و|ب)?(?:تعليقين|تعليقان|كومنتين)${DESCRIBED}\\s+${EACH}`);
/** X: the replies FOR EACH TWEET («ردين على كل منشور», «٣ ردود على كل تغريدة»): a tweet's replies are its children (X has no comments). */
const PER_TWEET_REPLIES = new RegExp(`(?:^|\\s)(?:مع\\s+|و|ب|بـ)?${NUM}\\s*${REPLY_NOUN}${DESCRIBED}\\s+${EACH}`);
const DUAL_REPLIES = new RegExp(`(?:^|\\s)(?:مع\\s+|و|ب)?(?:ردّين|ردين|ردّان|ردان)${DESCRIBED}\\s+${EACH}`);
export function repliesPerTweetOf(text: string): number | null {
  if (DUAL_REPLIES.test(text)) return 2;
  return numberIn(text, PER_TWEET_REPLIES);
}
/** A number of comments with NO «each» after it: «مع ١٠ تعليقات», «و٥٠ تعليق». */
const BARE_COMMENTS = new RegExp(`(?:^|\\s)(?:مع\\s+|و|ب|بـ)?${NUM}\\s*${COMMENT_NOUN}(?![ء-ي])`);
/** The words that make a number of comments a TOTAL: «١٠٠ تعليق في المجموع», «إجمالي ١٠٠ تعليق». */
const TOTAL_AFTER = new RegExp(`(?:^|\\s)${NUM}\\s*${COMMENT_NOUN}\\s+(?:في\\s+|ب)?(?:ال)?(?:مجموع|إجمالي|اجمالي|الكل|كلهم|كلها|كامل|الإجمالي)`);
const TOTAL_BEFORE = new RegExp(`(?:إجمالي|اجمالي|مجموع|المجموع)\\s+${NUM}\\s*${COMMENT_NOUN}`);
function numberIn(text: string, rx: RegExp): number | null {
  const m = rx.exec(digits(text));
  const n = m ? numberOfToken(m[1]) : null;
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}
const perParentOf = numberIn;

const NEWEST = /(?:^|\s)(?:ال)?[أا]حدث(?:\s|$)|الأخيرة|الاخيرة|latest|newest/i;
const MADE_WITH = /(?:معمول|مصنوع|متعمل|مولد|مصمم)\w*\s*(?:ب|بال)/;
const ABOUT = /(?:^|\s)(?:عن|حول|بخصوص|فيها|فيه|تذكر)\s/;
/** «في آخر كأس عالم», «في أحدث نهائي»: the latest occurrence of a recurring event (the event words of occurrence.ts), with the one word that names it («عالم», «دوري أبطال»). */
const LATEST_EVENT = /(?:^|\s)(?:في|خلال|أثناء|اثناء)\s+(?:آخر|اخر|أحدث|احدث)\s+((?:ال)?(?:نهائي|نهائيات|كأس|بطولة|دوري|موسم|انتخابات|سوبر|مونديال|أولمبياد|اولمبياد|قمة|مهرجان|ديربي|مؤتمر)(?:\s+(?:ال)?[\u0621-\u064A]+)?)(?=$|[\s،,.!؟?])/;

/** The names an official YouTube source is looked up by: the edit's (the customer's, or Stage 2's understanding step), else read from the topic. */
export const channelNamesOf = (ask: Pick<Ask, "topic" | "edits">): string[] => (ask.edits.channels && ask.edits.channels.length > 0 ? ask.edits.channels : officialChannelQueriesOf(ask.topic.text));

/**
 * THE CHANNEL NAMES OF AN OFFICIAL SOURCE (YouTube): when the topic ends with two names joined by «و» («نهائي السوبر المصري الأهلي والزمالك») each name is looked up with the word «الرسمية»; otherwise the whole topic is. Code only: it
 * cannot know what a name stands for, so the card says which channels it read, and the customer's edit (or Stage 2's understanding step) can replace the names.
 */
export function officialChannelQueriesOf(topic: string | null): string[] {
  const t = (topic ?? "").replace(/\s+/g, " ").trim();
  if (t === "") return [];
  const pair = /(\S+)\s+و(\S+)$/.exec(t);
  return pair ? [`${pair[1]} الرسمية`, `${pair[2]} الرسمية`] : [`${t} الرسمية`];
}

/** The Ask of a request (and of the customer's answer and edit). `requestedAtMs` is the moment the mission was created: «آخر ٣ شهور» counts back from that Cairo day. */
export function buildAsk(request: unknown, answer: unknown, requestedAtMs: number, edits: AskEdits = {}): Ask {
  const text = `${String(request ?? "")} ${String(answer ?? "")}`.replace(/\s+/g, " ").trim();
  const c = buildRequestContract(request, answer);
  const meaning = topicMeaningOf(text);
  // ROUND 33: «في آخر كأس عالم» / «في أحدث نهائي»: the customer names the LATEST occurrence of a recurring event themselves. The request parser stops the topic at «في» (the topic of «منتخب مصر في آخر كأس عالم» was «منتخب مصر»), so the event was dropped without a trace. It is now part of the topic (what the search and the topic marks read)
  // and, on the platforms that ask «تقصد أنهي مرة؟» (Facebook, Instagram, YouTube), it is the customer's own answer «آخر مرة»: no question. A request with no such phrase is read exactly as before.
  const eventLatest = c.platform === "facebook" || c.platform === "instagram" || c.platform === "youtube" ? LATEST_EVENT.exec(text)?.[1]?.replace(/\s+/g, " ").trim() ?? null : null;
  const baseTopic = c.topic ?? meaning.topic ?? null;
  const topicText = eventLatest && !(baseTopic ?? "").includes(eventLatest) ? [baseTopic, eventLatest].filter(Boolean).join(" ") : baseTopic;
  // «عن / حول / فيها X» is about X, «معمول بـ X» is made with X; a topic named with neither, that one can make content with, is ambiguous (asked before planning)
  const relation: TopicRelation = topicText === null ? "none" : MADE_WITH.test(text) ? "made_with" : ABOUT.test(text) ? "about" : meaning.kind === "ambiguous" ? "ambiguous" : "about";
  // A PAGE OR ACCOUNT GIVEN BY ITS LINK (Facebook, Instagram): the request contract reads the words after «من صفحة» and stops at the link's first dot; the link itself is the source
  const link = c.platform === "facebook" || c.platform === "instagram" ? /https?:\/\/(?:www\.|m\.)?(?:facebook|instagram)\.com\/[A-Za-z0-9._-]+\/?/i.exec(text)?.[0] ?? null : null;
  const sourceKind: AskSourceKind = link || c.source.named ? "named" : c.source.official ? "official" : "none";
  // A YEAR (decision 7; Facebook, Instagram and YouTube only): written by the customer in their words, or typed as the answer of «حدد سنة», is the period of that calendar year; the customer's own number of posts («٢٠٢٠ منشور») is never a year
  const social = c.platform === "facebook" || c.platform === "instagram" || c.platform === "youtube";
  const chosen = edits.occurrence ?? (occurrenceChoiceOf(answer) as Occurrence | { kind: "ask_year" } | null) ?? (eventLatest && !c.period ? ({ kind: "latest" } as Occurrence) : null);
  const occurrence: Occurrence | null = chosen && chosen.kind !== "ask_year" ? chosen : social && !c.period && requestYearOf(String(request ?? "")) !== null ? { kind: "year", year: requestYearOf(String(request ?? ""))! } : null;
  const yearPeriod: AskPeriod | null = social && !c.period && occurrence?.kind === "year" ? periodOf(dayOf(occurrence.year, 1, 1), dayOf(occurrence.year, 12, 31)) : null;
  const language: Ask["language"] = c.language ? (/بالإنجليزي|بالانجليزي|الإنجليزية|الانجليزية|english/i.test(text) ? "en" : "ar") : null;
  // ROUND 19: the comments number. «N تعليق من كل فيديو» is per parent; «N تعليق في المجموع» is a total (the card's own edit of the total); a bare «مع N تعليقات» is the one parent's number when the request has ONE parent («فيديو واحد»), else a bare count to ask about
  const count = edits.count ?? c.count;
  const eachValue = c.comments === "none" ? null : perParentOf(text, PER_PARENT_COMMENTS) ?? (DUAL_COMMENTS.test(text) ? 2 : null);
  const totalValue = c.comments === "none" ? null : numberIn(text, TOTAL_AFTER) ?? numberIn(text, TOTAL_BEFORE);
  const bare = c.comments === "none" || eachValue !== null || totalValue !== null ? null : numberIn(text, BARE_COMMENTS);
  const perParentValue = eachValue ?? (bare !== null && count === 1 ? bare : null);
  const bareValue = bare !== null && perParentValue === null ? bare : null;
  const totalEdit = totalValue !== null && edits.comments === undefined ? { comments: totalValue } : {};
  return {
    platform: c.platform,
    parentKind: c.parentKind,
    count,
    source: { kind: sourceKind, text: link ?? c.source.text },
    topic: { text: topicText, relation },
    period: c.period ? periodOfRequest(text, requestedAtMs) : yearPeriod,
    country: c.country ? countryNamedIn(text) : null,
    language,
    // X WITH ITS REPLIES (NOV 6 2026 CAMPAIGN): the replies are the children of an X request, so their tweets are chosen by the replies counter like any parent with children (the newest tweets of a «Latest» search have none yet)
    order: NEWEST.test(text) || (c.comments === "none" && !(c.platform === "x" && c.replies !== "none")) ? "newest" : "most_commented",
    comments: c.comments,
    replies: c.replies,
    ...(c.media ? { media: c.media } : {}),
    ...(c.wants ? { wants: c.wants } : {}),
    commentsPerParent: perParentValue,
    commentsBare: bareValue,
    repliesPerComment: c.replies === "none" ? null : perParentOf(text, PER_COMMENT_REPLIES),
    ...(c.platform === "x" && c.replies !== "none" && repliesPerTweetOf(text) !== null ? { repliesPerTweet: repliesPerTweetOf(text)! } : {}),
    ...(social && occurrence ? { occurrence } : {}),
    edits: { ...totalEdit, ...edits },
  };
}
