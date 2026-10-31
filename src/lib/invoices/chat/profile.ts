import { AGENT_SAMPLES_PER_COLUMN } from "./limits";
import { digitsOf, looksLikeEmail, looksLikePhone, maskCell, maskHeader } from "./mask";
import type { ColumnProfile, FileProfile, ParsedSheet, ParsedSheetFile, SheetProfile } from "./types";

/** A, B, … Z, AA, AB … */
export function colLetter(index: number): string {
  let n = index, out = "";
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}
export function colIndex(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const isNumeric = (v: string): boolean => v !== "" && /^[\d٠-٩۰-۹.,\s]+$/.test(v);

/**
 * The header row, decided by CODE (never by the model): among the first 10 rows, the first one that is nearly as wide as the widest and mostly text.
 * A title line above the table («كشف شركات كهروميكانيكا») is skipped; a file with no header row simply uses its first row.
 */
export function detectHeaderRow(rows: string[][]): number {
  const top = rows.slice(0, 10);
  const filled = top.map((r) => r.filter((c) => c !== "").length);
  const widest = Math.max(0, ...filled);
  for (let i = 0; i < top.length; i++) {
    if (filled[i] === 0 || filled[i] < Math.ceil(widest * 0.6)) continue;
    const cells = top[i].filter((c) => c !== "");
    if (cells.filter((c) => !isNumeric(c)).length * 2 >= cells.length) return i;
  }
  return 0;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const emailToken = /[^\s;,،/|<>()"']+@[^\s;,،/|<>()"']+/;

function profileColumn(sheet: ParsedSheet, header: string[], data: string[][], ci: number): ColumnProfile {
  const values = data.map((r) => r[ci] ?? "").filter((v) => v !== "");
  const seen = new Set<string>();
  const distinctValues: string[] = [];
  for (const v of values) { const k = v.toLowerCase(); if (!seen.has(k)) { seen.add(k); distinctValues.push(v); } }
  const picks: string[] = [];
  const want = Math.min(AGENT_SAMPLES_PER_COLUMN, distinctValues.length);
  for (let k = 0; k < want; k++) picks.push(distinctValues[want === 1 ? 0 : Math.round((k * (distinctValues.length - 1)) / (want - 1))]);
  const n = values.length || 1;
  return {
    col: colLetter(ci),
    header: maskHeader(header[ci] ?? ""),
    filled: values.length,
    distinct: seen.size,
    email_share: round2(values.filter((v) => emailToken.test(v) || looksLikeEmail(v)).length / n),
    phone_share: round2(values.filter((v) => looksLikePhone(v)).length / n),
    number_share: round2(values.filter((v) => isNumeric(v) && digitsOf(v).length > 0).length / n),
    avg_words: Math.round((values.reduce((s, v) => s + v.split(/\s+/).filter(Boolean).length, 0) / n) * 10) / 10,
    samples: picks.map(maskCell),
  };
}

/** What the model may know about a sheet: counts, the (masked) header, shape statistics and at most 5 MASKED samples per column. */
export function profileSheet(sheet: ParsedSheet): SheetProfile {
  const headerIdx = detectHeaderRow(sheet.rows);
  const header = sheet.rows[headerIdx] ?? [];
  const data = sheet.rows.slice(headerIdx + 1);
  const width = Math.max(header.length, ...data.map((r) => r.length), 0);
  const columns: ColumnProfile[] = [];
  for (let ci = 0; ci < width; ci++) {
    const col = profileColumn(sheet, header, data, ci);
    if (col.filled === 0 && col.header === "") continue;
    columns.push(col);
  }
  return { sheet: sheet.name, rows: data.length, header_row: headerIdx + 1, columns };
}

export function buildFileProfile(file: ParsedSheetFile): FileProfile {
  return { file: file.name, sheets: file.sheets.map(profileSheet) };
}
