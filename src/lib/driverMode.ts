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

/** «تقدر تقفل الصفحة» may be said only when the always-on driver is on. */
export const canClosePage = (mode: DriverMode): boolean => mode === "cron";
