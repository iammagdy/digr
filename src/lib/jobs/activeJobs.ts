/**
 * ONE definition of an «active» job for the customer-facing queue count, the same «stale» rule the watchdog uses to release abandoned
 * work (`src/app/api/cron/watchdog/route.ts`): a job in `queued` or `running` is STALE when more than 30 minutes have passed since its
 * lease ran out, or, when it never had a lease, since it last changed. A stale job is not work in progress: it is not counted in the
 * queue a customer reads (historical verification fixtures from October counted as nine «waiting» requests). Nothing here deletes or
 * edits a job: the rows stay as they are and the watchdog's own release path is untouched. Pure.
 */
export const STALE_ACTIVE_JOB_MS = 30 * 60 * 1000;

export interface ActiveJobRow {
  status?: unknown;
  lease_until?: unknown;
  updated_at?: unknown;
}

function ms(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * The same rule as a PostgREST `or` filter (used with `.in("status", ["queued","running"])` and an exact head count, so a large table is counted by the database, never truncated by the row limit):
 * NOT stale = the lease has not been out for more than 30 minutes, or there is no lease and the row changed within 30 minutes. The tests evaluate this exact text against `isStaleActiveJob`.
 */
export function notStaleActiveJobFilter(nowMs: number = Date.now()): string {
  const cutoff = new Date(nowMs - STALE_ACTIVE_JOB_MS).toISOString();
  return `lease_until.gte.${cutoff},and(lease_until.is.null,updated_at.gte.${cutoff})`;
}

/** True when the watchdog would pick this queued/running job up as abandoned. A row with neither a lease nor a change time is not stale (the watchdog cannot select it either). */
export function isStaleActiveJob(row: ActiveJobRow, nowMs: number = Date.now()): boolean {
  const cutoff = nowMs - STALE_ACTIVE_JOB_MS;
  const lease = ms(row.lease_until);
  if (lease !== null) return lease < cutoff;
  if (row.lease_until !== null && row.lease_until !== undefined) return false;
  const updated = ms(row.updated_at);
  return updated !== null && updated < cutoff;
}

/** Jobs that are really waiting or running now: queued/running and not stale. */
export function countActiveJobs(rows: ReadonlyArray<ActiveJobRow> | null | undefined, nowMs: number = Date.now()): number {
  let n = 0;
  for (const row of rows ?? []) {
    if (row?.status !== "queued" && row?.status !== "running") continue;
    if (!isStaleActiveJob(row, nowMs)) n += 1;
  }
  return n;
}
