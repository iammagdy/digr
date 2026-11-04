import { buildRequestContract } from "./requestContract";
import { normalizeText } from "./relevance";

/**
 * A DATA REQUEST WITH NO PLATFORM IS ASKED, NOT REFUSED (round 23). Live (4 Nov 2026): «عايز داتا عن رأي الناس في الذكاء الاصطناعي» named no platform, so no compiled path took it: the model-planned path paid for two searches on X and 20 model turns, then ended «خارج مصادرنا».
 * Now a request that asks for what PEOPLE SAY (opinions, comments, posts, videos, reactions) and names no platform gets one question card before anything is read or paid for, with one-tap choices; the answer is read with the request and its platform
 * takes the normal compiled path. A request that names a platform, a company list, a map, a site or a file is not asked. Code only. Pure.
 */
export const PLATFORM_QUESTION_AR = "من أنهي منصة؟";
export const PLATFORM_OPTIONS_AR: readonly string[] = ["تيك توك", "إكس", "إنستجرام", "فيسبوك", "يوتيوب"];

/** What people say on social platforms: the request is about opinions, comments, posts, videos or reactions. */
const SOCIAL_SIGNAL = /راي (?:ال)?(?:ناس|جمهور|مستخدمين)|اراء|كلام (?:ال)?ناس|(?:ال)?ناس (?:بتقول|بيقولوا|يقولون|بتتكلم|بيتكلموا)|ردود فعل|انطباع|تعليق|منشور|بوست|فيديو|مقاطع|محتوي|ترند|هاشتاج|هاشتاغ|مؤثرين|مشاعر|ريلز|ستوري/;
/** The requests that name another kind of source: companies, places, contacts, sites, news, files, other platforms. */
const OTHER_SOURCE = /شركات|شركه|مطاعم|عيادات|صيدليات|فنادق|موظف|مديري|ايميل|بريد|هاتف|تليفون|ارقام|خرائط|جوجل|google|موقع|مواقع|رابط|http|اخبار|وظائف|اسعار|اسواق|ملف|اكسل|excel|pdf|مقالات|ابحاث|دراسات|reddit|ريديت|لينكد|linkedin|تطبيقات|متجر|متاجر/i;

/** True when the request needs the platform question: it asks for what people say, names no platform, has no answer yet and names no other kind of source. */
export function platformQuestionNeeded(request: unknown, answer?: unknown): boolean {
  if (String(answer ?? "").trim() !== "") return false;
  const text = String(request ?? "");
  if (buildRequestContract(text).platform !== null) return false;
  const n = normalizeText(text);
  if (OTHER_SOURCE.test(n) || OTHER_SOURCE.test(text)) return false;
  return SOCIAL_SIGNAL.test(n);
}
