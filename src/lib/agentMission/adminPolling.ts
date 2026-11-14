/**
 * VERCEL ACTIVE CPU (docs/ops/VERCEL-CPU.md): how often the admin agent console («الوكيل») refreshes. Client-safe (no import).
 *
 * The selected mission's detail is read every 3 seconds while the mission can still change. Once it has ended (the same four statuses as
 * MISSION_TERMINAL in constants.ts, pinned by a test) nothing more happens to it on its own, so it is read once a minute instead of every 3 seconds.
 * The admin's own action still re-reads it at once. Both loops ask only while the tab is visible (visiblePolling.ts).
 */
export const ADMIN_DETAIL_POLL_MS = 3000;
export const ADMIN_DETAIL_ENDED_POLL_MS = 60_000;
export const ADMIN_OVERVIEW_POLL_MS = 10_000;
export const ADMIN_ENDED_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "unserved", "cancelled"]);

export function adminDetailDelayMs(status: string | null | undefined): number {
  return typeof status === "string" && ADMIN_ENDED_STATUSES.has(status) ? ADMIN_DETAIL_ENDED_POLL_MS : ADMIN_DETAIL_POLL_MS;
}
