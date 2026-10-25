/**
 * What a customer reads when the data source refuses or cannot serve a call, and which of these are DETERMINISTIC: the same request will
 * fail the same way, so no «try again» is offered for them (a retry only re-quotes a plan that cannot run). Pure module: the adapter
 * writes the sentences, the screens read them.
 */
export const PROVIDER_ROUTE_COST_EXCEEDED_AR = "تجاوز الطلب سقف التكلفة المسموح به للمصدر.";
export const PROVIDER_UNAVAILABLE_AR = "الخدمة غير متاحة مؤقتاً، يرجى المحاولة لاحقاً.";
export const PROVIDER_TARGET_NOT_FOUND_AR = "الهدف المطلوب غير موجود أو غير متاح للعامة.";
export const PROVIDER_INPUT_REJECTED_AR = "تعذر معالجة مدخلات الطلب لدى المصدر.";
export const PROVIDER_BUSY_AR = "المصدر مشغول حالياً بعد استنفاد محاولات الإعادة.";
export const PROVIDER_GENERIC_FAILURE_AR = "تعذر استخراج البيانات من المصدر بعد عدة محاولات.";
export const PROVIDER_INCOMPATIBLE_ANSWER_AR = "استجاب المصدر ببيانات غير متوافقة مع نوع البحث";

/** Sentences whose cause is in the request itself: the source will answer the same again. */
const DETERMINISTIC_FAILURE_AR: readonly string[] = [
  PROVIDER_INPUT_REJECTED_AR,
  PROVIDER_TARGET_NOT_FOUND_AR,
  PROVIDER_ROUTE_COST_EXCEEDED_AR,
  PROVIDER_INCOMPATIBLE_ANSWER_AR,
];

/** True when a failed job's customer text names a cause that a retry of the same plan cannot change. */
export function isDeterministicFailureAr(text: unknown): boolean {
  const value = typeof text === "string" ? text : "";
  return value.length > 0 && DETERMINISTIC_FAILURE_AR.some((sentence) => value.includes(sentence));
}
