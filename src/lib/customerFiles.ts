import { RESULT_FORMATS, type ResultFormat } from "./producedFormats";

/**
 * A CUSTOMER NEVER SEES OR DOWNLOADS A CSV. The CSV is still produced and stored with every delivered request (the worker writes it, settlement records its path and the close-out counts the delivered items from it), but the files a customer is offered
 * are the Excel (and, where an older request has one, its PDF). An older request that has a CSV and no Excel is still offered an Excel: the download builds it from that CSV, so nobody is left without a file. Pure.
 */
export type CustomerFormat = Exclude<ResultFormat, "csv">;

/** The formats of a request that a customer is offered: never the CSV; a request that has a CSV is always offered the Excel (stored, or built from the CSV when it is asked for). */
export function customerResultFormats(produced: readonly ResultFormat[]): CustomerFormat[] {
  const set = new Set<ResultFormat>(produced);
  if (set.has("csv")) set.add("xlsx");
  return RESULT_FORMATS.filter((f): f is CustomerFormat => f !== "csv" && set.has(f));
}

/** A list of format names with the CSV taken out (for a sentence or a chip). */
export const withoutCsvFormat = <T extends string>(formats: readonly T[]): T[] => formats.filter((f) => String(f).toLowerCase() !== "csv");

/**
 * The stored file ids of a request as an API tells them to a customer: the CSV's id is never given, and a request that has only a CSV says its Excel is ready (it is built from the CSV when asked for). The value of an id is only ever read as «is there one».
 */
export function customerFileIds(ids: { xlsx?: string | null; pdf?: string | null; csv?: string | null } | null | undefined): { xlsx: string | null; pdf: string | null; csv: null } {
  return { xlsx: ids?.xlsx || (ids?.csv ? "ready" : null), pdf: ids?.pdf || null, csv: null };
}
