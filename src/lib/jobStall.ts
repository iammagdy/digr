/**
 * When a running job is «stalled» for the customer. Pure: it reads timestamps the jobs row already carries and decides nothing
 * about money. Nothing here settles, releases or charges; the existing resume path (the open page's nudge, the always-on
 * driver) is what moves a stalled job again, and the existing atomic functions are what settle or release it.
 *
 * N is 10 minutes. A chunk lasts at most 45 seconds and holds a 60-second lease, a retry waits at most a few minutes, and the
 * once-a-minute driver resumes a broken chain within a minute: so ten minutes with no chunk progress and no live lease is not
 * ordinary waiting, while it is still well before the watchdog's 30-minute refund (`REFUND_AFTER_MS` in adminOperations).
 */
export const STALL_AFTER_MS = 10 * 60 * 1000;

/** The sentence the customer sees on a stalled job (exact). */
export const STALLED_LINE_AR = "المهمة متوقفة مؤقتًا، ولن يُخصم أكثر من المُسلَّم.";

export interface StallJobRow {
  status?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  lease_until?: string | null;
}

const ms = (value: string | null | undefined) => (value ? new Date(value).getTime() : Number.NaN);

/** Milliseconds since the job last moved (its last claim or completed chunk); null when unknown. */
export function idleMs(job: StallJobRow, now: number): number | null {
  const touched = ms(job.updated_at ?? job.created_at);
  return Number.isFinite(touched) ? Math.max(0, now - touched) : null;
}

/** A queued or running job with no live lease and no chunk progress for STALL_AFTER_MS. */
export function isJobStalled(job: StallJobRow, now: number): boolean {
  if (job.status !== "queued" && job.status !== "running") return false;
  const lease = ms(job.lease_until);
  if (Number.isFinite(lease) && lease > now) return false;
  const idle = idleMs(job, now);
  return idle !== null && idle >= STALL_AFTER_MS;
}
