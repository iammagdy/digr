/**
 * Understands what a researcher wants from a social platform, in Egyptian and Gulf Arabic as well as
 * standard Arabic and English, and which inputs are still missing before a plan can be priced.
 *
 * Pure functions only: no network, no model. The model reads the same text, but the decisions that
 * cost money (which service, which inputs are required) are made here so they are identical on
 * every turn and can be tested.
 */
import { periodWordFlags } from "./timeWindow";


export type SocialPlatformId = "facebook" | "youtube" | "tiktok" | "instagram" | "x" | "reddit" | "linkedin";
export type SocialTask = "comments" | "trending" | "channel_videos" | "video_search" | "page_posts" | "x_posts";

export const SOCIAL_PLATFORM_LABEL_AR: Record<SocialPlatformId, string> = {
  facebook: "فيسبوك",
  youtube: "يوتيوب",
  tiktok: "تيك توك",
  instagram: "إنستغرام",
  x: "منصة إكس",
  reddit: "ريديت",
  linkedin: "لينكد إن",
};

const PLATFORM_RES: Array<[SocialPlatformId, RegExp]> = [
  ["tiktok", /تيك\s*توك|تك\s*توك|تيكتوك|tik\s*tok|tiktok/iu],
  ["youtube", /يوتيوب|يوتوب|اليوتيوب|youtube|youtu\.be|\bshorts?\b|شورتس/iu],
  ["facebook", /فيسبوك|فيس\s*بوك|الفيس(?![\p{L}])|فيس(?![\p{L}])|facebook|\bfb\b|fb\.watch/iu],
  ["instagram", /انستغرام|إنستغرام|انستجرام|إنستجرام|انستا(?![\p{L}])|instagram|\binsta\b/iu],
  ["x", /تويتر|تغريد|منصة\s*(?:x|إكس|اكس)|(?:على|علي|في|من)\s+(?:إكس|اكس)(?![\p{L}])|twitter|\bx\b|\bx\.com\b/iu],
  ["reddit", /ريديت|reddit/iu],
  ["linkedin", /لينكد\s*إن|لينكدإن|لينكدان|linkedin/iu],
];

const URL_HOST_PLATFORM: Array<[SocialPlatformId, RegExp]> = [
  ["tiktok", /(?:^|\.)tiktok\.com$/i],
  ["youtube", /(?:^|\.)(?:youtube\.com|youtu\.be)$/i],
  ["facebook", /(?:^|\.)(?:facebook\.com|fb\.com|fb\.watch)$/i],
  ["instagram", /(?:^|\.)instagram\.com$/i],
  ["x", /(?:^|\.)(?:x\.com|twitter\.com)$/i],
  ["reddit", /(?:^|\.)reddit\.com$/i],
  ["linkedin", /(?:^|\.)linkedin\.com$/i],
];

/** Comments, in every spelling customers use (كومنت، كومنتس، كومنتات، تعليقات، ردود الناس، آراء). */
export const COMMENT_WORDS_RE = /كومنت|كومينت|كمنت|تعليق|تعليقات|ردود\s*(?:الناس|المتابعين|الجمهور)?|آراء|اراء|ريفيو|reviews?|comments?/iu;
/** The same words without «ردود»: on X a reply is part of the posts collection, not a comments request (X has no comments service). */
const COMMENT_WORDS_NO_REPLIES_RE = /كومنت|كومينت|كمنت|تعليق|تعليقات|آراء|اراء|ريفيو|reviews?|comments?/iu;
/** «ردود / ردودها / replies»: the customer wants the replies to the posts as well. */
export const REPLY_WORDS_RE = /(?:^|[\s،,؛.])(?:و?ردود(?:ها|هم|ه)?|replies|reply)(?=$|[\s،,؛.])/iu;

export function wantsReplies(text: string): boolean {
  return REPLY_WORDS_RE.test(text || "");
}

/** Trending, in every spelling (ترند، تريند، تراند، ستراندنج، استراندنج، رائج، الأكثر مشاهدة). */
export const TREND_WORDS_RE = /ترند|تريند|تراند|ترندنج|تريندنج|تراندنج|ستراندنج|استراندنج|سترندنج|ستريندنج|رائج|الرائج|رايج|الأكثر\s*(?:مشاهدة|تفاعل|انتشار)|الاكثر\s*(?:مشاهدة|تفاعل|انتشار)|فيرال|viral|trending|trends?/iu;

