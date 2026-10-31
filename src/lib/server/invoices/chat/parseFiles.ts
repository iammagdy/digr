import ExcelJS from "exceljs";
import { AGENT_MAX_COLUMNS, AGENT_MAX_FILE_BYTES, AGENT_MAX_IMAGE_BYTES, AGENT_MAX_ROWS_TOTAL, AGENT_MAX_SHEETS, AGENT_MAX_UNZIPPED_BYTES } from "@/lib/invoices/chat/limits";

/**
 * Reads the owner's files IN MEMORY, with code. Nothing is written to disk, a database or storage, and nothing here logs a cell value.
 * .xlsx (exceljs, already a dependency of the app) and .csv are spreadsheets; .png / .jpg are images (sent to the model as pictures, counts «تقريبي»).
 * The old binary .xls is refused: the app's reader cannot open it and the only library that can is not safe to add (the owner saves it as .xlsx in one tap).
 */
export class AgentInputError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

import type { ParsedFile as PF, ParsedSheet as PS } from "@/lib/invoices/chat/types";
export type ParsedSheet = PS;
export type ParsedFile = PF;

export interface RowBudget { left: number }
export const newRowBudget = (): RowBudget => ({ left: AGENT_MAX_ROWS_TOTAL });

const extOf = (name: string): string => (/\.([A-Za-z0-9]+)$/.exec(name.trim())?.[1] ?? "").toLowerCase();
const startsWith = (b: Uint8Array, sig: number[]): boolean => sig.every((v, i) => b[i] === v);

/** What a file is, from its name AND its first bytes (a renamed file is refused, not guessed). */
export function detectKind(name: string, bytes: Uint8Array): "xlsx" | "csv" | "png" | "jpg" {
  const ext = extOf(name);
  if (ext === "xls") throw new AgentInputError("xls", `الملف «${name}» بصيغة xls القديمة. افتحه في إكسل واحفظه بصيغة xlsx ثم ارفعه.`);
  if (ext === "xlsx") {
    if (!startsWith(bytes, [0x50, 0x4b])) throw new AgentInputError("bad_file", `الملف «${name}» ليس ملف xlsx سليمًا.`);
    return "xlsx";
  }
  if (ext === "csv") {
    if (startsWith(bytes, [0x50, 0x4b]) || startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || startsWith(bytes, [0xff, 0xd8, 0xff])) throw new AgentInputError("bad_file", `الملف «${name}» ليس ملف csv نصيًا.`);
    return "csv";
  }
  if (ext === "png") {
    if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) throw new AgentInputError("bad_file", `الملف «${name}» ليس صورة png سليمة.`);
    return "png";
  }
  if (ext === "jpg" || ext === "jpeg") {
    if (!startsWith(bytes, [0xff, 0xd8, 0xff])) throw new AgentInputError("bad_file", `الملف «${name}» ليس صورة jpg سليمة.`);
    return "jpg";
  }
  throw new AgentInputError("type", `نوع الملف «${name}» غير مدعوم. المسموح: xlsx و csv و png و jpg.`);
}

/** Reads the zip's central directory (no inflating) and refuses a file that would unpack to more than the limit: a zip bomb is stopped before exceljs sees it. */
export function checkZipSize(name: string, bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  const bad = () => new AgentInputError("bad_file", `الملف «${name}» تالف أو غير مقروء.`);
  if (eocd < 0) throw bad();
  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (entries === 0xffff || at === 0xffffffff) throw new AgentInputError("too_big", `الملف «${name}» أكبر مما يقبله المساعد.`);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw bad();
    const size = view.getUint32(at + 24, true);
    if (size === 0xffffffff) throw new AgentInputError("too_big", `الملف «${name}» أكبر مما يقبله المساعد.`);
    total += size;
    if (total > AGENT_MAX_UNZIPPED_BYTES) throw new AgentInputError("too_big", `الملف «${name}» أكبر مما يقبله المساعد بعد فك الضغط.`);
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
}

