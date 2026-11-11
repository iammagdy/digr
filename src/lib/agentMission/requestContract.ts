import { NUMBER_WORDS_SRC, numberOfWord } from "./arabicNumberWords";
import { conditionsOfRequest } from "./requestConditions";
import { GAP_CHOICE_LINE_AR, gapLinesAr } from "./gapLines";
import { platformOfStages, type SocialPlatform } from "./redesignFlagTypes";
import { readConditions } from "./semantic/conditions";
import { emptyFillReport, platformFromAnswer, platformWithReading, topicWithoutConditions, topicWithReading, type FillReport } from "./semantic/contractFill";
import { interpretRequest } from "./semantic/interpret";

/**
 * THE REQUEST CONTRACT (docs/ROOT-CAUSE.md, cause 1 and section 5). What the customer asked is built ONCE, by code, from their words (and the answer they gave to the one question), and every plan is checked against it before it is stored: for each thing
 * asked (the comments, the replies, a source, a topic, a country, a language, a period, a count) the plan either CARRIES it (a stage of the right kind exists; a field of the tool's input holds it), STATES it (an honest Arabic line the customer reads before approving),
 * or is MISSING it. A plan is never stored with something missing: a missing stage is sent back to the planner (at most CONTRACT_SEND_BACKS_MAX times), then written by code as a step that is not included; a condition no field carries gets its statement.
 * Pure: no I/O, no catalog, no model. The sentence was parsed by a dozen unrelated rules before (a stage was demanded only by a NUMBER: «مع كل التعليقات والردود» demanded nothing); this is the one place that knows what «the plan equals the request» means, for every platform.
 */
export type ChildAsk = "none" | "some" | "all";
export type ParentKind = "posts" | "videos" | "tweets";
export interface RequestContract {
  platform: SocialPlatform | null;
  parentKind: ParentKind | null;
  /** The number of top-level items asked for (a numeral or a dual form: «فيديوهين»), or null. */
  count: number | null;
  /** A named page, account or channel (or the official channels of an event), as the customer wrote it. */
  source: { named: boolean; official: boolean; text: string | null };
  /** The topic as the customer wrote it (after «عن» / «حول» / «فيها»), or null. */
  topic: string | null;
  country: boolean;
  language: boolean;
  period: boolean;
  comments: ChildAsk;
  replies: ChildAsk;
  /** NOV 6 2026: the optional preferences the customer wrote («منشورات فيديو لو متاح»), cut from the topic, the keywords, the kind and the count; stated on the plan. Absent: none. */
  preferences?: string[];
  /** ROUND 35: the customer asked for REELS (a kind of Instagram post, not a kind of «منشور»): the plan must serve it with a source that proves the media type or say that it cannot. Absent when the words ask for no reels. */
  media?: "reels";
  /** ROUND 36: the DELIVERABLE FIELDS the customer named («مع النصوص والروابط والتواريخ وعدد المشاهدات»), as the row keys that carry them. They take part in the choice of the source and in the plan's review: a field the chosen source cannot give is said before approval, never left out silently. Absent when the words name none of them. */
  wants?: ReadonlyArray<WantedField>;
}
export type WantedField = "posted_at" | "author" | "views" | "likes";

