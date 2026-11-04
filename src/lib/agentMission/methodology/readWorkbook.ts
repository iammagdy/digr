import ExcelJS from "exceljs";
import { DATE_PRECISION_APPROX_AR, DATE_PRECISION_EXACT_AR, DATE_PRECISION_TITLE_AR } from "../relativeDates";

/**
 * THE METHODOLOGY AS THE DELIVERED FILE STATES IT (round 21). The worker writes a «المنهجية» section below the summary of the first sheet of every delivered workbook (agent/src/methodology.ts, built by CODE from what the mission recorded:
 * the request, the platforms, what was searched, the period, the filters, the counts per stage, the reasons, the limits, the citation). The PDF is written from THAT section, read back from the file the customer received, so every number it says is
 * the number in the file; nothing is recomputed, estimated or added. The other sheets give the file's layout (its sheets, their delivered counts and columns, the date-precision marks).
 * Read only: the workbook bytes in, a plain model out. Nothing here knows a provider, an endpoint or a price.
 */
export const METHODOLOGY_SECTION_TITLE_AR = "المنهجية";
const COUNTS_BLOCK_LABEL_AR = "الأعداد في كل مرحلة";
const REASONS_BLOCK_LABEL_AR = "أسباب الاستبعاد";

export interface FileSheetFacts {
  name: string;
  /** The delivered records of the sheet (its rows below the header). */
  rows: number;
  /** The sheet's column titles as the customer reads them (the id columns left out). */
  columns: string[];
  /** The date-precision column of the sheet, when it has one: how many dates are marked «تقريبي» and «دقيق». */
  precision: { approx: number; exact: number } | null;
}

export interface WorkbookMethodology {
  items: Array<{ label: string; values: string[] }>;
  table: { head: string[]; rows: string[][] };
  reasons: string[];
  sheets: FileSheetFacts[];
}

const cellText = (cell: ExcelJS.Cell | undefined): string => {
  if (!cell) return "";
  const v = cell.value as unknown;
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as { richText?: Array<{ text: string }>; text?: unknown; result?: unknown };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("");
    if (typeof o.text === "string") return o.text;
    if (o.result !== undefined && o.result !== null) return String(o.result);
  }
  return "";
};
const lines = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter((l) => l !== "");

/** The columns that only carry a record's own key or its parent's key: not part of what a methodology says about the data. */
const isKeyColumn = (title: string): boolean => /^معرّف|^المعرّف|^المعرف/.test(title.trim());

function sheetFacts(ws: ExcelJS.Worksheet): FileSheetFacts {
  const head = ws.getRow(1);
  const columns: Array<{ index: number; title: string }> = [];
  head.eachCell({ includeEmpty: false }, (cell, index) => { const t = cellText(cell).trim(); if (t !== "") columns.push({ index, title: t }); });
  let rows = 0;
  ws.eachRow({ includeEmpty: false }, (row, n) => { if (n > 1 && row.hasValues) rows += 1; });
  const precisionColumn = columns.find((c) => c.title === DATE_PRECISION_TITLE_AR || c.title.startsWith(`${DATE_PRECISION_TITLE_AR} (`));
  let precision: FileSheetFacts["precision"] = null;
  if (precisionColumn) {
    let approx = 0;
    let exact = 0;
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      const t = cellText(row.getCell(precisionColumn.index)).trim();
      if (t === DATE_PRECISION_APPROX_AR) approx += 1;
      else if (t === DATE_PRECISION_EXACT_AR) exact += 1;
    });
    precision = { approx, exact };
  }
  return { name: ws.name, rows, columns: columns.filter((c) => !isKeyColumn(c.title)).map((c) => c.title), precision };
}

/** Reads the methodology section and the file's layout from the delivered workbook; null when the first sheet has no «المنهجية» section (an older file). */
export async function readWorkbookMethodology(xlsx: Buffer | ArrayBuffer | Uint8Array): Promise<WorkbookMethodology | null> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
  const first = wb.worksheets[0];
  if (!first) return null;
  let start = -1;
  // the title bar is merged across the row, so every cell of it reads as the title
  first.eachRow({ includeEmpty: false }, (row, n) => { if (start < 0 && cellText(row.getCell(1)).trim() === METHODOLOGY_SECTION_TITLE_AR && [ "", METHODOLOGY_SECTION_TITLE_AR ].includes(cellText(row.getCell(2)).trim())) start = n; });
  if (start < 0) return null;

  const items: WorkbookMethodology["items"] = [];
  const table: WorkbookMethodology["table"] = { head: [], rows: [] };
  let reasons: string[] = [];
  let inTable = false;
  for (let n = start + 1; n <= first.rowCount; n += 1) {
    const row = first.getRow(n);
    if (!row.hasValues) continue;
    // a labelled block merges its value across B:E; a counts-table row never does
    const block = row.getCell(3).isMerged;
    if (block) {
      inTable = false;
      const label = cellText(row.getCell(1)).trim();
      const values = lines(cellText(row.getCell(2)));
      if (label === COUNTS_BLOCK_LABEL_AR) { inTable = true; continue; }
      if (label === REASONS_BLOCK_LABEL_AR) { reasons = values; continue; }
      if (label !== "") items.push({ label, values });
      continue;
    }
    if (!inTable) continue;
    const cells = [1, 2, 3, 4, 5].map((c) => cellText(row.getCell(c)).trim());
    if (table.head.length === 0) table.head = cells;
    else table.rows.push(cells);
  }
  if (items.length === 0) return null;
  return { items, table, reasons, sheets: wb.worksheets.slice(1).map(sheetFacts) };
}
