import ExcelJS from "exceljs";
import { zipSync, strToU8 } from "fflate";
import { csvCell } from "../agentMission/csvText";
import { APPROX_WORD_AR } from "../agentMission/relativeDates";
import { withoutProviderHosts } from "../agentMission/providerLabels";

/**
 * THE CUSTOMER'S CSV (round 32). A customer's CSV is built FROM THE MISSION'S OWN EXCEL, the file the customer already has, so the two always say the same thing, for every mission ever delivered (the worker stored only one CSV, the deepest stage's,
 * which is not the whole delivery of a mission with more than one stage, so that stored file is never what a customer gets).
 *
 *   - one CSV per DATA SHEET of the workbook (every delivered stage; the first sheet is the summary and the methodology and is not a stage): the sheet's header row, then its rows, in the sheet's own order and columns;
 *   - the first sheet (what each sheet holds, the counts, the methodology and the limits of the delivery) is a CSV of its own, `methodology.csv`: ordinary data tables never carry a note row;
 *   - a text cell that starts like a formula gets the same apostrophe mark as the worker's CSV (csvText.ts), a date is written as the worker's CSV writes it, a link is its address, a missing value is empty;
 *   - the same last look as the worker's file: an address of a data provider is taken out of every cell (an older mission's file is read again here, so it is cleaned again; providerLabels.ts).
 * Pure: nothing is read from or written to any store here.
 */
export interface CsvStageFile { /** The sheet's name (the stage's title). */ sheet: string; /** The CSV text, UTF-8 with a byte-order mark, CRLF between rows. */ csv: string; /** Rows below the header. */ rows: number }
export interface CsvExport { stages: CsvStageFile[]; methodologyCsv: string }

const BOM = "﻿";
const DATE_TIME_FORMAT = "yyyy-mm-dd hh:mm";
const pad = (n: number): string => String(n).padStart(2, "0");

/** A date cell the way the worker's CSV writes it: a day «2026-10-28», a moment «2026-10-28 23:06» (the Cairo wall clock, stored as if it were UTC), a computed day with the word «تقريبًا». */
function dateText(d: Date, numFmt: string): string {
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (numFmt.includes(APPROX_WORD_AR)) return `${day} (${APPROX_WORD_AR})`;
  if (numFmt.toLowerCase().includes("hh")) return `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return day;
}

/** The text of one cell: what the customer reads in the Excel. */
export function cellText(cell: ExcelJS.Cell): string {
  // a merged cell holds its value in its first cell only
  if (cell.isMerged && cell.master && cell.master.address !== cell.address) return "";
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return dateText(v, String(cell.numFmt ?? DATE_TIME_FORMAT));
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "نعم" : "لا";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: unknown }>).map((p) => String(p.text ?? "")).join("");
    if ("hyperlink" in o || "text" in o) return typeof o.text === "string" ? o.text : Array.isArray((o.text as { richText?: unknown } | undefined)?.richText) ? ((o.text as { richText: Array<{ text?: unknown }> }).richText).map((p) => String(p.text ?? "")).join("") : String(o.hyperlink ?? "");
    if ("result" in o && o.result !== undefined && o.result !== null) return String(o.result);
  }
  return "";
}

function rowOf(sheet: ExcelJS.Worksheet, rowNumber: number, width: number): string[] {
  const row = sheet.getRow(rowNumber);
  return Array.from({ length: width }, (_, c) => cellText(row.getCell(c + 1)));
}

const toCsv = (rows: string[][]): string => `${BOM}${rows.map((r) => r.map((c) => csvCell(withoutProviderHosts(c))).join(",")).join("\r\n")}`;

export async function csvExportFromWorkbook(xlsx: ArrayBuffer | Uint8Array | Buffer): Promise<CsvExport> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((xlsx instanceof ArrayBuffer ? xlsx : Buffer.from(xlsx as Uint8Array)) as unknown as ArrayBuffer);
  const [summary, ...dataSheets] = wb.worksheets;
  if (!summary || dataSheets.length === 0) throw new Error("workbook has no data sheet");

  const stages: CsvStageFile[] = dataSheets.map((sheet) => {
    const width = Math.max(1, sheet.columnCount);
    const rows: string[][] = [];
    for (let r = 1; r <= sheet.rowCount; r += 1) rows.push(rowOf(sheet, r, width));
    return { sheet: sheet.name, csv: toCsv(rows), rows: Math.max(0, rows.length - 1) };
  });

  // the first sheet: every row that has anything, as wide as the widest row (a rectangular table; a note or a block is its first cells)
  const width = Math.max(1, summary.columnCount);
  const grid: string[][] = [];
  for (let r = 1; r <= summary.rowCount; r += 1) {
    const cells = rowOf(summary, r, width);
    if (cells.some((c) => c.trim() !== "")) grid.push(cells);
  }
  return { stages, methodologyCsv: toCsv(grid) };
}

/** A name that is safe inside an archive and on a disk. */
const safeEntry = (name: string): string => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 60) || "stage";

export const METHODOLOGY_FILE_NAME = "methodology.csv";
export const METHODOLOGY_ENTRY_AR = "المنهجية.csv";

export type CsvPackage =
  | { kind: "csv"; body: Buffer; /** Rows below the header. */ rows: number }
  | { kind: "zip"; body: Buffer; /** The entries of the archive, in order. */ entries: string[]; rows: number };

/** ONE delivered stage: its CSV as it is. MORE THAN ONE: an archive with a CSV per stage, numbered in the order of the sheets, and the methodology. Nothing is left out. */
export function packageCsvExport(exp: CsvExport): CsvPackage {
  const rows = exp.stages.reduce((n, s) => n + s.rows, 0);
  if (exp.stages.length === 1) return { kind: "csv", body: Buffer.from(exp.stages[0].csv, "utf8"), rows };
  const files: Record<string, Uint8Array> = {};
  const entries: string[] = [];
  exp.stages.forEach((s, i) => {
    const name = `${pad(i + 1)}-${safeEntry(s.sheet)}.csv`;
    entries.push(name);
    files[name] = strToU8(s.csv);
  });
  entries.push(METHODOLOGY_ENTRY_AR);
  files[METHODOLOGY_ENTRY_AR] = strToU8(exp.methodologyCsv);
  return { kind: "zip", body: Buffer.from(zipSync(files, { level: 6 })), entries, rows };
}
