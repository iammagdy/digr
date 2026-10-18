import { sanitizeCustomerErrorMessage } from "./catalogClient";
import { PEOPLE_SETTLEMENT_UNAVAILABLE_AR } from "./peopleSettlementReadiness";

export function toSafeReasonCode(err: unknown, failingStep?: string): string {
  if (!err || typeof err !== "object") return "internal_error";
  const anyErr = err as Record<string, unknown>;
  const explicitCode =
    (typeof anyErr.reasonCode === "string" && anyErr.reasonCode) ||
    (typeof anyErr.code === "string" && anyErr.code);
  if (explicitCode) {
    return String(explicitCode).replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 64);
  }

  const msg = typeof anyErr.message === "string" ? anyErr.message : "";
  const name = typeof anyErr.name === "string" ? anyErr.name : "";

  if (msg === PEOPLE_SETTLEMENT_UNAVAILABLE_AR) {
    return "people_settlement_unavailable";
  }

  if (/timeout|AbortError|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg) || /timeout|AbortError/i.test(name)) {
    return "timeout";
  }
  if (/rate limit|429|quota exceeded/i.test(msg)) {
    return "rate_limit_exceeded";
  }
  if (failingStep === "quote_save" || /سعر الوحدة غير صالح|الخدمة المطلوبة غير معتمدة/i.test(msg)) {
    return "plan_build_failed";
  }
  if (failingStep === "catalog_search" || /catalog|treg/i.test(msg)) {
    return "catalog_unavailable";
  }
  if (failingStep === "llm_turn" || /Anthropic|Claude/i.test(name) || /Anthropic|Claude/i.test(msg)) {
    return "llm_failed";
  }
  if (failingStep === "capabilities_load" || /supabase|database|postgres/i.test(msg)) {
    return "database_unavailable";
  }
  if (failingStep === "authenticate_user" || /غير مصرح|unauthorized|jwt/i.test(msg)) {
    return "auth_failed";
  }
  if (name && name !== "Error") {
    return name.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 64);
  }
  return "internal_error";
}

export function reasonCodeToCustomerMessage(reason: string, defaultMsg?: string): string {
  switch (reason) {
    case "capability_not_found":
    case "unsupported_platform":
      return "الخدمة أو المنصة المطلوبة غير متاحة حالياً ضمن الأدوات المعتمدة على المنصة.";
    case "plan_build_failed":
      return "تعذر إعداد خطة تسعير دقيقة للطلب بالبيانات المتاحة. يمكنك إعادة صياغة الطلب أو تحديد إحدى المنصات المعتمدة (فيسبوك، لينكد إن، إكس، يوتيوب).";
    case "people_settlement_unavailable":
      return PEOPLE_SETTLEMENT_UNAVAILABLE_AR;
    case "catalog_unavailable":
      return "تعذر الاتصال بفهرس الخدمات حالياً لتحديد التكلفة. يرجى المحاولة بعد لحظات.";
    case "llm_failed":
      return "واجه المساعد الذكي صعوبة في صياغة الرد في الوقت الحالي. يرجى المحاولة مرة أخرى.";
    case "timeout":
      return "استغرقت معالجة الطلب وقتاً أطول من المتوقع. يرجى المحاولة مرة أخرى أو اختصار الطلب.";
    case "rate_limit_exceeded":
      return "تم تجاوز الحد الأقصى المؤقت للطلبات. يرجى الانتظار دقيقة والمحاولة مجدداً.";
    case "auth_failed":
    case "forbidden":
      return "جلسة الدخول منتهية أو غير مصرح لك بهذه العملية. يرجى تسجيل الدخول مجدداً.";
    case "not_found":
      return "المحادثة المطلوبة غير موجودة.";
    default:
      return "حدث خطأ أثناء معالجة المحادثة. يرجى المحاولة مرة أخرى.";
  }
}
