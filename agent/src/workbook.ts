import ExcelJS from "exceljs";
import { SUMMARY_SHEET_AR } from "../../src/lib/modelPlanner/missionWorkbook";
import { wordBoundarySheetName } from "../../src/lib/agentMission/fileNames";
import { REASON_AR, type RelevanceReason } from "../../src/lib/agentMission/relevance";
import { requestedRowsOf } from "../../src/lib/agentMission/plan";
import { FILTER_REASON_LABEL_AR, type FilterReason } from "../../src/lib/agentMission/filters";
import { cairoCellDate, cairoText, DATE_NUMBER_FORMAT, DATE_ONLY_NUMBER_FORMAT, dateOnlyCellDate, dateOnlyText, isDateValues, parseDateOnly, parseMoment } from "../../src/lib/agentMission/dateCells";
import { reconcileParentColumns, type ParentColumnFix } from "../../src/lib/agentMission/parentColumns";
import { APPROX_DATES_NOTE_AR, APPROX_DATE_NUMBER_FORMAT, APPROX_WORD_AR, approxColumnsOf } from "../../src/lib/agentMission/relativeDates";
import { isInternalColumn, type PricedPlan, type PricedStage } from "../../src/lib/agentMission/plan";
import { deliveredOfAr, itemNounOfPlan } from "../../src/lib/agentMission/itemNoun";
import { formatAr } from "../../src/lib/arabicDigits";
import { parentCountsOf } from "../../src/lib/agentMission/parents";
import { isTextItemStage, textKeyOf } from "../../src/lib/agentMission/contract";

type Row = Record<string, unknown>;

/**
 * THE FILES OF A MISSION, readable first. One sheet per delivered stage, built for a person:
 *   - the sheet starts with the HUMAN columns: the context of the parent row (the company's name next to each employee, the post's text and link next to each comment) and then the stage's own readable columns;
 *   - the internal ids come LAST, under Arabic headers («المعرّف» and «معرّف الأصل»): they are how the sheets join (the parent id is a link to the parent's row);
 *   - no duplicated column (the same title, or the same values as another column of the sheet, appears once);
 *   - numbers are stored as numbers (a phone, a value with a leading zero or a very long id stays text), links are links;
 *   - headers are frozen and filters are on; the first sheet «ملخص المهمة» says what each sheet holds.
 * The CSV is the deepest delivered stage with the same columns as its sheet.
 */
const NAVY = "FF1B365D";
const WHITE = "FFFFFFFF";
const ZEBRA = "FFF8FAFC";
const GREY = "FF6B7280";
const BORDER = { top: { style: "thin" as const, color: { argb: "FFD0D7DE" } }, left: { style: "thin" as const, color: { argb: "FFD0D7DE" } }, bottom: { style: "thin" as const, color: { argb: "FFD0D7DE" } }, right: { style: "thin" as const, color: { argb: "FFD0D7DE" } } };
export const ID_HEADER_AR = "المعرّف";
export const PARENT_HEADER_AR = "معرّف الأصل";
const MAX_PARENT_CONTEXT_COLUMNS = 2;

const text = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const isUrl = (v: unknown) => /^https?:\/\//i.test(text(v).trim());
/**
 * A text that starts like a formula is dangerous in a CSV (a spreadsheet may run it), so the CSV marks it with a leading apostrophe. In the XLSX NO mark is written: a text cell is stored as a string (shared string),
 * which a spreadsheet never runs as a formula, so a customer's reply «@name ...» shows exactly as written.
 */
const isFormulaLike = (v: string): boolean => /^[=+\-@\t\r]/.test(v) && !/^\+\d[\d\s]*$/.test(v);
const csvText = (v: string): string => (isFormulaLike(v) ? `'${v}` : v);
const textCell = (v: string): string => v;

export interface SheetColumn { title: string; get: (row: Row, parent: Row | null) => unknown; kind?: "context" | "own"; contact?: boolean; link?: boolean; /** The stage column's key (the date columns are recognised by it and by the title). */ key?: string }
export interface SheetLayout { stageIndex: number; stage: PricedStage; rows: Row[]; columns: SheetColumn[]; hasParent: boolean }

