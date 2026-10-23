import { REVIEW_DAILY_CEILING_USD, socialReviewCapPreviousRuleUsd, socialReviewCapUsd, type ReviewLevel } from "./rowReviewAdvisor";

/**
 * The daily guard on the automatic review: what the review has cost today (UTC day, from the `llm_usage` rows whose reason starts with
 * `relevance_review`, failed calls included) against REVIEW_DAILY_CEILING_USD. When the ceiling is reached, a job that has not started reviewing
 * takes the PREVIOUS budget rule (20% of its expected revenue, floor one call) instead of the per-job ceiling, so chat and delivery keep working.
 * Fail-safe: when today's spend cannot be read, the previous rule applies too, never the larger budget.
 *
 * It only reads. The read is kept by one instance for REVIEW_DAILY_CACHE_MS, and the spend this instance records after the read is added to the
 * cached sum (`noteReviewSpend`), so it never under-counts its own traffic and does not add many queries. It never throws.
 */
export const REVIEW_DAILY_CACHE_MS = 45_000;
const PAGE = 1000;
const MAX_PAGES = 30;

export const utcDayStartIso = (now: number): string => {
  const at = new Date(now);
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())).toISOString();
};

/** Today's review spend in USD, read from the database; null when it cannot be read or the read did not reach the last row (never a partial sum). */
export async function readReviewSpendTodayUsd(admin: any, now: number): Promise<number | null> {
  try {
    const since = utcDayStartIso(now);
    let total = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { data, error } = await admin.from("llm_usage").select("cost_usd").like("reason", "relevance_review%").gte("created_at", since).order("created_at", { ascending: true }).range(page * PAGE, page * PAGE + PAGE - 1);
      if (error || !Array.isArray(data)) return null;
      for (const row of data) total += Number(row?.cost_usd) || 0;
      if (data.length < PAGE) return total;
    }
    return null;
  } catch {
    return null;
  }
}

let ownSpendUsd = 0;
let cache: { day: string; at: number; usd: number | null; ownAtRead: number } | null = null;
let inFlight: { day: string; promise: Promise<void> } | null = null;
let mode: "real" | "off" | undefined;

/** Records the review spend of THIS instance (USD) so the cached sum can add it. */
export function noteReviewSpend(costUsd: number): void {
  if (Number.isFinite(costUsd) && costUsd > 0) ownSpendUsd += costUsd;
}

/** Test-only: "real" runs the guard in tests, "off" (and, in tests, the default) never applies it; also clears the cache. */
export function setReviewDailyGuardForTesting(next: "real" | "off" | undefined): void {
  mode = next;
  cache = null;
  inFlight = null;
  ownSpendUsd = 0;
}

/** Today's review spend as this instance sees it: the cached read plus its own spend since, or null when it cannot be read (the failure is kept for the same window). */
export async function reviewSpendToday(admin: any, now: number = Date.now()): Promise<number | null> {
  const day = utcDayStartIso(now);
  if (!(cache && cache.day === day && now - cache.at < REVIEW_DAILY_CACHE_MS)) {
    let pending = inFlight && inFlight.day === day ? inFlight.promise : null;
    if (!pending) {
      const ownAtRead = ownSpendUsd;
      pending = readReviewSpendTodayUsd(admin, now).then((usd) => { cache = { day, at: now, usd, ownAtRead }; }).finally(() => { inFlight = null; });
      inFlight = { day, promise: pending };
    }
    await pending;
  }
  if (!cache || cache.usd === null) return null;
  return cache.usd + (ownSpendUsd - cache.ownAtRead);
}

export type ReviewBudgetRule = "normal" | "job_fallback" | "daily_ceiling" | "read_failed";

export interface ReviewBudgetDecision {
  capUsd: number;
  rule: ReviewBudgetRule;
  /** True when this chunk is the one that moved the job to the previous rule (the internal `review_fallback` row is written once, then). */
  fresh: boolean;
  todayUsd: number | null;
}

/**
 * The review budget of a job for this chunk.
 *  - A job already on the previous rule keeps it (`stickyFallback`).
 *  - A job that has already reviewed something keeps the rule it began with (`alreadyReviewing`): the daily ceiling decides only for a job that has not started.
 *  - Otherwise: below the ceiling the per-job rule (socialReviewCapUsd); at or above it, or when today's spend cannot be read, the previous rule.
 */
export async function resolveReviewBudget(input: { admin: any; targetMax: number; unitPricePoints: number; stickyFallback?: boolean; alreadyReviewing?: boolean; level?: ReviewLevel; now?: number }): Promise<ReviewBudgetDecision> {
  const normal = socialReviewCapUsd(input.targetMax, input.unitPricePoints, input.level ?? "row");
  const previous = socialReviewCapPreviousRuleUsd(input.targetMax, input.unitPricePoints);
  if (input.stickyFallback) return { capUsd: Math.min(previous, normal), rule: "job_fallback", fresh: false, todayUsd: null };
  if (input.alreadyReviewing) return { capUsd: normal, rule: "normal", fresh: false, todayUsd: null };
  if (process.env.NODE_ENV === "test" && mode === undefined) return { capUsd: normal, rule: "normal", fresh: false, todayUsd: null };
  if (mode === "off") return { capUsd: normal, rule: "normal", fresh: false, todayUsd: null };
  let todayUsd: number | null = null;
  try {
    todayUsd = await reviewSpendToday(input.admin, input.now);
  } catch {
    todayUsd = null;
  }
  if (todayUsd === null) return { capUsd: Math.min(previous, normal), rule: "read_failed", fresh: true, todayUsd };
  if (todayUsd >= REVIEW_DAILY_CEILING_USD) return { capUsd: Math.min(previous, normal), rule: "daily_ceiling", fresh: true, todayUsd };
  return { capUsd: normal, rule: "normal", fresh: false, todayUsd };
}
