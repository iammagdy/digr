import ExcelJS from "exceljs";
import { columnsOfMap } from "./fieldMap";
import type { StoredModelPlan } from "./types";

/**
 * THE WORKBOOK OF A MISSION: one sheet per delivered stage, LINKED by ids. Every delivered row of a mission carries `mission_row_id` (its own id: the source's id when the plan maps one, else
 * a number made by the engine) and `mission_parent_id` (the id of the row of the earlier stage it was collected for). The sheets repeat those two columns first, so a customer joins them in
 * any tool («المنشورات» and «التعليقات» by the post id; «الشركات» and «الموظفون» and «جهات الاتصال» by the ids), and the parent id is a link to the parent's row. Headers are frozen, filters are on,
 * numbers are stored as numbers, links are links, and the first sheet says in plain Arabic what each sheet holds and how they connect.
 */
const NAVY = "FF1B365D";
const WHITE = "FFFFFFFF";
const ZEBRA = "FFF8FAFC";
const BORDER = { top: { style: "thin" as const, color: { argb: "FFD0D7DE" } }, left: { style: "thin" as const, color: { argb: "FFD0D7DE" } }, bottom: { style: "thin" as const, color: { argb: "FFD0D7DE" } }, right: { style: "thin" as const, color: { argb: "FFD0D7DE" } } };

export const SUMMARY_SHEET_AR = "ملخص المهمة";
const ID_HEADER_AR = "المعرّف";
const PARENT_HEADER_AR = "معرّف الأصل";
const NUMERIC_ROLES = new Set(["likes", "replies", "shares", "views", "followers"]);