const POST_WORDS_RE = /بوست|بوستات|منشور|منشورات|posts?/iu;
const X_POST_WORDS_RE = /تغريدة|تغريدات|تويتة|تويتات|تويت|tweets?/iu;
const VIDEO_WORDS_RE = /فيديو|فيديوهات|مقطع|مقاطع|ريلز|ريل|شورتس|videos?|reels?|shorts?/iu;
const CHANNEL_WORDS_RE = /قناة|قنوات|قناه|حساب|channel/iu;

export interface SocialUrl {
  platform: SocialPlatformId | null;
  url: string;
  host: string;
  /** What the link points to, as far as the link itself tells. */
  kind: "video" | "post" | "channel" | "unknown";
  /** Machine id carried by the link (video id, numeric aweme id, channel handle), when present. */
  id?: string;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/giu;

export function extractUrls(text: string): SocialUrl[] {
  const found: SocialUrl[] = [];
  for (const match of (text || "").matchAll(URL_RE)) {
    const raw = match[0].replace(/[.,،؛:!؟?]+$/u, "");
    let host = "";
    let path = "";
    try {
      const parsed = new URL(raw);
      host = parsed.hostname.toLowerCase();
      path = parsed.pathname + parsed.search;
    } catch {
      continue;
    }
    const platform = URL_HOST_PLATFORM.find(([, re]) => re.test(host))?.[0] ?? null;
    found.push({ platform, url: raw, host, ...classifyUrl(platform, host, path) });
  }
  return found;
}

function classifyUrl(platform: SocialPlatformId | null, host: string, path: string): Pick<SocialUrl, "kind" | "id"> {
  if (platform === "youtube") {
    const watch = /[?&]v=([\w-]{11})/.exec(path)?.[1];
    if (watch) return { kind: "video", id: watch };
    const short = /^\/(?:shorts\/|embed\/)?([\w-]{11})(?:[/?]|$)/.exec(path)?.[1];
    if ((host === "youtu.be" || /^\/(?:shorts|embed)\//.test(path)) && short) return { kind: "video", id: short };
    const handle = /^\/(@[\w.-]+|channel\/UC[\w-]{20,}|c\/[\w.-]+|user\/[\w.-]+)/.exec(path)?.[1];
    if (handle) return { kind: "channel", id: handle.replace(/^(?:channel|c|user)\//, "") };
  }
  if (platform === "tiktok") {
    const video = /\/video\/(\d{8,})/.exec(path)?.[1];
    if (video) return { kind: "video", id: video };
    if (/^vm\.|^vt\./.test(host)) return { kind: "video" };
    const handle = /^\/@([\w.]{2,30})\/?(?:\?|$)/.exec(path)?.[1];
    if (handle) return { kind: "channel", id: handle };
  }
  if (platform === "facebook") {
    if (/\/(?:posts|videos|reel|watch|permalink|photo|story)[/.?]|story_fbid=|[?&]v=\d+|\/share\/[pvr]\//.test(path)) return { kind: "post" };
    if (/^\/(?:[\w.-]{3,})\/?(?:\?|$)/.test(path)) return { kind: "channel" };
  }
  return { kind: "unknown" };
}

export interface SocialIntent {
  platform: SocialPlatformId | null;
  wantsComments: boolean;
  wantsTrending: boolean;
  /** A single post/video link the customer gave, when there is one. */
  targetUrl: SocialUrl | null;
  /** A channel/account the customer named by link or @handle. */
  channelRef: string | null;
  /** Task the customer is asking for, or null when the text is not a social-content request. */
  task: SocialTask | null;
  /** After the comments, the videos they come from are searched/ranked by this: trending feed, keyword, or a channel. */
  discover: "target" | "trending" | "keyword" | "channel" | null;
  /** True when the customer wants the posts/videos AND their comments together. */
  videosWithComments: boolean;
}

function detectPlatform(text: string, urls: SocialUrl[]): SocialPlatformId | null {
  const fromUrl = urls.find((u) => u.platform)?.platform;
  if (fromUrl) return fromUrl;
  const hits = PLATFORM_RES.filter(([, re]) => re.test(text)).map(([id]) => id);
  return hits.length === 1 ? hits[0] : hits[0] ?? null;
}

function detectChannelRef(text: string, urls: SocialUrl[]): string | null {
  const channelUrl = urls.find((u) => u.kind === "channel");
  if (channelUrl) return channelUrl.url;
  const handle = /(?:^|[\s(])@([\w.]{2,30})/u.exec(text)?.[1];
  return handle ? `@${handle}` : null;
}

export function detectSocialIntent(text: string): SocialIntent {
  const body = text || "";
  const urls = extractUrls(body);
  const platform = detectPlatform(body, urls);
  // On X, «posts and their replies» is one posts collection; only the other comment words make it a comments request.
  const wantsComments = (platform === "x" ? COMMENT_WORDS_NO_REPLIES_RE : COMMENT_WORDS_RE).test(body);
  const wantsTrending = TREND_WORDS_RE.test(body);
  const wantsPosts = POST_WORDS_RE.test(body);
  const wantsXTweets = platform === "x" && (X_POST_WORDS_RE.test(body) || POST_WORDS_RE.test(body));
  const wantsVideos = VIDEO_WORDS_RE.test(body);
  const wantsChannel = CHANNEL_WORDS_RE.test(body);
  const targetUrl = urls.find((u) => u.kind === "video" || u.kind === "post") ?? null;
  const channelRef = detectChannelRef(body, urls);

  let task: SocialTask | null = null;
  let discover: SocialIntent["discover"] = null;
  let videosWithComments = false;

  if (wantsComments && wantsTrending) {
    task = "comments";
    discover = "trending";
    videosWithComments = true;
  } else if (wantsComments && targetUrl) {
    task = "comments";
    discover = "target";
  } else if (wantsComments && channelRef && !targetUrl && (wantsVideos || wantsPosts)) {
    task = "comments";
    discover = "channel";
    videosWithComments = true;
  } else if (wantsComments) {
    task = "comments";
    discover = "keyword";
    videosWithComments = wantsVideos || wantsPosts;
  } else if (wantsTrending) {
    task = "trending";
    discover = "trending";
  } else if ((channelRef || wantsChannel) && (wantsVideos || wantsPosts || wantsXTweets)) {
    task = wantsPosts && platform === "facebook" ? "page_posts" : wantsXTweets ? "x_posts" : "channel_videos";
    discover = "channel";
  } else if (wantsVideos && platform) {
    task = "video_search";
    discover = "keyword";
  } else if (wantsXTweets) {
    task = "x_posts";
    discover = "keyword";
  } else if (wantsPosts && platform === "facebook") {
    task = "page_posts";
    discover = channelRef ? "channel" : "keyword";
  }

  return { platform, wantsComments, wantsTrending, targetUrl, channelRef, task, discover, videosWithComments };
}

/** English phrase the live catalog's search understands for this request. */
export function socialCatalogQuery(intent: SocialIntent): string | null {
  if (!intent.task) return null;
  const p = intent.platform;
  if (!p) return null;
  const base: Record<SocialTask, string> = {
    comments: p === "youtube" ? "youtube video comments" : p === "tiktok" ? "tiktok video comments" : `${p} post comments`,
    trending: p === "youtube" ? "youtube trending shorts" : p === "tiktok" ? "tiktok trending feed" : `${p} trending`,
    channel_videos: p === "youtube" ? "youtube channel videos" : "tiktok user videos",
    video_search: p === "youtube" ? "youtube search videos" : "tiktok search videos",
    page_posts: intent.discover === "channel" ? `${p} user posts` : `${p} posts`,
    x_posts: intent.discover === "channel" ? "X user posts by handle" : "X posts search by keyword",
  };
  return base[intent.task];
}

export type MissingSocialTaskInput =
  | "social_comment_target_required"
  | "social_trending_region_required"
  | "social_trending_platform_required"
  | "social_channel_required"
  | "social_x_topic_required"
  | "social_x_account_required";

/** Ids of the questions built here: their own options are final and are never replaced by a generic option bank. */
export const SOCIAL_TASK_QUESTION_IDS: ReadonlySet<string> = new Set<MissingSocialTaskInput>([
  "social_comment_target_required",
  "social_trending_region_required",
  "social_trending_platform_required",
  "social_channel_required",
  "social_x_topic_required",
  "social_x_account_required",
]);

/** Platforms the verified services can serve for each task. */
export const SOCIAL_TASK_PLATFORMS: Record<SocialTask, SocialPlatformId[]> = {
  comments: ["facebook", "youtube", "tiktok"],
  trending: ["youtube", "tiktok"],
  channel_videos: ["youtube", "tiktok"],
  video_search: ["youtube", "tiktok"],
  page_posts: ["facebook"],
  x_posts: ["x"],
};

const REGION_HINT_RE = /(?:مصر|المصر|السعود|الإمارات|الامارات|الكويت|قطر|البحرين|عمان|الأردن|الاردن|لبنان|العراق|المغرب|الجزائر|تونس|ليبيا|السودان|اليمن|سوريا|فلسطين|تركيا|ألمانيا|المانيا|فرنسا|بريطانيا|المملكة المتحدة|أمريكا|امريكا|الولايات المتحدة|إيطاليا|ايطاليا|إسبانيا|اسبانيا|الهند|باكستان|اندونيسيا|إندونيسيا|البرازيل|كندا|استراليا|أستراليا|اليابان|كوريا|الصين|روسيا|egypt|saudi|uae|emirates|kuwait|qatar|bahrain|oman|jordan|lebanon|iraq|morocco|algeria|tunisia|turkey|germany|france|\buk\b|britain|\busa?\b|america|india|brazil|canada|australia|japan|korea|china|russia|italy|spain|worldwide|global|عالمي|العالم)/iu;

export function hasRegionHint(text: string): boolean {
  return REGION_HINT_RE.test(text || "");
}

/** Words that add nothing to a topic: request verbs, platform names, quantities and the task words themselves. */
const TOPIC_NOISE = new Set([
  "عايز", "عايزه", "عايزة", "عاوز", "عاوزه", "اريد", "أريد", "محتاج", "محتاجة", "ابغى", "أبغى", "هات", "هاتلي", "اسحب", "سحب", "استخرج", "جمع", "اجمع", "ابحث", "لي", "لى", "ليا", "لنا",
  "من", "على", "علي", "في", "فى", "داخل", "عن", "حول", "الى", "إلى", "مع", "و", "او", "أو", "ال", "كل", "بعض", "ده", "دي", "دا", "هذا", "هذه", "اللي", "الي", "التي", "الذي",
  // Labels of stored card answers and placeholder words: never a topic.
  "موضوع", "البحث", "المطلوب", "المطلوبه", "مصدر", "القنوات", "الحد", "الأقصى", "الاقصى", "أقصى", "اقصى", "الإجابة", "الاجابة", "إجابة", "اجابة",
  "ردود", "وردود", "ردودها", "وردودها", "ردودهم", "وردودهم", "ردوده", "replies", "reply",
  "فيديو", "فيديوهات", "مقطع", "مقاطع", "بوست", "بوستات", "منشور", "منشورات", "تغريدة", "تغريدات", "تويت", "تويتة", "تويتات", "tweets", "tweet", "كومنت", "كومنتس", "كومنتات", "تعليق", "تعليقات", "ترند", "تريند", "تراند", "الترند", "التريند",
  "ستراندنج", "الستراندنج", "استراندنج", "الاستراندنج", "ترندنج", "الترندنج", "رائج", "الرائج", "الاكثر", "الأكثر", "مشاهدة", "تفاعل", "انتشار", "فيرال",
  "تيك", "توك", "تيكتوك", "يوتيوب", "يوتوب", "فيسبوك", "فيس", "انستغرام", "إنستغرام", "انستا", "تويتر", "إكس", "اكس", "ريديت", "لينكد", "منصة", "منصه",
  "قناة", "حساب", "صفحة", "رابط", "ريلز", "شورتس", "الفيس", "اليوم", "النهاردة", "حاليا", "حالياً", "دلوقتي", "الان", "الآن", "اخر", "آخر", "جديد",
  "عدد", "كام", "كم", "رقم", "حوالي", "تقريبا", "تقريباً", "لكل", "ولكل", "بتاع", "بتاعت", "بتاعه", "خاص", "خاصة", "الخاصة", "الخاص", "مع",
  // Discovery answers are merged with the original request. Time-window labels must not leak into
  // the provider topic (for example: "كرة السلة الفترة المطلوبة شهر").
  "فترة", "الفترة", "زمنية", "الزمنية", "مطلوبة", "المطلوبة", "اسبوع", "أسبوع", "الشهر", "شهر", "اشهر", "أشهر", "سنة", "سنوات",
  "خلال", "منذ", "الماضي", "الماضية", "الماضيه", "السابق", "السابقة", "يوم", "ايام", "أيام", "يومين", "اسبوعين", "أسبوعين", "شهرين", "الاسبوع", "الأسبوع", "العام", "عام", "السنة", "الاخيرة", "الأخيرة", "الاخير", "الأخير",
  "week", "month", "months", "year", "years", "period", "timeframe",
  "tiktok", "youtube", "facebook", "instagram", "twitter", "videos", "video", "posts", "post", "comments", "comment", "trending", "trend", "viral", "get", "me", "the", "of", "on", "from", "about", "for", "with", "and", "a", "an", "i", "want", "need",
]);

/** Words that make the country after them a LOCATION («في مصر», «من مصر», «داخل مصر», «بمصر»), not part of the topic. */
const LOCATION_PREPOSITIONS = new Set(["في", "فى", "من", "داخل"]);

interface AnalyzedToken { token: string; location: boolean }

/**
 * The words of a request, each marked as a location or not. A country is a location only when the customer says so with a
 * preposition («في مصر»); a country that is part of the topic («مباراة مصر والمغرب», «الأهلي والزمالك») is an entity and stays in it.
 * A second country joined with «و» right after a location («في مصر والسعودية») is a location too.
 */
function analyzeTokens(text: string): AnalyzedToken[] {
  const tokens = (text || "")
    .replace(URL_RE, " ")
    .toLowerCase()
    .replace(/[0-9٠-٩۰-۹]+/g, " ")
    .replace(/[^\p{L}\p{N}#@_]+/gu, " ")
    .split(/\s+/);
  const out: AnalyzedToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let location = false;
    if (token && REGION_HINT_RE.test(token)) {
      const previous = tokens[i - 1] || "";
      const previousLocation = i > 0 && out[i - 1]?.location === true;
      location =
        LOCATION_PREPOSITIONS.has(previous) ||
        (token.length > 2 && token.startsWith("ب") && REGION_HINT_RE.test(token.slice(1)) && !REGION_HINT_RE.test(token.slice(0, 1))) ||
        (previousLocation && token.startsWith("و"));
    }
    out.push({ token, location });
  }
  return out;
}

function topicTokens(text: string): string[] {
  const periodFlags = periodWordFlags((text || "").replace(URL_RE, " ").toLowerCase().replace(/[0-9٠-٩۰-۹]+/g, " ").replace(/[^\p{L}\p{N}#@_]+/gu, " ").split(/\s+/));
  return analyzeTokens(text)
    .filter(({ token, location }, index) => {
      if (!token) return false;
      if (periodFlags[index]) return false;
      const bare = token.replace(/^ال/u, "");
      if (bare.length < 2) return false;
      if (TOPIC_NOISE.has(token) || TOPIC_NOISE.has(bare)) return false;
      // A location is a filter, not a topic word; an entity that is a country stays in the topic.
      if (location) return false;
      return true;
    })
    .map(({ token }) => token);
}

/** The places the customer named as a location («في مصر», «من السعودية»): the only words a country filter may come from. */
export function socialLocationText(text: string): string {
  return analyzeTokens(text).filter((entry) => entry.location).map((entry) => entry.token).join(" ");
}

/** True when the text names a subject (a keyword, hashtag or name) beyond verbs, platform, region and task words. */
export function hasSocialSubject(text: string): boolean {
  if (/(?:^|\s)[#@][\p{L}\p{N}_]{2,}/u.test(text || "")) return true;
  return topicTokens(text).length >= 1;
}

/**
 * Inputs the customer must still give before a plan can be priced. One question at a time is asked
 * from this list by the discovery gate; the first entry is the one to ask.
 */
export function getMissingSocialTaskInputs(text: string): MissingSocialTaskInput[] {
  const intent = detectSocialIntent(text);
  if (!intent.task || !intent.platform) return [];
  const missing: MissingSocialTaskInput[] = [];

  if (!SOCIAL_TASK_PLATFORMS[intent.task].includes(intent.platform)) {
    // Let the full platform guide and live catalog resolve newly connected routes.
    return [];
  }

  if (intent.task === "comments") {
    if (intent.discover === "target") return [];
    if (intent.discover === "trending") {
      if (intent.platform === "tiktok" && !hasRegionHint(text)) missing.push("social_trending_region_required");
      return missing;
    }
    if (intent.discover === "channel") return [];
    // Comments with no link: a subject can be searched; with neither, the link is what is missing.
    if (!hasSocialSubject(text)) missing.push("social_comment_target_required");
    return missing;
  }

  if (intent.task === "trending") {
    // The YouTube trending feed is one worldwide list; only TikTok's feed depends on the country.
    if (intent.platform === "tiktok" && !hasRegionHint(text)) missing.push("social_trending_region_required");
    return missing;
  }

  if (intent.task === "channel_videos" || (intent.task === "page_posts" && intent.discover === "channel")) {
    if (!intent.channelRef) missing.push("social_channel_required");
    return missing;
  }

  if (intent.task === "x_posts") {
    if (intent.discover === "channel" && !intent.channelRef) missing.push("social_x_account_required");
    else if (intent.discover === "keyword" && !hasSocialSubject(text)) missing.push("social_x_topic_required");
    return missing;
  }

  return missing;
}

export interface SocialTaskQuestion {
  id: MissingSocialTaskInput;
  text: string;
  question: string;
  type: "free" | "single";
  options: string[];
  allowOther: boolean;
}

function socialQuestion(id: MissingSocialTaskInput, text: string, type: "free" | "single", options: string[] = []): SocialTaskQuestion {
  return { id, text, question: text, type, options, allowOther: true };
}

/** The one question to ask for a missing input: Arabic only, short, with tappable options where the answer is a choice. */
export function socialTaskQuestion(id: MissingSocialTaskInput): SocialTaskQuestion {
  switch (id) {
    case "social_comment_target_required":
      return socialQuestion(id, "ما موضوع الفيديوهات أو اسم القناة التي تريد تعليقاتها؟ ويمكنك لصق رابط فيديو بدل ذلك.", "free");
    case "social_trending_region_required":
      return socialQuestion(id, "في أي دولة تريد الفيديوهات الرائجة؟", "single", ["مصر", "السعودية", "الإمارات", "أخرى"]);
    case "social_trending_platform_required":
      return socialQuestion(id, "ما المنصة المطلوبة للفيديوهات الرائجة؟", "free");
    case "social_channel_required":
      return socialQuestion(id, "ما اسم القناة أو رابطها؟", "free");
    case "social_x_topic_required":
      return socialQuestion(id, "ما الموضوع الذي تريد البحث عن منشوراته؟", "free");
    case "social_x_account_required":
      return socialQuestion(id, "ما اسم حساب إكس أو رابطه؟", "free");
  }
}

/** The subject words of a request (a keyword or name), for a search the customer did not spell out as a query. */
export function socialSubjectText(text: string): string {
  const hashtag = /(?:^|\s)#([\p{L}\p{N}_]{2,})/u.exec(text || "")?.[1];
  if (hashtag) return hashtag.replace(/_/g, " ");
  return topicTokens(text).slice(0, 6).join(" ");
}

/** Customer-facing social subject; trending feeds are a task type rather than a keyword topic. */
export function socialSubjectForDisplay(text: string, trending = false): string {
  return trending ? "الفيديوهات الرائجة" : socialSubjectText(text);
}
