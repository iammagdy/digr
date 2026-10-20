import { formatAr, normalizeDigits, toArabicDigits } from "./arabicDigits";
import { detectSocialIntent, SOCIAL_PLATFORM_LABEL_AR, socialSubjectText, type SocialPlatformId } from "./socialTasks";
import { resolveTimeWindow, windowQuestion, type ResolvedWindow } from "./timeWindow";
import { extractRequestIntent, missingInputsForIntent, type RequestIntent } from "./requestIntent";
import { CLARIFICATION_ANSWER_LABELS } from "./clarificationLabels";
import { channelKey, channelsCountAr, handlesInText, parseChannelAnswer } from "./channelNames";

/**
 * How the assistant talks: a data consultant, not a form.
 *   1. acknowledge the goal and say what was understood (platform, subject, volume, window, output) in one sentence;
 *   2. ask AT MOST ONE specific question, and only when something required is missing;
 *   3. never ask for what the customer already said, never repeat.
 * Everything here is decided by code from the customer's own words; no model call, no price, no provider name.
 */

export type MissionKind = "companies" | "people" | "social_ranked_comments" | "social_channel_topic" | "social_feed" | "social_comments_url" | "other";

export interface MissionUnderstanding {
  kind: MissionKind;
  platform: SocialPlatformId | null;
  /** The subject words, best effort, for display only. */
  subject: string | null;
  channels: { count: number | null; named: string[] };
  /** «أعلى ١٠ فيديوهات مشاهدة لكل قناة»: how many top videos per channel, and what they are ranked by. */
  topPerChannel: number | null;
  rankedBy: "views" | null;
  allComments: boolean;
  includeReplies: boolean;
  /** A count the customer stated for the records themselves (posts, comments, companies). */
  volume: number | null;
  window: ResolvedWindow;
  /** An open-ended volume («كل التعليقات») must always carry a customer cap on the plan. */
  needsCap: boolean;
  /** What is still missing, in the order they are asked; the first is the ONE question. */
  missing: MissingInput[];
  /** The customer skipped the channels of a mission: the videos are found by a topic instead, and the plan says so. */
  channelsSkipped: boolean;
}

export type MissingInput =
  | "platform"
  | "subject"
  | "channels"
  | "window"
  | "country"
  | "industry"
  | "roles"
  | "goal"
  | "cap"
  | "count";

const CHANNEL_WORD = "(?:قنوات|قناة|قناه|حسابات|حساب|صفحات|صفحة)";
const COUNT = "([0-9]+)";

function digits(text: string): string {
  // «37,500» and «٣٧٬٥٠٠» are one number; the brackets of an unedited template default («[١٠]») are not part of the request.
  return normalizeDigits(text).replace(/(\d)[,٬،.](?=\d{3}(?!\d))/g, "$1").replace(/[\[\]【】]/g, " ");
}

const NUMBER_WORDS: Record<string, number> = { خمس: 5, خمسة: 5, ست: 6, ستة: 6, سبع: 7, سبعة: 7, ثمان: 8, ثمانية: 8, تسع: 9, تسعة: 9, عشر: 10, عشرة: 10, ثلاث: 3, ثلاثة: 3, اربع: 4, أربع: 4, اربعة: 4, أربعة: 4 };

function channelCount(text: string): number | null {
  const m = new RegExp(`${COUNT}\\s*${CHANNEL_WORD}`).exec(text);
  if (m) return Number(m[1]);
  const word = new RegExp(`(${Object.keys(NUMBER_WORDS).join("|")})\\s*${CHANNEL_WORD}`).exec(text);
  return word ? NUMBER_WORDS[word[1]] : null;
}

const CHANNEL_NAME_STOP = new Set(["على", "في", "عن", "اللي", "و", "مع", "من", "ال", "يوتيوب", "اليوتيوب", "فيسبوك", "تيك", "توك", "كل", "بتاعة", "بتاعت"]);