/** One cell as plain text: numbers keep their digits (no 1e+21), dates are ISO, formulas give their result, links give their text. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? (Number.isInteger(value) ? BigInt(value).toString() : String(value)) : "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) return (v.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("").trim();
    if ("result" in v) return cellText(v.result);
    if (typeof v.text === "string") return v.text.trim();
    if (typeof v.hyperlink === "string") return v.hyperlink.replace(/^mailto:/i, "").trim();
    if ("error" in v) return "";
  }
  return "";
}

export async function parseXlsx(name: string, bytes: Uint8Array, budget: RowBudget): Promise<ParsedFile> {
  checkZipSize(name, bytes);
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(bytes as unknown as ArrayBuffer); } catch { throw new AgentInputError("bad_file", `تعذّرت قراءة الملف «${name}». تأكد أنه xlsx سليم.`); }
  const sheets: ParsedSheet[] = [];
  for (const ws of wb.worksheets) {
    if (ws.state !== "visible") continue;
    if (sheets.length >= AGENT_MAX_SHEETS) throw new AgentInputError("too_many_sheets", `الملف «${name}» فيه أوراق كثيرة (أكثر من ${AGENT_MAX_SHEETS}).`);
    const rows: string[][] = [];
    let truncated = false;
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as unknown[]; // 1-based
      const width = Math.min(values.length - 1, AGENT_MAX_COLUMNS);
      if (values.length - 1 > AGENT_MAX_COLUMNS) truncated = true;
      const cells: string[] = [];
      let any = false;
      for (let c = 1; c <= width; c++) { const t = cellText(values[c]); cells.push(t); if (t !== "") any = true; }
      if (!any) return;
      budget.left -= 1;
      if (budget.left < 0) throw new AgentInputError("rows", `الملفات أكبر من ${AGENT_MAX_ROWS_TOTAL.toLocaleString("en")} صف إجمالًا. ارفع جزءًا منها.`);
      rows.push(cells);
    });
    if (rows.length) sheets.push({ name: ws.name, rows, truncatedColumns: truncated });
  }
  if (!sheets.length) throw new AgentInputError("empty", `الملف «${name}» لا يحتوي بيانات.`);
  return { kind: "sheet", name, sheets };
}

/** UTF-8 (with or without BOM); a file that is not valid UTF-8 is read as Windows-1256, the usual encoding of Arabic CSV from older Excel. */
export function decodeCsv(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, ""); }
  catch { return new TextDecoder("windows-1256").decode(bytes); }
}

/** RFC 4180: quotes, doubled quotes, newlines inside quotes; the delimiter (, ; tab |) is detected from the first lines. */
export function parseCsvText(text: string): string[][] {
  const head = text.split(/\r?\n/).slice(0, 5).join("\n");
  const delim = [",", ";", "\t", "|"].map((d) => [d, head.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const endCell = () => { row.push(cell.trim()); cell = ""; };
  const endRow = () => { endCell(); if (row.some((c) => c !== "")) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) endCell();
    else if (ch === "\n") endRow();
    else if (ch === "\r") { if (text[i + 1] !== "\n") endRow(); }
    else cell += ch;
  }
  if (cell !== "" || row.length) endRow();
  return rows;
}

export function parseCsv(name: string, bytes: Uint8Array, budget: RowBudget): ParsedFile {
  const all = parseCsvText(decodeCsv(bytes));
  if (!all.length) throw new AgentInputError("empty", `الملف «${name}» لا يحتوي بيانات.`);
  const width = Math.max(...all.map((r) => r.length));
  budget.left -= all.length;
  if (budget.left < 0) throw new AgentInputError("rows", `الملفات أكبر من ${AGENT_MAX_ROWS_TOTAL.toLocaleString("en")} صف إجمالًا. ارفع جزءًا منها.`);
  return { kind: "sheet", name, sheets: [{ name: "csv", rows: all.map((r) => r.slice(0, AGENT_MAX_COLUMNS)), truncatedColumns: width > AGENT_MAX_COLUMNS }] };
}

/** Any accepted file. The caller has already checked the count; sizes are checked here. */
export async function parseAgentFile(name: string, bytes: Uint8Array, budget: RowBudget): Promise<ParsedFile> {
  if (bytes.byteLength === 0) throw new AgentInputError("empty", `الملف «${name}» فارغ.`);
  if (bytes.byteLength > AGENT_MAX_FILE_BYTES) throw new AgentInputError("too_big", `الملف «${name}» أكبر من ١٠ ميجابايت.`);
  const kind = detectKind(name, bytes);
  if (kind === "png" || kind === "jpg") {
    if (bytes.byteLength > AGENT_MAX_IMAGE_BYTES) throw new AgentInputError("too_big", `الصورة «${name}» أكبر من ٥ ميجابايت. صغّرها وأعد رفعها.`);
    return { kind: "image", name, mediaType: kind === "png" ? "image/png" : "image/jpeg", bytes };
  }
  return kind === "xlsx" ? parseXlsx(name, bytes, budget) : parseCsv(name, bytes, budget);
}