const readableColumns = (stage: PricedStage) => stage.columns.filter((c) => !isInternalColumn(c));

/** True when a column's values are numbers and nothing else (no leading zero, at most 15 digits): only then it is stored as a number. */
function numericColumn(values: unknown[], contact: boolean): boolean {
  if (contact) return false;
  const filled = values.map((v) => text(v).trim()).filter(Boolean);
  return filled.length > 0 && filled.every((v) => /^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(v));
}

/** Two columns that say the same thing (same title, or the same values on at least 80% of the rows) are one column. */
function sameValues(a: unknown[], b: unknown[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let same = 0;
  let any = false;
  for (let i = 0; i < a.length; i += 1) { const x = text(a[i]).trim(); const y = text(b[i]).trim(); if (x || y) any = true; if (x === y && x !== "") same += 1; }
  return any && same / a.length >= 0.8;
}

/**
 * A POST, TWEET OR COMMENT WITH NO TEXT (a picture, a video, a sticker) shows a clear Arabic marker in the file instead of an empty cell, so nobody thinks data is missing. The marker is for the file only: the item itself, its id and its de-duplication are untouched.
 * A top-level item says «منشور بصورة أو فيديو دون نص»; a child item (a comment, a reply) says «تعليق بصورة أو ملصق دون نص».
 */
export const MEDIA_ONLY_POST_AR = "منشور بصورة أو فيديو دون نص";
export const MEDIA_ONLY_COMMENT_AR = "تعليق بصورة أو ملصق دون نص";
const isBlankText = (v: unknown): boolean => v === null || v === undefined || (typeof v !== "object" && String(v).replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "").trim() === "");
function textGetter(stage: PricedStage, key: string): ((row: Row) => unknown) | null {
  if (!isTextItemStage(stage) || textKeyOf(stage) !== key) return null;
  const marker = stage.parent_key === null ? MEDIA_ONLY_POST_AR : MEDIA_ONLY_COMMENT_AR;
  return (row) => (isBlankText(row[key]) ? marker : row[key]);
}

export function layoutOf(plan: PricedPlan, rowsByStage: Record<string, Row[]>): SheetLayout[] {
  const stageByKey = new Map(plan.stages.map((s, i) => [s.key, { s, i }]));
  const layouts: SheetLayout[] = [];
  plan.stages.forEach((stage, stageIndex) => {
    const rows = rowsByStage[stage.key] ?? [];
    if (!stage.deliver || rows.length === 0) return;
    const parentInfo = stage.parent_key !== null ? stageByKey.get(stage.parent_key) : undefined;
    const parentRows = parentInfo ? rowsByStage[parentInfo.s.key] ?? [] : [];
    const parentById = new Map(parentRows.map((r) => [text(r.id), r]));
    const own = readableColumns(stage);
    const columns: SheetColumn[] = [];
    const titles = new Set<string>();
    const sample = (get: (row: Row, parent: Row | null) => unknown) => rows.map((r) => get(r, parentById.get(text(r.parent_id)) ?? null));
    // 1. the context of the parent row, so a child row is understood on its own
    if (parentInfo && parentRows.length > 0) {
      const parentCols = readableColumns(parentInfo.s);
      const firstText = parentCols.find((c) => !c.kind && !rows.every((r) => isUrl((parentById.get(text(r.parent_id)) ?? {})[c.key])));
      const firstLink = parentCols.find((c) => c !== firstText && rows.some((r) => isUrl((parentById.get(text(r.parent_id)) ?? {})[c.key])));
      for (const pc of [firstText, firstLink].filter((c): c is NonNullable<typeof c> => Boolean(c)).slice(0, MAX_PARENT_CONTEXT_COLUMNS)) {
        const parentText = textGetter(parentInfo.s, pc.key);
        const get = (_r: Row, parent: Row | null) => (parent ? (parentText ? parentText(parent) : parent[pc.key] ?? "") : "");
        const values = sample(get);
        const twin = own.find((c) => sameValues(values, rows.map((r) => r[c.key])));
        if (twin) continue;
        const title = titles.has(pc.title_ar) || own.some((c) => c.title_ar === pc.title_ar) ? `${pc.title_ar} (${parentInfo.s.title_ar})` : pc.title_ar;
        titles.add(title);
        columns.push({ title, get, kind: "context", link: isUrl(values.find((v) => text(v)) ?? "") });
      }
    }
    // 2. the stage's own readable columns, without a repeated title or a copy of another column
    const taken: unknown[][] = columns.map((c) => sample(c.get));
    for (const c of own) {
      if (titles.has(c.title_ar)) continue;
      const values = rows.map((r) => r[c.key]);
      if (taken.some((t) => sameValues(t, values))) continue;
      titles.add(c.title_ar);
      taken.push(values);
      const ownText = textGetter(stage, c.key);
      columns.push({ title: c.title_ar, get: ownText ? (r) => ownText(r) : (r) => r[c.key], kind: "own", contact: c.kind !== undefined, link: values.some((v) => isUrl(v)), key: c.key });
    }
    layouts.push({ stageIndex, stage, rows, columns, hasParent: stage.parent_key !== null });
  });
  return layouts;
}

