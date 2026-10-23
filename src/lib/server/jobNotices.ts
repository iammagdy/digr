import { pointsAr } from "../pointsFormat";
import { toArabicDigits } from "../arabicDigits";
import type { DriverMode } from "../driverMode";
import { STALLED_LINE_AR } from "../jobStall";
import { getRecipient, sendPlatformEmail } from "./sendPlatformEmail";

/**
 * The notices of a long job, in plain Arabic: it started, and it stalled (the daily watchdog released it). Completion
 * is announced by the worker itself. A notice never names a provider, an endpoint, a file or an id.
 */
export const LONG_JOB_MIN_UNITS = 200;

export function isLongJob(targetVolumeMax: number): boolean {
  return Number.isFinite(targetVolumeMax) && targetVolumeMax >= LONG_JOB_MIN_UNITS;
}

export interface JobNotice {
  title: string;
  body: string;
  link: string;
  /** A deterministic id makes sending the same notice twice a no-op (the primary key refuses the second row). */
  id?: string;
}

/** The kinds of notice a job can have. Each is sent at most once per job, and never more than JOB_NOTICES_PER_JOB_LIMIT in all. */
export type JobNoticeKind = "started" | "stalled" | "completed" | "partial" | "released";
export const JOB_NOTICES_PER_JOB_LIMIT = 4;

/** What the e-mail of a notice says: the words go into the «job-update» template (an Edge Function template). */
export interface JobNoticeEmail {
  subject: string;
  heading: string;
  lead: string;
  detail1: string;
  detail2: string;
  buttonLabel: string;
}

export interface JobNoticeFull extends JobNotice {
  kind: JobNoticeKind;
  /** null: in-app only (a full completion and a full release already have their own e-mails: «job-done» and «refund»). */
  email: JobNoticeEmail | null;
}

export const jobNoticeId = (kind: JobNoticeKind, jobId: string) => `notif_${kind}_${jobId}`;
export const jobNoticeEmailKey = (kind: JobNoticeKind, jobId: string) => `job-update:${kind}:${jobId}`;

/**
 * A large request runs in the background in batches. «يمكنك إغلاق الصفحة» is said ONLY when the always-on driver is on
 * (`LONG_JOB_DRIVER=cron`); otherwise the notice says honestly that the page should stay open, or that the request continues when
 * the customer comes back.
 */
export function jobStartedNotice(input: { targetVolumeMax: number; driver?: DriverMode }): JobNotice {
  const count = toArabicDigits(Math.floor(input.targetVolumeMax));
  const canClose = input.driver === "cron";
  return {
    title: "بدأ تنفيذ طلبك الكبير",
    body: canClose
      ? `بدأ جمع حتى ${count} سجل. الطلب الكبير يعمل على دفعات في الخلفية، ويمكنك إغلاق الصفحة؛ سنخبرك عند اكتماله، وإذا تعذر استكماله تعود نقاطك المحجوزة كاملة.`
      : `بدأ جمع حتى ${count} سجل. الطلب الكبير يعمل على دفعات؛ أبقِ الصفحة مفتوحة حتى تسير المهمة بلا انقطاع، وإن أغلقتها فستكمل عند عودتك. سنخبرك عند اكتماله، وإذا تعذر استكماله تعود نقاطك المحجوزة كاملة.`,
    link: "/dashboard/requests",
  };
}

/** The daily watchdog found the job without progress and released it with its whole reserve. */
export function jobStalledNotice(): JobNotice {
  return {
    title: "توقف طلبك وأعدنا نقاطك",
    body: "توقف تنفيذ طلبك عن التقدم قبل اكتماله، فأعدنا نقاطك المحجوزة كاملة لرصيدك دون أي خصم. يمكنك إعادة الطلب متى شئت.",
    link: "/dashboard/requests",
  };
}

const buttonRequests = "افتح طلباتي";

export function startedNoticeFull(input: { targetVolumeMax: number; driver?: DriverMode }): JobNoticeFull {
  const base = jobStartedNotice(input);
  return { ...base, kind: "started", email: { subject: base.title, heading: base.title, lead: base.body, detail1: "", detail2: "", buttonLabel: buttonRequests } };
}

/** A temporary stop (no chunk progress for ten minutes): not a refund, nothing is charged beyond what was delivered. */
export function stalledNoticeFull(): JobNoticeFull {
  const body = `${STALLED_LINE_AR} نحاول استئنافها تلقائيًا، وسنخبرك عند اكتمالها.`;
  return { kind: "stalled", title: "توقف طلبك مؤقتًا", body, link: "/dashboard/requests", email: { subject: "توقف طلبك مؤقتًا", heading: "توقف طلبك مؤقتًا", lead: body, detail1: "", detail2: "", buttonLabel: buttonRequests } };
}

export interface CompletionFacts {
  delivered: number;
  requested: number;
  chargedPoints: number;
  refundedPoints: number;
}

const arCount = (n: number) => toArabicDigits(Math.max(0, Math.round(n)));

