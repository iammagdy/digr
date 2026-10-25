import { toArabicDigits } from "./arabicDigits";

/** The longest reason a customer is shown (the admin form allows 256; a longer one is cut with «…»). */
export const REJECT_REASON_MAX_CHARS = 200;

const NOTIFICATION_PREFIX = "notif_";
const REASON_MARKER = "السبب:";

/** The id of the notification the reject route writes for a request (`notif_<topupId>`), which the customer can read with their own session. */
export const notificationIdForTopup = (topupId: string): string => `${NOTIFICATION_PREFIX}${topupId}`;
export const topupIdFromNotificationId = (notificationId: string): string =>
  notificationId.startsWith(NOTIFICATION_PREFIX) ? notificationId.slice(NOTIFICATION_PREFIX.length) : notificationId;

/**
 * A rejection reason as the customer reads it: plain text (React escapes it; there is no HTML path), no internal id (rcpt_…, a long hex string, a uuid),
 * no e-mail address, no control character, one line of single spaces, Arabic-Indic digits, at most REJECT_REASON_MAX_CHARS characters.
 * Nothing left means null (the screen then shows nothing, never a placeholder).
 */
export function cleanRejectReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw
    .replace(/rcpt_[A-Za-z0-9_-]+/g, " ")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, " ")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, " ")
    .replace(/\b[0-9a-f]{24,}\b/gi, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const chars = Array.from(text);
  const capped = chars.length > REJECT_REASON_MAX_CHARS ? `${chars.slice(0, REJECT_REASON_MAX_CHARS - 1).join("").trimEnd()}…` : text;
  return toArabicDigits(capped);
}

/** «تم رفض طلب الشحن. السبب: …» (the older text also carried «(مرجع: rcpt_…)» before the marker, which is never read): the words after the first «السبب:». */
export function rejectReasonFromNotificationBody(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const at = body.indexOf(REASON_MARKER);
  return at < 0 ? null : cleanRejectReason(body.slice(at + REASON_MARKER.length));
}

/** What the requests list shows under a request: only a REJECTED request has a reason (the column when the table has one, else the customer's own notification). */
export function rejectionReasonFor(input: { status: string; columnReason?: string | null; notificationBody?: string | null }): string | null {
  if (input.status !== "rejected") return null;
  return cleanRejectReason(input.columnReason) ?? rejectReasonFromNotificationBody(input.notificationBody);
}
