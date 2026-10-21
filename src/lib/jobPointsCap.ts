/**
 * The ONE per-job points cap. Every TypeScript place that limits a job's reserve or settlement reads this constant (the quote
 * writer, the calculator, the public pages, the worker's settlement call, the assistant's platform guide). The SQL functions hold the
 * same number (create_quote_atomic, settle_job_atomic, settle_people_job_atomic): see docs/proposals/job-cap-5000/.
 *
 * A reserve above JOB_CONFIRM_ABOVE_POINTS needs the customer's explicit confirmation on the plan before it can be approved.
 * `JOB_MAX_POINTS_CAP` environment variable may only LOWER the cap, never raise it above this constant.
 */
export const JOB_MAX_POINTS_CAP = 5000;
export const JOB_CONFIRM_ABOVE_POINTS = 600;

/** The cap in force: the environment may lower it, never raise it. */
export function effectiveJobPointsCap(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.JOB_MAX_POINTS_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), JOB_MAX_POINTS_CAP) : JOB_MAX_POINTS_CAP;
}

/**
 * The most records one plan item may ask for (the plan editor's schema). The database refuses a quote above its own record ceiling
 * (`accept_quote_atomic`, `v_target_max`): production holds 5,000 today and docs/proposals/job-cap-5000/ raises it to this same number,
 * so apply that step before this code is deployed. What a job can really hold is set by the points cap: see `maxRecordsInOneJob`.
 */
export const PLAN_ITEM_MAX_RECORDS = 100_000;
