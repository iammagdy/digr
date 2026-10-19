import { detectMentionedPlatforms } from "./capabilityRegistry";
import { isGreetingOrGeneralQuestion } from "./briefManager";
import { looksLikeFileShapingRequest, unsupportedFileEdit } from "../../lib/fileSpec";

/**
 * Which earlier messages may inform the CURRENT research request.
 *
 * A research request is interpreted from its own message first. Earlier messages only fill what a short follow-up
 * leaves out (an answer to a question, "ابدأ", "١٠٠ شركة"); they never override a country, topic or platform the
 * customer stated, greetings and identity questions never count, and a new self-contained request never inherits
 * the country, topic or contact-field wording of an older one.
 */

const REQUEST_VERB = /(?:^|\s)(?:جيب|جيبلي|تجيبلي|تجبلي|لاقي|ممكن|لو سمحت|هات|هاتلي|هات لي|اجمع|اجمعلي|ابحث|دورلي|دور على|عايز|عاوز|عايزة|أريد|اريد|أبغى|ابغى|أبي|ابي|محتاج|محتاجة|استخرج|طلعلي|جمع|اعطني|أعطني|جهزلي|قارن)(?=\s|$)/;
const REQUEST_OBJECT = /(?:تعليق|تعليقات|كومنت|كومنتس|كومنتات|تغريد|تويت|بوست|منشور|فيديو|فيديوهات|شرك|مدير|مديري|دراس|بحث|أبحاث|ابحاث|مقال|حساب|متابع|ايميل|إيميل|رقم|صناع|مصنع|مستشف|مطعم|مكتب|مورد|عملاء|جامع|دكتور|أطباء|اطباء|محامي)/;
const SHAPING_VERB_START = /^(?:رتّ?ب|فلتر|قسّ?م|وزّ?ع|سيب|خلي)(?:ها|ه|لي|لنا)?(?=\s)/u;
const TOPIC_MARKER = /(?:^|\s)(?:عن|حول|بخصوص|في|من|لدى|داخل)\s/;
const PLAN_REFERENCE = /(?:الخطة|الخطه|العرض|السعر|عرض السعر|النقاط|الرصيد|الملف|الشيت|الاكسل|الإكسل|اللي فات|السابق)/;
/** An answer to one of our questions (the card answers are stored as labelled text) never starts a new request. */
const ANSWER_PREFIX = /^\s*(?:إجابة عن|الإجابة\s*:|الدولة المطلوبة\s*:|المجال المطلوب\s*:|عدد الشركات المطلوب\s*:|دولة صناع القرار المطلوبة\s*:|نطاق صناع القرار\s*:|المسميات الوظيفية المطلوبة\s*:|عدد صناع القرار المطلوب\s*:|اسم الحساب المطلوب\s*:|موضوع البحث المطلوب\s*:|منصة البحث المطلوبة\s*:|الفترة المطلوبة\s*:|المصدر المطلوب\s*:|إجابة هدف التواصل\s*:)/;
const LEADING_COUNT_OBJECT = new RegExp(`^[0-9٠-٩]+\\s+\\S*${REQUEST_OBJECT.source}`);

export function isClarificationAnswerPayload(text: string): boolean {
  const t = (text || "").trim();
  return t.startsWith("{") && t.includes("clarification_answers");
}

/** A message that states its own research task: its own platform, or a request verb/count with an object and a topic. */
export function isStandaloneResearchRequest(text: string): boolean {
  const t = (text || "").trim();
  if (!t || isClarificationAnswerPayload(t) || ANSWER_PREFIX.test(t)) return false;
  const { isGreeting, isGeneralQuestion } = isGreetingOrGeneralQuestion(t);
  if (isGreeting || isGeneralQuestion) return false;
  // "شركة" alone names the company database, not a platform: it does not make a fragment an independent request.
  const platforms = detectMentionedPlatforms(t).filter((p) => p !== "companies");
  if (PLAN_REFERENCE.test(t) && platforms.length === 0) return false;
  if (platforms.length > 0) return true;
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words < 4 || !REQUEST_OBJECT.test(t) || !TOPIC_MARKER.test(t)) return false;
  // A task needs a request verb ("اجمع ١٠ دراسات عن ...") or a leading quantity of the thing wanted ("٣ مديرين في ...").
  // A bare number inside a sentence is not enough: "آخر ٣ شهور، ملف لكل منصة" is an answer to a question.
  return REQUEST_VERB.test(t) || LEADING_COUNT_OBJECT.test(t);
}

