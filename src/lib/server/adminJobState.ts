/**
 * One place that says what state an admin sees for a job. The jobs table's statuses are queued, running, completed, failed and
 * refused (see the `chk_jobs_status` check in the first migration); «done» is not one of them. Pure: no I/O, no write, no money.
 */
import { classifyJob, type JobRowLite } from "./adminOperations";

export type AdminJobState = "done" | "refunded" | "failed" | "refused" | "running" | "queued" | "queued_stuck" | "stalled" | "unknown";

export const ADMIN_JOB_STATE_LABEL_AR: Record<AdminJobState, string> = {
  done: "مكتمل",
  refunded: "حجز مُحرَّر",
  failed: "فشل · حجز مُحرَّر",
  refused: "مرفوض · حجز مُحرَّر",
  running: "قيد التنفيذ",
  queued: "في الانتظار",
  queued_stuck: "عالقة في الانتظار",
  stalled: "متوقفة",
  unknown: "حالة غير معروفة",
};

/** A job that has ended: its hold is settled (charged, or released in full). */
export const ENDED_STATES: readonly AdminJobState[] = ["done", "refunded", "failed", "refused"];

export interface AdminJobInput extends JobRowLite {
  status: string;
  delivered_units?: number | null;
  charged_credits?: number | null;
}

/**
 * A completed job with nothing delivered and nothing charged is «حجز مُحرَّر» (the whole hold was released); a completed job
 * that delivered or charged is «مكتمل». Failed and refused jobs release their hold. Live jobs go by `classifyJob`.
 */
export function adminJobState(job: AdminJobInput, now: number): AdminJobState {
  if (job.status === "completed") {
    return Number(job.delivered_units) > 0 || Number(job.charged_credits) > 0 ? "done" : "refunded";
  }
  if (job.status === "failed") return "failed";
  if (job.status === "refused") return "refused";
  if (job.status === "queued" || job.status === "running") {
    const kind = classifyJob(job, now);
    if (kind === "queued_stuck") return "queued_stuck";
    if (kind === "stalled") return "stalled";
    if (kind === "queued") return "queued";
    return "running";
  }
  return "unknown";
}

/** The tabs of the admin jobs list: each tab names the states it shows. */
export const ADMIN_JOB_TAB_STATES: Record<string, readonly AdminJobState[] | "all"> = {
  all: "all",
  running: ["running", "queued", "queued_stuck", "stalled"],
  done: ["done"],
  failed: ["failed", "refused"],
  refunded: ["refunded"],
};

export interface SuccessRate {
  /** Ended jobs with at least one delivered unit. */
  numerator: number;
  /** Ended jobs (completed, failed, refused). Live jobs are not counted. */
  denominator: number;
  percent: number | null;
  /** Of the numerator, the failed or refused ones: they count as successes by the rule above, so the owner can see them. */
  failedWithDelivery: number;
}

export function successRate(jobs: Array<{ state: AdminJobState; delivered: number }>): SuccessRate {
  let numerator = 0;
  let denominator = 0;
  let failedWithDelivery = 0;
  for (const job of jobs) {
    if (!ENDED_STATES.includes(job.state)) continue;
    denominator += 1;
    if (job.delivered > 0) {
      numerator += 1;
      if (job.state === "failed" || job.state === "refused") failedWithDelivery += 1;
    }
  }
  return { numerator, denominator, percent: denominator ? (numerator / denominator) * 100 : null, failedWithDelivery };
}

/** Released points = the sum of the `release` rows (`rel_<jobId>`) of the period. Rows are read only. */
export function releasedPoints(ledger: Array<{ type: string; delta: number | string | null }>): { points: number; rows: number } {
  let points = 0;
  let rows = 0;
  for (const row of ledger) {
    if (row.type !== "release") continue;
    points += Math.abs(Number(row.delta) || 0);
    rows += 1;
  }
  return { points, rows };
}
