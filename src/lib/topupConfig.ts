/**
 * Top-up screen texts the owner can change without touching the screen.
 *
 * OWNER ACTION (not decided by code): `TOPUP_REVIEW_TIME_AR` is left empty on purpose. While it is empty the screen promises no duration; set it to the
 * review time you can keep («خلال ساعة في أيام العمل») here, or in the public settings row `pricing` as `value.reviewTimeAr` (it wins over this constant).
 */
export const TOPUP_REVIEW_TIME_AR: string | null = null;

/**
 * The label above the payment address: the platform's own receiving account, never a person's name. The ADDRESS under it is the value the owner saved in the
 * admin settings (`ipa`); if it is a personal handle, replacing it there is the owner's call (the code cannot know). `value.paymentLabelAr` in the public
 * settings row overrides this label.
 */
export const TOPUP_PAYMENT_LABEL_AR = "عنوان الدفع اللحظي · منصة ديجر";

/** The sentence under the send button: the configured review time when there is one, otherwise a sentence that promises no duration. */
export function topupReviewSentenceAr(configured?: string | null): string {
  const time = String(configured ?? TOPUP_REVIEW_TIME_AR ?? "").trim().slice(0, 120);
  return time
    ? `يراجع فريق الإدارة صورة الإيصال يدويًا، ومدة المراجعة المتوقعة ${time}، وتُضاف النقاط إلى محفظتك فور الاعتماد.`
    : "يراجع فريق الإدارة صورة الإيصال يدويًا، وتُضاف النقاط إلى محفظتك فور الاعتماد وتصلك رسالة بذلك.";
}
