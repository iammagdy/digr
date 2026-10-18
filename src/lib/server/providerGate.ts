import { peekProviderKey, resolveProviderKey } from "./providerKeys";

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
  // Last resolved key (store or environment); callers that matter prime it with resolveProviderKey first.
  return peekProviderKey("treg");
}

/**
 * Evaluates the live data provider status safely at runtime.
 */
export function getLiveProviderGateStatus(): ProviderGateStatus {
  const rawLive = String(process.env.TREG_LIVE ?? process.env["TREG_LIVE"] ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim()
    .toLowerCase();
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
 * Resolve the non-secret live switch from shared application settings before
 * evaluating the gate. Vercel runs route handlers in separate functions, so a
 * process.env mutation made by the admin route is not shared with the accept
 * or worker routes. The switch is stored in settings_private; provider tokens
 * live in the encrypted key store (or the environment) and are never read from that row.
 */
export async function getLiveProviderGateStatusFromSettings(source: any): Promise<ProviderGateStatus> {
  let savedLive: unknown;

  try {
    if (typeof source?.getRow === "function") {
      const row = await source.getRow({
        databaseId: "digr",
        tableId: "settings_private",
        rowId: "providers",
      });
      savedLive = row?.TREG_LIVE ?? row?.value?.TREG_LIVE;
    } else if (typeof source?.from === "function") {
      const { data, error } = await source
        .from("settings_private")
        .select("value")
        .eq("key", "providers")
        .maybeSingle();
      if (!error) savedLive = data?.value?.TREG_LIVE;
    }
  } catch {
    // If shared settings are unavailable, retain the deployment env fallback.
  }

  if (typeof savedLive === "boolean") {
    process.env.TREG_LIVE = savedLive ? "true" : "false";
  } else if (typeof savedLive === "string" && /^(true|false)$/i.test(savedLive.trim())) {
    process.env.TREG_LIVE = savedLive.trim().toLowerCase();
  }

  // Prime the shared resolver so a key held only in the encrypted store counts as configured.
  await resolveProviderKey("treg");
  return getLiveProviderGateStatus();
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
