import { toArabicDigits } from "./arabicDigits";

/**
 * What a customer reads when the sign-in service is rate limited or the confirmation e-mail is late: plain Arabic, what to do next,
 * and a resend button with limits of its own (a longer wait after each press, a few presses at most) so a room full of phones
 * on one network cannot flood the e-mail service by tapping.
 */

/** Seconds to wait after the 1st, 2nd, 3rd and 4th send of the confirmation e-mail. */
export const RESEND_COOLDOWNS_SECONDS = [30, 60, 120, 180] as const;
export const RESEND_MAX_SENDS = RESEND_COOLDOWNS_SECONDS.length;
/** After this long without the e-mail, the page says it may be late and what to check. */
export const LATE_EMAIL_AFTER_SECONDS = 90;

export interface ResendState { allowed: boolean; waitSeconds: number; sendsLeft: number }

/** Whether the customer may ask for another e-mail, given how many he asked for and how long ago the last one was. */
export function resendState(sendsSoFar: number, secondsSinceLast: number): ResendState {
  const sent = Math.max(0, Math.floor(sendsSoFar || 0));
  if (sent >= RESEND_MAX_SENDS) return { allowed: false, waitSeconds: 0, sendsLeft: 0 };
  if (sent === 0) return { allowed: true, waitSeconds: 0, sendsLeft: RESEND_MAX_SENDS };
  const cooldown = RESEND_COOLDOWNS_SECONDS[Math.min(sent, RESEND_COOLDOWNS_SECONDS.length) - 1];
  const wait = Math.max(0, cooldown - Math.max(0, Math.floor(secondsSinceLast || 0)));
  return { allowed: wait === 0, waitSeconds: wait, sendsLeft: RESEND_MAX_SENDS - sent };
}

export const RESEND_BUTTON_AR = "إعادة إرسال الرسالة";
export const RESEND_LIMIT_REACHED_AR = "وصلت إلى الحد الأقصى لإعادة الإرسال. افحص مجلد الرسائل غير المرغوب فيها، أو اكتب لنا من صفحة «تواصل معنا» وسنؤكد حسابك يدويًا.";

export function resendWaitAr(seconds: number): string {
  return `أُرسلت — يمكنك الطلب مجددًا بعد ${toArabicDigits(Math.max(0, Math.ceil(seconds)))} ثانية`;
}

/** Said under the e-mail box once the message is late: a busy network delays it, and what to check meanwhile. */
export const LATE_EMAIL_HINT_AR = "الرسالة قد تتأخر بضع دقائق عندما تزدحم الشبكة. افحص مجلد الرسائل غير المرغوب فيها، وتأكد من كتابة البريد بلا خطأ، ثم اضغط «إعادة إرسال الرسالة» مرة واحدة فقط.";

export type AuthFailure = "rate_limited" | "email_rate_limited" | "offline" | "exists" | "invalid_credentials" | "unknown";

/** Which plain failure an error from the sign-in service is, read from its code, its status and its words. */
export function classifyAuthFailure(err: unknown): AuthFailure {
  const e = err as { code?: number | string; type?: string; message?: string; status?: number; name?: string } | undefined;
  const msg = String(e?.message || "").toLowerCase();
  const code = String(e?.code || "").toLowerCase();
  const status = e?.status || (typeof e?.code === "number" ? e.code : undefined);
  if (code === "over_email_send_rate_limit" || msg.includes("email rate limit") || msg.includes("over_email_send_rate_limit")) return "email_rate_limited";
  if (status === 429 || code === "over_request_rate_limit" || msg.includes("rate limit") || msg.includes("too many")) return "rate_limited";
  if (msg.includes("failed to fetch") || msg.includes("networkerror") || msg.includes("network request failed") || e?.name === "TypeError" && msg.includes("fetch")) return "offline";
  if (status === 409 || code === "user_already_exists" || e?.type === "user_already_exists" || msg.includes("already registered") || msg.includes("already exists")) return "exists";
  if (status === 401 || code === "invalid_credentials" || code === "invalid_grant" || e?.type === "user_invalid_credentials" || msg.includes("invalid login credentials")) return "invalid_credentials";
  return "unknown";
}

export const AUTH_FAILURE_AR: Record<AuthFailure, string | null> = {
  rate_limited: "عدد كبير من المحاولات من نفس الشبكة الآن، وهذا يحدث عندما يتصل الكثيرون معًا. انتظر دقيقة ثم أعد المحاولة مرة واحدة، دون ضغط متكرر.",
  email_rate_limited: "أُرسل عدد كبير من رسائل التأكيد في وقت واحد، فأوقفنا الإرسال لحظات. انتظر دقيقتين ثم اطلب الرسالة مرة واحدة.",
  offline: "تعذّر الاتصال بالخدمة. تأكد من الإنترنت وأعد المحاولة بعد لحظات.",
  exists: "هذا البريد مسجّل بالفعل — جرّب تسجيل الدخول.",
  invalid_credentials: "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
  unknown: null,
};

export function authFailureMessageAr(err: unknown, fallback: string): string {
  return AUTH_FAILURE_AR[classifyAuthFailure(err)] ?? fallback;
}
