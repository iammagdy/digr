import { toArabicDigits } from "./arabicDigits";
import { customerResultColumnLabel, previewColumns } from "./customerResultColumns";
import { relativeDateDisplay } from "./relativeDateDisplay";

/**
 * What the customer sees while a request runs, kept in small pure helpers:
 *  - ONE remaining-time figure: the one `computeJobProgress` (jobProgress.ts) works out from the real chunk times. The worker also wrote a
 *    second, differently computed time into every page line («الوقت المتوقع بحسب زمن الصفحات المسجل: نحو ٣١ ثانية»); two times that
 *    disagree are worse than none, so the display drops that segment (the stored line is untouched, old and new jobs alike).
 *  - no line twice: a line that repeats the one before it is shown once.
 *  - a live preview of what was collected: a few accepted rows in the customer's own columns, or, while no row is ready, only the counts.
 */
const WORKER_ETA_SEGMENT = /\s*·\s*الوقت المتوقع بحسب زمن الصفحات المسجل:[^·\n]*?(?=\s*·|\s*$)/gu;

/** The page line without the worker's own time estimate. */
export function stripWorkerEta(text: string): string {
  return String(text ?? "").replace(WORKER_ETA_SEGMENT, "").trim();
}

const sameLine = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** Events as the panel lists them: the worker's second time removed, and a line identical to the one just before it shown once. */
export function liveEventsForDisplay<T extends { textAr: string }>(events: readonly T[]): T[] {
  const out: T[] = [];
  for (const event of events) {
    const textAr = stripWorkerEta(event.textAr);
    if (!textAr) continue;
    const previous = out[out.length - 1];
    if (previous && sameLine(previous.textAr, textAr)) continue;
    out.push({ ...event, textAr });
  }
  return out;
}

export const PREVIEW_MAX_ROWS = 5;
export const PREVIEW_MAX_COLUMNS = 4;
const PREVIEW_CELL_MAX_CHARS = 80;

export interface LivePreviewSample {
  columns: Array<{ key: string; titleAr: string }>;
  rows: string[][];
}

/** A date or a date with a time as the files keep it (ISO text): the preview shows it in Arabic-Indic digits, like the results table. */
const ISO_DATE_TEXT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  // numbers and dates are shown in Arabic-Indic digits (a comment's own words are left as written)
  if (typeof value === "number" && Number.isFinite(value)) return toArabicDigits(value);
  const text = (typeof value === "object" ? JSON.stringify(value) : String(value)).replace(/[#*_`>~|\\]+/g, " ").replace(/\s+/g, " ").trim();
  if (ISO_DATE_TEXT.test(text)) return toArabicDigits(text);
  const relative = text ? relativeDateDisplay(text) : null;
  if (relative) return relative;
  return text.length <= PREVIEW_CELL_MAX_CHARS ? text : `${text.slice(0, PREVIEW_CELL_MAX_CHARS - 1).trimEnd()}…`;
};

/** A few accepted rows in the columns the customer reads (never ids or links of a social record), or null when there is nothing to show. */
const COMPANY_PREVIEW_ORDER = ["company_name", "industry", "website", "city", "location", "work_email", "phone", "description"];

export function buildLivePreviewSample(rows: ReadonlyArray<Record<string, any>>, columns: readonly string[], isCompanyDataset: boolean): LivePreviewSample | null {
  // The same reading order as the results table: a company's name first; the plain text and the location are left out when the
  // description and the city already say it.
  let ordered = [...columns];
  if (ordered.includes("description")) ordered = ordered.filter((key) => key !== "text");
  if (ordered.includes("city")) ordered = ordered.filter((key) => key !== "location");
  if (isCompanyDataset) ordered = [...COMPANY_PREVIEW_ORDER.filter((key) => ordered.includes(key)), ...ordered.filter((key) => !COMPANY_PREVIEW_ORDER.includes(key))];
  const shown = previewColumns(ordered, isCompanyDataset)
    .filter((key, index, list) => list.findIndex((other) => customerResultColumnLabel(other) === customerResultColumnLabel(key)) === index)
    .filter((key) => rows.some((row) => cellText(row?.[key]) !== ""))
    .slice(0, PREVIEW_MAX_COLUMNS);
  const picked = rows.slice(-PREVIEW_MAX_ROWS);
  if (!shown.length || !picked.length) return null;
  return {
    columns: shown.map((key) => ({ key, titleAr: customerResultColumnLabel(key) })),
    rows: picked.map((row) => shown.map((key) => cellText(row?.[key]))),
  };
}

export const PREVIEW_TITLE_AR = "معاينة مباشرة لما جُمع";
export const PREVIEW_WAITING_AR = "لم يُعتمد أي سجل للمعاينة بعد؛ تظهر أعلاه الأعداد فور كل دفعة، وتظهر السجلات هنا عند اعتماد أولها.";

/** The counts line shown under the preview (Arabic-Indic digits). */
export function previewCountsLineAr(input: { accepted: number; requested?: number; received?: number | null; underReview?: number | null }): string {
  const parts = [`المقبول حتى الآن ${toArabicDigits(Math.max(0, Math.floor(input.accepted)))}${input.requested ? ` من ${toArabicDigits(Math.floor(input.requested))}` : ""}`];
  if (typeof input.received === "number") parts.push(`استلمنا ${toArabicDigits(input.received)}`);
  if (typeof input.underReview === "number" && input.underReview > 0) parts.push(`قيد المراجعة ${toArabicDigits(input.underReview)}`);
  return parts.join(" · ");
}
