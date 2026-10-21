import { REVIEW_JOB_CEILING_USD } from "./rowReviewAdvisor";

/** A row of `llm_usage` as the daily review read needs it. */
export interface ReviewUsageRow { created_at: string; reason: string | null; cost_usd: number | string | null }

export interface ReviewSpendDay {
  /** The day in Cairo time (the owner's day), `YYYY-MM-DD`. */
  date: string;
  /** Review calls that got an answer (reason `relevance_review`). */
  calls: number;
  /** Review calls that failed (reason `relevance_review_failed:...`); their cost is what the model billed, usually nothing. */
  failedCalls: number;
  usd: number;
}

export interface ReviewSpendSummary {
  timezone: "Africa/Cairo";
  /** The most one job's review may spend (the constant), so the owner can read the daily total next to the ceiling. */
  jobCeilingUsd: number;
  days: ReviewSpendDay[];
  totalUsd: number;
}

const cairoDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" });
const dayOf = (iso: string): string | null => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : cairoDay.format(at);
};

/**
 * What the automatic review cost per day, from the `llm_usage` rows of the review (reason `relevance_review` or `relevance_review_failed:...`;
 * every other reason is not counted). The last `days` days up to `now`, newest first, a day with no call shown as zero. Read-only.
 */
export function summarizeReviewSpendByDay(rows: ReviewUsageRow[], options: { days: number; now?: Date }): ReviewSpendSummary {
  const days = Math.min(90, Math.max(1, Math.floor(options.days || 1)));
  const now = options.now ?? new Date();
  const byDay = new Map<string, ReviewSpendDay>();
  for (let back = 0; back < days; back += 1) {
    const date = dayOf(new Date(now.getTime() - back * 86_400_000).toISOString())!;
    byDay.set(date, { date, calls: 0, failedCalls: 0, usd: 0 });
  }
  for (const row of rows) {
    const reason = String(row.reason ?? "");
    if (reason !== "relevance_review" && !reason.startsWith("relevance_review_failed")) continue;
    const date = dayOf(row.created_at);
    const day = date ? byDay.get(date) : undefined;
    if (!day) continue;
    if (reason === "relevance_review") day.calls += 1; else day.failedCalls += 1;
    day.usd += Number(row.cost_usd) || 0;
  }
  const list = [...byDay.values()].map((day) => ({ ...day, usd: Number(day.usd.toFixed(6)) }));
  return { timezone: "Africa/Cairo", jobCeilingUsd: REVIEW_JOB_CEILING_USD, days: list, totalUsd: Number(list.reduce((sum, day) => sum + day.usd, 0).toFixed(6)) };
}
