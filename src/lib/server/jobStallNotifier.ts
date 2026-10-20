import { STALL_AFTER_MS, isJobStalled } from "../jobStall";
import { sendJobNotice, stalledNoticeFull } from "./jobNotices";

/** The most jobs one call notices: the next call picks up the rest. */
export const MAX_STALLED_NOTICES_PER_CALL = 20;

/**
 * Tells the customers of stalled jobs (no chunk progress for STALL_AFTER_MS, no live lease) that their request is temporarily
 * stopped and that nothing beyond what was delivered will be charged: once per job (a deterministic notice id), in the app and by
 * e-mail. It SELECTs jobs and inserts notices; it does not settle, release, charge or move a job: the existing resume path (the
 * open page's nudge, the always-on driver) resumes it, and the existing atomic functions settle or release it.
 */
export async function notifyStalledJobs(adminClient: any, now: number = Date.now(), limit: number = MAX_STALLED_NOTICES_PER_CALL): Promise<{ considered: number; notified: number }> {
  try {
    const { data } = await adminClient
      .from("jobs")
      .select("id, user_id, status, updated_at, created_at, lease_until")
      .in("status", ["queued", "running"])
      .lt("updated_at", new Date(now - STALL_AFTER_MS).toISOString())
      .order("updated_at", { ascending: true })
      .limit(Math.max(1, Math.min(limit, MAX_STALLED_NOTICES_PER_CALL)));
    const stalled = (Array.isArray(data) ? data : []).filter((job: any) => job?.user_id && isJobStalled(job, now));
    let notified = 0;
    for (const job of stalled) {
      const result = await sendJobNotice(adminClient, job.user_id, job.id, stalledNoticeFull(), () => new Date(now));
      if (result.inApp) notified += 1;
    }
    return { considered: stalled.length, notified };
  } catch {
    return { considered: 0, notified: 0 };
  }
}
