import { topupAmountMessageAr } from "./topupAmount";

export type TopupReasonCode =
  | "payment_details_not_configured"
  | "receipt_missing"
  | "file_oversized"
  | "file_invalid_type"
  | "duplicate_receipt"
  | "pending_limit_reached"
  | "unauthorized"
  | "email_not_verified"
  | "invalid_file_owner"
  | "network_offline"
  | "amount_invalid"
  | "amount_below_min"
  | "amount_above_max"
  | "server_error";

export const TOPUP_ERROR_MESSAGES: Record<TopupReasonCode, string> = {
  payment_details_not_configured: "بيانات الدفع اللحظي (إنستاباي) غير مهيأة حالياً. يرجى التواصل مع الدعم الفني.",
  receipt_missing: "صورة إيصال التحويل مطلوبة لمراجعة الطلب واعتماد الرصيد.",
  file_oversized: "حجم صورة الإيصال يتجاوز الحد الأقصى المسموح به (٥ ميجابايت).",
  file_invalid_type: "صيغة الملف غير مدعومة. يرجى إرفاق صورة الإيصال بصيغة PNG أو JPG أو WebP أو PDF.",
  duplicate_receipt: "هذا الإيصال مسجل مسبقاً في طلب شحن آخر؛ لا يمكن إعادة استخدام نفس الإيصال.",
  pending_limit_reached: "لديك الحد الأقصى من طلبات الشحن المعلقة. يرجى انتظار معالجتها قبل تقديم طلب جديد.",
  unauthorized: "غير مصرح — يرجى تسجيل الدخول أولاً.",
  email_not_verified: "يرجى تأكيد بريدك الإلكتروني أولاً قبل شحن الرصيد.",
  invalid_file_owner: "مسار ملف الإيصال غير صالح.",
  network_offline: "أنت غير متصل بالإنترنت. يرجى التحقق من اتصالك والمحاولة مجدداً.",
  // the amount limits are written from the top-up config; the server states them again with the live credit value (topupAmountMessageAr)
  amount_invalid: topupAmountMessageAr("invalid", 0.1),
  amount_below_min: topupAmountMessageAr("below_min", 0.1),
  amount_above_max: topupAmountMessageAr("above_max", 0.1),
  server_error: "تعذر تسجيل طلب الشحن بسبب مشكلة مؤقتة. يرجى المحاولة مرة أخرى.",
};
