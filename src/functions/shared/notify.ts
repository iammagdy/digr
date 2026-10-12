import { ID, Messaging, Permission, Role, TablesDB, Users } from "node-appwrite";

export type NotificationKind = "topup_approved" | "topup_rejected" | "job_done" | "refund" | "welcome";
type PrefKey = "topup" | "done" | "refund" | "news";

const PREF_FOR_KIND: Record<NotificationKind, PrefKey | null> = {
  topup_approved: "topup",
  topup_rejected: "topup",
  job_done: "done",
  refund: "refund",
  welcome: null,
};

export interface NotifyInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link?: string;
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
    await new Messaging(client).createEmail({
      messageId: ID.unique(),
      subject: input.title,
      content: `<div dir="rtl" style="font-family:sans-serif;line-height:1.9"><p>${escapeHtml(input.title)}</p><p>${escapeHtml(input.body)}</p></div>`,
      users: [input.userId],
      html: true,
    });
  } catch (e: any) {
    // No Messaging provider configured, or the user opted out: the in-app notification already exists.
    log?.(`email skipped: ${e?.message}`);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const arDigits = (n: number) => String(n).replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));

export interface JobOutcome {
  status: "done" | "failed" | "cancelled" | string;
  deliveredUnits?: number;
  chargedCredits?: number;
  refundCredits?: number;
  reservedCredits?: number;
}

/** In-app (+ email per preferences) events for a finished run: «اكتمل بحثك» and «رجعت N نقطة لرصيدك». */
export async function notifyJobOutcome(
  client: ConstructorParameters<typeof TablesDB>[0],
  userId: string,
  result: JobOutcome,
  log?: (m: string) => void,
): Promise<void> {
  const refund = Math.max(0, Number(result.refundCredits ?? 0));
  if (result.status === "done" || result.status === "cancelled") {
    await notifyUser(client, {
      userId, kind: "job_done", title: "اكتمل بحثك",
      body: `${arDigits(result.deliveredUnits ?? 0)} سجلًا، والملفات جاهزة للتحميل.`,
      link: "/dashboard/requests",
    }, log);
    if (refund > 0) {
      await notifyUser(client, {
        userId, kind: "refund", title: `رجعت ${arDigits(refund)} نقطة لرصيدك`,
        body: "فرق الحجز من بحثك الأخير عاد إلى محفظتك.", link: "/dashboard/topup",
      }, log);
    }
  } else if (result.status === "failed") {
    const back = refund || Math.max(0, Number(result.reservedCredits ?? 0));
    await notifyUser(client, {
      userId, kind: "refund", title: back > 0 ? `رجعت ${arDigits(back)} نقطة لرصيدك` : "تعذّر إكمال البحث",
      body: "تعذّر إكمال البحث ولم يُخصم شيء — رجعت النقاط المحجوزة كاملة.", link: "/dashboard/requests",
    }, log);
  }
}
