/**
 * Who drives a long job to the end. Read-only configuration, never assumed:
 *  - "tab"  (the default): the chunks chain themselves from one chunk to the next and an open page resumes a broken chain;
 *  - "cron": an always-on scheduler (the database's pg_cron, or a platform cron) calls /api/cron/drive every minute, so a job
 *            keeps running with the page closed.
 * "cron" is now decided by a live check, never by configuration: the driver is live when its last tick (driver_heartbeat, written on
 * every authorised /api/cron/drive call) is newer than DRIVER_LIVE_WINDOW_MS (see `liveDriverMode` in server/driverHeartbeat.ts).
 * `longJobDriverMode` below only reads the legacy flag and is no longer what the customer is promised from; LONG_JOB_DRIVER can
 * only force "tab" (`driverForcedToTab`).
 */
export type DriverMode = "tab" | "cron";

export function longJobDriverMode(env: Record<string, string | undefined> = process.env): DriverMode {
  return String(env.LONG_JOB_DRIVER || "").trim().toLowerCase() === "cron" ? "cron" : "tab";
}

/** The driver counts as live while its last tick (written by /api/cron/drive into driver_heartbeat) is newer than this. */
export const DRIVER_LIVE_WINDOW_MS = 3 * 60_000;
/** How long any cache of the live answer may live (server memory, /api/driver-status, the page's hook). */
export const DRIVER_STATUS_CACHE_MS = 30_000;

/** The only thing LONG_JOB_DRIVER may still do: force "tab" (value `tab` or `off`). It can never switch the driver on. */
export const driverForcedToTab = (env: Record<string, string | undefined> = process.env): boolean => {
  const value = String(env.LONG_JOB_DRIVER || "").trim().toLowerCase();
  return value === "tab" || value === "off";
};

/** Pure: "cron" only when the last tick is newer than the live window and nothing forces "tab". A missing or future-dated tick is "tab". */
export function driverModeFromTick(lastTickAt: string | Date | null | undefined, nowMs: number = Date.now(), env: Record<string, string | undefined> = process.env): DriverMode {
  if (driverForcedToTab(env) || !lastTickAt) return "tab";
  const at = new Date(lastTickAt).getTime();
  if (!Number.isFinite(at)) return "tab";
  const age = nowMs - at;
  return age >= 0 && age <= DRIVER_LIVE_WINDOW_MS ? "cron" : "tab";
}

/** «تقدر تقفل الصفحة» may be said only when the always-on driver is on. */
export const canClosePage = (mode: DriverMode): boolean => mode === "cron";

/** The line about closing the page, honest for each driver: «تقدر تقفل الصفحة» only when the always-on driver is on. */
export function closePageLineAr(mode: DriverMode): string {
  return canClosePage(mode)
    ? "تقدر تقفل الصفحة وتروح تشرب قهوة، هنكمّل الشغل وهنبعتلك إيميل أول ما نخلص."
    : "أبقِ الصفحة مفتوحة حتى تكتمل المهمة.";
}

/** Anything the server did not send is treated as «tab»: never assume the driver is on. */
export function normalizeDriverMode(value: unknown): DriverMode {
  return value === "cron" ? "cron" : "tab";
}
