import { isMissingAtomicRpc } from "../../functions/shared/atomicRpc";
import { toArabicDigits } from "../arabicDigits";

export const ADMIN_GRANT_MAX_POINTS = 100000;
const UNAVAILABLE_AR = "إضافة الرصيد اليدوي غير متاحة حاليًا لأن تحديث قاعدة البيانات لم يُطبَّق بعد.";
const GENERIC_AR = "تعذرت إضافة الرصيد الآن. لم تُسجَّل أي نقاط.";

export interface AdminGrantOutcome {
  ok: boolean;
  reason: string;
  messageAr: string;
  points?: number;
  balance?: number;
  alreadyGranted?: boolean;
}

/** Whole positive points only; Arabic-Indic digits accepted. Anything else is rejected before the database. */
export function parseGrantPoints(raw: unknown): number | null {
  const text = String(raw ?? "").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).trim();
  if (!/^\d{1,6}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= ADMIN_GRANT_MAX_POINTS ? n : null;
}

/**
 * Manual credit through the approved SQL function, which verifies the admin role itself. The route has already
 * checked the role too, but nothing here trusts that: a non-admin id is refused by the database.
 */
export async function grantCreditAsAdmin(
  adminClient: any,
  input: { adminId: string; userId: string; points: number; note: string; requestId: string },
): Promise<AdminGrantOutcome> {
  const { data, error } = await adminClient.rpc("admin_grant_credit_atomic", {
    p_admin_id: input.adminId,
    p_user_id: input.userId,
    p_points: input.points,
    p_note: input.note,
    p_request_id: input.requestId,
  });
  if (error) {
    if (isMissingAtomicRpc(error, "admin_grant_credit_atomic")) {
      console.warn("[money:admin_grant_credit_atomic_unavailable] migration not applied; manual credit is off");
      return { ok: false, reason: "unavailable", messageAr: UNAVAILABLE_AR };
    }
    console.error("[money:admin_grant_credit_atomic_failed] code=" + String(error?.code || "unknown"));
    return { ok: false, reason: "failed", messageAr: GENERIC_AR };
  }
  if (data?.success === true) {
    const points = Number(data.points) || input.points;
    const balance = Number(data.balance) || 0;
    return {
      ok: true,
      reason: data.already_granted ? "already_granted" : "granted",
      alreadyGranted: Boolean(data.already_granted),
      points,
      balance,
      messageAr: data.already_granted
        ? `هذه الإضافة سُجلت من قبل، والرصيد الحالي ${toArabicDigits(balance)} نقطة.`
        : `تمت إضافة ${toArabicDigits(points)} نقطة. الرصيد الحالي ${toArabicDigits(balance)} نقطة.`,
    };
  }
  return {
    ok: false,
    reason: String(data?.error || "failed"),
    messageAr: (typeof data?.error_ar === "string" && data.error_ar) || GENERIC_AR,
  };
}

export interface PromoCodeInput {
  code: string;
  points: number;
  maxRedemptions: number;
  startsAt: string | null;
  expiresAt: string | null;
  active: boolean;
  note: string;
}

export async function savePromoCodeAsAdmin(
  adminClient: any,
  adminId: string,
  input: PromoCodeInput,
): Promise<{ ok: boolean; reason: string; messageAr: string }> {
  const { data, error } = await adminClient.rpc("admin_save_promo_code_atomic", {
    p_admin_id: adminId,
    p_code: input.code,
    p_points: input.points,
    p_max_redemptions: input.maxRedemptions,
    p_starts_at: input.startsAt,
    p_expires_at: input.expiresAt,
    p_active: input.active,
    p_note: input.note || null,
  });
  if (error) {
    if (isMissingAtomicRpc(error, "admin_save_promo_code_atomic")) {
      console.warn("[money:admin_save_promo_code_atomic_unavailable] migration not applied; promo codes are off");
      return { ok: false, reason: "unavailable", messageAr: "الأكواد الترويجية غير متاحة حاليًا لأن تحديث قاعدة البيانات لم يُطبَّق بعد." };
    }
    console.error("[money:admin_save_promo_code_atomic_failed] code=" + String(error?.code || "unknown"));
    return { ok: false, reason: "failed", messageAr: "تعذر حفظ الكود الآن." };
  }
  if (data?.success === true) return { ok: true, reason: "saved", messageAr: "تم حفظ الكود." };
  return { ok: false, reason: String(data?.error || "failed"), messageAr: (typeof data?.error_ar === "string" && data.error_ar) || "تعذر حفظ الكود." };
}
