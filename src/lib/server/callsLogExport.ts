import ExcelJS from "exceljs";
import type { CallsLogRow } from "./adminCallsLog";

/**
 * CSV and XLSX of the CURRENT FILTERED calls log (admin only). One column list, one text neutralizer, two writers.
 *
 * Formula injection: a text cell that a spreadsheet would read as a formula (it starts with = + - @, a tab or a carriage return, after any
 * leading blanks) gets a leading apostrophe. Only such cells are touched, so a normal value (an email, a job id, a capability label) never
 * shows an apostrophe. Numbers are written as numbers, not text. The CSV starts with a UTF-8 byte-order mark so Excel reads Arabic.
 */
export const EXPORT_COLUMNS = [
  "الوقت (UTC)", "المزود", "نوع الاستدعاء", "رقم المهمة", "بريد المستخدم", "اسم المستخدم", "معرّف المستخدم", "حساب تجريبي",
  "الوحدات", "التكلفة (USD)", "الحالة", "المدة (مللي ثانية)", "تقدير غير مؤكد",
] as const;

const PROVIDER_NAME: Record<string, string> = { treg: "TREG", firecrawl: "Firecrawl", contextdev: "Context.dev" };
const STATUS_AR: Record<string, string> = { success: "نجح", failed: "فشل", empty: "بلا نتيجة" };
export const UNAVAILABLE_AR = "غير متاح";

const FORMULA_START = /^[\s\u0000-\u0008]*[=+\-@\t\r]/;

/** Text for a spreadsheet cell: a value that could run as a formula is prefixed with an apostrophe; everything else is returned unchanged. */
export function neutralizeCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

type Cell = string | number;

/** TREG key pool: a column «المفتاح» is added only when the filtered rows carry pool marks (otherwise the file is exactly what it always was). */
export const KEY_COLUMN = "المفتاح (TREG)";
const hasKeyMarks = (rows: CallsLogRow[]): boolean => rows.some((r) => typeof r.keyNumber === "number");
const keyCell = (r: CallsLogRow): string => (typeof r.keyNumber === "number" ? neutralizeCell(`#${r.keyNumber} ${r.keyLabel ?? ""}`.trim()) : "");

export function exportRows(rows: CallsLogRow[]): Cell[][] {
  const withKey = hasKeyMarks(rows);
  return rows.map((r) => [
    neutralizeCell(r.at),
    PROVIDER_NAME[r.provider] ?? neutralizeCell(String(r.provider)),
    neutralizeCell(r.capabilityLabelAr ?? UNAVAILABLE_AR),
    neutralizeCell(r.jobId ?? ""),
    neutralizeCell(r.userEmail ?? ""),
    neutralizeCell(r.userName ?? ""),
    neutralizeCell(r.userId ?? ""),
    r.isTestAccount ? "نعم" : "لا",
    r.units,
    r.costUsd,
    r.status ? STATUS_AR[r.status] : UNAVAILABLE_AR,
    r.durationMs === null ? UNAVAILABLE_AR : r.durationMs,
    r.isEstimate ? "نعم" : "لا",
    ...(withKey ? [keyCell(r)] : []),
  ]);
}

export const exportColumns = (rows: CallsLogRow[]): readonly string[] => (hasKeyMarks(rows) ? [...EXPORT_COLUMNS, KEY_COLUMN] : EXPORT_COLUMNS);

const csvField = (cell: Cell): string => {
  const text = typeof cell === "number" ? String(cell) : cell;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function toCsv(rows: CallsLogRow[]): string {
  const lines = [exportColumns(rows) as readonly Cell[], ...exportRows(rows)].map((line) => line.map(csvField).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

export async function toXlsx(rows: CallsLogRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("سجل الاستدعاءات", { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
  sheet.addRow([...exportColumns(rows)]);
  sheet.getRow(1).font = { bold: true };
  for (const line of exportRows(rows)) {
    // A string value is written as a string cell (never parsed as a formula); numbers stay numbers.
    sheet.addRow(line);
  }
  sheet.columns.forEach((column, index) => { column.width = [22, 12, 24, 30, 30, 22, 38, 14, 10, 14, 12, 16, 16, 22][index] ?? 16; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";
export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
