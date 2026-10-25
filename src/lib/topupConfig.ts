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

/**
 * The InstaPay shortcuts under the payment address: the owner's InstaPay link and the QR image (public/instapay-qr.jpeg, the owner's file, never redrawn).
 * They belong to ONE account, so the screen shows them only while the saved payment address is that account (TOPUP_INSTAPAY_ACCEPTED_ADDRESSES: «iammagdy@instapay» or the bare «iammagdy»): if the owner
 * changes the address in the admin settings, the old QR and link disappear instead of sending money to the wrong place, until this config is updated too.
 */
export const TOPUP_INSTAPAY_URL = "https://ipn.eg/S/iammagdy/instapay/2dNSeG";
export const TOPUP_INSTAPAY_ADDRESS = "iammagdy@instapay";
/** The two ways the owner's address is saved in the admin settings: the full address and the bare handle. Nothing else matches. */
export const TOPUP_INSTAPAY_ACCEPTED_ADDRESSES: readonly string[] = [TOPUP_INSTAPAY_ADDRESS, "iammagdy"];
export const TOPUP_INSTAPAY_QR_SRC = "/instapay-qr.jpeg";

export function showsInstapayShortcuts(savedAddress: string | null | undefined): boolean {
  return TOPUP_INSTAPAY_ACCEPTED_ADDRESSES.includes(String(savedAddress ?? "").trim().toLowerCase());
}

/**
 * The amounts a customer may top up, in POINTS (1 point = the credit value, 0.10 EGP today, read from the public pricing settings, never typed here).
 * The screen offers the presets and a free amount («أخرى»); the server re-checks the minimum, the maximum and that the amount is a whole number of
 * points, whatever the screen sent.
 */
export const TOPUP_PRESET_POINTS = [1000, 2500, 5000, 10000] as const;
export const TOPUP_DEFAULT_POINTS = 2500;
export const TOPUP_MIN_POINTS = 1000;
export const TOPUP_MAX_POINTS = 100_000;
