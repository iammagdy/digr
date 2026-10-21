/**
 * Who drives a long job to the end. Read-only configuration, never assumed:
 *  - "tab"  (the default): the chunks chain themselves from one chunk to the next and an open page resumes a broken chain;
 *  - "cron": an always-on scheduler (the database's pg_cron, or a platform cron) calls /api/cron/drive every minute, so a job
 *            keeps running with the page closed.
 * The owner turns "cron" on only after the scheduler is set up (docs/proposals/08_long_job_driver_setup.md). Anything else,
 * a missing variable included, means "tab".
 */
export type DriverMode = "tab" | "cron";

export function longJobDriverMode(env: Record<string, string | undefined> = process.env): DriverMode {
  return String(env.LONG_JOB_DRIVER || "").trim().toLowerCase() === "cron" ? "cron" : "tab";
}

/** A driver tick older than this no longer proves the driver is running. */
export const DRIVER_FRESH_MS = 3 * 60_000;

/**
 * The driver the customer may be told about: «cron» only when the flag is «cron» AND the scheduler really called the driver route in the
 * last three minutes. A flag with no recent tick (the scheduler was never set up, was stopped, or the secret is wrong) is «tab»: the page
 * must stay open. `lastTickAt` is the time of the last tick in milliseconds, or null when there is none.
 */
export function effectiveDriverMode(configured: DriverMode, lastTickAt: number | null | undefined, now: number = Date.now()): DriverMode {
  if (configured !== "cron") return "tab";
  if (typeof lastTickAt !== "number" || !Number.isFinite(lastTickAt)) return "tab";
  const age = now - lastTickAt;
  return age >= 0 && age <= DRIVER_FRESH_MS ? "cron" : "tab";
}

/** «تقدر تقفل الصفحة» may be said only when the always-on driver is on (and, through `effectiveDriverMode`, was seen working lately). */
export const canClosePage = (mode: DriverMode): boolean => mode === "cron";

/** The line about closing the page, honest for each driver: «تقدر تقفل الصفحة» only when the always-on driver is on. */
export function closePageLineAr(mode: DriverMode): string {
  return canClosePage(mode)
    ? "تقدر تقفل الصفحة؛ المهمة تكمل وحدها وسنبلغك عند الاكتمال."
    : "أبقِ الصفحة مفتوحة حتى لا يتوقف التنفيذ؛ وإن أغلقتها فستكمل المهمة عند عودتك.";
}

/** Anything the server did not send is treated as «tab»: never assume the driver is on. */
export function normalizeDriverMode(value: unknown): DriverMode {
  return value === "cron" ? "cron" : "tab";
}
