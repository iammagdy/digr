/**
 * The fixed request the "retry" button sends after a failed run. It asks for a
 * fresh quote only; it never approves or starts anything. The server recognizes
 * this exact text to reuse the rows already collected by the failed run.
 */
export const RETRY_SAME_PLAN_MESSAGE =
  "أعد المحاولة بنفس الخطة. اعرض عرض سعر جديدًا فقط، ولا تعتمد أو تبدأ التنفيذ.";

export function isRetrySamePlanMessage(message: unknown): boolean {
  return typeof message === "string" && message.trim() === RETRY_SAME_PLAN_MESSAGE;
}

/** What the «review the plan and edit it» button sends: a request for a new quote, never research content. */
export const REVIEW_PLAN_MESSAGE =
  "عايز أراجع الخطة السابقة وأعدّلها. اعرض خطة وعرض سعر جديد فقط، ولا تبدأ أي استخراج قبل ما أوافق بنفسي.";

export function isReviewPlanMessage(message: unknown): boolean {
  return typeof message === "string" && message.trim() === REVIEW_PLAN_MESSAGE;
}

/** Letters only: no diacritics, punctuation or spacing differences, one spelling of the hamza and the final letters. */
function plainWords(text: string): string {
  return text
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

const APPROVAL_PHRASES = new Set([
  "اوافق", "اوافق وابدا", "اوافق وابدا البحث", "اوافق وابدا التنفيذ", "اوافق ابدا", "اوافق على الخطه", "اوافق على الخطه وابدا",
  "موافق", "موافقه", "موافق وابدا", "موافق ابدا", "موافق وابدا البحث", "وافقت", "وافقت وابدا",
  "ابدا", "ابدا البحث", "ابدا الان", "ابدا التنفيذ", "ابدا بالبحث", "ابدا من فضلك", "نفذ", "نفذ الان", "نفذ الخطه",
  "نعم ابدا", "نعم اوافق", "تمام ابدا", "تمام وابدا", "تمام اوافق", "ok", "okay", "go", "start", "yes",
]);

/** A message that only approves («أوافق وابدأ البحث»): consent is given with the plan card's button, never with typed text. */
export function isTypedApprovalMessage(message: unknown): boolean {
  if (typeof message !== "string") return false;
  const words = plainWords(message);
  return words.length > 0 && words.length <= 40 && APPROVAL_PHRASES.has(words);
}

/**
 * Messages the buttons and the approval ritual send: they carry no research request, so they are never read as part of the
 * topic, the places, the window or the volume of the request they refer to.
 */
export function isChatControlMessage(message: unknown): boolean {
  return isRetrySamePlanMessage(message) || isReviewPlanMessage(message) || isTypedApprovalMessage(message);
}

export const APPROVAL_NEEDS_BUTTON_AR =
  "لا أبدأ البحث ولا أحجز نقاطاً من رسالة مكتوبة. لبدء التنفيذ اضغط زر «أوافق وابدأ البحث» في بطاقة الخطة الأخيرة؛ وإن ظهر فيها «تحديث السعر» فاضغطه أولاً.";

/** True when the newest priced plan of the conversation is still waiting for approval (its request is «quoted», not «accepted»). */
export function hasPendingPlan(history: Array<{ role: string; requestStatus?: string | null; requestQuoteId?: string | null }>): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i];
    if (row.role !== "user" || !row.requestQuoteId) continue;
    return row.requestStatus === "quoted";
  }
  return false;
}

/** What the customer reads in their own chat for each of those fixed messages: one short line, never the instruction the server reads. */
export const RETRY_SAME_PLAN_DISPLAY_AR = "أعد المحاولة بنفس الخطة";
export const REVIEW_PLAN_DISPLAY_AR = "عايز أراجع الخطة وأعدّلها";

/** A stored or sent customer message as the chat shows it: the fixed button messages become their one clean line, anything else is unchanged. */
export function customerFacingMessageText(content: string): string {
  if (isRetrySamePlanMessage(content)) return RETRY_SAME_PLAN_DISPLAY_AR;
  if (isReviewPlanMessage(content)) return REVIEW_PLAN_DISPLAY_AR;
  return content;
}