/** A row the relevance check left out of a stage (never delivered, never charged), with the reason. */
export interface ExcludedRow { id: string; reason: RelevanceReason | FilterReason; row: Row }

/**
 * THE ADMIN'S VIEW OF WHAT WAS LEFT OUT: a CSV (the stage, the reason in Arabic, the readable columns of the row, its id) kept in the mission's own storage folder, NEVER in the customer's files. Customer files hold only items that were
 * delivered and charged. Null when nothing was left out.
 */
export function buildExcludedAdminCsv(plan: PricedPlan, excludedByStage: Record<string, ExcludedRow[]>): string | null {
  const lines: string[] = [];
  const esc = (v: unknown) => `"${csvText(text(v)).replace(/"/g, '""')}"`;
  for (const stage of plan.stages) {
    const rows = excludedByStage[stage.key] ?? [];
    if (rows.length === 0) continue;
    const cols = readableColumns(stage).filter((c) => !c.kind);
    if (lines.length > 0) lines.push("");
    lines.push(["المرحلة", "سبب الاستبعاد", ...cols.map((c) => c.title_ar), ID_HEADER_AR].map(esc).join(","));
    for (const e of rows) lines.push([stage.title_ar, (REASON_AR as Record<string, string>)[e.reason] ?? (FILTER_REASON_LABEL_AR as Record<string, string>)[e.reason] ?? e.reason, ...cols.map((c) => e.row[c.key]), e.id].map(esc).join(","));
  }
  return lines.length > 0 ? `﻿${lines.join("\r\n")}` : null;
}

/** What the first sheet's closing note may say about the file: only what the file really has. */
export interface WorkbookFacts { sheets: number; hasParentColumn: boolean; parentLinked: boolean; hasDateColumn: boolean; /** Some date of the file was computed from a relative time the source gave («قبل ٣ أيام»). */ hasApproxDates?: boolean }

/** The closing note of the summary sheet, built from the sheets and columns the file REALLY has: a link between sheets is described only when a parent column and its target sheet exist; the time zone only when a date column exists. */
export function workbookNoteAr(f: WorkbookFacts): string {
  const where = f.sheets > 1 ? "كل ورقة" : "الورقة";
  const parts = [`الأعمدة الأولى في ${where} مقروءة؛ وفي آخرها «${ID_HEADER_AR}»${f.hasParentColumn ? ` و«${PARENT_HEADER_AR}»` : ""}${f.sheets > 1 && f.hasParentColumn ? " للربط بين الأوراق" : ""}${f.parentLinked ? ` (اضغط على «${PARENT_HEADER_AR}» للانتقال إلى صفّه)` : ""}.`];
  if (f.hasDateColumn) parts.push("التواريخ والأوقات بتوقيت القاهرة.");
  if (f.hasApproxDates) parts.push(APPROX_DATES_NOTE_AR);
  return parts.join(" ");
}

