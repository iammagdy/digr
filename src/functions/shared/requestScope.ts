import { detectMentionedPlatforms } from "./capabilityRegistry";
import { isGreetingOrGeneralQuestion } from "./briefManager";
import { looksLikeFileShapingRequest, unsupportedFileEdit } from "../../lib/fileSpec";
import { extractUrls, hasSocialSubject } from "../../lib/socialTasks";
import { CLARIFICATION_ANSWER_LABELS } from "../../lib/clarificationLabels";

export { CLARIFICATION_ANSWER_LABELS };

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
const ANSWER_LABEL_ALTERNATION = Array.from(new Set([...Object.values(CLARIFICATION_ANSWER_LABELS), "إجابة هدف التواصل"]))
  .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
/** An answer to one of our questions (the card answers are stored as labelled text) never starts a new request. */
const ANSWER_PREFIX = new RegExp(`^\\s*(?:إجابة عن|الإجابة\\s*:|(?:${ANSWER_LABEL_ALTERNATION})\\s*:)`);
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

/**
 * «على يوتيوب» sent after a request that never named a platform completes that request: it names a platform and a count but no
 * subject, link or channel of its own, so the earlier request's subject and channel still apply and nothing is asked twice.
 */
function completesEarlierRequest(own: string, prior: string[]): boolean {
  const text = own.trim();
  if (hasSocialSubject(text) || extractUrls(text).length > 0 || /@[\p{L}\p{N}_.]{2,}/u.test(text)) return false;
  for (let i = prior.length - 1, scanned = 0; i >= 0 && scanned < MAX_SCAN_BACK; i--, scanned++) {
    const earlier = (prior[i] || "").trim();
    if (!earlier || isGreetingOrIdentityTurn(earlier) || ANSWER_PREFIX.test(earlier)) continue;
    // the nearest earlier request: it must be a research request that named no platform
    return isStandaloneResearchRequest(earlier) === false
      ? false
      : detectMentionedPlatforms(earlier).filter((p) => p !== "companies").length === 0;
  }
  return false;
}

/** At most this many earlier customer messages (not counting card answers) can complete a follow-up. */
export const MAX_FOLLOW_UP_CHAIN = 4;
/** How far back the nearest research request is searched; card answers never push it out of reach. */
const MAX_SCAN_BACK = 30;

/** True when the text is a stored card answer (labelled value). */
export function isCardAnswerText(text: string): boolean {
  return ANSWER_PREFIX.test((text || "").trim());
}

/**
 * The text every routing decision of this turn reads (country, topic, platform, contact fields).
 * `priorUserMessages` are the customer's earlier messages, oldest first, WITHOUT the current one.
 */
export function scopeRequestText(priorUserMessages: string[], current: string, extraNotes: string[] = []): string {
  const own = (current || "").trim();
  // How the delivered file should look is about the saved result: it never reads (or routes by) an earlier research request.
  if (isFileShapingMessage(own)) return own;
  if (isStandaloneResearchRequest(own) && !completesEarlierRequest(own, priorUserMessages)) return [own, ...extraNotes].filter(Boolean).join(" ");

  // Card answers always travel with the request they complete, however many there are: only the other follow-ups are limited,
  // so a request the customer stated (its platform, its topic) is never pushed out by a chain of answers.
  const chain: string[] = [];
  let followUps = 0;
  for (let i = priorUserMessages.length - 1, scanned = 0; i >= 0 && scanned < MAX_SCAN_BACK; i--, scanned++) {
    const earlier = (priorUserMessages[i] || "").trim();
    if (!earlier || isGreetingOrIdentityTurn(earlier)) continue;
    const isAnswer = ANSWER_PREFIX.test(earlier);
    if (!isAnswer && followUps >= MAX_FOLLOW_UP_CHAIN) break;
    chain.unshift(earlier);
    if (!isAnswer) followUps++;
    // A request that only named the platform of the one before it does not anchor the chain: the one before it still applies.
    if (isStandaloneResearchRequest(earlier) && !completesEarlierRequest(earlier, priorUserMessages.slice(0, i))) break;
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
