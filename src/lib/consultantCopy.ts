import { formatAr, normalizeDigits, toArabicDigits } from "./arabicDigits";
import { detectSocialIntent, SOCIAL_PLATFORM_LABEL_AR, socialSubjectText, type SocialPlatformId } from "./socialTasks";
import { resolveTimeWindow, windowQuestion, type ResolvedWindow } from "./timeWindow";
import { extractRequestIntent, missingInputsForIntent, type RequestIntent } from "./requestIntent";

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
  | "count";

const CHANNEL_WORD = "(?:قنوات|قناة|قناه|حسابات|حساب|صفحات|صفحة)";
const COUNT = "([0-9]+)";

function digits(text: string): string {
  // «37,500» and «٣٧٬٥٠٠» are one number
  return normalizeDigits(text).replace(/(\d)[,٬،.](?=\d{3}(?!\d))/g, "$1");
}

const NUMBER_WORDS: Record<string, number> = { خمس: 5, خمسة: 5, ست: 6, ستة: 6, سبع: 7, سبعة: 7, ثمان: 8, ثمانية: 8, تسع: 9, تسعة: 9, عشر: 10, عشرة: 10, ثلاث: 3, ثلاثة: 3, اربع: 4, أربع: 4, اربعة: 4, أربعة: 4 };

function channelCount(text: string): number | null {
  const m = new RegExp(`${COUNT}\\s*${CHANNEL_WORD}`).exec(text);
  if (m) return Number(m[1]);
  const word = new RegExp(`(${Object.keys(NUMBER_WORDS).join("|")})\\s*${CHANNEL_WORD}`).exec(text);
  return word ? NUMBER_WORDS[word[1]] : null;
}

const CHANNEL_NAME_STOP = new Set(["على", "في", "عن", "اللي", "و", "مع", "من", "ال", "يوتيوب", "اليوتيوب", "فيسبوك", "تيك", "توك", "كل", "بتاعة", "بتاعت"]);

function namedChannels(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@([\w.]{2,30})/gu)) out.push(`@${m[1]}`);
  const m = /(?:قناة|قناه|صفحة)\s+((?:[\p{L}\p{N}_.]+\s?){1,3})/u.exec(text);
  if (m) {
    const words = m[1].trim().split(/\s+/);
    const kept: string[] = [];
    for (const w of words) {
      if (CHANNEL_NAME_STOP.has(w)) break;
      kept.push(w);
    }
    if (kept.length && !/^\d+$/.test(kept[0])) out.push(kept.join(" "));
  }
  return [...new Set(out)];
}

function topPerChannel(text: string): { top: number | null; rankedBy: "views" | null } {
  const m = /(?:اعلي|اعلى|أعلى|اكتر|أكتر|اكثر|أكثر|اعلا|توب|top)\s*(\d+)\s*(?:فيديو|فيديوهات|مقطع|مقاطع|بوست|منشور)/iu.exec(text)
    || /(?:ال)?(\d+)\s*(?:فيديو|فيديوهات|مقطع|مقاطع)\s*(?:ال)?(?:اكتر|أكتر|اكثر|أكثر|اعلي|اعلى|أعلى)/iu.exec(text);
  const views = /مشاهد[ةه]|مشاهدات|views/iu.test(text);
  return { top: m ? Number(m[1]) : null, rankedBy: m && views ? "views" : views && /(?:اكتر|أكتر|اكثر|أكثر|اعلي|أعلى|اعلى)/u.test(text) ? "views" : null };
}

const ALL_COMMENTS_RE = /كل\s*(?:ال)?(?:تعليقات|كومنتات|كومنتس|كومينتات)|(?:التعليقات|الكومنتات)\s*كلها|جميع\s*(?:ال)?(?:تعليقات|كومنتات)|all\s+comments/iu;
const REPLIES_RE = /ردود|replies|وردود/iu;