export async function buildMissionFiles(plan: PricedPlan, rowsIn: Record<string, Row[]>): Promise<{ xlsx: Buffer; csv: string; /** Wrong parent-describing values of a child sheet that were replaced from the row's own parent (for the admin only). */ parentFixes: ParentColumnFix[] }> {
  // BEFORE THE FILE IS WRITTEN: every value of a child row that describes its parent must be its OWN parent's (parentColumns.ts); a mapping that copied the first company's website onto every person is repaired here and reported to the admin
  const reconciled = reconcileParentColumns(plan.stages, rowsIn, (key) => { const st = plan.stages.find((x) => x.key === key); return st ? readableColumns(st).map((c) => c.key) : []; }, (key) => { const st = plan.stages.find((x) => x.key === key); return st ? readableColumns(st).map((c) => c.key) : []; });
  const rowsByStage = reconciled.rowsByStage;
  const layouts = layoutOf(plan, rowsByStage);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Diger";
  const used = new Set<string>([SUMMARY_SHEET_AR.toLowerCase()]);
  const summary = wb.addWorksheet(SUMMARY_SHEET_AR, { views: [{ state: "frozen", ySplit: 1, rightToLeft: true }] });
  const sheetNameOf = new Map<string, string>();
  // where each row's id cell is, so a parent id can link to it
  const idCell = new Map<string, Map<string, string>>();
  let hasDateColumn = false;
  let hasApproxDates = false;

  for (const lay of layouts) sheetNameOf.set(lay.stage.key, wordBoundarySheetName(lay.stage.title_ar, used, `مرحلة ${lay.stageIndex + 1}`));

  for (const lay of layouts) {
    const name = sheetNameOf.get(lay.stage.key)!;
    const parentLayout = lay.stage.parent_key !== null ? layouts.find((l) => l.stage.key === lay.stage.parent_key) : undefined;
    const parentByIdRow = new Map((rowsByStage[lay.stage.parent_key ?? ""] ?? []).map((r) => [text(r.id), r]));
    const headers = [...lay.columns.map((c) => c.title), ID_HEADER_AR, ...(lay.hasParent ? [PARENT_HEADER_AR] : [])];
    const sheet = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1, rightToLeft: true }] });
    const columnValues = lay.columns.map((c) => lay.rows.map((r) => c.get(r, parentByIdRow.get(text(r.parent_id)) ?? null)));
    const dateAt = lay.columns.map((c, k) => isDateValues(c.title, c.key, columnValues[k]));
    if (dateAt.some(Boolean)) hasDateColumn = true;
    const numericAt = lay.columns.map((c, k) => !dateAt[k] && numericColumn(columnValues[k], Boolean(c.contact)));
    sheet.columns = headers.map((h, j) => ({ width: j >= lay.columns.length ? 16 : /نص|تعليق|وصف|عنوان|تقييم|منشور|تغريدة/.test(h) ? 52 : /رابط|الموقع/.test(h) ? 34 : 24 }));
    const head = sheet.addRow(headers);
    head.eachCell((cell, col) => {
      cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: WHITE } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: col > lay.columns.length ? GREY : NAVY } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    });
    head.height = 30;
    const ids = new Map<string, string>();
    lay.rows.forEach((record, r) => {
      const parent = parentByIdRow.get(text(record.parent_id)) ?? null;
      const cellFormat: Array<string | null> = [];
      const values: ExcelJS.CellValue[] = lay.columns.map((c, k) => {
        const v = c.get(record, parent);
        // a missing value is an EMPTY cell, never an empty text
        if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) { cellFormat[k] = null; return null; }
        if (dateAt[k]) {
          // a date with no time stays a date (no time of day, no zone shift); only a real timestamp is written in Cairo time
          const day = parseDateOnly(v);
          if (day) {
            // a date computed from a relative time the source gave («قبل ٣ أيام») is written with the word «تقريبًا» before it
            const approx = c.key !== undefined && approxColumnsOf(record).includes(c.key);
            if (approx) hasApproxDates = true;
            cellFormat[k] = approx ? APPROX_DATE_NUMBER_FORMAT : DATE_ONLY_NUMBER_FORMAT;
            return dateOnlyCellDate(day);
          }
          const moment = parseMoment(v);
          if (moment) { cellFormat[k] = DATE_NUMBER_FORMAT; return cairoCellDate(moment); }
        }
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v === "boolean") return v ? "نعم" : "لا";
        const t = text(v);
        if (numericAt[k]) return Number(t.trim());
        if (isUrl(t)) return { text: t.trim(), hyperlink: t.trim(), tooltip: t.trim() };
        return textCell(t);
      });
      values.push(textCell(text(record.id)));
      if (lay.hasParent) values.push(textCell(text(record.parent_id)));
      const row = sheet.addRow(values);
      ids.set(text(record.id), `${sheet.getColumn(lay.columns.length + 1).letter}${r + 2}`);
      row.alignment = { vertical: "middle", wrapText: true };
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cell.border = BORDER;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: r % 2 ? ZEBRA : WHITE } };
        if (col <= lay.columns.length && dateAt[col - 1] && cellFormat[col - 1]) { cell.numFmt = cellFormat[col - 1]!; cell.alignment = { horizontal: "center", vertical: "middle" }; }
        if (cell.hyperlink) cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true };
        else if (col > lay.columns.length) cell.font = { name: "Calibri", size: 9, color: { argb: GREY } };
      });
    });
    idCell.set(lay.stage.key, ids);
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: lay.rows.length + 1, column: headers.length } };
    void parentLayout;
  }

  // the parent id is a link to the parent's row, where the parent stage has its own sheet
  for (const lay of layouts) {
    if (!lay.hasParent) continue;
    const parentName = sheetNameOf.get(lay.stage.parent_key!);
    const targets = idCell.get(lay.stage.parent_key!);
    if (!parentName || !targets) continue;
    const sheet = wb.getWorksheet(sheetNameOf.get(lay.stage.key)!)!;
    const parentColumn = lay.columns.length + 2;
    lay.rows.forEach((record, r) => {
      const target = targets.get(text(record.parent_id));
      if (!target) return;
      const cell = sheet.getRow(r + 2).getCell(parentColumn);
      cell.value = { text: text(record.parent_id), hyperlink: `#'${parentName.replace(/'/g, "''")}'!${target}`, tooltip: parentName };
      cell.font = { name: "Calibri", size: 9, color: { argb: "FF0563C1" }, underline: true };
    });
  }

  // the first sheet: what each sheet holds, and how they connect
  summary.columns = [{ width: 30 }, { width: 24 }, { width: 14 }, { width: 14 }, { width: 52 }];
  const sh = summary.addRow(["المرحلة", "الورقة", "العدد", "المتوقع", "ملاحظة"]);
  sh.eachCell((cell) => { cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: WHITE } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } }; cell.alignment = { horizontal: "center", vertical: "middle" }; });
  // THE TRUTH ABOUT A PARENT STAGE, from the items themselves: how many parents were read and how many of them have items in this file (never the number the plan allowed)
  const parentCounts = parentCountsOf(plan, rowsByStage);
  plan.stages.forEach((stage, index) => {
    const rows = (rowsByStage[stage.key] ?? []).length;
    const parent = stage.parent_key !== null ? plan.stages.find((p) => p.key === stage.parent_key) : undefined;
    const child = plan.stages.find((c) => c.parent_key === stage.key && c.deliver);
    const sheetName = sheetNameOf.get(stage.key);
    const read = parentCounts[`stage_${index + 1}_read`];
    const used = parentCounts[`stage_${index + 1}_used`];
    const link = parent ? `كل عنصر هنا تابع لعنصر في مرحلة «${parent.title_ar}»` : "لا ترتبط بمرحلة سابقة";
    if (child && read !== undefined && !stage.deliver) {
      // an intermediate stage is not in the file: it says what it read and how many of what it read have results in the file
      summary.addRow([stage.title_ar, "لم تُسلَّم (مرحلة وسيطة)", `قُرئ ${formatAr(read)}، ومنها ${formatAr(used ?? 0)} لها نتائج في الملف`, `حتى ${formatAr(stage.planned_rows)}`, link]);
    } else {
      summary.addRow([stage.title_ar, sheetName ?? (stage.deliver ? "—" : "لم تُسلَّم (مرحلة وسيطة)"), rows, stage.planned_rows, child && used !== undefined ? `${link}؛ ومنها ${formatAr(used)} لها عناصر تابعة في الملف` : link]);
    }
  });
  summary.addRow([]);
  // the one sentence about the delivery is built from the real counts (never from the agent's own words, which may name the requested number): «تم تسليم ٢٥٠ من ٣٠٠ تغريدة.»
  const deliveredCount = plan.stages.filter((st) => st.deliver).reduce((n, st) => n + (rowsByStage[st.key] ?? []).length, 0);
  // the number of items the CUSTOMER asked for (the plan's target, or the request when the model proposed fewer with a reason the card showed): a delivery below it is never written «N من N»
  const requestedCount = requestedRowsOf(plan);
  const intro = summary.addRow([`تم تسليم ${deliveredOfAr(deliveredCount, requestedCount, itemNounOfPlan(plan))}.`]);
  summary.mergeCells(intro.number, 1, intro.number, 5);
  intro.alignment = { wrapText: true, readingOrder: "rtl" as any, vertical: "middle" };
  intro.height = 32;
  intro.font = { name: "Calibri", size: 11, bold: true };
  const parentLinked = layouts.some((l) => l.hasParent && sheetNameOf.has(l.stage.parent_key!) && (idCell.get(l.stage.parent_key!)?.size ?? 0) > 0);
  const note = summary.addRow([workbookNoteAr({ sheets: layouts.length, hasParentColumn: layouts.some((l) => l.hasParent), parentLinked, hasDateColumn, hasApproxDates })]);
  summary.mergeCells(note.number, 1, note.number, 5);
  note.alignment = { wrapText: true, readingOrder: "rtl" as any };
  note.height = 34;
  summary.autoFilter = { from: { row: 1, column: 1 }, to: { row: plan.stages.length + 1, column: 5 } };
  const xlsx = Buffer.from(await wb.xlsx.writeBuffer());

  // the CSV: the deepest delivered stage, the same columns as its sheet
  const last = layouts[layouts.length - 1];
  const esc = (v: unknown) => `"${csvText(text(v)).replace(/"/g, '""')}"`;
  const lines: string[] = [];
  if (last) {
    const parentByIdRow = new Map((rowsByStage[last.stage.parent_key ?? ""] ?? []).map((r) => [text(r.id), r]));
    lines.push([...last.columns.map((c) => c.title), ID_HEADER_AR, ...(last.hasParent ? [PARENT_HEADER_AR] : [])].map(esc).join(","));
    const lastDates = last.columns.map((c) => isDateValues(c.title, c.key, last.rows.map((r) => c.get(r, parentByIdRow.get(text(r.parent_id)) ?? null))));
    for (const r of last.rows) lines.push([...last.columns.map((c, k) => { const v = c.get(r, parentByIdRow.get(text(r.parent_id)) ?? null); if (lastDates[k]) { const day = parseDateOnly(v); if (day) return approxColumnsOf(r).includes(c.key ?? "") ? `${dateOnlyText(day)} (${APPROX_WORD_AR})` : dateOnlyText(day); const moment = parseMoment(v); if (moment) return cairoText(moment); } return v; }), r.id, ...(last.hasParent ? [r.parent_id] : [])].map(esc).join(","));
  }
  return { xlsx, csv: `﻿${lines.join("\r\n")}`, parentFixes: reconciled.fixes };
}