const CHANNEL_ANSWER_LABEL = CLARIFICATION_ANSWER_LABELS.social_channel_required;
const ANY_ANSWER_LABEL_RE = `(?:${Array.from(new Set([...Object.values(CLARIFICATION_ANSWER_LABELS), "إجابة هدف التواصل"])).join("|")})`;
/** Closes an answer typed or tapped for one of our questions, so a later message of the customer is never read as part of it. */
export const ANSWER_END = "\u2063";
const CHANNEL_ANSWER_RE = new RegExp(`${CHANNEL_ANSWER_LABEL}\\s*:\\s*([\\s\\S]*?)(?=${ANSWER_END}|\\s${ANY_ANSWER_LABEL_RE}\\s*:|$)`, "gu");

/** The channels the customer named, in any form: an answer to the channel question (names, handles with or without «@», links), handles and links anywhere, «قناة X». */
function namedChannels(text: string): string[] {
  const out: string[] = [];
  const add = (name: string) => {
    const key = channelKey(name);
    if (key && !out.some((existing) => channelKey(existing) === key)) out.push(name);
  };
  for (const m of text.matchAll(CHANNEL_ANSWER_RE)) for (const name of parseChannelAnswer(m[1])) add(name);
  for (const handle of handlesInText(text)) add(handle);
  const m = /(?:قناة|قناه|صفحة)\s+((?:[\p{L}\p{N}_.]+\s?){1,3})/u.exec(text.replace(CHANNEL_ANSWER_RE, " "));
  if (m) {
    const words = m[1].trim().split(/\s+/);
    const kept: string[] = [];
    for (const w of words) {
      if (CHANNEL_NAME_STOP.has(w)) break;
      kept.push(w);
    }
    if (kept.length && !/^\d+$/.test(kept[0])) add(kept.join(" "));
  }
  return out;
}

const CAP_ANSWER_RE = new RegExp(`${CLARIFICATION_ANSWER_LABELS.volume_cap_required}\\s*:\\s*(\\d{1,8})`, "u");

/** What a skipped channel question leaves in the text a routing decision reads (a word that is never a subject). */
export const CHANNELS_SKIPPED_VALUE = "تخطي";
const CHANNELS_SKIPPED_RE = new RegExp(`${CLARIFICATION_ANSWER_LABELS.social_channel_required}\\s*:\\s*${CHANNELS_SKIPPED_VALUE}(?![\\p{L}])`, "u");

function topPerChannel(text: string): { top: number | null; rankedBy: "views" | null } {
  const m = /(?:اعلي|اعلى|أعلى|اكتر|أكتر|اكثر|أكثر|اعلا|توب|top)\s*(\d+)\s*(?:فيديو|فيديوهات|مقطع|مقاطع|بوست|منشور)/iu.exec(text)
    || /(?:ال)?(\d+)\s*(?:فيديو|فيديوهات|مقطع|مقاطع)\s*(?:ال)?(?:اكتر|أكتر|اكثر|أكثر|اعلي|اعلى|أعلى)/iu.exec(text);
  const views = /مشاهد[ةه]|مشاهدات|views/iu.test(text);
  return { top: m ? Number(m[1]) : null, rankedBy: m && views ? "views" : views && /(?:اكتر|أكتر|اكثر|أكثر|اعلي|أعلى|اعلى)/u.test(text) ? "views" : null };
}

const ALL_COMMENTS_RE = /كل\s*(?:ال)?(?:تعليقات|كومنتات|كومنتس|كومينتات)|(?:التعليقات|الكومنتات)\s*كلها|جميع\s*(?:ال)?(?:تعليقات|كومنتات)|all\s+comments/iu;
const ALL_ITEMS_RE = /كل\s*(?:ال)?(?:منشورات|بوستات|تغريدات|فيديوهات|مقاطع)|جميع\s*(?:ال)?(?:منشورات|بوستات|تغريدات|فيديوهات|مقاطع)/u;
const REPLIES_RE = /ردود|replies|وردود/iu;

const SUBJECT_STOP = new Set([
  "في", "من", "على", "علي", "مع", "خلال", "آخر", "اخر", "لحد", "حتى", "الى", "إلى", "بين", "لمدة",
  // the next request words end the subject («… منتخب مصر كل تعليقات ٣ فيديوهات»): they are never part of it
  "كل", "جميع", "تعليقات", "تعليق", "كومنتات", "فيديوهات", "فيديو", "منشورات", "بوستات", "تغريدات", "ورابط", "ورابطه",
]);

