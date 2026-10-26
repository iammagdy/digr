export type ResultFormat = "xlsx" | "pdf" | "csv";

export const RESULT_FORMATS: readonly ResultFormat[] = ["xlsx", "pdf", "csv"];

export type ResultFileIds = Partial<Record<ResultFormat, string | null>>;

/**
 * Formats that actually exist for a finished job. A format is produced only when its stored file id is
 * set; the others are generated from the saved data when the customer asks. With no artifact record at
 * all (an older job) the plan's default, Excel, is the only format presented as ready.
 */
export function producedFormats(fileIds?: ResultFileIds | null, options: { nothingDelivered?: boolean } = {}): ResultFormat[] {
  // A request that delivered nothing has no file: the default format is not presented as ready.
  if (options.nothingDelivered) return [];
  if (!fileIds) return ["xlsx"];
  const produced = RESULT_FORMATS.filter((format) => Boolean(fileIds[format]));
  return produced.length > 0 ? produced : ["xlsx"];
}

/**
 * A result (file or rows) is released to the customer only when the request settled and charged: its status is completed (or done), or points were
 * charged for it. The files are saved BEFORE settlement, and a request that fails at settlement keeps `delivered_units` (a release does not reset it)
 * but is not charged and not delivered: its file and rows are never served. Money is never read or written here; the caller passes the job row.
 */
export function resultsReleasable(job: { status?: unknown; charged_credits?: unknown; chargedCredits?: unknown } | null | undefined): boolean {
  const status = String(job?.status || "").toLowerCase();
  return status === "completed" || status === "done" || (Number(job?.charged_credits ?? job?.chargedCredits) || 0) > 0;
}

/** What the customer is told when a request has no releasable result (Arabic only, no hold wording other than the approved one). */
export const NO_RELEASABLE_RESULT_AR = "لا يوجد ملف لتحميله لأن هذا الطلب لم يكتمل، ولم يُخصم منك أي رصيد.";

/** A finished-and-failed request that delivered no record: nothing to download. */
export function deliveredNothing(job: { status?: unknown; delivered?: unknown } | null | undefined): boolean {
  const status = String(job?.status || "").toLowerCase();
  return ["failed", "cancelled", "canceled", "refused"].includes(status) && !(Number(job?.delivered) > 0);
}

/** Formats not produced for this job; offered as «generate on request» from the saved data. */
export function onRequestFormats(fileIds?: ResultFileIds | null, options: { nothingDelivered?: boolean } = {}): ResultFormat[] {
  if (options.nothingDelivered) return [];
  const produced = new Set(producedFormats(fileIds));
  return RESULT_FORMATS.filter((format) => !produced.has(format));
}
