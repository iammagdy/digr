import { pointsAr } from "../pointsFormat";
import { isMissingAtomicRpc } from "../../functions/shared/atomicRpc";
import { toArabicDigits } from "../arabicDigits";

export const PROMO_CODE_PATTERN = /^[A-Z0-9_-]{3,32}$/;

const PROMO_UNAVAILABLE_AR = "خدمة الأكواد الترويجية غير متاحة حاليًا. حاول مرة أخرى بعد قليل.";
const GENERIC_FAILURE_AR = "تعذر تطبيق الكود الآن. حاول مرة أخرى بعد قليل.";

/** Codes are typed on a phone: accept Arabic-Indic digits, spaces and lower case. */
export function normalizePromoCode(raw: unknown): string {
  const text = String(raw ?? "")
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .trim()
    .toUpperCase();
  return text;
}

export function isWellFormedPromoCode(code: string): boolean {
  return PROMO_CODE_PATTERN.test(code);
}

export interface PromoRedeemOutcome {
  ok: boolean;
  /** Stable machine reason for tests and logs; the customer sees only messageAr. */
  reason: string;
  messageAr: string;
  points?: number;
  balance?: number;
}

const REASON_AR: Record<string, string> = {
  invalid_code: "الكود غير صحيح. تأكد من كتابته كما وصلك.",
  code_not_found: "الكود غير صحيح. تأكد من كتابته كما وصلك.",
  already_redeemed: "استخدمت هذا الكود من قبل، ولا يمكن استخدامه مرة ثانية.",
  code_inactive: "هذا الكود غير مفعّل حاليًا.",
  code_not_started: "هذا الكود لم يبدأ سريانه بعد.",
  code_expired: "انتهت صلاحية هذا الكود.",
  code_exhausted: "استُنفد هذا الكود، فقد استخدمه العدد الأقصى من الأشخاص.",
  user_not_found: "تعذر العثور على الحساب.",
};

/**
 * Redeems a code through the approved SQL function. If the function is not installed yet (migration not applied)
 * the customer gets a clear Arabic message and one safe log line; no credit row is ever written by hand.
 */
export async function redeemPromoCode(adminClient: any, userId: string, rawCode: unknown): Promise<PromoRedeemOutcome> {
  const code = normalizePromoCode(rawCode);
  if (!isWellFormedPromoCode(code)) {
    return { ok: false, reason: "invalid_code", messageAr: REASON_AR.invalid_code };
  }
  const { data, error } = await adminClient.rpc("redeem_promo_code_atomic", { p_user_id: userId, p_code: code });
  if (error) {
    if (isMissingAtomicRpc(error, "redeem_promo_code_atomic")) {
      console.warn("[money:redeem_promo_code_atomic_unavailable] migration not applied; promo codes are off");
      return { ok: false, reason: "unavailable", messageAr: PROMO_UNAVAILABLE_AR };
    }
    console.error("[money:redeem_promo_code_atomic_failed] code=" + String(error?.code || "unknown"));
    return { ok: false, reason: "failed", messageAr: GENERIC_FAILURE_AR };
  }
  if (data?.success === true) {
    const points = Number(data.points) || 0;
    const balance = Number(data.balance) || 0;
    return {
      ok: true,
      reason: "redeemed",
      points,
      balance,
      messageAr: `تم تطبيق الكود. أُضيف ${pointsAr(points, toArabicDigits)} إلى رصيدك، ورصيدك الآن ${pointsAr(balance, toArabicDigits)}.`,
    };
  }
  const reason = String(data?.error || "failed");
  return {
    ok: false,
    reason,
    messageAr: REASON_AR[reason] || (typeof data?.error_ar === "string" && data.error_ar) || GENERIC_FAILURE_AR,
    balance: typeof data?.balance === "number" ? data.balance : undefined,
  };
}

/** Failed-attempt throttle per account: guessing codes is slowed down without blocking an honest typo. */
const attempts = new Map<string, number[]>();
export const PROMO_ATTEMPT_LIMIT = 8;
export const PROMO_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

export function promoAttemptsExceeded(userId: string, now = Date.now()): boolean {
  const recent = (attempts.get(userId) || []).filter((t) => now - t < PROMO_ATTEMPT_WINDOW_MS);
  attempts.set(userId, recent);
  return recent.length >= PROMO_ATTEMPT_LIMIT;
}

export function recordFailedPromoAttempt(userId: string, now = Date.now()): void {
  attempts.set(userId, [...(attempts.get(userId) || []).filter((t) => now - t < PROMO_ATTEMPT_WINDOW_MS), now]);
}

export function resetPromoAttemptsForTesting(): void {
  attempts.clear();
}

export const PROMO_TOO_MANY_ATTEMPTS_AR = "محاولات كثيرة غير صحيحة. انتظر عدة دقائق ثم حاول مرة أخرى.";