/** «عن ماتش مصر والمغرب في …»: the phrase after «عن», cut at the first period/place/platform word. */
function subjectAfterAbout(text: string): string {
  const m = /(?:^|\s)(?:عن|حول|بخصوص)\s+(.+)/u.exec(text);
  if (!m) return "";
  const kept: string[] = [];
  for (const word of m[1].trim().split(/\s+/)) {
    if (SUBJECT_STOP.has(word) || /^\d/.test(word)) break;
    kept.push(word);
    if (kept.length >= 8) break;
  }
  return kept.join(" ");
}

export function understandMission(rawText: string, options: { today?: Date } = {}): MissionUnderstanding {
  const text = digits(rawText || "");
  const social = detectSocialIntent(text);
  const intent: RequestIntent = extractRequestIntent(text);
  const channels = { count: channelCount(text), named: namedChannels(text) };
  const channelsSkipped = channels.named.length === 0 && CHANNELS_SKIPPED_RE.test(text);
  const { top, rankedBy } = topPerChannel(text);
  const allComments = ALL_COMMENTS_RE.test(text);
  const allItems = ALL_ITEMS_RE.test(text);
  const includeReplies = REPLIES_RE.test(text);

  const isDirectory = intent.dataType === "companies" || intent.dataType === "people";
  const channelMode = Boolean(channels.count || channels.named.length || social.discover === "channel" || social.channelRef);
  const hasContentWords = social.task !== null || /منشور|بوست|بوستات|تغريد|فيديو|فيديوهات|تعليق|تعليقات|كومنت/iu.test(text);
  const platform = social.platform;

  let kind: MissionKind = "other";
  if (intent.dataType === "companies") kind = "companies";
  else if (intent.dataType === "people") kind = "people";
  else if (social.targetUrl) kind = "social_comments_url";
  else if (channelMode && (top !== null || rankedBy) && (social.wantsComments || allComments)) kind = "social_ranked_comments";
  else if (channelMode && (social.wantsComments || allComments)) kind = "social_channel_topic";
  else if (hasContentWords) kind = "social_feed";

  // The count of the records themselves: never a number that means channels or top-N.
  let volume: number | null = null;
  if (!isDirectory) {
    let stripped = text;
    if (channels.count) stripped = stripped.replace(new RegExp(`${COUNT}\\s*${CHANNEL_WORD}`), " ");
    if (top !== null) stripped = stripped.replace(/(?:اعلي|اعلى|أعلى|اكتر|أكتر|اكثر|أكثر|اعلا|توب|top)?\s*\d+\s*(?:فيديو|فيديوهات|مقطع|مقاطع)/iu, " ");
    const counted = /(\d{2,7})\s*(?:بوست|بوستات|منشور|منشورات|تغريد\S*|تعليق|تعليقات|كومنت\S*|ردود|سجل|سجلات|مشاركة)/iu.exec(stripped);
    // The answer to the cap question is stored as «الحد الأقصى المطلوب: N»; a bare number there is the cap too.
    const capAnswer = CAP_ANSWER_RE.exec(text);
    volume = capAnswer ? Number(capAnswer[1]) : counted ? Number(counted[1]) : null;
  } else {
    volume = intent.count;
  }

  const feedKind = kind === "social_feed" || kind === "social_channel_topic" || kind === "social_ranked_comments";
  // A named channel's own videos or posts are scoped by the channel (the latest N), not by a period.
  const needsWindow = feedKind && !social.wantsTrending && !social.targetUrl && !(kind === "social_feed" && channelMode);
  // Without channels the top videos are found by a topic: a search, which needs its period like any other.
  const window = resolveTimeWindow(text, { needsWindow, today: options.today, rankingRequest: kind === "social_ranked_comments" && !channelsSkipped });

  const topicAnswer = channelsSkipped ? topicAnswerFromText(text) : null;
  const subjectRaw = topicAnswer || (kind === "social_feed" || kind === "social_channel_topic" ? subjectAfterAbout(text) || socialSubjectText(text) : "");
  const subject = subjectRaw || (intent.industry?.arabic ?? null) || null;

  const missing: MissingInput[] = [];
  if (kind === "companies" || kind === "people") {
    for (const gap of missingInputsForIntent(intent, text)) {
      if (gap === "industry_or_company") missing.push("industry");
      else if (gap === "country" || gap === "industry" || gap === "roles" || gap === "count") missing.push(gap);
    }
  } else if (kind === "other" && !hasContentWords) {
    missing.push("goal");
  } else if (kind === "other" && !platform && hasContentWords) {
    missing.push("platform");
  } else if (feedKind || kind === "social_comments_url") {
    if (!platform) missing.push("platform");
    if (kind === "social_ranked_comments" && channelsSkipped) {
      if (!subject) missing.push("subject");
    } else if (kind === "social_ranked_comments" && channels.named.length === 0 && !(channels.count && social.discover === "channel" && social.channelRef)) missing.push("channels");
    if (kind === "social_channel_topic" && channels.named.length === 0 && !social.channelRef) missing.push("channels");
    if (kind === "social_feed" && !subject && !channelMode) missing.push("subject");
    // «كل التعليقات» or an unstated volume over channels always carries a cap the customer chooses.
    if ((kind === "social_ranked_comments" || kind === "social_channel_topic") && volume === null) missing.push("cap");
    else if ((kind === "social_feed" || kind === "social_comments_url") && (allComments || allItems) && volume === null) missing.push("cap");
    if (window.status === "missing") missing.push("window");
  }

  return {
    kind,
    platform,
    subject: subject || null,
    channels,
    topPerChannel: top,
    rankedBy,
    allComments,
    includeReplies,
    volume,
    window,
    needsCap: allComments || allItems || (feedKind && volume === null && kind !== "social_feed"),
    missing,
    channelsSkipped,
  };
}

