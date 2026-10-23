import { toArabicDigits } from "./arabicDigits";
export interface QuoteApprovalState {
  canApprove: boolean;
  expiredByTime: boolean;
  inactiveStatus: boolean;
}

/**
 * A quote must still be current in storage as well as inside its time window.
 * `unknown` is used for restored cards when the stored status could not be read.
 */
export function getQuoteApprovalState(
  status: string | undefined,
  expiresAt: string,
  now = Date.now(),
): QuoteApprovalState {
  const expiresAtMs = Date.parse(expiresAt);
  const expiredByTime = !Number.isFinite(expiresAtMs) || expiresAtMs <= now;
  const inactiveStatus = status !== undefined && status !== "quoted";

  return {
    canApprove: !expiredByTime && !inactiveStatus,
    expiredByTime,
    inactiveStatus,
  };
}

/**
 * A plan with a step that has no service, no parameters or no volume is incomplete: the card shows no price and no
 * approve button for it, and the customer is asked ONE question instead.
 */
export function isQuotePlanComplete(items: Array<{ capabilitySlug?: string; params?: Record<string, any>; targetVolumeMax?: number }> | undefined): boolean {
  if (items === undefined) return true; // restored cards without items are judged by status and time only
  if (items.length === 0) return false;
  return items.every((item) => Boolean(item.capabilitySlug) && Boolean(item.params) && Object.keys(item.params || {}).length > 0 && Number(item.targetVolumeMax) > 0);
}

/**
 * Why a plan card shows no approve button, in one plain sentence, for the states that used to say nothing. Null when the card can
 * be approved (the button is shown) or when another message of the card already explains it (expired by time, a superseded quote).
 */
export function planApprovalNoteAr(input: { locked: boolean; status?: string; expiredByTime: boolean; planComplete: boolean }): string | null {
  if (input.status === "accepted") return "بدأ تنفيذ هذه الخطة بالفعل، ولا يمكن الموافقة عليها مرة ثانية.";
  if (input.status !== undefined && input.status !== "quoted") return null;
  if (input.expiredByTime) return null;
  if (!input.planComplete) return "الخطة غير مكتملة بعد، لذلك لا يظهر زر الموافقة. أجب عن السؤال المعروض في المحادثة لنكمل التفاصيل.";
  if (input.locked) return "هذه الخطة معروضة للاطلاع هنا. يمكنك الموافقة عليها بعد انتهاء الطلب الجاري.";
  return null;
}

/**
 * Which panel the chat shows: the plan to act on, or the results of a job. A new plan that can still be approved (after a retry, or
 * a plan made while the results of a finished or failed request are open) takes the panel, because a plan the customer cannot
 * approve is worthless; a request that is still running keeps it, and a plan that belongs to the open job never replaces its results.
 */
export function shouldShowPlanPanel(input: {
  latestQuote: { quoteId: string; status?: string; expiresAt: string } | null;
  activeJob: { jobId: string; status?: string } | null;
  restPlanQuoteId: string | null;
  jobIdForQuote: (quoteId: string) => string;
  now?: number;
}): boolean {
  const latest = input.latestQuote;
  if (!latest) return false;
  if (!input.activeJob) return true;
  if (input.restPlanQuoteId === latest.quoteId) return true;
  const finished = ["done", "failed", "cancelled", "completed"].includes(String(input.activeJob.status));
  if (!finished) return false;
  if (input.jobIdForQuote(latest.quoteId) === input.activeJob.jobId) return false;
  return getQuoteApprovalState(latest.status, latest.expiresAt, input.now ?? Date.now()).canApprove;
}

/**
 * «ينتهي العرض خلال ٢٨ دقيقة»: the minutes left until the quote's own expiry, read from the clock passed in (the card passes a clock that moves),
 * never a stored number. Empty once the offer has expired.
 */
export function expiryShortAr(expiresAt: string, now: number): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(ms) || ms <= 0) return "";
  const mins = Math.max(1, Math.floor(ms / 60000));
  if (mins < 60) return `ينتهي العرض خلال ${toArabicDigits(mins)} دقيقة`;
  return `ينتهي العرض خلال ${toArabicDigits(Math.floor(mins / 60))} ساعة`;
}