/** Completed in full, or partially: what was delivered, what was charged and what came back, in plain Arabic. */
export function completionNoticeFull(facts: CompletionFacts): JobNoticeFull {
  const partial = facts.requested > 0 && facts.delivered < facts.requested;
  if (!partial) {
    const body = `تم استخراج ${arCount(facts.delivered)} عنصر بنجاح. يمكنك الآن مراجعة وتحميل النتائج.`;
    return { kind: "completed", title: "اكتمل طلب استخراج البيانات بنجاح", body, link: "/dashboard/jobs", email: null };
  }
  const lead = `اكتمل طلبك جزئيًا: وصلك ${arCount(facts.delivered)} من ${arCount(facts.requested)} مطلوب، لأن المصدر لم يتوفر فيه عدد أكبر يطابق طلبك.`;
  const detail1 = `خُصم ${pointsAr(facts.chargedPoints, arCount)} مقابل ما سُلّم فقط.`;
  const detail2 = facts.refundedPoints > 0 ? `وعادت ${pointsAr(facts.refundedPoints, arCount)} إلى رصيدك.` : "";
  return {
    kind: "partial",
    title: "اكتمل طلبك جزئيًا",
    body: `${lead} ${detail1}${detail2 ? ` ${detail2}` : ""}`,
    link: "/dashboard/jobs",
    email: { subject: "اكتمل طلبك جزئيًا", heading: "اكتمل طلبك جزئيًا", lead, detail1, detail2, buttonLabel: "تحميل الملفات" },
  };
}

/** The request could not finish and its whole reserve came back with no charge. */
export function releasedNoticeFull(refundedPoints: number, options: { withEmail?: boolean } = {}): JobNoticeFull {
  const detail = refundedPoints > 0 ? `أعدنا ${pointsAr(refundedPoints, arCount)} محجوزة كاملة إلى رصيدك دون أي خصم.` : "أعدنا نقاطك المحجوزة كاملة إلى رصيدك دون أي خصم.";
  const lead = "تعذّر استكمال طلبك.";
  const title = "تعذّر تنفيذ طلبك وأعدنا نقاطك";
  // By default in-app only: the release that goes through the refund e-mail already has one. A release made inside the failure record has no
  // other e-mail, so its caller asks for this one (the same notice id and e-mail key, so it is sent at most once per job).
  return {
    kind: "released", title, body: `${lead} ${detail}`, link: "/dashboard/requests",
    email: options.withEmail ? { subject: title, heading: title, lead, detail1: detail, detail2: "", buttonLabel: buttonRequests } : null,
  };
}

/**
 * Sends one notice of a job: the in-app row first (a deterministic id, so the same notice twice is a no-op), then, only for a new
 * row and only when the notice has an e-mail and the customer's preferences allow it, the e-mail (idempotent by key). Never throws:
 * a notice must never fail the path that sends it, and it never touches money. At most JOB_NOTICES_PER_JOB_LIMIT per job.
 */
export async function sendJobNotice(
  adminClient: any,
  userId: string,
  jobId: string,
  notice: JobNoticeFull,
  now: () => Date = () => new Date(),
): Promise<{ inApp: boolean; email: boolean }> {
  const result = { inApp: false, email: false };
  try {
    if (!userId || !jobId) return result;
    try {
      const count = await adminClient.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", userId).like("id", `notif\\_%\\_${jobId}`);
      if (typeof count?.count === "number" && count.count >= JOB_NOTICES_PER_JOB_LIMIT) return result;
    } catch {
      // the limit check is best effort; the deterministic ids already make each kind at most once
    }
    result.inApp = await insertJobNotice(adminClient, userId, { title: notice.title, body: notice.body, link: notice.link, id: jobNoticeId(notice.kind, jobId) }, now);
    if (!result.inApp || !notice.email) return result;
    const recipient = await getRecipient(adminClient, userId, "job-update");
    if (!recipient) return result;
    const sent = await sendPlatformEmail("job-update", recipient.email, {
      Name: recipient.name,
      Subject: notice.email.subject,
      Heading: notice.email.heading,
      Lead: notice.email.lead,
      DetailOne: notice.email.detail1,
      DetailTwo: notice.email.detail2,
      ButtonLabel: notice.email.buttonLabel,
      JobURL: `${(process.env.NEXT_PUBLIC_SITE_URL || "https://diger.tech").replace(/\/+$/, "")}/dashboard/requests?job=${encodeURIComponent(jobId)}`,
    }, jobNoticeEmailKey(notice.kind, jobId));
    result.email = Boolean(sent?.ok);
  } catch {
    // never throws
  }
  return result;
}

/** Inserts an in-app notice; never throws (a notice must never fail the job path that sends it). */
export async function insertJobNotice(adminClient: any, userId: string, notice: JobNotice, now: () => Date = () => new Date()): Promise<boolean> {
  try {
    const res = await adminClient.from("notifications").insert({
      id: notice.id || `notif_${now().getTime()}_${Math.random().toString(36).substring(2, 7)}`,
      user_id: userId,
      title: notice.title,
      body: notice.body,
      link: notice.link,
      read: false,
      created_at: now().toISOString(),
    });
    return !res?.error;
  } catch {
    return false;
  }
}
