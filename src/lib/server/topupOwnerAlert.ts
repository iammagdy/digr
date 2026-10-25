import { sendPlatformEmail } from "@/lib/server/sendPlatformEmail";
import { SITE_URL } from "@/lib/site";
import { egpDueAr } from "@/lib/topupAmount";
import { toArabicDigits } from "@/lib/arabicDigits";

/**
 * The owner's alert for a new top-up request: ONE e-mail to the address in ADMIN_ALERT_EMAIL (server only; nothing is hard-coded and nothing is sent
 * while it is empty). It goes through the e-mail function that already exists, with its generic update layout, so no new template is needed. It
 * carries the customer's name and address, the points, the EGP to expect, the time and the link to the approval page: no receipt image, no secret and
 * no token. It NEVER throws and never delays or fails the request: the caller only awaits it so the serverless run is not cut short.
 */
export const OWNER_ALERT_ENV = "ADMIN_ALERT_EMAIL";

export function ownerAlertRecipient(env: Record<string, string | undefined> = process.env): string | null {
  const value = String(env[OWNER_ALERT_ENV] ?? "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

export interface TopupAlertInput {
  topupId: string;
  customerName: string;
  customerEmail: string;
  points: number;
  amountEgp: number;
  createdAt: string;
}

/** The time as the owner reads it: Cairo, Arabic-Indic digits. */
export function alertTimeAr(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ar-EG-u-nu-arab", { timeZone: "Africa/Cairo", dateStyle: "long", timeStyle: "short" }).format(date);
}

/** The variables of the e-mail (the generic update layout: heading, lead, two detail lines, one button). Values are escaped by the template. */
export function buildTopupAlertVars(input: TopupAlertInput): Record<string, string> {
  const points = toArabicDigits(input.points);
  return {
    Name: "الإدارة",
    Subject: `طلب شحن جديد: ${points} نقطة`,
    Heading: "طلب شحن جديد بانتظار الاعتماد",
    Lead: `وصل طلب شحن من ${input.customerName}${input.customerEmail ? ` (${input.customerEmail})` : ""}.`,
    DetailOne: `النقاط: ${points}. ${egpDueAr(input.amountEgp).replace("ستحوّل", "المبلغ المتوقع:")}.`,
    DetailTwo: `وقت الطلب: ${alertTimeAr(input.createdAt)}.`,
    ButtonLabel: "افتح صفحة الاعتماد",
    JobURL: `${SITE_URL}/admin/topups`,
  };
}

export async function notifyOwnerOfTopup(input: TopupAlertInput, deps: { send?: typeof sendPlatformEmail; env?: Record<string, string | undefined> } = {}): Promise<{ sent: boolean; reason?: "no_recipient" | "failed" }> {
  try {
    const to = ownerAlertRecipient(deps.env);
    if (!to) {
      console.log("[topup:owner_alert_skipped] no ADMIN_ALERT_EMAIL");
      return { sent: false, reason: "no_recipient" };
    }
    const result = await (deps.send ?? sendPlatformEmail)("job-update", to, buildTopupAlertVars(input), `topup-alert:${input.topupId}`);
    return result && result.ok === false ? { sent: false, reason: "failed" } : { sent: true };
  } catch {
    console.error("[topup:owner_alert_failed]");
    return { sent: false, reason: "failed" };
  }
}
