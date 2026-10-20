import { isTerminalJobStatus, toChatJobStatus } from "./status";

export interface ProgressNoticeMessage {
  jobId?: string;
  progressNotice?: boolean;
  content?: string;
}

export interface ActiveJobState {
  jobId?: string;
  status?: string;
  [key: string]: any;
}

/**
 * Pure helper determining whether a progress notice line (e.g. "جاري استخراج السجلات...")
 * should be rendered for a message.
 *
 * Rules:
 * 1. Only messages with progressNotice === true are evaluated; normal messages are not notices.
 * 2. If activeJob is null/undefined or its jobId does not match, return false.
 * 3. If activeJob status is terminal (done, completed, failed, cancelled, refused), return false.
 * 4. If terminalJobs map has recorded this jobId as terminal, return false independent of activeJob.
 * 5. Returns true only while activeJob is actively running or queued.
 */
export function shouldShowProgressNotice(
  message: ProgressNoticeMessage | null | undefined,
  activeJob: ActiveJobState | null | undefined,
  terminalJobs?: Map<string, boolean> | Set<string> | null
): boolean {
  if (!message || !message.progressNotice) {
    return false;
  }

  const jId = message.jobId;

  // If known to be terminal in independent map, hide immediately
  if (jId && terminalJobs) {
    if (terminalJobs instanceof Map && terminalJobs.get(jId)) {
      return false;
    }
    if (terminalJobs instanceof Set && terminalJobs.has(jId)) {
      return false;
    }
  }

  if (!activeJob) {
    return false;
  }

  if (jId && activeJob.jobId && jId !== activeJob.jobId) {
    return false;
  }

  if (isTerminalJobStatus(activeJob.status)) {
    return false;
  }

  const chatStatus = toChatJobStatus(activeJob.status);
  return chatStatus === "running" || chatStatus === "queued";
}

/**
 * Pure helper applying a raw database job row to previous chat job state.
 */
export function applyJobRow<T extends { jobId?: string; status?: string }>(
  prev: T | null | undefined,
  row: any
): T & {
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  updatedAt?: string;
  rowsCollected: number;
  chargedCredits?: number;
  reservedCredits?: number;
  requestedRows?: number;
  errorAr?: string;
  startedAt?: string;
  leaseUntil?: string | null;
  nextAttemptAt?: string | null;
  attemptCount?: number;
} {
  const status = toChatJobStatus(row?.status);
  const base = (prev || {}) as T;

  return {
    ...base,
    jobId: row?.id || row?.$id || base.jobId,
    status,
    updatedAt: row?.updated_at ?? (base as any).updatedAt,
    rowsCollected:
      row?.delivered_units ??
      row?.rows_collected ??
      row?.rowsCollected ??
      (base as any).rowsCollected ??
      0,
    chargedCredits: row?.charged_credits ?? row?.chargedCredits ?? (base as any).chargedCredits,
    reservedCredits: row?.reserved_credits ?? row?.reservedCredits ?? (base as any).reservedCredits,
    requestedRows: row?.target_volume_max ?? (base as any).requestedRows,
    errorAr: row?.error_message ?? row?.error_ar ?? row?.errorAr ?? (base as any).errorAr,
    // what the progress line and the stalled line read (timestamps and counts only)
    startedAt: row?.created_at ?? (base as any).startedAt,
    leaseUntil: row?.lease_until !== undefined ? row.lease_until : (base as any).leaseUntil,
    nextAttemptAt: row?.next_attempt_at !== undefined ? row.next_attempt_at : (base as any).nextAttemptAt,
    attemptCount: row?.attempt_count ?? (base as any).attemptCount,
  };
}
