export type ResultFormat = "xlsx" | "pdf" | "csv";

export const RESULT_FORMATS: readonly ResultFormat[] = ["xlsx", "pdf", "csv"];

export type ResultFileIds = Partial<Record<ResultFormat, string | null>>;

/**
 * Formats that actually exist for a finished job. A format is produced only when its stored file id is
 * set; the others are generated from the saved data when the customer asks. With no artifact record at
 * all (an older job) the plan's default, Excel, is the only format presented as ready.
 */
export function producedFormats(fileIds?: ResultFileIds | null): ResultFormat[] {
  if (!fileIds) return ["xlsx"];
  const produced = RESULT_FORMATS.filter((format) => Boolean(fileIds[format]));
  return produced.length > 0 ? produced : ["xlsx"];
}

/** Formats not produced for this job; offered as «generate on request» from the saved data. */
export function onRequestFormats(fileIds?: ResultFileIds | null): ResultFormat[] {
  const produced = new Set(producedFormats(fileIds));
  return RESULT_FORMATS.filter((format) => !produced.has(format));
}