/* ---------------------------------------------------------------- the reply */

export type NextStep =
  | { type: "plan" }
  | { type: "ask_one"; id: string; textAr: string; options?: string[] };

const QUESTION_BY_MISSING: Record<MissingInput, { id: string; textAr: string; options?: string[] }> = {
  platform: { id: "social_platform_required", textAr: "على أي منصة تريد البحث؟", options: ["تيك توك", "يوتيوب", "إنستغرام", "أخرى"] },
  subject: { id: "social_topic_required", textAr: "ما الموضوع أو الكلمات التي تريد البحث عنها؟" },
  channels: { id: "social_channel_required", textAr: "ما أسماء القنوات أو روابطها؟" },
  window: { id: "social_time_required", textAr: windowQuestion().text, options: [...windowQuestion().options] },
  country: { id: "company_country_required", textAr: "في أي دولة تريد البحث؟" },
  industry: { id: "company_industry_required", textAr: "ما المجال أو القطاع المطلوب؟" },
  goal: { id: "goal_required", textAr: "ما نوع البيانات التي تريد جمعها؟", options: ["بيانات منصات اجتماعية", "شركات", "صناع قرار"] },
  cap: { id: "volume_cap_required", textAr: "ما الحد الأقصى لعدد التعليقات الذي تريده؟", options: ["٥٠٠ تعليق", "١٠٠٠ تعليق", "٢٠٠٠ تعليق", "٥٠٠٠ تعليق"] },
  roles: { id: "people_roles_required", textAr: "ما المسميات الوظيفية التي تريدها؟" },
  count: { id: "company_count_required", textAr: "كم سجلًا تريد في النتائج؟" },
};

/** The question that asks for the channels of a mission, and the different one asked when the customer skipped it. */
export const CHANNEL_QUESTION_AR = QUESTION_BY_MISSING.channels.textAr;
export const TOPIC_INSTEAD_OF_CHANNELS_QUESTION_AR = "ما موضوع الفيديوهات التي تريد تعليقاتها؟ سأبحث عن أعلاها مشاهدة بدل القنوات.";
export const TOPIC_INSTEAD_OF_CHANNELS_ID = "social_topic_required";