const digits = (s: string): string => s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
const PLATFORM_WORDS: ReadonlyArray<[SocialPlatform, RegExp]> = [
  ["tiktok", /تيك\s*توك|تيكتوك|tiktok/i],
  ["youtube", /يوتيوب|youtube/i],
  ["instagram", /[إا]نستجرام|[إا]نستغرام|[إا]نستا(?![ء-ي])|instagram/i],
  ["facebook", /فيس\s*بوك|facebook/i],
  ["x", /(?:^|[\s«"'(])(?:X|x|إكس|اكس)(?=$|[\s»"'.,،)؟?])|تويتر|تغريد|twitter/],
];
// ROUND 35: «ريلز» / «ريل» / «reels»: the word stands alone (a prefix «ال» «و» «ب» «ل» is allowed); «أبريل» and «تريليون» contain the letters and are not reels
export const REELS_WORD = /(?<![ء-ي])(?:[وبلف])?(?:ال)?ريل(?:ز|س|ات)?(?![ء-ي])|\breels?\b/i;
// ROUND 36: the fields a request names for the delivered rows. «من تاريخ ١ يناير» is a period, not a date column: the date column is asked with «التواريخ», «تاريخ النشر», «وقت النشر», «مع التاريخ»
const WANT_WORDS: ReadonlyArray<[WantedField, RegExp]> = [
  ["posted_at", /(?:ال)?تواريخ|تاريخ\s+(?:ال)?(?:نشر|منشور|ريل|فيديو)|وقت\s+(?:ال)?نشر|(?:مع|و)\s*(?:ال)?تاريخ(?![ء-ي])(?!\s*\d)/],
  // NOV 6 2026 (Instagram msn_34dcf09434697a62995c): «والروابط وأسماء الحسابات» (the plural) named the account and was not read: the file had no account column and nothing said so
  ["author", /صاحب\s+(?:ال)?(?:حساب|منشور|ريل)|أصحاب|اسم\s+(?:ال)?(?:حساب|ناشر|كاتب|مستخدم|صفحة|صفحه|قناة|قناه)|[أا]سماء\s+(?:ال)?(?:حسابات|صفحات|قنوات|ناشرين|كتّاب|كتاب|مستخدمين|المستخدمين)|(?:ال)?ناشر|(?:ال)?كاتب(?![ء-ي])|المؤلف|يوزر|بيانات\s+(?:ال)?حساب/],
  ["views", /مشاهدات/],
  ["likes", /إعجابات|اعجابات|لايكات/],
];
export const wantedFieldsOf = (text: string): WantedField[] => WANT_WORDS.filter(([, re]) => re.test(text)).map(([k]) => k);
const KIND_WORDS: ReadonlyArray<[ParentKind, RegExp]> = [["videos", /فيديو|مقطع|مقاطع/], ["posts", new RegExp(`منشور|بوست|${REELS_WORD.source}`, "i")], ["tweets", /تغريد|تويت/]];
const DUAL = /(?:فيديوهين|فيديوهان|منشورين|منشوران|تغريدتين|تغريدتان|بوستين|مقطعين)/;
const COUNT_NOUN = /(?:فيديو|منشور|بوست|تغريد|تويت|مقطع|مقاطع|ريلز|ريلس|ريلات|ريل(?![ء-ي])|reels?\b)/i;
const ALL_COMMENTS = /(?:كل|جميع|كافة)\s+(?:ال)?تعليقات/;
const ALL_REPLIES = /(?:كل|جميع|كافة)\s+(?:ال)?ردود|(?:كل|جميع|كافة)\s+(?:ال)?تعليقات\s+(?:و)?(?:ال)?ردود/;
/**
 * NOV 6 2026 CAMPAIGN (X, msn_d31f37958788a24ec46d: «منشورين عامين من إكس عن الذكاء الاصطناعي، مع ردين حقيقيين على كل منشور»): the reply words were read by `/ردود/` only, so the DUAL «ردين» (and «ردان», a counted singular
 * «٣ رد», «ردًا واحدًا», «مع الرد») asked for nothing: the plan had no replies stage and said nothing about it. Every form of the noun is read now; «ردود فعل» / «رد فعل» / «ردة فعل» are REACTIONS (an opinion request), never replies.
 */
const REPLY_WORDS = [
  /ردود(?!\s+(?:ال)?فعل)/,
  /(?<![ء-ي])و?ردّ?(?:ين|ان)(?![ء-ي])/,
  /(?:\d|[٠-٩])\s*ردّ?(?:ًا|ا)?(?![ء-ي])/,
  /(?<![ء-ي])(?:ال)?ردّ?(?:ًا|ا)?\s+(?:واحد|واحدًا|واحدا)(?![ء-ي])/,
  /(?:^|\s)(?:مع|و)\s*الردّ?(?![ء-ي])(?!\s+(?:ال)?فعل)/,
  /ريبلاي|\breplies\b/i,
];
export const repliesAskedIn = (text: string): boolean => REPLY_WORDS.some((re) => re.test(text));
const STOP = /^(?:على|من|عن|في|آخر|اخر|مع|بالعربي|بالعربية|باللغة|،|,|\.|\(|«|"|بين|منذ|خلال)$/;

function firstPlatform(text: string): SocialPlatform | null {
  let best: { at: number; p: SocialPlatform } | null = null;
  for (const [p, re] of PLATFORM_WORDS) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.at)) best = { at: m.index, p };
  }
  return best ? best.p : null;
}

/**
 * CONSOLIDATED MISSION: EVERY platform a text names (not only the first), by the contract's own words and by the semantic reading's spellings (also a name the reading holds only as a candidate). Used by the research brief's grounding check:
 * a platform in the consolidated request must have been named by the customer (or by the question they answered). Pure.
 */
export function platformsNamedIn(text: string): SocialPlatform[] {
  const out = new Set<SocialPlatform>();
  for (const [p, re] of PLATFORM_WORDS) if (re.test(text)) out.add(p);
  const r = interpretRequest(text).platform;
  if (r.status === "resolved") out.add(r.id);
  else if (r.status === "multiple") for (const id of r.ids) out.add(id);
  else if (r.status === "ambiguous") for (const id of r.candidates) out.add(id);
  return [...out].sort();
}

// ROUND 19: the count of top-level items, in digits (Arabic-Indic or Latin), in words («خمس فيديوهات», «تلات منشورات», «عشرين تغريدة»), as «واحد» after the noun («فيديو واحد», «منشور واحد», «تغريدة واحدة») or as the dual («فيديوهين», «منشورين»)
const COUNT_WORD = new RegExp(`(?:^|\\s)(${NUMBER_WORDS_SRC})\\s+${COUNT_NOUN.source}`);
const COUNT_ONE = new RegExp(`${COUNT_NOUN.source}[ء-ي]*\\s+(?:ال)?(?:واحد|واحدة|وحدة)(?![ء-ي])`);
function countOf(text: string): number | null {
  const d = digits(text);
  const numeric = new RegExp(`(?:^|\\s)(\\d{1,6})\\s*${COUNT_NOUN.source}`).exec(d);
  if (numeric) return Number(numeric[1]);
  if (DUAL.test(text)) return 2;
  const word = COUNT_WORD.exec(text);
  if (word) return numberOfWord(word[1]);
  return COUNT_ONE.test(text) ? 1 : null;
}

function sourceOf(text: string): RequestContract["source"] {
  const official = /(?:القنوات|القناة|الحساب|الحسابات|الصفحة|الصفحات)\s+الرسمي(?:ة|ين|ات)?/.test(text);
  const handle = /@([A-Za-z0-9_.]{2,})/.exec(text)?.[1] ?? /\(([A-Za-z0-9_.]{2,})\)/.exec(text)?.[1] ?? null;
  // «من صفحة قناة العربية على فيسبوك»: the words after the kind word, up to the next preposition, without the kind words themselves
  const m = /(?:^|\s)(?:صفحة|صفحه|حساب|قناة|قنوات)\s+((?:(?:صفحة|قناة|حساب|ال\S+|[^\s،,.()«»"]+)\s*){1,3})/.exec(text);
  let named: string | null = null;
  if (m) {
    // rt-06: «حساب عام» is «a public account», never an account NAMED «عام» (a describing word is not a name; the customer is asked which account, as for no name at all)
    const words = m[1].trim().split(/\s+/).filter((w) => !/^(?:صفحة|قناة|حساب|قنوات|الرسمية|الرسمي|عام|عامة|عامه|معين|معينة|معينه|ما|واحد)$/.test(w));
    const kept: string[] = [];
    for (const w of words) { if (STOP.test(w)) break; kept.push(w); }
    named = kept.length > 0 ? kept.join(" ") : null;
  }
  const text2 = handle ?? named;
  return { named: text2 !== null, official, text: text2 };
}

function topicOf(text: string): string | null {
  const quoted = /(?:عن|حول|بخصوص|فيها|فيه|تذكر)\s+["«“]([^"»”]+)["»”]/.exec(text);
  if (quoted) return quoted[1].trim();
  // ROUND 25: «رأي الناس في X», «آراء الجمهور عن X», «كلام الناس حول X»: the SUBJECT is X (live: the topic read «رأي الناس» and the search would have looked for that phrase)
  const opinion = /(?:رأي|راي|آراء|اراء|كلام|انطباعات|ردود\s+فعل|مشاعر|موقف)\s+(?:ال\S+\s+)?(?:في|عن|حول|تجاه|بخصوص)\s+(.+?)(?=\s+(?:من|في|على|آخر|اخر|بالعربي|بالعربية|مع|بين|منذ|خلال)(?:\s|$)|[،,.؟?]|$)/.exec(text);
  if (opinion) return opinion[1].trim();
  const m = /(?:عن|حول|بخصوص)\s+(.+?)(?=\s+(?:من|في|على|آخر|اخر|بالعربي|بالعربية|مع|بين|منذ|خلال)(?:\s|$)|[،,.]|$)/.exec(text);
  return m ? m[1].trim() : null;
}

/**
 * NOV 6 2026 CAMPAIGN (Facebook msn_60fd71cf5e4d1c9fc5f2, Instagram msn_34dcf09434697a62995c): «عن الذكاء الاصطناعي (منشورات فيديو لو متاح)» and «(ريلز لو متاح)» are OPTIONAL FORMAT PREFERENCES, not part of the topic. The topic
 * parser stopped at «،» only, so the topic became «الذكاء الاصطناعي (منشورات فيديو لو متاح)»: it was sent to the source as the search keyword, it named the files, it made every row «لا يذكر الموضوع» (the words «لو متاح» are in no post), and
 * «فيديو» made a Facebook posts request a «videos» request. An optional clause is a parenthesis, or a clause after «،» / «-», that holds a conditional of availability («لو متاح», «إن أمكن», «إن وجد», «إذا توفر», «if available»).
 * It is cut from the text that decides the topic, the keywords, the kind and the count; it is kept, as written, as a preference the plan states.
 */
const IF_AVAILABLE = /(?:لو|إن|ان|إذا|اذا)\s+(?:كان\s+|كانت\s+)?(?:متاح|متاحة|متاحه|متوفر|متوفرة|متوفره|موجود|موجودة|موجوده|أمكن|امكن|وجد|وُجد|توفر|توفّر|تيسر|يتاح)|if\s+(?:available|possible)|when\s+available/i;
export function optionalPartsOf(text: string): { required: string; preferences: string[] } {
  const preferences: string[] = [];
  let required = String(text ?? "").replace(/\(([^()]*)\)/g, (all, inner: string) => (IF_AVAILABLE.test(inner) ? (preferences.push(inner.trim()), " ") : all));
  // a clause after a comma or a dash that is itself conditional («، ويفضل فيديو لو متاح»): cut up to the next comma or the end
  required = required.replace(/[،,\-–]\s*([^،,.؟?()]*)/g, (all, clause: string) => (IF_AVAILABLE.test(clause) ? (preferences.push(clause.trim()), "،") : all));
  return { required: required.replace(/\s+/g, " ").replace(/\s+([،,.])/g, "$1").replace(/(?:[،,]\s*){2,}/g, "، ").trim(), preferences };
}

/** THE ONE JOIN of the customer's words and their answer to the one question (it was written by hand at a dozen call sites, `${request_text} ${answer_text ?? ""}`): every reader of «what was asked» takes it from here. */
export const askedTextOf = (mission: { request_text: string; answer_text?: string | null }): string => `${mission.request_text} ${mission.answer_text ?? ""}`;

/** How the contract is read. `semantic`: PR-1.2, the server-controlled flag `semantic_normalization_v1` (OFF unless the caller, which read it from the trusted settings, says true). The caller never takes it from the customer. */
export interface ContractOptions { semantic?: boolean; /** PR-1.3: what the customer typed to the question about a period, a country or a language (kept by the worker with the choices): read by the conditions reader together with the answer, never part of the request. */ conditionsAnswer?: string }

/** The contract of a request, from the customer's words and the answer they gave to the one question (either may be empty). */
export function buildRequestContract(request: unknown, answer?: unknown, options: ContractOptions = {}): RequestContract {
  return buildRequestContractWithReport(request, answer, options).contract;
}

/**
 * The same, with the report of what the semantic reading did (field names only: never the customer's words). With `semantic` off the contract is built exactly as before and the report is empty. With it on, the parser's values are kept; the reading only fills what it left
 * empty from an unambiguous reading, cuts an instruction out of an over-read topic, and clears an X platform that only a bare «X» gave in «مطعم اسمه X» (`semantic/contractFill.ts`).
 */
export function buildRequestContractWithReport(request: unknown, answer?: unknown, options: ContractOptions = {}): { contract: RequestContract; report: FillReport } {
  const text = `${String(request ?? "")} ${String(answer ?? "")}`.replace(/\s+/g, " ").trim();
  // THE REQUIRED WORDS decide the kind, the count and the topic; an optional preference never does (NOV 6 2026)
  const { required, preferences } = optionalPartsOf(text);
  const report = emptyFillReport();
  const readingOfText = options.semantic === true ? interpretRequest(text) : null;
  const readingOfRequired = options.semantic === true ? interpretRequest(required) : null;
  const parsedPlatform = firstPlatform(text);
  const answerText = String(answer ?? "").replace(/\s+/g, " ").trim();
  // CONSOLIDATED MISSION: with the reading on, the customer's ANSWER is also read on its own (their latest word): its platform fills or corrects, its comments are added
  const readingOfAnswer = options.semantic === true && answerText !== "" ? interpretRequest(answerText) : null;
  const readPlatform = readingOfText ? platformWithReading(parsedPlatform, readingOfText, report) : parsedPlatform;
  const platform = readingOfAnswer ? platformFromAnswer(readPlatform, readingOfAnswer, (phrase) => { const r = interpretRequest(phrase).platform; return r.status === "resolved" ? [r.id] : r.status === "multiple" ? r.ids : []; }, answerText, report) : readPlatform;
  let kind = KIND_WORDS.find(([, re]) => re.test(required))?.[0] ?? (platform === "x" ? "tweets" : null);
  if (kind === null && readingOfRequired?.parent_kind) { kind = readingOfRequired.parent_kind; report.filled.push("parentKind"); }
  const classes = conditionsOfRequest(text);
  const parsedComments = /تعليق/.test(text) && platform !== "x";
  const commentsAsked = parsedComments || ((readingOfText?.content.comments === true || readingOfAnswer?.content.comments === true) && platform !== "x");
  if (commentsAsked && !parsedComments) report.filled.push("comments");
  const parsedReplies = repliesAskedIn(text);
  const repliesAsked = parsedReplies || readingOfText?.content.replies === true || readingOfAnswer?.content.replies === true;
  if (repliesAsked && !parsedReplies) report.filled.push("replies");
  const parsedTopic = topicOf(required);
  // PR-1.3: the conditions of the words (a period, a country, a language), read with no clock: only WHETHER each is asked is needed here (the values and the clarifications are the Ask's, which has the moment of the request)
  const conditions = options.semantic === true ? readConditions(request, answer, 0) : null;
  const readTopic = readingOfRequired ? topicWithReading(parsedTopic, readingOfRequired, report) : parsedTopic;
  const topic = conditions ? topicWithoutConditions(readTopic, conditions.phrases, report) : readTopic;
  const periodAsked = classes.includes("date") || (conditions !== null && conditions.period.status !== "none");
  const countryAsked = classes.includes("country") || (conditions !== null && (conditions.country.status === "resolved" || conditions.country.status === "many"));
  // the old language reading cannot tell the language of the CONTENT from the language of the REPORT or of the chat: when the words carry any language word the conditions reader decides
  const languageAsked = conditions !== null && conditions.language.found
    ? conditions.language.content === "ar" || conditions.language.content === "en" || conditions.language.content === "unsupported"
    : classes.includes("language");
  if (conditions !== null) {
    if (periodAsked && !classes.includes("date")) report.filled.push("period");
    if (countryAsked && !classes.includes("country")) report.filled.push("country");
    if (conditions.language.found && languageAsked !== classes.includes("language")) report.corrected.push("language");
  }
  const contract: RequestContract = {
    platform,
    parentKind: kind,
    ...(REELS_WORD.test(text) && platform === "instagram" ? { media: "reels" as const } : {}),
    ...(wantedFieldsOf(text).length > 0 ? { wants: wantedFieldsOf(text) } : {}),
    count: countOf(required),
    source: sourceOf(text),
    topic,
    ...(preferences.length > 0 ? { preferences } : {}),
    country: countryAsked,
    language: languageAsked,
    period: periodAsked,
    comments: commentsAsked ? (ALL_COMMENTS.test(text) ? "all" : "some") : "none",
    replies: repliesAsked ? (ALL_REPLIES.test(text) || ALL_COMMENTS.test(text) && /ردود/.test(text) ? "all" : "some") : "none",
  };
  return { contract, report };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE PLAN AS THE GATE READS IT (a structural subset of PricedPlan: no import of the plan module, so this file stays pure and the tests can build plans by hand)

export type GateClass = "date" | "language" | "country" | "account";
export interface ContractStage {
  key: string;
  parent_key: string | null;
  replies_of?: string;
  deliver: boolean;
  endpoint_id: string;
  capability?: string;
  planned_rows: number;
  engine?: { params?: Record<string, unknown>; gaps?: Array<{ cls: string; reason: string }>; sources?: unknown[]; source_listing?: boolean };
}
export interface ContractPlan {
  summary_ar?: string;
  notes_ar?: string[];
  unserved_steps?: Array<{ what_ar: string; reason_ar: string }>;
  replies_status?: string;
  stages: ContractStage[];
}
export type ContractWhat = "platform" | "count" | "comments" | "replies" | "source" | "topic" | "period" | "country" | "language";
export interface ContractItem { what: ContractWhat; status: "carried" | "stated" | "missing" }
export interface ContractVerdict {
  items: ContractItem[];
  /** Stages the customer asked for that the plan neither has nor states. */
  missingStages: Array<"comments" | "replies">;
  /** Stages the plan does not carry whose words the summary still promises (the card then contradicts itself). */
  overclaims: Array<"comments" | "replies">;
}
/** The most times a plan with a missing comments stage is sent back to the planner before the code states the step as not included. */
export const CONTRACT_SEND_BACKS_MAX = 2;

const norm = (s: string): string => s.replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
const tokens = (s: string): string[] => norm(s).split(/[\s،,:؛;.!؟?()"«»\-–—/_]+/).map((t) => t.replace(/^و(?=.{3,})/, "").replace(/^ال/, "")).filter((t) => t.length > 1);

const topLevel = (plan: ContractPlan): ContractStage | undefined => plan.stages.find((s) => s.parent_key === null && s.deliver) ?? plan.stages.find((s) => s.parent_key === null);
const stringValues = (e: ContractStage["engine"]): string[] => {
  const out: string[] = [];
  const add = (o: Record<string, unknown> | undefined): void => { for (const v of Object.values(o ?? {})) if (typeof v === "string") out.push(v); };
  add(e?.params);
  for (const s of e?.sources ?? []) if (s && typeof s === "object") add((s as { params?: Record<string, unknown> }).params);
  return out;
};
const keysOf = (e: ContractStage["engine"]): string[] => {
  const out = Object.keys(e?.params ?? {});
  for (const s of e?.sources ?? []) if (s && typeof s === "object") out.push(...Object.keys((s as { params?: Record<string, unknown> }).params ?? {}));
  return out;
};
const KEY_RE = {
  date: /^(?:startdate|enddate|since|until|from|to|datefrom|dateto|starttime|endtime|publishedafter|publishedbefore|after|before|fromdate|todate|createdafter|createdbefore|dateposted|period|timerange|timeframe|daterange|datefilter|publishedwithin)$/i,
  language: /^(?:lang|language|hl|lr|locale|languagecode)$/i,
  country: /^(?:country|region|gl|geo|countrycode|regioncode)$/i,
  account: /^(?:username|user|handle|screenname|account|accountname|channelid|channel|channelurl|profile|profileurl|userid|authorid|url|pageurl|page|pagename)$/i,
};
const hasKey = (e: ContractStage["engine"], re: RegExp): boolean => keysOf(e).some((k) => re.test(k.replace(/[_\-\s]/g, "")) && (e?.params?.[k] ?? "") !== "");

/** A condition is CARRIED when a field of the tool's input holds it; the query's own operators count (`since:`, `until:`, `lang:`). */
function carriedBy(stage: ContractStage, what: "period" | "country" | "language" | "source" | "topic", contract: RequestContract): boolean {
  const e = stage.engine;
  const all = stringValues(e).join(" ");
  switch (what) {
    case "period": return hasKey(e, KEY_RE.date) || /(?:since|until):/.test(all);
    case "language": return hasKey(e, KEY_RE.language) || /lang:/.test(all);
    case "country": return hasKey(e, KEY_RE.country);
    case "source": return hasKey(e, KEY_RE.account) || (e?.sources?.length ?? 0) > 0 || e?.source_listing === true;
    case "topic": {
      const want = tokens(contract.topic ?? "");
      if (want.length === 0) return true;
      const have = new Set(tokens(all));
      return want.filter((t) => have.has(t)).length >= Math.ceil(want.length * 0.6);
    }
  }
}

const GAP_CLASS: Record<"period" | "country" | "language" | "source", GateClass> = { period: "date", country: "country", language: "language", source: "account" };
const TOPIC_LINE_AR = "المصدر المختار لا يسمح بتحديد الموضوع بكلمات البحث، فنختار ما نقرؤه من نتائجه بحسب نصها، وقد تصلك نتائج لا تتحدث عن موضوعك.";
const lineOf = (cls: GateClass): string => gapLinesAr([{ cls, reason: "not_enforced" }])[0]!;
const statedLineOf = (what: "period" | "country" | "language" | "source" | "topic"): string => (what === "topic" ? TOPIC_LINE_AR : lineOf(GAP_CLASS[what]));

function statedBy(plan: ContractPlan, stage: ContractStage | undefined, what: "period" | "country" | "language" | "source" | "topic"): boolean {
  if (what !== "topic" && (stage?.engine?.gaps ?? []).some((g) => g.cls === GAP_CLASS[what])) return true;
  const line = statedLineOf(what);
  return (plan.notes_ar ?? []).includes(line) || (what !== "topic" && (plan.notes_ar ?? []).some((n) => n === gapLinesAr([{ cls: GAP_CLASS[what], reason: "no_field" }])[0]));
}

const commentsStageOf = (plan: ContractPlan): ContractStage | undefined => plan.stages.find((s) => s.parent_key !== null && s.replies_of === undefined && s.deliver);
const repliesStageOf = (plan: ContractPlan): ContractStage | undefined => plan.stages.find((s) => s.replies_of !== undefined || /replies?$/.test(s.capability ?? ""));
const commentsStated = (plan: ContractPlan): boolean => (plan.unserved_steps ?? []).some((u) => /تعليق/.test(u.what_ar));
const repliesStated = (plan: ContractPlan): boolean => plan.replies_status !== undefined || (plan.unserved_steps ?? []).some((u) => /ردود/.test(u.what_ar));

/** Checks a finished plan against the contract. Pure; reads only the plan. */
export function checkPlanAgainstContract(contract: RequestContract, plan: ContractPlan): ContractVerdict {
  const items: ContractItem[] = [];
  const missingStages: Array<"comments" | "replies"> = [];
  const overclaims: Array<"comments" | "replies"> = [];
  const top = topLevel(plan);
  if (contract.platform !== null) {
    const actual = platformOfStages(plan.stages as never);
    items.push({ what: "platform", status: actual === null || actual === contract.platform ? "carried" : "missing" });
  }
  if (contract.count !== null && top) items.push({ what: "count", status: top.planned_rows === contract.count ? "carried" : "missing" });
  // THE STAGES: X has no comments source, so no comments stage is demanded there. Its REPLIES are a child stage on the tweets (the verified `tweet.replies` card, live round 8): NOV 6 2026 CAMPAIGN (msn_d31f37958788a24ec46d), the gate
  // exempted X from the replies check too, so a plan with no replies stage for «مع ردين على كل منشور» passed without a word. A replies stage is now demanded on every platform (carried, or stated before approval).
  const needsStages = contract.platform !== "x" && top !== undefined;
  const needsReplies = top !== undefined;
  if (needsStages && contract.comments !== "none") {
    const present = commentsStageOf(plan) !== undefined;
    const stated = commentsStated(plan);
    items.push({ what: "comments", status: present ? "carried" : stated ? "stated" : "missing" });
    if (!present && !stated) missingStages.push("comments");
    if (!present && /تعليق/.test(plan.summary_ar ?? "")) overclaims.push("comments");
  }
  if (needsReplies && contract.replies !== "none") {
    const present = repliesStageOf(plan) !== undefined;
    const stated = repliesStated(plan);
    items.push({ what: "replies", status: present ? "carried" : stated ? "stated" : "missing" });
    if (!present && !stated) missingStages.push("replies");
    if (!present && /ردود/.test(plan.summary_ar ?? "")) overclaims.push("replies");
  }
  // THE CONDITIONS, on the stage that lists the top-level items
  if (top) {
    const conds: Array<[ContractWhat & ("period" | "country" | "language" | "source" | "topic"), boolean]> = [
      ["period", contract.period], ["country", contract.country], ["language", contract.language],
      ["source", contract.source.named || contract.source.official], ["topic", contract.topic !== null],
    ];
    for (const [what, asked] of conds) {
      if (!asked) continue;
      items.push({ what, status: carriedBy(top, what, contract) ? "carried" : statedBy(plan, top, what) ? "stated" : "missing" });
    }
  }
  return { items, missingStages, overclaims };
}

const nounOf = (kind: ParentKind | null): string => (kind === "videos" ? "فيديو" : kind === "posts" ? "منشور" : "عنصر");
const STEP_REASON_COMMENTS_AR = "لم نجد في هذه الخطة مصدرًا نقرأ منه التعليقات لهذه المنصة";
const STEP_REASON_REPLIES_AR = "لم نجد في هذه الخطة مصدرًا نقرأ منه ردود التعليقات لهذه المنصة";
const STEP_REASON_X_REPLIES_AR = "لم نجد في هذه الخطة مصدرًا نقرأ منه الردود على التغريدات، فلن تُضاف هذه الخطوة ولن تُحسب في السعر";

/**
 * Makes the plan say what it does not carry (idempotent: a second call adds nothing; a plan that satisfies the contract is not touched). A missing stage becomes a step that is NOT INCLUDED on the card; a condition no field carries gets its sentence in the notes.
 * `added` lists what was written, for the internal event.
 */
export function repairPlanByContract(contract: RequestContract, plan: ContractPlan): { added: string[] } {
  const verdict = checkPlanAgainstContract(contract, plan);
  const added: string[] = [];
  const unserved = (what_ar: string, reason_ar: string): void => { plan.unserved_steps = [...(plan.unserved_steps ?? []), { what_ar, reason_ar }]; };
  for (const stage of verdict.missingStages) {
    if (stage === "comments") unserved(`التعليقات على كل ${nounOf(contract.parentKind)}`, STEP_REASON_COMMENTS_AR);
    else if (contract.platform === "x") unserved("الردود على كل تغريدة", STEP_REASON_X_REPLIES_AR);
    else unserved("الردود على كل تعليق", STEP_REASON_REPLIES_AR);
    added.push(stage);
  }
  const lines: string[] = [];
  for (const item of verdict.items) {
    if (item.status !== "missing") continue;
    if (item.what === "period" || item.what === "country" || item.what === "language" || item.what === "source" || item.what === "topic") { lines.push(statedLineOf(item.what)); added.push(item.what); }
  }
  if (lines.length > 0) plan.notes_ar = [...(plan.notes_ar ?? []).filter((n) => n !== GAP_CHOICE_LINE_AR), ...lines, GAP_CHOICE_LINE_AR];
  return { added };
}

/** The text that sends a plan back to the planner: what is missing, the tools of the catalog that can serve it, and what not to say. Empty when nothing needs the planner (a statement is written by code). */
export function contractSendBackIssues(verdict: ContractVerdict, contract: RequestContract, tools: { commentsTools?: string[] }): string[] {
  if (!verdict.missingStages.includes("comments")) return [];
  const list = (tools.commentsTools ?? []).slice(0, 4);
  const lines = [`the customer asked for ${contract.comments === "all" ? "ALL the comments" : "the comments"}${verdict.missingStages.includes("replies") ? " and the replies" : ""} of each ${contract.parentKind === "videos" ? "video" : contract.parentKind === "posts" ? "post" : "item"}, and the plan has no comments stage. Do not drop a step the customer asked for. Add the comments stage (parent_key = the stage of the ${contract.parentKind ?? "items"}, deliver true) after sampling a comments source on one item of your first sample${list.length > 0 ? `; the catalog's comments sources for this platform: ${list.join(", ")}` : ""}. If no source can serve it, say so in unserved_steps with an honest reason instead`];
  if (verdict.overclaims.length > 0) lines.push(`summary_ar promises ${verdict.overclaims.join(" and ")} that no stage of the plan carries: say only what the stages deliver`);
  return lines;
}

export type GateOutcome = { kind: "send_back"; issues: string[] } | { kind: "accept"; added: string[]; verdict: ContractVerdict };
/**
 * THE FINAL GATE, called after the last pass of planning and before the plan is stored. A missing comments stage is sent back to the planner while the budget lasts; after that (and for everything the planner cannot fix: replies, conditions) the plan is repaired by code so
 * it states what it does not carry. Never returns an accept with something missing.
 */
export function gateContract(contract: RequestContract, plan: ContractPlan, sendBacksUsed: number, tools: { commentsTools?: string[] } = {}): GateOutcome {
  const verdict = checkPlanAgainstContract(contract, plan);
  const issues = contractSendBackIssues(verdict, contract, tools);
  if (issues.length > 0 && sendBacksUsed < CONTRACT_SEND_BACKS_MAX) return { kind: "send_back", issues };
  const { added } = repairPlanByContract(contract, plan);
  return { kind: "accept", added, verdict: checkPlanAgainstContract(contract, plan) };
}
