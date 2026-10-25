import { toArabicDigits } from "./arabicDigits";

/**
 * Top-up screen texts the owner can change without touching the screen.
 *
 * `TOPUP_REVIEW_TIME_AR` is empty: the screen then says the owner-approved sentence (usually 15 minutes, 24 hours at most). To promise another
 * duration, set it here («خلال ساعة في أيام العمل»), or in the public settings row `pricing` as `value.reviewTimeAr` (it wins over this constant).
 */
export const TOPUP_REVIEW_TIME_AR: string | null = null;

/**
 * The label above the payment address: the platform's own receiving account, never a person's name. The ADDRESS under it is the value the owner saved in the
 * admin settings (`ipa`); if it is a personal handle, replacing it there is the owner's call (the code cannot know). `value.paymentLabelAr` in the public
 * settings row overrides this label.
 */
export const TOPUP_PAYMENT_LABEL_AR = "عنوان الدفع اللحظي · منصة ديجر";

/** The owner-approved sentence under the send button (used while no review time is configured). */
export const TOPUP_REVIEW_DEFAULT_AR = "غالبًا يتم الاعتماد خلال ١٥ دقيقة، وبحد أقصى ٢٤ ساعة، وتصلك رسالة عند إضافة النقاط.";

/** The sentence under the send button: the configured review time when there is one, otherwise the owner-approved sentence. Digits are Arabic-Indic. */
export function topupReviewSentenceAr(configured?: string | null): string {
  const time = toArabicDigits(String(configured ?? TOPUP_REVIEW_TIME_AR ?? "").trim().slice(0, 120));
  return time
    ? `يراجع فريق الإدارة صورة الإيصال يدويًا، ومدة المراجعة المتوقعة ${time}، وتُضاف النقاط إلى محفظتك فور الاعتماد.`
    : TOPUP_REVIEW_DEFAULT_AR;
}