/**
 * The label of the stored answer a plain typed message gives, when the assistant's last message asked one of the questions below.
 * A message typed instead of tapping the card is read exactly like the card's answer.
 */
export function typedAnswerLabelFor(assistantText: string): string | null {
  const text = String(assistantText || "");
  if (text.includes(TOPIC_INSTEAD_OF_CHANNELS_QUESTION_AR)) return CLARIFICATION_ANSWER_LABELS.social_topic_required;
  if (text.includes(CHANNEL_QUESTION_AR)) return CLARIFICATION_ANSWER_LABELS.social_channel_required;
  return null;
}

/** The answer to the topic question asked instead of the channels, from the stored labelled text; null when there is none. */
export function topicAnswerFromText(text: string): string | null {
  const m = new RegExp(`${CLARIFICATION_ANSWER_LABELS.social_topic_required}\\s*:\\s*([\\s\\S]*?)(?=${ANSWER_END}|\\s${ANY_ANSWER_LABEL_RE}\\s*:|$)`, "u").exec(text || "");
  const topic = m?.[1]?.trim();
  return topic ? topic : null;
}

/** What the assistant does next: ask the ONE missing thing, or go to the plan. Never more than one question. */
export function nextStep(understanding: MissionUnderstanding, ignore?: ReadonlySet<string>): NextStep {
  // A question the customer skipped and that may be answered by a stated default (the period, the cap) is not asked again.
  const first = ignore && ignore.size > 0 ? understanding.missing.find((item) => !ignore.has(QUESTION_BY_MISSING[item].id)) : understanding.missing[0];
  if (!first) return { type: "plan" };
  const q = QUESTION_BY_MISSING[first];
  if (first === "subject" && understanding.channelsSkipped) return { type: "ask_one", id: TOPIC_INSTEAD_OF_CHANNELS_ID, textAr: TOPIC_INSTEAD_OF_CHANNELS_QUESTION_AR };
  // The cap is a count of what the customer asked for: comments, or records for anything else.
  if (first === "cap" && !(understanding.allComments || understanding.kind === "social_ranked_comments" || understanding.kind === "social_channel_topic" || understanding.kind === "social_comments_url")) {
    return { type: "ask_one", id: q.id, textAr: "ما الحد الأقصى لعدد السجلات الذي تريده؟", options: ["٥٠٠ سجل", "١٠٠٠ سجل", "٢٠٠٠ سجل", "٥٠٠٠ سجل"] };
  }
  return { type: "ask_one", ...q };
}

/** The cap question when «كل …» was asked without a number and nothing else stands before it; null otherwise. */
export function capQuestionFor(understanding: MissionUnderstanding) {
  if (!understanding.missing.includes("cap")) return null;
  const step = nextStep({ ...understanding, missing: ["cap"] });
  return step.type === "ask_one" ? questionForStep(step) : null;
}

const KIND_NOUN_AR: Record<string, string> = {
  comments: "التعليقات",
  posts: "المنشورات",
  videos: "الفيديوهات",
};

const num = (n: number) => toArabicDigits(n);

/** The same hedge the plan carries: the source may not return replies, and the customer is told so up front. */
export const REPLIES_HEDGE_AR = "إن أعادها المصدر";

