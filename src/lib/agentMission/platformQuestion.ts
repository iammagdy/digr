import { buildRequestContract } from "./requestContract";
import { normalizeText } from "./relevance";

/**
 * A DATA REQUEST WITH NO PLATFORM IS ASKED, NOT REFUSED (rounds 23 and 25). Live (4 Nov 2026): «عايز داتا عن رأي الناس في الذكاء الاصطناعي» named no platform, so no compiled path took it: the legacy model-planned path paid for searches on X and model turns, then ended «خارج مصادرنا».
 * The LEGACY model-planned path now takes only a request that is clearly about COMPANIES OR PLACES. A request that looks like social data (opinions, comments, posts, videos, «رأي الناس», «الناس بتقول ايه», trends) with no platform gets the platform card «من أنهي منصة؟»;
 * anything else unclear gets ONE short clarifying card. Both come before any model turn or provider call. The platform the customer chooses is kept for the whole mission (round 25: the answer of the next question, the count, used to replace it), so the request takes the
 * normal compiled path of that platform. Code only. Pure.
 */
export const PLATFORM_QUESTION_AR = "من أنهي منصة؟";
export const PLATFORM_OPTIONS_AR: readonly string[] = ["تيك توك", "إكس", "إنستجرام", "فيسبوك", "يوتيوب"];
export const COMPANIES_OR_PLACES_OPTION_AR = "قائمة شركات أو أماكن";
export const CLARIFY_QUESTION_AR = "من أي مصدر تحب أجمع لك البيانات؟ اختر منصة أو «قائمة شركات أو أماكن»، أو اكتب طلبك بتفصيل أكثر.";
export const CLARIFY_OPTIONS_AR: readonly string[] = [...PLATFORM_OPTIONS_AR, COMPANIES_OR_PLACES_OPTION_AR];
export const UNCLEAR_END_AR = "لم يتضح لي بعد من أين أجمع بيانات طلبك، فلم أبدأ شيئًا ولم يُخصم منك شيء. اكتب طلبك من جديد واذكر المنصة (تيك توك أو إكس أو إنستجرام أو فيسبوك أو يوتيوب) أو نوع الشركات أو الأماكن.";

/** What people say on social platforms: opinions, comments, posts, videos, reactions, trends. */
const SOCIAL_SIGNAL = /راي (?:ال)?(?:ناس|جمهور|مستخدمين|شارع)|اراء|كلام (?:ال)?ناس|(?:ال)?ناس (?:بتقول|بيقولوا|يقولون|بتتكلم|بيتكلموا|تتحدث|يتحدثون)|بتتكلم|بيتكلموا|ردود فعل|انطباع|تعليق|منشور|بوست|فيديو|مقاطع|محتوي|ترند|تريند|هاشتاج|هاشتاغ|مؤثرين|مشاعر|ريلز|ستوري/;
/** Companies and places: the only requests the legacy model-planned path still takes. */
const COMPANIES_OR_PLACES = /شركات|شركه|مؤسسات|مصانع|مصنع|مطاعم|مطعم|عيادات|عياده|صيدليات|صيدليه|فنادق|فندق|محلات|متاجر|مقاهي|كافيهات|مستشفيات|مستشفي|مدارس|جامعات|بنوك|فروع|مكاتب|مراكز|خرائط|اماكن|موردين|مقاولات|وكالات|مديري|مدراء|صناع القرار|موظفين|google maps|companies|places|leads/i;

/** Platforms named by the customer that the compiled path does not serve. */
const OTHER_PLATFORM = /ريديت|reddit|لينكد|linkedin|تليجرام|telegram|سناب|snapchat|بينترست|pinterest|ثريدز|threads/;

const textOf = (request: unknown, answer?: unknown): string => `${String(request ?? "")} ${String(answer ?? "")}`.trim();

export const isCompaniesOrPlaces = (text: unknown): boolean => COMPANIES_OR_PLACES.test(normalizeText(text)) || COMPANIES_OR_PLACES.test(String(text ?? ""));
const isSocialLike = (text: string): boolean => SOCIAL_SIGNAL.test(normalizeText(text));

/** Where a request with NO platform goes: the legacy model-planned path (companies or places only), the platform card, or the clarifying card. */
export function legacyRouteOf(request: unknown, answer?: unknown): "legacy" | "platform_question" | "clarify" {
  const text = textOf(request, answer);
  if (isCompaniesOrPlaces(text)) return "legacy";
  // a platform the compiled path does not serve (Reddit, LinkedIn, …): the clarifying card names what is available, never «which platform» again
  if (OTHER_PLATFORM.test(normalizeText(text))) return "clarify";
  return isSocialLike(text) ? "platform_question" : "clarify";
}

/** True when the request needs the platform question: no platform, no answer yet, and it looks like social data (round 23; the worker routes with `legacyRouteOf`). */
export function platformQuestionNeeded(request: unknown, answer?: unknown): boolean {
  if (String(answer ?? "").trim() !== "") return false;
  if (buildRequestContract(String(request ?? "")).platform !== null) return false;
  return legacyRouteOf(request) === "platform_question";
}

/** The platform choice a card answer names (one of the five, as tapped or typed), else null. */
export function platformOptionOf(answer: unknown): string | null {
  const a = String(answer ?? "").replace(/\s+/g, " ").trim();
  return PLATFORM_OPTIONS_AR.includes(a) ? a : null;
}

/** The request as it reads once the platform is chosen: the customer's words with «على <platform>» added; an answer that WAS the platform is consumed (a later answer, the count, stays). */
export function withPlatformChoice<T extends { request_text: string; answer_text?: string | null }>(mission: T, platform: string): T {
  return { ...mission, request_text: `${mission.request_text} على ${platform}`, answer_text: platformOptionOf(mission.answer_text) ? null : (mission.answer_text ?? null) };
}
