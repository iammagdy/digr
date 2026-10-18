import { extractNumberFromText } from "../../lib/arabicNumbers";
import { detectCountryFromText } from "../../lib/planParameters";
import { socialSubjectText } from "../../lib/socialTasks";
import type { GuideService } from "./platformGuide";

export type UnderstandingCapability =
  | "companies" | "decision_makers" | "youtube_comments" | "tiktok_comments" | "facebook_comments"
  | "tiktok_trending" | "channel_videos" | "facebook_posts" | "x_tweets" | "topic_research" | "greeting" | "vague";

export interface UnderstandingResult {
  capability: UnderstandingCapability;
  missingInputs: string[];
}

function normalize(text: string): string {
  return String(text || "").toLowerCase().normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/\s+/g, " ").trim();
}

function hasCount(text: string): boolean { return extractNumberFromText(text) !== undefined; }
function hasCountry(text: string): boolean { return Boolean(detectCountryFromText(text)) || /\b(?:global|worldwide)\b|عالمي|العالم/iu.test(text); }
function hasIndustry(text: string): boolean {
  return /كهرب|ميكاني|الكتر|برمج|سوفت|تقني|طبي|مطاعم|عقار|تعليم|طاقة|سيارات|غذائ|زراع|مقاول|contract|software|it\b|solar|sports|football|basketball|news|أخبار|بحث|اكاديمي|أكاديمي|جامعي/iu.test(text);
}
function hasRole(text: string): boolean {
  return /مدير|مدراء|رئيس|مسؤول|تنفيذي|مؤسس|مالك|قرار|ceo|cto|director|manager|executive|founder/iu.test(text);
}
function hasChannel(text: string): boolean {
  return /@[-\w.]+|youtube\.com\/(?:@|channel\/)|tiktok\.com\/@|(?:قناة|صفحة|حساب)\s+(?!يوتيوب|تيك\s*توك|فيسبوك|فيس\s*بوك|على|دي|ده)(?:اسم\s+)?[\p{L}\p{N}_.-]{2,}/iu.test(text);
}
function hasTopic(text: string): boolean {
  const subject = socialSubjectText(text);
  const stripped = normalize(text).replace(/https?:\/\/\S+/g, " ").replace(/[؟?!.,،:;]+/g, " ").replace(/\s+/g, " ").trim();
  const onlyIntent = /^(?:عايز|عاوزه|محتاج|ممكن|هات|اجمع|جيب|وريني|اعرض|اريد|ابغى|please|want|need|تعليقات?|كومنتس?|كومنتات?|كمنتس?|ردود|فيديوهات?|بوستات?|منشورات?|تويتات?|تغريدات?|يوتيوب|youtube|تيك\s*توك|tiktok|فيسبوك|facebook|منصة|x|اكس|إكس|تويتر|\d+|و|على|من|عن|في|ال|\s)*$/iu;
  return Boolean(subject && subject.length >= 2 && !onlyIntent.test(stripped));
}

