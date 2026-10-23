import { normalizeDriverMode } from "./driverMode";

/**
 * Shown once, right after the customer approves a plan and the job starts. «ويمكنك إغلاق الصفحة» is said ONLY when the always-on
 * driver is on (the server tells the page which driver is active); otherwise the sentence is the honest one: keep the page open,
 * or the request continues when the customer comes back.
 */
export const POST_APPROVAL_CRON_AR = "جاري سحب البيانات، سيصلك إشعار عند الاكتمال ويمكنك إغلاق الصفحة.";
export const POST_APPROVAL_TAB_AR = "جاري سحب البيانات، وسيصلك إشعار عند الاكتمال. أبقِ الصفحة مفتوحة حتى تكتمل المهمة.";

export function postApprovalMessageAr(mode?: unknown): string {
  return normalizeDriverMode(mode) === "cron" ? POST_APPROVAL_CRON_AR : POST_APPROVAL_TAB_AR;
}