/** A sheet name Excel accepts: at most 31 characters, none of [ ] : * ? / \, unique in the book. */
export function safeSheetName(title: string, used: Set<string>, fallback: string): string {
  let base = String(title || "").replace(/[\[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 28) || fallback;
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base.slice(0, 26)} ${n}`;
  used.add(name.toLowerCase());
  return name;
}

/** A text that starts like a formula is stored as text (a customer's word is never run as a formula). */
const textCell = (v: string): string => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

function cellOf(value: unknown, numeric: boolean, isLink: boolean): ExcelJS.CellValue {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  const text = String(value);
  if (numeric && /^-?\d+(?:\.\d+)?$/.test(text.trim())) return Number(text);
  if ((isLink || /^https?:\/\//i.test(text.trim())) && /^https?:\/\//i.test(text.trim())) return { text: text.trim(), hyperlink: text.trim(), tooltip: text.trim() };
  return textCell(text);
}

export async function generateMissionWorkbook(rows: ReadonlyArray<Record<string, unknown>>, plan: StoredModelPlan): Promise<Buffer> {
  const stages = plan.stages ?? [];
  const wb = new ExcelJS.Workbook();
  wb.creator = "Diger";
  const used = new Set<string>([SUMMARY_SHEET_AR.toLowerCase()]);
  const byStage = stages.map((_, i) => rows.filter((r) => Number(r.mission_stage) === i + 1));
  const names: Array<string | null> = stages.map((s, i) => (s.deliver && byStage[i].length > 0 ? safeSheetName(s.titleAr, used, `مرحلة ${i + 1}`) : null));
  const summary = wb.addWorksheet(SUMMARY_SHEET_AR, { views: [{ state: "frozen", ySplit: 1, rightToLeft: true }] });
  const idRowOf: Array<Map<string, number>> = stages.map(() => new Map());

  stages.forEach((stage, i) => {
    const name = names[i];
    if (!name) return;
    const step = plan.steps[i];
    const cols = columnsOfMap(step.fieldMap);
    const hasParent = stage.parent !== null && names[stage.parent!] !== undefined && names[stage.parent!] !== null;
    const headers = [ID_HEADER_AR, ...(stage.parent !== null ? [PARENT_HEADER_AR] : []), ...cols.map((c) => c.titleAr)];
    const sheet = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1, rightToLeft: true }] });
    sheet.columns = headers.map((h, j) => ({ width: j === 0 ? 16 : j === 1 && stage.parent !== null ? 16 : /نص|تعليق|وصف|عنوان/.test(h) ? 48 : 24 }));
    const head = sheet.addRow(headers);
    head.eachCell((cell) => { cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: WHITE } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } }; cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; });
    head.height = 30;
    byStage[i].forEach((record, r) => {
      const id = String(record.mission_row_id ?? "");
      const parentId = String(record.mission_parent_id ?? "");
      const values: ExcelJS.CellValue[] = [textCell(id)];
      if (stage.parent !== null) values.push(textCell(parentId));
      cols.forEach((c, k) => {
        const colDef = step.fieldMap.columns[k];
        values.push(cellOf(record[c.key], NUMERIC_ROLES.has(String(colDef?.role)) || colDef?.transform === "number", colDef?.role === "url" || colDef?.role === "website"));
      });
      const row = sheet.addRow(values);
      idRowOf[i].set(id, r + 2);
      row.alignment = { vertical: "middle", wrapText: true };
      row.eachCell((cell) => { cell.border = BORDER; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: r % 2 ? ZEBRA : WHITE } }; if (cell.hyperlink) cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true }; });
    });
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: byStage[i].length + 1, column: headers.length } };
    void hasParent;
  });

  // the parent id is a link to the parent's row, where the parent stage is a delivered sheet
  stages.forEach((stage, i) => {
    const name = names[i];
    if (!name || stage.parent === null) return;
    const parentName = names[stage.parent];
    if (!parentName) return;
    const sheet = wb.getWorksheet(name)!;
    byStage[i].forEach((record, r) => {
      const parentId = String(record.mission_parent_id ?? "");
      const target = idRowOf[stage.parent!].get(parentId);
      if (!target) return;
      const cell = sheet.getRow(r + 2).getCell(2);
      cell.value = { text: parentId, hyperlink: `#'${parentName.replace(/'/g, "''")}'!A${target}`, tooltip: parentName };
      cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true };
    });
  });

  // the first sheet: what each sheet holds and how they connect
  summary.columns = [{ width: 30 }, { width: 24 }, { width: 14 }, { width: 14 }, { width: 44 }];
  const sh = summary.addRow(["المرحلة", "الورقة", "الصفوف", "المطلوب", "ترتبط بـ"]);
  sh.eachCell((cell) => { cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: WHITE } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } }; cell.alignment = { horizontal: "center", vertical: "middle" }; });
  stages.forEach((stage, i) => {
    const parentTitle = stage.parent !== null ? stages[stage.parent].titleAr : "";
    summary.addRow([stage.titleAr, names[i] ?? (stage.deliver ? "—" : "لم تُسلَّم (مرحلة وسيطة)"), byStage[i].length, stage.effVolume, stage.parent !== null ? `«${PARENT_HEADER_AR}» يشير إلى «${ID_HEADER_AR}» في مرحلة «${parentTitle}»` : "لا ترتبط بمرحلة سابقة"]);
  });
  summary.addRow([]);
  // the note describes only the columns the file really has: «معرّف الأصل» and the link between sheets exist only when a stage has a parent
  const anyParent = stages.some((st) => st.parent !== null);
  const note = summary.addRow([anyParent ? `كل ورقة تبدأ بالعمودين «${ID_HEADER_AR}» و«${PARENT_HEADER_AR}»؛ اربط الأوراق بهما، أو اضغط على «${PARENT_HEADER_AR}» للانتقال إلى صفّه.` : `كل ورقة تبدأ بالعمود «${ID_HEADER_AR}».`]);
  summary.mergeCells(note.number, 1, note.number, 5);
  note.alignment = { wrapText: true, readingOrder: "rtl" as any };
  note.height = 36;
  summary.autoFilter = { from: { row: 1, column: 1 }, to: { row: stages.length + 1, column: 5 } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** True when the delivered rows are those of a multi-stage mission (the files then take the linked-sheets form). */
export const isMissionRowSet = (plan: StoredModelPlan | undefined, rows: ReadonlyArray<Record<string, unknown>>): boolean => Boolean(plan?.stages && plan.stages.length > 1 && rows.some((r) => typeof r.mission_stage === "number"));