/** One sentence: what the assistant understood, built from the structured understanding. Null when nothing useful was understood. */
export function understoodLineAr(u: MissionUnderstanding): string | null {
  const where = u.platform ? ` على ${SOCIAL_PLATFORM_LABEL_AR[u.platform]}` : "";
  const windowText = u.window.status === "resolved" && u.window.source !== "open_scope" ? `، ${u.window.labelAr}` : u.window.status === "resolved" ? "، على كل الفترة المتاحة" : "";
  const amount = (n: number, noun: string) => `${formatAr(n)} ${noun}`;
  switch (u.kind) {
    case "social_ranked_comments": {
      if (u.channelsSkipped) {
        const ranking = u.topPerChannel ? `أعلى ${num(u.topPerChannel)} فيديوهات${u.rankedBy === "views" ? " مشاهدة" : ""}` : "فيديوهات";
        const about = u.subject ? ` عن «${u.subject}»` : "";
        return `فهمت أنك تريد ${u.allComments ? "كل تعليقات" : "تعليقات"} ${ranking}${about}${where}، بلا قنوات محددة${windowText}.`;
      }
      // What the customer named is what the plan covers; the count in the template only counts when no name was given.
      const named = u.channels.named;
      const channelsText = named.length > 1 ? (named.length <= 3 ? `القنوات ${named.join(" و")}` : channelsCountAr(named.length)) : named.length ? `قناة ${named[0]}` : u.channels.count ? channelsCountAr(u.channels.count) : "عدة قنوات";
      const ranking = u.topPerChannel ? `أعلى ${num(u.topPerChannel)} فيديوهات${u.rankedBy === "views" ? " مشاهدة" : ""} لكل قناة` : "فيديوهات القنوات";
      return `فهمت أنك تريد ${u.allComments ? "كل تعليقات" : "تعليقات"} ${ranking} من ${channelsText}${where}، مع رابط كل فيديو${windowText}.`;
    }
    case "social_channel_topic": {
      const channel = u.channels.named[0] ? `قناة ${u.channels.named[0]}` : "القناة";
      const about = u.subject ? ` عن «${u.subject}»` : "";
      return `فهمت أنك تريد فيديوهات ${channel}${about}${u.allComments ? " مع كل تعليقاتها" : " مع تعليقاتها"}${where}${windowText}.`;
    }
    case "social_feed": {
      const about = u.subject ? ` عن «${u.subject}»` : "";
      // The replies come only if the source returns them: the sentence says so, as the plan does.
      const what = u.volume
        ? `حتى ${amount(u.volume, u.includeReplies ? `منشور مع ردودها ${REPLIES_HEDGE_AR}` : "سجل")}`
        : u.includeReplies ? `المنشورات مع ردودها ${REPLIES_HEDGE_AR}` : "المحتوى";
      return `فهمت أنك تريد ${what}${about}${where}${windowText}.`;
    }
    case "social_comments_url":
      return `فهمت أنك تريد تعليقات الرابط الذي أرسلته${where}.`;
    case "companies":
      return u.subject ? `فهمت أنك تريد ${u.volume ? `${num(u.volume)} شركة` : "شركات"} في مجال ${u.subject}.` : null;
    case "people":
      return `فهمت أنك تريد ${u.volume ? `${num(u.volume)} من ` : "بيانات "}صناع القرار${u.subject ? ` في مجال ${u.subject}` : ""}.`;
    default:
      return null;
  }
}

/**
 * The plan lines about the channels of a mission when what was planned differs from what the template asked: fewer channels than it
 * said, more than one job holds, a lower top-per-channel, or the videos found by a topic because no channel was given.
 */
export function missionCoverageLinesAr(u: MissionUnderstanding, planned: { channels: string[]; topPerChannel?: number | null; maxChannels: number }): string[] {
  const lines: string[] = [];
  if (u.kind !== "social_ranked_comments" && u.kind !== "social_channel_topic") return lines;
  if (u.channelsSkipped) {
    if (u.subject) lines.push(`القنوات: لم تحدد قنوات، فأبحث عن أعلى الفيديوهات مشاهدة عن «${u.subject}».`);
    return lines;
  }
  const given = u.channels.named.length;
  if (given > 0 && u.channels.count && given < u.channels.count) {
    lines.push(`القنوات: ذكرت ${channelsCountAr(given)} من ${channelsCountAr(u.channels.count)}، فجهزت الخطة على ما كتبته.`);
  }
  if (given > planned.maxChannels) {
    lines.push(`القنوات: كتبت ${channelsCountAr(given)}، واعتمدت أول ${channelsCountAr(planned.maxChannels)} لأن المهمة الواحدة لا تتسع لأكثر، ويمكنك تقديم طلب آخر لبقية القنوات.`);
  }
  if (u.topPerChannel && planned.topPerChannel && planned.topPerChannel < u.topPerChannel) {
    lines.push(`الفيديوهات: خفّضت أعلى ${num(u.topPerChannel)} فيديوهات لكل قناة إلى ${num(planned.topPerChannel)} حتى لا تتجاوز المهمة الواحدة حدّ الفيديوهات.`);
  }
  return lines;
}

