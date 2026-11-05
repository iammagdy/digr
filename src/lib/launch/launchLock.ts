/**
 * ONE real launch-email run at a time, across every server instance.
 *
 * Why: the per-recipient claim (`markSent`) is a read-then-write of `app_metadata`; the sign-in service has no compare-and-set. Two overlapping runs
 * could therefore both claim and both send the same person, and each would spend its own cap. A run takes this lock before it sends anything.
 *
 * How (no migration, no new table): one row of the existing `agent_settings` table, key `launch_email_lock:<campaign>`, taken by ONE atomic
 * INSERT (the primary key on `key` lets exactly one caller win). A crashed run leaves a row that expires after the lease: an expired row is taken over
 * by ONE atomic conditional UPDATE (`updated_at` older than the cutoff), so two callers can never both take it over. Release deletes only the
 * caller's own row (matched on `holder`). Any unexpected database answer means NOT acquired: it fails closed and nothing is sent.
 * Only the admin route (service role) touches this key; nothing reads it but this file.
 */
const TABLE = "agent_settings";

/** Longer than a run can last (the runner's 45 s budget + the route's 60 s limit): a live run is never taken over. */
export const LAUNCH_LOCK_LEASE_MS = 150_000;

export const launchLockKey = (campaign: string): string => `launch_email_lock:${campaign}`;

export async function acquireLaunchLock(admin: any, campaign: string, holder: string, nowMs: number = Date.now()): Promise<boolean> {
  const key = launchLockKey(campaign);
  const at = new Date(nowMs).toISOString();
  try {
    const inserted = await admin.from(TABLE).insert({ key, value: { holder, at }, updated_at: at });
    if (!inserted?.error) return true;
    // 23505 = the row exists (another run holds it, or a crashed run left it): only an EXPIRED row may be taken over, atomically
    if (inserted.error.code !== "23505") return false;
    const cutoff = new Date(nowMs - LAUNCH_LOCK_LEASE_MS).toISOString();
    const taken = await admin.from(TABLE).update({ value: { holder, at }, updated_at: at }).eq("key", key).lt("updated_at", cutoff).select("key");
    return !taken?.error && Array.isArray(taken?.data) && taken.data.length === 1;
  } catch {
    return false;
  }
}

/** Removes the caller's own lock row; never throws, never removes another run's lock. */
export async function releaseLaunchLock(admin: any, campaign: string, holder: string): Promise<void> {
  try {
    await admin.from(TABLE).delete().eq("key", launchLockKey(campaign)).eq("value->>holder", holder);
  } catch {
    /* the lease expires by itself */
  }
}