/** Offline intent and required-input evaluator shared by tests and the understanding report script. */
export function classifyUnderstandingRequest(rawText: string): UnderstandingResult {
  const text = normalize(rawText);
  const isGreeting = /^(?:السلام عليكم|سلام عليكم|اهلا|مرحبا|ازيك|ازيكم|صباح الخير|مساء الخير|هاي|hello|hi)[!.؟? ]*$/iu.test(text);
  if (isGreeting) return { capability: "greeting", missingInputs: [] };

  const isPeople = /صناع\s*(?:ال)?قرار|صانعي\s*(?:ال)?قرار|مدير(?:ين|ون)?|مدراء|رئيس(?:ين)?|مسؤول(?:ين)?|تنفيذي(?:ين)?|مؤسس(?:ين)?|ceos?|ctos?|decision makers?|executives?/iu.test(text);
  if (isPeople) {
    const missing: string[] = [];
    if (!hasCountry(text)) missing.push("country");
    if (!hasIndustry(text) && !/في\s+شركات|في شركة|at\s+\w/iu.test(text)) missing.push("company_or_industry");
    if (!hasRole(text)) missing.push("roles");
    if (!hasCount(text)) missing.push("count");
    return { capability: "decision_makers", missingInputs: missing };
  }

  const platform = /يوتيوب|youtube/iu.test(text) ? "youtube" : /تيك\s*توك|tiktok/iu.test(text) ? "tiktok" : /فيسبوك|فيس\s*بوك|facebook|\bfb\b/iu.test(text) ? "facebook" : /تويتر|تغريد|منصة\s*x|\bx\.com\b|twitter/iu.test(text) ? "x" : "";
  const comments = /تعليق|كومنت|كمنت|comment|ردود/iu.test(text);
  const trending = /ترند|تريند|ترندينج|رائج|trending|viral/iu.test(text);
  const videos = /فيديو|مقطع|مقاطع|شورت|ريلز|video|shorts/iu.test(text);
  const channel = hasChannel(text);
  const post = /بوست|منشور|post|تغريدة|تويتة|تويتات|تغريدات|tweet/iu.test(text);

  if (comments && platform) {
    const capability = platform === "youtube" ? "youtube_comments" : platform === "facebook" ? "facebook_comments" : "tiktok_comments";
    return { capability, missingInputs: /https?:\/\//i.test(text) || hasTopic(text) ? [] : ["topic_or_link"] };
  }
  if (trending && platform === "tiktok") return { capability: "tiktok_trending", missingInputs: hasCountry(text) ? [] : ["country"] };
  if ((channel && videos) || (videos && /من قناة|بتاعة|بتاع|من حساب/iu.test(text))) {
    return { capability: "channel_videos", missingInputs: hasChannel(text) ? [] : ["channel"] };
  }
  if (post && platform === "facebook") return { capability: "facebook_posts", missingInputs: /https?:\/\//i.test(text) || hasTopic(text) ? [] : ["topic_or_page"] };
  if ((platform === "x" && post) || /تويت|تغريد|tweets?/iu.test(text)) return { capability: "x_tweets", missingInputs: hasTopic(text) ? [] : ["topic"] };
  if (/شركة|شركات|مؤسسة|مؤسسات|مصنع|مصانع|شركات\s+في/iu.test(text)) {
    const missing: string[] = [];
    if (!hasCountry(text)) missing.push("country");
    if (!hasIndustry(text)) missing.push("industry");
    if (!hasCount(text)) missing.push("count");
    return { capability: "companies", missingInputs: missing };
  }
  if (/خبر|اخبار|أخبار|اكاديمي|أكاديمي|ورقة|دراسات|بحث عن|اجمع|مصادر|football|basketball|كورة|كرة|موضوع|news|academic|research/iu.test(text)) {
    return { capability: "topic_research", missingInputs: /عايز بيانات|اجمع بيانات|بحث عن شيء|موضوع معين/iu.test(text) ? ["topic"] : [] };
  }
  return { capability: "vague", missingInputs: ["topic"] };
}

/** A conservative offline approximation of the old prompt/router behavior, used only as a pre-guide baseline. */
export function classifyBeforeGuide(rawText: string): UnderstandingResult {
  const text = normalize(rawText);
  if (/^(?:السلام عليكم|سلام عليكم|اهلا|مرحبا|ازيك|ازيكم|صباح الخير|مساء الخير|هاي|hello|hi)[!.؟? ]*$/iu.test(text)) {
    return { capability: "greeting", missingInputs: [] };
  }
  if (/صناع\s*(?:ال)?قرار|صانعي\s*(?:ال)?قرار|مدير(?:ين|ون)?|مدراء|رئيس(?:ين)?|مسؤول(?:ين)?|تنفيذي(?:ين)?|مؤسس(?:ين)?|ceos?|ctos?|decision makers?|executives?/iu.test(text)) {
    const missing: string[] = [];
    if (!hasCountry(text)) missing.push("country");
    if (!hasIndustry(text) && !/في\s+شركات|في شركة|at\s+\w/iu.test(text)) missing.push("company_or_industry");
    if (!hasRole(text)) missing.push("roles");
    if (!hasCount(text)) missing.push("count");
    return { capability: "decision_makers", missingInputs: missing };
  }
  const platform = /يوتيوب|youtube/iu.test(text) ? "youtube" : /تيك\s*توك|tiktok/iu.test(text) ? "tiktok" : /فيسبوك|facebook/iu.test(text) ? "facebook" : /تويتر|twitter|منصة\s*x/iu.test(text) ? "x" : "";
  if (/تعليقات?|كومنتات?|كومنت|كومنتس|ردود/iu.test(text) && platform) return { capability: platform === "youtube" ? "youtube_comments" : platform === "facebook" ? "facebook_comments" : "tiktok_comments", missingInputs: [] };
  if (/شركات|شركة|مؤسسات|مصانع/iu.test(text)) return { capability: "companies", missingInputs: [] };
  if (/تغريدات?|تويتات?|tweets?/iu.test(text)) return { capability: "x_tweets", missingInputs: [] };
  if (/أخبار|اخبار|ورقة علمية|مقال أكاديمي|كرة القدم|كرة السلة/iu.test(text)) return { capability: "topic_research", missingInputs: [] };
  if (/قناة|فيديوهات?|مقاطع/iu.test(text) && platform) return { capability: "channel_videos", missingInputs: [] };
  return { capability: "vague", missingInputs: ["topic"] };
}

export function guideServiceByCapability(capability: UnderstandingCapability, services: GuideService[]): GuideService | undefined {
  const slug = capability === "companies" ? "icypeas-companies-search" : capability === "decision_makers" ? "professional-people-search" :
    capability === "youtube_comments" ? "social-youtube-comments" : capability === "tiktok_comments" ? "social-tiktok-comments" :
    capability === "facebook_comments" ? "social-facebook-comments" : capability === "tiktok_trending" ? "social-tiktok-videos" :
    capability === "channel_videos" ? "social-youtube-videos" : capability === "facebook_posts" ? "social-facebook-posts" :
    capability === "x_tweets" ? "social-x-posts" : capability === "topic_research" ? "topic-news-academic-research" : "";
  return services.find((service) => service.slug === slug);
}
