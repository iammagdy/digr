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