const SUBJECT_STOP = new Set(["في", "من", "على", "علي", "مع", "خلال", "آخر", "اخر", "لحد", "حتى", "الى", "إلى", "بين", "لمدة"]);

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
  const { top, rankedBy } = topPerChannel(text);
  const allComments = ALL_COMMENTS_RE.test(text);
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
  else if (channelMode && (social.wantsComments || /فيديو|فيديوهات/u.test(text))) kind = "social_channel_topic";
  else if (hasContentWords) kind = "social_feed";

  // The count of the records themselves: never a number that means channels or top-N.
  let volume: number | null = null;
  if (!isDirectory) {
    let stripped = text;
    if (channels.count) stripped = stripped.replace(new RegExp(`${COUNT}\\s*${CHANNEL_WORD}`), " ");
    if (top !== null) stripped = stripped.replace(/(?:اعلي|اعلى|أعلى|اكتر|أكتر|اكثر|أكثر|اعلا|توب|top)?\s*\d+\s*(?:فيديو|فيديوهات|مقطع|مقاطع)/iu, " ");
    const counted = /(\d{2,7})\s*(?:بوست|بوستات|منشور|منشورات|تغريد\S*|تعليق|تعليقات|كومنت\S*|ردود|سجل|سجلات|مشاركة)/iu.exec(stripped);
    volume = counted ? Number(counted[1]) : null;
  } else {
    volume = intent.count;
  }

  const feedKind = kind === "social_feed" || kind === "social_channel_topic" || kind === "social_ranked_comments";
  const needsWindow = feedKind && !social.wantsTrending && !social.targetUrl;
  const window = resolveTimeWindow(text, { needsWindow, today: options.today, rankingRequest: kind === "social_ranked_comments" });

  const subjectRaw = kind === "social_feed" || kind === "social_channel_topic" ? subjectAfterAbout(text) || socialSubjectText(text) : "";
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
    if (kind === "social_ranked_comments" && channels.named.length === 0 && !(channels.count && social.discover === "channel" && social.channelRef)) missing.push("channels");
    if (kind === "social_channel_topic" && channels.named.length === 0 && !social.channelRef) missing.push("channels");
    if (kind === "social_feed" && !subject) missing.push("subject");
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
    needsCap: allComments || (feedKind && volume === null && kind !== "social_feed"),
    missing,
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
  roles: { id: "people_roles_required", textAr: "ما المسميات الوظيفية التي تريدها؟" },
  count: { id: "company_count_required", textAr: "كم سجلًا تريد في النتائج؟" },
};

/** What the assistant does next: ask the ONE missing thing, or go to the plan. Never more than one question. */
export function nextStep(understanding: MissionUnderstanding): NextStep {
  const first = understanding.missing[0];
  if (!first) return { type: "plan" };
  const q = QUESTION_BY_MISSING[first];
  return { type: "ask_one", ...q };
}

const KIND_NOUN_AR: Record<string, string> = {
  comments: "التعليقات",
  posts: "المنشورات",
  videos: "الفيديوهات",
};

const num = (n: number) => toArabicDigits(n);

/** One sentence: what the assistant understood, built from the structured understanding. Null when nothing useful was understood. */
export function understoodLineAr(u: MissionUnderstanding): string | null {
  const where = u.platform ? ` على ${SOCIAL_PLATFORM_LABEL_AR[u.platform]}` : "";
  const windowText = u.window.status === "resolved" && u.window.source !== "open_scope" ? `، ${u.window.labelAr}` : u.window.status === "resolved" ? "، على كل الفترة المتاحة" : "";
  const amount = (n: number, noun: string) => `${formatAr(n)} ${noun}`;
  switch (u.kind) {
    case "social_ranked_comments": {
      const channelsText = u.channels.count ? `${num(u.channels.count)} قنوات` : u.channels.named.length > 1 ? `القنوات ${u.channels.named.join(" و")}` : u.channels.named.length ? `قناة ${u.channels.named[0]}` : "عدة قنوات";
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
      const what = u.volume
        ? `حتى ${amount(u.volume, u.includeReplies ? "منشور مع ردودها" : "سجل")}`
        : u.includeReplies ? "المنشورات مع ردودها" : "المحتوى";
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

const WHY_AR: Record<string, string> = {
  social_time_required: "ولم تذكر فترة زمنية، وكلما طالت الفترة زاد حجم البيانات وقد يصل إلى أعداد كبيرة جدًا، لذلك يفضّل تحديد سقف للنقاط في الخطة.",
  social_platform_required: "وأحتاج أن أعرف المنصة أولًا.",
  social_topic_required: "وأحتاج أن أعرف الموضوع أو الكلمات المقصودة.",
  social_channel_required: "وأحتاج أن أعرف القنوات المقصودة.",
  company_country_required: "وأحتاج أن أعرف الدولة حتى لا أفترضها.",
  company_industry_required: "وأحتاج أن أعرف المجال حتى تأتي النتائج مطابقة.",
  goal_required: "وأحتاج أن أعرف نوع البيانات لأبدأ.",
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
  const why = questionId ? WHY_AR[questionId] : undefined;
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
