/**
 * The ONE per-job points cap. Every TypeScript place that limits a job's reserve or settlement reads this constant (the quote
 * writer, the calculator, the public pages, the assistant's platform guide, the decision-maker pricing). The SQL functions hold the
 * same number (create_quote_atomic, settle_people_job_atomic); nothing here changes them.
 *
 * The `JOB_MAX_POINTS_CAP` environment variable may only LOWER the cap, never raise it above this constant.
 */
export const JOB_MAX_POINTS_CAP = 600;

/** The cap in force: the environment may lower it, never raise it. */
export function effectiveJobPointsCap(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.JOB_MAX_POINTS_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), JOB_MAX_POINTS_CAP) : JOB_MAX_POINTS_CAP;
}