/**
 * «قسّم الملف شيت لكل محافظة», «رتبها حسب التاريخ»: how the delivered file should look. A research request that merely names
 * a layout ("منشورات من حسابات مشهورة، ملف لكل منصة") carries a research object and is not one.
 */
export function isFileShapingMessage(text: string): boolean {
  const t = String(text || "").trim();
  // An edit of the delivered file that is not offered («احذف التكرار», «عدل اتجاه الشيت») is about the file too.
  if (unsupportedFileEdit(t)) return true;
  if (!looksLikeFileShapingRequest(t)) return false;
  // A message that BEGINS with a shaping verb is about the file even when a column it names looks like a research object
  // («رتب النتائج حسب المتابعين»); one that begins with a request verb and names an object is research.
  return !REQUEST_OBJECT.test(t) || SHAPING_VERB_START.test(t);
}

/** A turn that carries no research request: a greeting, an identity question, or how the delivered file should look. */
export function isGreetingOrIdentityTurn(text: string): boolean {
  const { isGreeting, isGeneralQuestion } = isGreetingOrGeneralQuestion((text || "").trim());
  return isGreeting || isGeneralQuestion || isFileShapingMessage(text);
}

/** At most this many earlier customer messages can complete a follow-up. */
export const MAX_FOLLOW_UP_CHAIN = 4;

/**
 * The text every routing decision of this turn reads (country, topic, platform, contact fields).
 * `priorUserMessages` are the customer's earlier messages, oldest first, WITHOUT the current one.
 */
export function scopeRequestText(priorUserMessages: string[], current: string, extraNotes: string[] = []): string {
  const own = (current || "").trim();
  // How the delivered file should look is about the saved result: it never reads (or routes by) an earlier research request.
  if (isFileShapingMessage(own)) return own;
  if (isStandaloneResearchRequest(own)) return [own, ...extraNotes].filter(Boolean).join(" ");

  const chain: string[] = [];
  for (let i = priorUserMessages.length - 1; i >= 0 && chain.length < MAX_FOLLOW_UP_CHAIN; i--) {
    const earlier = (priorUserMessages[i] || "").trim();
    if (!earlier || isGreetingOrIdentityTurn(earlier)) continue;
    chain.unshift(earlier);
    if (isStandaloneResearchRequest(earlier)) break;
  }
  return [...chain, own, ...extraNotes].filter(Boolean).join(" ");
}

/**
 * History shown to the model: greetings and identity questions (answered by code) and the reply that followed them
 * carry no research content, so they are left out instead of being re-read on every later turn.
 */
export function dropGreetingAndIdentityTurns<T extends { role: string; content: string }>(messages: T[]): T[] {
  const out: T[] = [];
  // The newest customer message is the turn being answered: it always stays.
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { lastUser = i; break; }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (i !== lastUser && m.role === "user" && isGreetingOrIdentityTurn(m.content)) {
      if (messages[i + 1]?.role === "assistant") i++;
      continue;
    }
    out.push(m);
  }
  return out;
}

export const INDEPENDENT_REQUEST_NOTE_AR =
  "[تعليمات داخلية — طلب بحث مستقل]: هذه الرسالة طلب بحث جديد قائم بذاته. فسّره من رسالته الأخيرة وحدها: الدولة والموضوع والمنصة وحقول التواصل تُؤخذ منها فقط، ولا تنقل شيئًا منها من رسائل سابقة عن طلب آخر.";
