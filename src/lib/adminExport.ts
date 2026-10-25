/**
 * The admin's read-only backup export. The free database plan has no automatic backups, so the owner copies the five tables that hold the
 * money and the accounts into files (before the conference, every few hours on the day, and after).
 * Pure helpers: the route reads pages with SELECT only, the page assembles the file in the browser. Nothing here writes anywhere.
 */

export type ExportTableId = "credit_ledger" | "topups" | "jobs" | "plans_quotes" | "profiles";

export interface ExportTable {
  id: ExportTableId;
  titleAr: string;
  noteAr: string;
}

export const EXPORT_TABLES: ExportTable[] = [
  { id: "credit_ledger", titleAr: "دفتر الرصيد", noteAr: "كل حركات النقاط: الحجز والتحرير والخصم والشحن" },
  { id: "topups", titleAr: "طلبات الشحن", noteAr: "طلبات الشحن وحالتها" },
  { id: "jobs", titleAr: "الطلبات (المهام)", noteAr: "حالة كل مهمة وما سُلّم منها" },
  { id: "plans_quotes", titleAr: "الخطط والأسعار", noteAr: "كل خطة وعرض سعر معروض" },
  { id: "profiles", titleAr: "الحسابات", noteAr: "بيانات الحسابات (الاسم والبريد والهاتف)" },
];

export const EXPORT_TABLE_IDS: ReadonlySet<string> = new Set(EXPORT_TABLES.map((t) => t.id));

/** Rows per request: the same size the database API returns per request. */
export const EXPORT_PAGE_SIZE = 1000;
/** A runaway guard: no table is read past this many rows in one export. */
export const EXPORT_MAX_ROWS = 200_000;

/** Column names that could hold a secret or a token are never exported (none of the five tables has one today; this keeps it so). */
const SECRET_COLUMN = /(token|secret|password|passwd|api[_-]?key|service[_-]?role|jwt|private[_-]?key)/i;

export function isSecretColumn(name: string): boolean {
  return SECRET_COLUMN.test(name);
}

/** The row without secret-looking columns; returns the names that were left out. */
export function stripSecrets(row: Record<string, unknown>): { row: Record<string, unknown>; omitted: string[] } {
  const kept: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (isSecretColumn(key)) omitted.push(key);
    else kept[key] = value;
  }
  return { row: kept, omitted };
}

/** The union of the column names, in order of first appearance. */
export function columnsOf(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** A CSV cell: quoted, inner quotes doubled; a leading = + - @ is prefixed so a spreadsheet never runs a cell as a formula. */
export function csvCell(value: unknown): string {
  let text = cellText(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function rowsToCsv(rows: Array<Record<string, unknown>>, columns: string[] = columnsOf(rows)): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(","));
  return lines.join("\r\n");
}

export function exportFileName(table: ExportTableId, now: Date = new Date(), ext: "csv" | "json" = "csv"): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `diger-${table}-${stamp}.${ext}`;
}

/**
 * The ZIP of all five tables is built on the server in one request, so it has a smaller ceiling than the page-by-page download (which is assembled in the
 * browser): a table past this many rows is refused with a plain Arabic message before anything is sent, and the tables can still be downloaded one by one.
 */
export const EXPORT_ZIP_MAX_ROWS_PER_TABLE = 50_000;
/** The ZIP stops (and the download fails, never a short file) when reading takes longer than this: under the function's 60 s limit. */
export const EXPORT_ZIP_TIME_BUDGET_MS = 50_000;

/** diger-backup-YYYY-MM-DD-HHmm.zip, the date and time read in Cairo. */
export function backupZipFileName(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const at = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `diger-backup-${at("year")}-${at("month")}-${at("day")}-${at("hour")}${at("minute")}.zip`;
}
