import { pointsAr } from "../../lib/pointsFormat";
import { ID, Messaging, Permission, Role, TablesDB, Users } from "./dbCompat";
import { calculateBalance } from "./ledger";
import { renderEmailTemplate, resolveSiteUrl, type PlatformEmailTemplateId } from "./emailTemplates";

export type NotificationKind = "topup_approved" | "topup_rejected" | "topup_received" | "job_done" | "refund" | "welcome";
type PrefKey = "topup" | "done" | "refund" | "news";

const PREF_FOR_KIND: Record<NotificationKind, PrefKey | null> = {
  topup_approved: "topup",
  topup_rejected: "topup",
  topup_received: "topup",
  job_done: "done",
  refund: "refund",
  welcome: null,
};

/** Which branded platform email template renders each notification kind. */
const TEMPLATE_FOR_KIND: Record<NotificationKind, PlatformEmailTemplateId> = {
  welcome: "welcome",
  topup_received: "topup-received",
  topup_approved: "topup-approved",
  topup_rejected: "topup-rejected",
  job_done: "job-done",
  refund: "refund",
};

export interface NotifyInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link?: string;
  /** Template variables for the branded email (Name / SiteURL are filled in here). */
  emailVars?: Record<string, string | number | undefined>;
}

/**
 * Creates the in-app notification (owner-readable, owner may set readAt) and, when the user's
 * preferences allow it, sends the same event by email through Appwrite Messaging.
 * Notifications never block or fail the business action that triggers them.
 */
export async function notifyUser(
  client: ConstructorParameters<typeof TablesDB>[0],
  input: NotifyInput,
  log?: (m: string) => void,
): Promise<void> {
  const tables = new TablesDB(client);
  try {
    await tables.createRow({
      databaseId: "digr",
      tableId: "notifications",
      rowId: ID.unique(),
      data: {
        userId: input.userId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
        readAt: null,
        createdAt: new Date().toISOString(),
      },
      permissions: [Permission.read(Role.user(input.userId)), Permission.update(Role.user(input.userId))],
    });
  } catch (e: any) {
    log?.(`notification row failed: ${e?.message}`);
  }

  try {
    const users = new Users(client);
    const user = await users.get({ userId: input.userId });
    const pref = PREF_FOR_KIND[input.kind];
    const prefs = ((user.prefs as any)?.notif ?? {}) as Partial<Record<PrefKey, boolean>>;
    if (pref && prefs[pref] === false) return;
    if (!user.email) return;
    const vars: Record<string, string | number> = { Name: user.name || "مستخدم", ...input.emailVars };
    // Balance is only shown on the topup-approved / refund templates; fetch it lazily.
    // Guarded: a failure leaves Balance blank and never breaks the notification.
    if ((input.kind === "topup_approved" || input.kind === "refund") && vars.Balance === undefined) {
      try {
        vars.Balance = arDigits(await calculateBalance(tables, input.userId));
      } catch {
        vars.Balance = "";
      }
    }
    const { subject, html } = renderEmailTemplate(TEMPLATE_FOR_KIND[input.kind], vars);
    await new Messaging(client).createEmail({
      messageId: ID.unique(),
      subject,
      content: html,
      users: [input.userId],
      html: true,
    });
  } catch (e: any) {
    // No Messaging provider configured, or the user opted out: the in-app notification already exists.
    log?.(`email skipped: ${e?.message}`);
  }
}

const arDigits = (n: number) => String(n).replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));

export interface JobOutcome {
  status: "done" | "failed" | "cancelled" | string;
  deliveredUnits?: number;
  chargedCredits?: number;
  refundCredits?: number;
  reservedCredits?: number;
  /** Display title of the research job (template name), used by the job-done / refund emails. */
  jobTitle?: string;
  /** Requested volume (target), used by the job-done email. */
  requestedUnits?: number;
  /** Short reason phrase for the refund email ("السبب: ..."). */
  refundReason?: string;
}

/** In-app (+ email per preferences) events for a finished run: «اكتمل بحثك» and «حُرّر حجز مؤقت بقيمة N نقطة». */
export async function notifyJobOutcome(
  client: ConstructorParameters<typeof TablesDB>[0],
  userId: string,
  result: JobOutcome,
  log?: (m: string) => void,
): Promise<void> {
  const refund = Math.max(0, Number(result.refundCredits ?? 0));
  const jobTitle = result.jobTitle || "بحثك";
  const jobUrl = `${resolveSiteUrl()}/dashboard/requests`;
  if (result.status === "done" || result.status === "cancelled") {
    await notifyUser(client, {
      userId, kind: "job_done", title: "اكتمل بحثك",
      body: `${arDigits(result.deliveredUnits ?? 0)} سجلًا، والملفات جاهزة للتحميل.`,
      link: "/dashboard/requests",
      emailVars: {
        Charged: arDigits(result.chargedCredits ?? 0),
        Delivered: arDigits(result.deliveredUnits ?? 0),
        Refunded: arDigits(refund),
        Requested: result.requestedUnits === undefined ? "" : arDigits(result.requestedUnits),
        JobTitle: jobTitle,
        JobURL: jobUrl,
      },
    }, log);
    if (refund > 0) {
      await notifyUser(client, {
        userId, kind: "refund", title: `حُرّر حجز مؤقت بقيمة ${pointsAr(refund, arDigits)}`,
        body: "حجز مؤقت مُحرَّر: الجزء الذي لم يُستخدم من حجز بحثك الأخير لم يُخصم وهو متاح في رصيدك.", link: "/dashboard/topup",
        emailVars: {
          Points: arDigits(refund),
          Reason: result.refundReason || "حجز مؤقت مُحرَّر من بحثك الأخير",
          JobTitle: jobTitle,
        },
      }, log);
    }
  } else if (result.status === "failed") {
    const back = refund || Math.max(0, Number(result.reservedCredits ?? 0));
    await notifyUser(client, {
      userId, kind: "refund", title: back > 0 ? `حُرّر حجز مؤقت بقيمة ${pointsAr(back, arDigits)}` : "تعذّر إكمال البحث",
      body: "تعذّر إكمال البحث ولم يُخصم شيء — حُرّر الحجز المؤقت كاملًا.", link: "/dashboard/requests",
      emailVars: {
        Points: arDigits(back),
        Reason: result.refundReason || "تعذّر إكمال البحث ولم يُخصم شيء",
        JobTitle: jobTitle,
      },
    }, log);
  }
}
