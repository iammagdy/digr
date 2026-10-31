import ExcelJS from "exceljs";

/**
 * AN EXCEL BUILT FROM A STORED CSV, for an older request that has a CSV and no Excel: the customer is never left without a file, and never offered a CSV. Reading is plain CSV (a leading byte-order mark, quoted cells with doubled quotes, line breaks inside
 * quotes, CRLF or LF); the first line is the header. The one mark the CSV writer adds, an apostrophe before a text that starts like a formula, is taken off (a text cell of a workbook is never run as a formula). Numbers that are numbers in every filled
 * cell of their column (no leading zero, at most 15 digits) are stored as numbers, links as links. Nothing here touches the stored CSV.
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i += 1; row.push(cell); cell = ""; rows.push(row); row = []; }
    else cell += ch;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ""));
}

const NAVY = "FF1B365D";
const WHITE = "FFFFFFFF";
const BORDER = { top: { style: "thin" as const, color: { argb: "FFD0D7DE" } }, left: { style: "thin" as const, color: { argb: "FFD0D7DE" } }, bottom: { style: "thin" as const, color: { argb: "FFD0D7DE" } }, right: { style: "thin" as const, color: { argb: "FFD0D7DE" } } };
const unmark = (v: string): string => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);
const isNumber = (v: string): boolean => /^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(v.trim());
const isUrl = (v: string): boolean => /^https?:\/\/\S+$/i.test(v.trim());

export async function excelFromCsv(csv: string, sheetName = "النتائج"): Promise<Buffer> {
  const rows = parseCsv(csv).map((r) => r.map(unmark));
  const wb = new ExcelJS.Workbook();
  wb.creator = "Diger";
  const sheet = wb.addWorksheet(sheetName.slice(0, 31), { views: [{ state: "frozen", ySplit: 1, rightToLeft: true }] });
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const body = rows.slice(1);
  const numeric = Array.from({ length: width }, (_, c) => { const filled = body.map((r) => (r[c] ?? "").trim()).filter(Boolean); return filled.length > 0 && filled.every(isNumber); });
  sheet.columns = Array.from({ length: width }, (_, c) => ({ width: body.some((r) => isUrl(r[c] ?? "")) ? 34 : Math.min(52, Math.max(14, ...[rows[0]?.[c] ?? "", ...body.slice(0, 30).map((r) => r[c] ?? "")].map((v) => Math.min(52, v.length + 4)))) }));
  if (rows.length > 0) {
    const head = sheet.addRow(Array.from({ length: width }, (_, c) => rows[0][c] ?? ""));
    head.eachCell((cell) => { cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: WHITE } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } }; cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; });
    head.height = 30;
  }
  for (const r of body) {
    const row = sheet.addRow(Array.from({ length: width }, (_, c): ExcelJS.CellValue => {
      const v = r[c] ?? "";
      if (v.trim() === "") return null;
      if (numeric[c]) return Number(v.trim());
      if (isUrl(v)) return { text: v.trim(), hyperlink: v.trim(), tooltip: v.trim() };
      return v;
    }));
    row.alignment = { vertical: "middle", wrapText: true };
    row.eachCell({ includeEmpty: true }, (cell) => { cell.border = BORDER; if (cell.hyperlink) cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true }; });
  }
  if (rows.length > 0) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length), column: Math.max(1, width) } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
