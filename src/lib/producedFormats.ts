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

/**
 * THE FILES OF A JOB AS «طلباتي» LISTS THEM, from every place that knows them, so the list is the one the completion panel shows: the job's artifact rows (the newest version first), the file the job stored as its result, and, for an AGENT mission, the files the
 * mission itself delivered (`missions.files`: the Excel and its CSV copy). The artifact rows must be asked for BY JOB: a page that asks for «the latest 100 artifact rows of the account» loses the rows of a job when the account has more (live: 104 rows,
 * the newest mission's Excel row was the one dropped, and the page showed its CSV alone).
 */
export function jobFileIds(input: { artifacts?: ReadonlyArray<{ file_id_xlsx?: string | null; file_id_pdf?: string | null; file_id_csv?: string | null }> | null; resultFileId?: string | null; missionFiles?: ReadonlyArray<{ kind?: unknown; path?: unknown }> | null }): Record<ResultFormat, string | null> {
  const out: Record<ResultFormat, string | null> = { xlsx: null, pdf: null, csv: null };
  for (const a of input.artifacts ?? []) {
    out.xlsx ||= a.file_id_xlsx || null;
    out.pdf ||= a.file_id_pdf || null;
    out.csv ||= a.file_id_csv || null;
  }
  const result = String(input.resultFileId ?? "");
  for (const f of RESULT_FORMATS) if (result.endsWith(`.${f}`)) out[f] ||= result;
  for (const f of input.missionFiles ?? []) {
    const kind = String(f?.kind ?? "");
    if ((kind === "xlsx" || kind === "csv") && !out[kind]) out[kind] = String(f?.path || `mission/result.${kind}`);
  }
  return out;
}
