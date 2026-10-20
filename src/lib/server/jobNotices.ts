import { toArabicDigits } from "../arabicDigits";

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
}

/** A large request runs in the background in batches; the customer may close the page, and is told what happens in each case. */
export function jobStartedNotice(input: { targetVolumeMax: number }): JobNotice {
  return {
    title: "بدأ تنفيذ طلبك الكبير",
    body: `بدأ جمع حتى ${toArabicDigits(Math.floor(input.targetVolumeMax))} سجل. الطلب الكبير يعمل على دفعات في الخلفية، ويمكنك إغلاق الصفحة؛ سنخبرك عند اكتماله، وإذا تعذر استكماله تعود نقاطك المحجوزة كاملة.`,
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

/** Inserts an in-app notice; never throws (a notice must never fail the job path that sends it). */
export async function insertJobNotice(adminClient: any, userId: string, notice: JobNotice, now: () => Date = () => new Date()): Promise<boolean> {
  try {
    const res = await adminClient.from("notifications").insert({
      id: `notif_${now().getTime()}_${Math.random().toString(36).substring(2, 7)}`,
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
