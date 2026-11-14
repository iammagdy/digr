import { STALL_AFTER_MS, isJobStalled } from "../jobStall";
import { jobNoticeId, sendJobNotice, stalledNoticeFull } from "./jobNotices";

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
    // ONE read for the whole batch: a job whose stalled notice already exists is skipped here. Without it, a job that stays stalled was asked about
    // on EVERY call (a count, then an insert the primary key refuses), every minute, for as long as it stayed stalled. The outcome is the same either
    // way (no second notice, no e-mail: the e-mail goes only with a notice that was just inserted); an unreadable answer falls back to the old path.
    const already = await existingStalledNotices(adminClient, stalled.map((job: any) => String(job.id)));
    let notified = 0;
    for (const job of stalled) {
      if (already.has(jobNoticeId("stalled", String(job.id)))) continue;
      const result = await sendJobNotice(adminClient, job.user_id, job.id, stalledNoticeFull(), () => new Date(now));
      if (result.inApp) notified += 1;
    }
    return { considered: stalled.length, notified };
  } catch {
    return { considered: 0, notified: 0 };
  }
}

/** The ids of the stalled notices that already exist for these jobs (`notif_stalled_<job id>`, the deterministic id). Read-only; any failure is an empty set (every job is then tried as before). */
async function existingStalledNotices(adminClient: any, jobIds: string[]): Promise<Set<string>> {
  if (!jobIds.length) return new Set();
  try {
    const { data, error } = await adminClient.from("notifications").select("id").in("id", jobIds.map((id) => jobNoticeId("stalled", id)));
    if (error || !Array.isArray(data)) return new Set();
    return new Set(data.map((row: { id?: unknown }) => String(row?.id ?? "")));
  } catch {
    return new Set();
  }
}
