import { detectMentionedPlatforms } from "../functions/shared/capabilityRegistry";
import { extractNumberFromText } from "./arabicNumbers";
import { COMMENT_WORDS_RE, TREND_WORDS_RE, hasSocialSubject } from "./socialTasks";

/** Social-content requests (videos, posts, comments, trends, tweets) as opposed to an account lookup. */
const BASE_SOCIAL_CONTENT_WORDS_RE = /(?:فيديو(?:هات)?|مقطع|مقاطع|منشور(?:ات)?|بوست(?:ات)?|تعليق(?:ات)?|تغريد(?:ات|ة)?|ترند|تريند|وسم|هاشتاج|هاشتاغ|كلمات مفتاحية|tweets?)/iu;
export const SOCIAL_CONTENT_WORDS_RE = new RegExp(`${BASE_SOCIAL_CONTENT_WORDS_RE.source}|${COMMENT_WORDS_RE.source}|${TREND_WORDS_RE.source}`, "iu");

/** Request for one public account's profile data rather than content search. */
export const ACCOUNT_LOOKUP_RE = /(?:بيانات|إحصائيات|احصائيات|ملف)\s+(?:حساب|ال?حساب)|حساب\s+(?:عام|على|تيك|إنستغرام|انستغرام)|(?:account|profile)\s+(?:data|stats|lookup)|user\s+profile/i;

export const ACCOUNT_HANDLE_RE = /(?:@|tiktok\.com\/@|اسم الحساب المطلوب\s*:\s*@?)([a-zA-Z0-9_.]{2,30})/i;

/**
 * Words that carry no search subject: request verbs, generic nouns, platform
 * names, prepositions and units. What remains after removing them is the topic
 * (a page name, keyword, hashtag, subject). Used only to decide whether the
 * customer has said *what* to search for, never to build the search itself.
 */
const NON_TOPIC_TOKENS = new Set([
  "عايز", "عايزه", "عايزة", "اريد", "أريد", "ابغى", "أبغى", "محتاج", "محتاجة", "نفسي", "ابحث", "ابحثي", "بحث", "اسحب", "سحب", "استخرج", "استخراج",
  "جمع", "اجمع", "هات", "هاتلي", "اعطني", "أعطني", "ممكن", "لو", "سمحت", "من", "فضلك", "خطة", "عرض", "سعر", "كام", "كم", "هيكلفني", "تكلفة",
  "فيديو", "فيديوهات", "مقطع", "مقاطع", "منشور", "منشورات", "تعليق", "تعليقات", "ترند", "تريند", "وسم", "هاشتاج", "هاشتاغ", "بيانات", "سجل", "سجلات",
  "على", "في", "فى", "عن", "حول", "بشأن", "الى", "إلى", "مع", "ل", "لل", "و", "او", "أو", "ان", "أن", "هذا", "هذه", "ده", "دي", "كل", "بعض",
  "منصة", "حساب", "صفحة", "قناة", "الخاصة", "الخاص", "العامة", "العام", "عامة", "عام", "اخر", "آخر", "خلال", "منذ", "الاخيرة", "الأخيرة", "شهر", "شهور",
  "اسبوع", "أسبوع", "سنة", "يوم", "ايام", "أيام", "الفترة", "فترة", "تيك", "توك", "تيكتوك", "يوتيوب", "انستغرام", "إنستغرام", "فيسبوك", "تويتر", "منصة",
  "tiktok", "youtube", "instagram", "facebook", "twitter", "reddit", "linkedin", "snapchat", "telegram",
  "i", "want", "need", "get", "find", "search", "show", "me", "the", "a", "an", "of", "on", "in", "for", "from", "about", "with", "and", "or", "to",
  "videos", "video", "posts", "post", "comments", "comment", "data", "records", "last", "month", "week", "year", "days",
]);

function stripToTopicTokens(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[0-9٠-٩۰-۹]+/g, " ")
    .replace(/[^\p{L}\p{N}#@_]+/gu, " ")
    .split(/\s+/)
    .filter((token) => {
      const bare = token.replace(/^ال/u, "");
      return bare.length >= 2 && !NON_TOPIC_TOKENS.has(token) && !NON_TOPIC_TOKENS.has(bare);
    });
}

/** True when the text names something to search for, beyond verbs, platform and quantity words. */
export function hasSocialTopic(text: string): boolean {
  if (/(?:^|\s)[#@][\p{L}\p{N}_]{2,}/u.test(text || "")) return true;
  if (/موضوع البحث المطلوب\s*:\s*\S+/u.test(text || "")) return true;
  return stripToTopicTokens(text).length >= 1 && hasSocialSubject(text);
}

export function hasSocialPlatform(text: string): boolean {
  return detectMentionedPlatforms(text || "").some((platform) => platform !== "companies");
}

export type MissingSocialInput = "social_account_required" | "social_platform_required" | "social_topic_required";

/**
 * Required inputs for social requests. The period is intentionally NOT
 * required: it never changes cost and an absent period simply applies no date
 * filter. Quantity is handled by the caller.
 */
export function getMissingSocialInputs(text: string): MissingSocialInput[] {
  const body = text || "";
  const isAccount = ACCOUNT_LOOKUP_RE.test(body);
  if (isAccount) return ACCOUNT_HANDLE_RE.test(body) ? [] : ["social_account_required"];
  if (!SOCIAL_CONTENT_WORDS_RE.test(body)) return [];
  const missing: MissingSocialInput[] = [];
  if (!hasSocialPlatform(body)) missing.push("social_platform_required");
  if (!hasSocialTopic(body)) missing.push("social_topic_required");
  return missing;
}

export function hasExplicitCount(text: string): boolean {
  return Boolean(extractNumberFromText(text || ""));
}
