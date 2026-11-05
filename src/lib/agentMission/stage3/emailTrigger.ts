/**
 * STAGE 3, WHEN A JOB SENDS ONE E-MAIL (docs/STAGE-3.md, FOUNDATION-PLAN PR 5). A pure decision; nothing here sends, and no template is made (the e-mail template lives in `src/functions/**`,
 * which needs the owner's explicit go: the proposal is in docs/STAGE-3.md). One e-mail per job, only when the job has finished and the customer's MEASURED wait (from the stored approval time
 * to the stored finish time) was over one minute, to an address that can receive, and within Resend's 50,000 e-mails a month (a count that is not known sends nothing).
 */
export const EMAIL_WAIT_THRESHOLD_MS = 60_000;
export const RESEND_MONTHLY_LIMIT = 50_000;
const FINISHED = new Set(["completed", "partial", "failed", "unserved"]);

export interface EmailJobFacts {
  status: string;
  /** The stored moment the customer approved (the wait starts), or null. */
  approvedAtMs: number | null;
  /** The stored moment the job finished, or null. */
  finishedAtMs: number | null;
  /** This job already sent its e-mail (stored on the job by the wiring). */
  alreadyEmailed: boolean;
  /** A real address with e-mails on (customerActions `userWillBeEmailed`). */
  emailable: boolean;
  /** E-mails sent this calendar month, or null when not counted. */
  sentThisMonth: number | null;
}
export type EmailReason = "waited_long" | "not_finished" | "wait_not_measured" | "already_emailed" | "not_emailable" | "short_wait" | "quota_unknown" | "monthly_limit";

/** The measured wait, or null when a stored time is missing or impossible (never a guess). */
export function measuredWaitMs(job: Pick<EmailJobFacts, "approvedAtMs" | "finishedAtMs">): number | null {
  const a = job.approvedAtMs, f = job.finishedAtMs;
  if (typeof a !== "number" || typeof f !== "number" || !Number.isFinite(a) || !Number.isFinite(f) || f < a) return null;
  return f - a;
}

export function emailDecision(job: EmailJobFacts): { send: boolean; reason: EmailReason; waitMs: number | null } {
  const waitMs = measuredWaitMs(job);
  const no = (reason: EmailReason) => ({ send: false, reason, waitMs });
  if (!FINISHED.has(job.status)) return no("not_finished");
  if (waitMs === null) return no("wait_not_measured");
  if (job.alreadyEmailed) return no("already_emailed");
  if (!job.emailable) return no("not_emailable");
  if (waitMs <= EMAIL_WAIT_THRESHOLD_MS) return no("short_wait");
  if (job.sentThisMonth === null || !Number.isFinite(job.sentThisMonth)) return no("quota_unknown");
  if (job.sentThisMonth >= RESEND_MONTHLY_LIMIT) return no("monthly_limit");
  return { send: true, reason: "waited_long", waitMs };
}

export const shouldNotifyByEmail = (job: EmailJobFacts): boolean => emailDecision(job).send;
