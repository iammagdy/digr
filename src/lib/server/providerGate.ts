/**
 * Live Data Provider Gate & Diagnostics
 * Centralizes runtime environment flag checks (TREG_LIVE, TREG_TOKEN / TREG_API_KEY).
 *
 * Security rules:
 * - NEVER log, expose, or print token or secret values.
 * - Accept trimmed, case-insensitive truthy flags ("true", "1", "yes", "on").
 * - Accept either TREG_TOKEN or TREG_API_KEY with whitespace or quotes trimmed.
 * - Customer-facing messages must NEVER mention internal provider names or tokens.
 */

export type ProviderGateReasonCode =
  | "ok"
  | "flag_off"
  | "token_missing"
  | "token_rejected"
  | "catalog_unavailable"
  | "spend_cap";

export interface ProviderGateStatus {
  isReady: boolean;
  reasonCode: ProviderGateReasonCode;
  messageAr: string;
}

const REASON_MESSAGES_AR: Record<ProviderGateReasonCode, string> = {
  ok: "",
  flag_off: "محرك استخراج البيانات المباشر غير مفعل حالياً؛ لم يتم حجز أو خصم أي نقاط من رصيدك.",
  token_missing: "محرك استخراج البيانات المباشر غير مهيأ حالياً؛ لم يتم حجز أو خصم أي نقاط من رصيدك.",
  token_rejected: "تعذر بدء الاستخراج بسبب عدم اعتماد صلاحية الاتصال؛ لم يتم حجز أو خصم أي نقاط من رصيدك.",
  catalog_unavailable: "خدمة استخراج البيانات المباشرة غير متاحة مؤقتاً؛ تم استرداد كامل الرصيد دون أي خصم.",
  spend_cap: "تم بلوغ الحد الأقصى للاستهلاك اليومي للبيانات؛ تم استرداد كامل الرصيد دون أي خصم.",
};

/**
 * Returns clean sanitized token string without quotes or whitespace.
 * Never logs or prints this value.
 */
export function getSanitizedProviderToken(): string {
  const raw = process.env.TREG_TOKEN || process.env.TREG_API_KEY || "";
  return raw.trim().replace(/^["']|["']$/g, "").trim();
}

/**
 * Evaluates the live data provider status safely at runtime.
 */
export function getLiveProviderGateStatus(): ProviderGateStatus {
  const rawLive = (process.env.TREG_LIVE || "").trim().toLowerCase();
  const isLive = rawLive === "true" || rawLive === "1" || rawLive === "yes" || rawLive === "on";

  if (!isLive) {
    return {
      isReady: false,
      reasonCode: "flag_off",
      messageAr: REASON_MESSAGES_AR.flag_off,
    };
  }

  const token = getSanitizedProviderToken();
  if (!token) {
    return {
      isReady: false,
      reasonCode: "token_missing",
      messageAr: REASON_MESSAGES_AR.token_missing,
    };
  }

  return {
    isReady: true,
    reasonCode: "ok",
    messageAr: "",
  };
}

/**
 * Boolean-only convenience check.
 */
export function isLiveProviderConfigured(): boolean {
  return getLiveProviderGateStatus().isReady;
}

/**
 * Map error or diagnostic string to safe generic Arabic user message.
 * Strictly guarantees ZERO leakage of provider names.
 */
export function mapProviderReasonToUserMessage(reasonCode: ProviderGateReasonCode | string): string {
  const code = (reasonCode || "").toLowerCase() as ProviderGateReasonCode;
  if (REASON_MESSAGES_AR[code]) {
    return REASON_MESSAGES_AR[code];
  }
  return "تعذر إتمام عملية استخراج البيانات المباشرة حالياً؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.";
}
