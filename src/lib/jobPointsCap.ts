/**
 * The ONE per-job points cap. Every TypeScript place that limits a job's reserve or settlement reads this constant (the quote
 * writer, the calculator, the public pages, the assistant's platform guide, the decision-maker pricing, the settlement call of the worker).
 * The SQL functions hold the same number (create_quote_atomic, settle_people_job_atomic, and the default of settle_job_atomic): the proposal
 * docs/proposals/job-cap-25000/ raises them to this value, by hand, in the order its README gives. APPLY THAT SQL BEFORE this code is deployed:
 * with the old SQL (600) a quote above 600 points is refused by the database.
 *
 * 25,000 points = 2,500 EGP. The reserve of the owner's 300-post Facebook request with about 5 comments per post is 21,735 points (posts 8 points,
 * comments 11 points, 15% buffer on the reserve only); 25,000 holds that with about 15% to spare. One point costs the platform at most 1/5,500 USD.
 *
 * The `JOB_MAX_POINTS_CAP` environment variable may only LOWER the cap, never raise it above this constant.
 */
export const JOB_MAX_POINTS_CAP = 25_000;

/**
 * The cap in force: the environment may lower it, never raise it. Every reader that decides what a plan may hold (the quote writer, the calculator, the public pages, the
 * assistant's guide, the decision-maker pricing, the size helpers) reads THIS, so lowering the cap by the environment lowers it on every surface alike. The settlement call of the
 * worker does not: it always passes the constant itself, because a job sold under a higher cap must never be under-charged when the cap is lowered afterwards.
 */
export function effectiveJobPointsCap(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): number {
  const raw = Number(env.JOB_MAX_POINTS_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), JOB_MAX_POINTS_CAP) : JOB_MAX_POINTS_CAP;
}
