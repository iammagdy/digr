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
