import ExcelJS from "exceljs";
import { SUMMARY_SHEET_AR } from "../../src/lib/modelPlanner/missionWorkbook";
import { wordBoundarySheetName } from "../../src/lib/agentMission/fileNames";
import { REASON_AR, type RelevanceReason } from "../../src/lib/agentMission/relevance";
import { firstSentenceAr, isInternalColumn, type PricedPlan, type PricedStage } from "../../src/lib/agentMission/plan";

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

export interface SheetColumn { title: string; get: (row: Row, parent: Row | null) => unknown; kind?: "context" | "own"; contact?: boolean; link?: boolean }
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
        const get = (_r: Row, parent: Row | null) => parent?.[pc.key] ?? "";
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
      columns.push({ title: c.title_ar, get: (r) => r[c.key], kind: "own", contact: c.kind !== undefined, link: values.some((v) => isUrl(v)) });
    }
    layouts.push({ stageIndex, stage, rows, columns, hasParent: stage.parent_key !== null });
  });
  return layouts;
}

/** A row the relevance check left out of a stage (never delivered, never charged), with the reason. */
export interface ExcludedRow { id: string; reason: RelevanceReason; row: Row }
export const REVIEW_SHEET_AR = "لم تُحتسب (للمراجعة)";

export async function buildMissionFiles(plan: PricedPlan, rowsByStage: Record<string, Row[]>, excludedByStage: Record<string, ExcludedRow[]> = {}): Promise<{ xlsx: Buffer; csv: string }> {
  const layouts = layoutOf(plan, rowsByStage);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Diger";
  const used = new Set<string>([SUMMARY_SHEET_AR.toLowerCase(), REVIEW_SHEET_AR.toLowerCase()]);
  const summary = wb.addWorksheet(SUMMARY_SHEET_AR, { views: [{ state: "frozen", ySplit: 1, rightToLeft: true }] });
  const sheetNameOf = new Map<string, string>();
  // where each row's id cell is, so a parent id can link to it
  const idCell = new Map<string, Map<string, string>>();

  for (const lay of layouts) sheetNameOf.set(lay.stage.key, wordBoundarySheetName(lay.stage.title_ar, used, `مرحلة ${lay.stageIndex + 1}`));

  for (const lay of layouts) {
    const name = sheetNameOf.get(lay.stage.key)!;
    const parentLayout = lay.stage.parent_key !== null ? layouts.find((l) => l.stage.key === lay.stage.parent_key) : undefined;
    const parentByIdRow = new Map((rowsByStage[lay.stage.parent_key ?? ""] ?? []).map((r) => [text(r.id), r]));
    const headers = [...lay.columns.map((c) => c.title), ID_HEADER_AR, ...(lay.hasParent ? [PARENT_HEADER_AR] : [])];
    const sheet = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1, rightToLeft: true }] });
    const numericAt = lay.columns.map((c) => numericColumn(lay.rows.map((r) => c.get(r, parentByIdRow.get(text(r.parent_id)) ?? null)), Boolean(c.contact)));
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
      const values: ExcelJS.CellValue[] = lay.columns.map((c, k) => {
        const v = c.get(record, parent);
        if (v === null || v === undefined || v === "") return "";
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
      row.eachCell((cell, col) => {
        cell.border = BORDER;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: r % 2 ? ZEBRA : WHITE } };
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

  // THE REVIEW SHEET: the rows the relevance check left out (another person with the same name, a mention with no words, a row that matched only through its author's name ...). They are NOT delivered and NOT charged;
  // they are here only so the customer can see what was left out and why.
  const reviewStage = plan.stages.find((st) => (excludedByStage[st.key] ?? []).length > 0);
  const excludedRows = reviewStage ? excludedByStage[reviewStage.key] : [];
  if (reviewStage && excludedRows.length > 0) {
    const cols = readableColumns(reviewStage).filter((c) => !c.kind);
    const sheet = wb.addWorksheet(REVIEW_SHEET_AR, { views: [{ state: "frozen", ySplit: 1, rightToLeft: true }], properties: { tabColor: { argb: "FF9CA3AF" } } });
    const headers = [...cols.map((c) => c.title_ar), "سبب الاستبعاد", ID_HEADER_AR];
    sheet.columns = headers.map((h, j) => ({ width: j >= cols.length + 1 ? 16 : j === cols.length ? 40 : /نص|تعليق|وصف|عنوان|تقييم|منشور|تغريدة/.test(h) ? 52 : 24 }));
    const head = sheet.addRow(headers);
    head.eachCell((cell) => { cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: WHITE } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } }; cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; });
    head.height = 30;
    excludedRows.forEach((e, r) => {
      const row = sheet.addRow([...cols.map((c) => { const v = e.row[c.key]; const t = text(v); return isUrl(t) ? { text: t.trim(), hyperlink: t.trim(), tooltip: t.trim() } : textCell(t); }), REASON_AR[e.reason] ?? "", textCell(text(e.id))]);
      row.alignment = { vertical: "middle", wrapText: true };
      row.eachCell((cell, col) => { cell.border = BORDER; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: r % 2 ? ZEBRA : WHITE } }; if (col > cols.length) cell.font = { name: "Calibri", size: 9, color: { argb: GREY } }; });
    });
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: excludedRows.length + 1, column: headers.length } };
  }

  // the first sheet: what each sheet holds, and how they connect
  summary.columns = [{ width: 30 }, { width: 24 }, { width: 14 }, { width: 14 }, { width: 52 }];
  const sh = summary.addRow(["المرحلة", "الورقة", "الصفوف", "المتوقع", "ملاحظة"]);
  sh.eachCell((cell) => { cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: WHITE } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } }; cell.alignment = { horizontal: "center", vertical: "middle" }; });
  plan.stages.forEach((stage) => {
    const rows = (rowsByStage[stage.key] ?? []).length;
    const parent = stage.parent_key !== null ? plan.stages.find((p) => p.key === stage.parent_key) : undefined;
    const sheetName = sheetNameOf.get(stage.key);
    summary.addRow([stage.title_ar, sheetName ?? (stage.deliver ? "—" : "لم تُسلَّم (مرحلة وسيطة)"), rows, stage.planned_rows, parent ? `كل صف هنا تابع لصف في مرحلة «${parent.title_ar}»` : "لا ترتبط بمرحلة سابقة"]);
  });
  if (reviewStage && excludedRows.length > 0) summary.addRow(["صفوف استُبعدت لأنها لا تخص طلبك", REVIEW_SHEET_AR, excludedRows.length, "", "لم تُسلَّم ولم تُحتسب في السعر؛ وُضعت هنا للمراجعة فقط"]);
  summary.addRow([]);
  const intro = summary.addRow([firstSentenceAr(plan.summary_ar)]);
  summary.mergeCells(intro.number, 1, intro.number, 5);
  intro.alignment = { wrapText: true, readingOrder: "rtl" as any, vertical: "middle" };
  intro.height = 32;
  intro.font = { name: "Calibri", size: 11, bold: true };
  const note = summary.addRow([`الأعمدة الأولى في كل ورقة مقروءة؛ وفي آخرها «${ID_HEADER_AR}» و«${PARENT_HEADER_AR}» للربط بين الأوراق (اضغط على «${PARENT_HEADER_AR}» للانتقال إلى صفّه).`]);
  summary.mergeCells(note.number, 1, note.number, 5);
  note.alignment = { wrapText: true, readingOrder: "rtl" as any };
  note.height = 34;
  summary.autoFilter = { from: { row: 1, column: 1 }, to: { row: plan.stages.length + 1 + (reviewStage && excludedRows.length > 0 ? 1 : 0), column: 5 } };
  const xlsx = Buffer.from(await wb.xlsx.writeBuffer());

  // the CSV: the deepest delivered stage, the same columns as its sheet
  const last = layouts[layouts.length - 1];
  const esc = (v: unknown) => `"${csvText(text(v)).replace(/"/g, '""')}"`;
  const lines: string[] = [];
  if (last) {
    const parentByIdRow = new Map((rowsByStage[last.stage.parent_key ?? ""] ?? []).map((r) => [text(r.id), r]));
    lines.push([...last.columns.map((c) => c.title), ID_HEADER_AR, ...(last.hasParent ? [PARENT_HEADER_AR] : [])].map(esc).join(","));
    for (const r of last.rows) lines.push([...last.columns.map((c) => c.get(r, parentByIdRow.get(text(r.parent_id)) ?? null)), r.id, ...(last.hasParent ? [r.parent_id] : [])].map(esc).join(","));
  }
  return { xlsx, csv: `﻿${lines.join("\r\n")}` };
}