const WHY_AR: Record<string, string> = {
  social_time_required: "ولم تذكر فترة زمنية، وكلما طالت الفترة زاد حجم البيانات وقد يصل إلى أعداد كبيرة جدًا، لذلك يفضّل تحديد سقف للنقاط في الخطة.",
  social_platform_required: "وأحتاج أن أعرف المنصة أولًا.",
  social_topic_required: "وأحتاج أن أعرف الموضوع أو الكلمات المقصودة.",
  social_channel_required: "وأحتاج أن أعرف القنوات المقصودة.",
  company_country_required: "وأحتاج أن أعرف الدولة حتى لا أفترضها.",
  company_industry_required: "وأحتاج أن أعرف المجال حتى تأتي النتائج مطابقة.",
  goal_required: "وأحتاج أن أعرف نوع البيانات لأبدأ.",
  volume_cap_required: "وطلب كل التعليقات يحتاج حدًا أقصى حتى لا يكبر السعر دون سقف.",
  people_roles_required: "وأحتاج أن أعرف المسميات الوظيفية المقصودة.",
  company_count_required: "وأحتاج أن أعرف العدد المطلوب.",
};

/** Generic lead when nothing about the request could be restated. */
export const GENERIC_ASK_ONE_INTRO_AR = "فهمت أنك تريد جمع بيانات، وسؤال واحد يكفي لأجهز لك الخطة.";

/**
 * The text that introduces the ONE question: what was understood, then why this question. At most two short sentences.
 * Never a list, never a repeat of what the customer already said as a question.
 */
export function consultantIntroAr(rawText: string, questionId?: string, options: { today?: Date } = {}): string {
  const understanding = understandMission(rawText, options);
  const line = understoodLineAr(understanding);
  let why = questionId ? WHY_AR[questionId] : undefined;
  // «all posts» is not «all comments»: the cap sentence names what is collected.
  if (why && questionId === "volume_cap_required" && understanding.kind === "social_feed" && !/تعليق|كومنت|كومينت/.test(rawText)) {
    why = why.replace("كل التعليقات", "كل المنشورات");
  }
  if (line && why) return `${line} ${why}`;
  if (line) return line;
  if (why) return `سأجهز لك الخطة، ${why.replace(/^و/u, "لكن ")}`;
  return GENERIC_ASK_ONE_INTRO_AR;
}

/**
 * An intro that reads like a form: it ends in a colon that introduces a list of questions, or uses the stock phrases
 * («محتاج أعرف», «جاوبني على الأسئلة دي», «أحتاج أعدّل الخطة، لحظة»). The model sometimes produces them; the customer never sees them.
 */
export function isFormStyleIntro(text: string): boolean {
  const body = String(text || "").trim();
  if (!body) return true;
  return /[:：]\s*$/.test(body) || /محتاج أعرف|جاوبني على الأسئلة|أحتاج أعدّل الخطة|لحظة\.?\s*$/u.test(body);
}

/** The only line the chat shows when a plan is ready: the plan itself lives in the results panel. */
// In the RTL page the chat is the first column (right) and the plan panel the second (left); on a phone the panel is a bottom sheet.
export const PLAN_READY_DESKTOP_AR = "جهزت لك الخطة، راجعها على اليسار.";
export const PLAN_READY_MOBILE_AR = "جهزت لك الخطة، راجعها في النافذة التي ظهرت من الأسفل.";

/** The clarification question object the chat renders for a next step (one question, tappable options where it is a choice). */
export function questionForStep(step: Extract<NextStep, { type: "ask_one" }>) {
  return {
    id: step.id,
    text: step.textAr,
    question: step.textAr,
    type: step.options?.length ? "single" : "free",
    options: step.options ?? [],
    allowOther: true,
  };
}
