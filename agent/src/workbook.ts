import ExcelJS from "exceljs";
import { SUMMARY_SHEET_AR } from "../../src/lib/modelPlanner/missionWorkbook";
import { wordBoundarySheetName } from "../../src/lib/agentMission/fileNames";
import { REASON_AR, type RelevanceReason } from "../../src/lib/agentMission/relevance";
import { cardTotalOf, deliveryDenominatorOf, requestedRowsOf } from "../../src/lib/agentMission/plan";
import { FILTER_REASON_LABEL_AR, type FilterReason } from "../../src/lib/agentMission/filters";
import { cairoCellDate, cairoText, DATE_NUMBER_FORMAT, DATE_ONLY_NUMBER_FORMAT, dateOnlyCellDate, dateOnlyText, isDateValues, parseDateOnly, parseMoment } from "../../src/lib/agentMission/dateCells";
import { reconcileParentColumns, type ParentColumnFix } from "../../src/lib/agentMission/parentColumns";
import { APPROX_DATES_NOTE_AR, APPROX_DATE_NUMBER_FORMAT, APPROX_WORD_AR, approxColumnsOf } from "../../src/lib/agentMission/relativeDates";
import { isInternalColumn, type PricedPlan, type PricedStage } from "../../src/lib/agentMission/plan";
import { deliveredOfAr, itemNounOfPlan } from "../../src/lib/agentMission/itemNoun";
import { formatAr } from "../../src/lib/arabicDigits";
import { parentCountsOf } from "../../src/lib/agentMission/parents";
import { isTextItemStage, textKeyOf } from "../../src/lib/agentMission/contract";
import { buildMethodology, type MissionFacts } from "./methodology";
import { DECISION_MAKER_NO_AR, DECISION_MAKER_YES_AR, NO_DECISION_MAKERS_NOTE_AR, PERSON_NAME_TITLE_AR, PERSON_TITLE_TITLE_AR, ROW_NUMBER_TITLE_AR, contractTypeOf } from "../../src/lib/agentMission/taskContracts";
import { bilingualActivity, bilingualName, bilingualTitle } from "../../src/lib/agentMission/titleLexicon";
import { titleFieldOf, titleTierOf } from "../../src/lib/agentMission/roles";
import { isPeopleStage } from "../../src/lib/agentMission/people";
import { isCompanyStage } from "../../src/lib/agentMission/entities";
import { companiesWithoutDecisionMakers } from "./perParentLimits";
import { ACTIVITY_AR_KEY, NAME_AR_KEY, TITLE_AR_KEY } from "./namesAr";
import { cleanRowsForCustomer, isProviderUrl, providerContext, withoutProviderNames, withoutProviderUrls, type ProviderCleanReport } from "../../src/lib/agentMission/providerHosts";

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

/**
 * INVISIBLE DIRECTION MARKS IN A NAME CELL (live: a person's name written between U+202A, U+202C and U+200F, which a spreadsheet shows as stray squares or reverses next to Arabic): the embedding and override marks U+202A-U+202E, the left and right marks
 * U+200E and U+200F and the isolates U+2066-U+2069 are removed from the cells of the columns that hold a NAME (a person, a company, an author, a channel, a page), in the workbook and in the CSV alike; the text between them is untouched. Only names: the
 * words of a post or a comment are delivered as the source gave them.
 */
const DIRECTION_MARKS = /[\u202a-\u202e\u200e\u200f\u2066-\u2069]/g;
export const withoutDirectionMarks = (v: unknown): unknown => (typeof v === "string" ? v.replace(DIRECTION_MARKS, "") : v);
const NAME_KEY = /(^|_)(name|full_?name|first_?name|last_?name|display_?name|author|author_?name|username|user_?name|parent_company|company|company_?name|channel|channel_?name|page|page_?name|owner|publisher|uploader|creator|poster|contact)$/i;
const NAME_TITLE = /^(?:اسم(?:\s|$)|الاسم|الناشر|الكاتب|المعلّق|المعلق|كاتب|الشركة|القناة|الصفحة|المصدر|صاحب|اسم الشركة|اسم الموظف)/;
const isNameColumn = (c: SheetColumn): boolean => (c.key !== undefined && NAME_KEY.test(c.key)) || NAME_TITLE.test(c.title.trim());

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
  // THE REFERENCE'S SHEETS (taskContracts.ts, audit 2026-11 reference A): for «companies and their decision makers» each sheet starts with «م» (a running number of its rows), the decision-maker marker and the per-company notes are computed from the delivered people's titles, and the title and name cells read «العربية (English)»
  const referenced = contractTypeOf(plan.stages) === "companies_people";
  const managerStages = referenced ? plan.stages.filter((s) => s.deliver && isPeopleStage(s) && s.role_preference?.role === "manager" && plan.stages.some((p) => p.key === s.parent_key && p.deliver && isCompanyStage(p))) : [];
  const referencedKeys = new Set<string>([...managerStages.map((s) => s.key), ...managerStages.map((s) => s.parent_key ?? "")]);
  const noDecisionMaker = new Set<string>();
  for (const ms of managerStages) for (const id of companiesWithoutDecisionMakers((rowsByStage[ms.parent_key ?? ""] ?? []).map((r) => text(r.id)), rowsByStage[ms.key] ?? [], "manager")) noDecisionMaker.add(id);
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
    // 0. «م»: the running number of the rows of this sheet (one rule for every sheet: per row, in the order of the sheet)
    if (referencedKeys.has(stage.key)) {
      const numberOf = new Map<Row, number>(rows.map((r, i) => [r, i + 1] as const));
      titles.add(ROW_NUMBER_TITLE_AR);
      columns.push({ title: ROW_NUMBER_TITLE_AR, get: (r) => numberOf.get(r) ?? "", kind: "own", key: "__row_number" });
    }
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
    // the reference's computed and bilingual columns (taskContracts.ts): the marker and the notes from the delivered people's titles, a decision maker's title and name as «العربية (English)»
    const isManagerStage = managerStages.includes(stage);
    const ACTIVITY_COLUMN_TITLE_AR = "النشاط والتخصص";
    const specialGet = (c: (typeof own)[number]): ((r: Row) => unknown) | null => {
      if (!referencedKeys.has(stage.key)) return null;
      if (c.computed === "decision_maker" && isManagerStage) return (r) => { const f = titleFieldOf(r); return f && titleTierOf(r[f], "manager") === 0 ? DECISION_MAKER_YES_AR : DECISION_MAKER_NO_AR; };
      if (c.computed === "notes") return (r) => (noDecisionMaker.has(text(isManagerStage ? r.parent_id : r.id)) ? NO_DECISION_MAKERS_NOTE_AR : "");
      if (isManagerStage && c.title_ar === PERSON_TITLE_TITLE_AR) return (r) => bilingualTitle(r[c.key], r[TITLE_AR_KEY]);
      if (!isManagerStage && c.title_ar === ACTIVITY_COLUMN_TITLE_AR) return (r) => bilingualActivity(r[c.key], r[ACTIVITY_AR_KEY]);
      if (isManagerStage && c.title_ar === PERSON_NAME_TITLE_AR) return (r) => bilingualName(r[c.key], r[NAME_AR_KEY]);
      return null;
    };
    for (const c of own) {
      if (titles.has(c.title_ar)) continue;
      const special = specialGet(c);
      const values = rows.map((r) => (special ? special(r) : r[c.key]));
      // a status column («موثّق» / «غير موثّق») says the same words on every row by nature: it is never merged into a twin; neither is a computed column of the reference
      if (c.status_of === undefined && c.type_of === undefined && c.computed === undefined && taken.some((t) => sameValues(t, values))) continue;
      titles.add(c.title_ar);
      taken.push(values);
      const ownText = textGetter(stage, c.key);
      columns.push({ title: c.title_ar, get: special ? (r) => special(r) : ownText ? (r) => ownText(r) : (r) => r[c.key], kind: "own", contact: c.kind !== undefined, link: values.some((v) => isUrl(v)), key: c.key });
    }
    layouts.push({ stageIndex, stage, rows, columns: columns.map((c) => (isNameColumn(c) ? { ...c, get: (row: Row, parent: Row | null) => withoutDirectionMarks(c.get(row, parent)) } : c)), hasParent: stage.parent_key !== null });
  });
  return layouts;
}

/** The generic mailboxes found for the companies: by the key of the stage whose rows are the companies, then by the company row's id. */
export type CompanyMailboxes = Record<string, Map<string, string[]>>;
export const COMPANY_MAILBOXES_KEY = "company_mailboxes";
export const COMPANY_MAILBOXES_HEADER_AR = "إيميلات عامة للشركة";

/** Adds the «إيميلات عامة للشركة» column to each stage that has companies' mailboxes (one cell per company, one address per line), on a copy: the plan and the rows the settlement counts are untouched. */
function withCompanyMailboxes(plan: PricedPlan, rowsIn: Record<string, Row[]>, mailboxes: CompanyMailboxes | undefined): { rowsByStage: Record<string, Row[]>; layoutPlan: PricedPlan } {
  const rowsByStage: Record<string, Row[]> = { ...rowsIn };
  let layoutPlan = plan;
  for (const [stageKey, byParent] of Object.entries(mailboxes ?? {})) {
    const rows = rowsByStage[stageKey];
    if (!rows || ![...byParent.values()].some((v) => v.length > 0)) continue;
    // A COMPANY STEP EXISTS FOR THIS STAGE (the company's e-mail is a column of the reference, taskContracts.ts): these addresses ARE its candidates, so there is no second column. A company whose e-mail cell is still empty (the step did not reach it) keeps the first one it was given, «غير موثّق»: a found value is never dropped.
    const step = (plan.contact_steps ?? []).find((x) => x.level === "company" && x.kind === "email" && x.stage_key === stageKey);
    if (step) {
      const filled = rows.map((r) => {
        const have = text(r[step.column_key]).trim();
        const first = (byParent.get(text(r.id)) ?? [])[0];
        return have === "" && first ? { ...r, [step.column_key]: first, [step.status_key]: "غير موثّق" } : r;
      });
      // the company's e-mail is ONE address (the best role mailbox); any other mailbox found for it stays in the old column, one per line: a found value is never dropped
      const extras = new Map(filled.map((r) => [text(r.id), (byParent.get(text(r.id)) ?? []).filter((m) => m.toLowerCase() !== text(r[step.column_key]).trim().toLowerCase())] as const));
      if (![...extras.values()].some((v) => v.length > 0)) { rowsByStage[stageKey] = filled; continue; }
      rowsByStage[stageKey] = filled.map((r) => ({ ...r, [COMPANY_MAILBOXES_KEY]: (extras.get(text(r.id)) ?? []).join("\n") }));
      layoutPlan = { ...layoutPlan, stages: layoutPlan.stages.map((st) => (st.key === stageKey ? { ...st, columns: [...st.columns, { key: COMPANY_MAILBOXES_KEY, title_ar: COMPANY_MAILBOXES_HEADER_AR }] } : st)) };
      continue;
    }
    rowsByStage[stageKey] = rows.map((r) => ({ ...r, [COMPANY_MAILBOXES_KEY]: (byParent.get(text(r.id)) ?? []).join("\n") }));
    layoutPlan = { ...layoutPlan, stages: layoutPlan.stages.map((s) => (s.key === stageKey ? { ...s, columns: [...s.columns, { key: COMPANY_MAILBOXES_KEY, title_ar: COMPANY_MAILBOXES_HEADER_AR }] } : s)) };
  }
  return { rowsByStage, layoutPlan };
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
export interface WorkbookFacts { sheets: number; hasParentColumn: boolean; parentLinked: boolean; hasDateColumn: boolean; /** The sheets start with «م», the running number of their rows. */ hasRowNumber?: boolean; /** Some date of the file was computed from a relative time the source gave («قبل ٣ أيام»). */ hasApproxDates?: boolean }

/** The closing note of the summary sheet, built from the sheets and columns the file REALLY has: a link between sheets is described only when a parent column and its target sheet exist; the time zone only when a date column exists. */
export function workbookNoteAr(f: WorkbookFacts): string {
  const where = f.sheets > 1 ? "كل ورقة" : "الورقة";
  const parts = [`الأعمدة الأولى في ${where} مقروءة؛ وفي آخرها «${ID_HEADER_AR}»${f.hasParentColumn ? ` و«${PARENT_HEADER_AR}»` : ""}${f.sheets > 1 && f.hasParentColumn ? " للربط بين الأوراق" : ""}${f.parentLinked ? ` (اضغط على «${PARENT_HEADER_AR}» للانتقال إلى صفّه)` : ""}.`];
  if (f.hasRowNumber) parts.push(`العمود «${ROW_NUMBER_TITLE_AR}» رقم تسلسلي لصفوف كل ورقة.`);
  if (f.hasDateColumn) parts.push("التواريخ والأوقات بتوقيت القاهرة.");
  if (f.hasApproxDates) parts.push(APPROX_DATES_NOTE_AR);
  return parts.join(" ");
}

/**
 * THE «المنهجية» SECTION, written BELOW the summary in the FIRST sheet (never a sheet of its own: the settlement counts the items of every sheet after the first). A title bar, then one labelled block per fact, the counts of every stage as a small table
 * and the reasons for what was left out. Text only: nothing here is a number the settlement could read.
 */
function addMethodologySection(sheet: ExcelJS.Worksheet, model: ReturnType<typeof buildMethodology>): void {
  const WIDTH = 104; // the characters a merged B:E block shows on a line (14 + 14 + 24 + 52)
  const heightOf = (lines: string[]): number => Math.max(20, lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / WIDTH)), 0) * 15 + 6);
  sheet.addRow([]);
  const title = sheet.addRow([model.title]);
  sheet.mergeCells(title.number, 1, title.number, 5);
  title.height = 26;
  title.alignment = { horizontal: "right", vertical: "middle", readingOrder: "rtl" as any };
  title.font = { name: "Calibri", size: 12, bold: true, color: { argb: WHITE } };
  title.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  const block = (label: string, values: string[]) => {
    const row = sheet.addRow([label, values.join("\n")]);
    sheet.mergeCells(row.number, 2, row.number, 5);
    row.height = heightOf(values);
    row.alignment = { vertical: "top", wrapText: true, horizontal: "right", readingOrder: "rtl" as any };
    row.getCell(1).font = { name: "Calibri", size: 10, bold: true };
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
    row.getCell(2).font = { name: "Calibri", size: 10 };
    [1, 2].forEach((c) => { row.getCell(c).border = BORDER; });
  };
  for (const item of model.items) {
    block(item.label, item.values);
    if (item.label !== model.tableAfterLabel) continue;
    block("الأعداد في كل مرحلة", ["قراءة ما أعطاه المصدر، وما استُبعد ولماذا، وما سُلّم في ملفك."]);
    const head = sheet.addRow(model.table.head);
    head.eachCell((cell) => { cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: WHITE } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } }; cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; });
    for (const r of model.table.rows) {
      const row = sheet.addRow(r);
      row.alignment = { vertical: "middle", wrapText: true, horizontal: "center", readingOrder: "rtl" as any };
      row.getCell(1).alignment = { vertical: "middle", wrapText: true, horizontal: "right", readingOrder: "rtl" as any };
      row.eachCell((cell) => { cell.border = BORDER; cell.font = { name: "Calibri", size: 10 }; });
    }
    if (model.reasons.length) block("أسباب الاستبعاد", model.reasons);
  }
}

export async function buildMissionFiles(plan: PricedPlan, rowsIn: Record<string, Row[]>, facts?: MissionFacts, companyMailboxes?: CompanyMailboxes): Promise<{ xlsx: Buffer; csv: string; /** Wrong parent-describing values of a child sheet that were replaced from the row's own parent (for the admin only). */ parentFixes: ParentColumnFix[]; /** What was taken out of the customer's cells because it named a data provider (for the admin only). */ providerFixes: ProviderCleanReport & { final: number } }> {
  // BEFORE THE FILE IS WRITTEN: every value of a child row that describes its parent must be its OWN parent's (parentColumns.ts); a mapping that copied the first company's website onto every person is repaired here and reported to the admin
  const reconciled = reconcileParentColumns(plan.stages, rowsIn, (key) => { const st = plan.stages.find((x) => x.key === key); return st ? readableColumns(st).map((c) => c.key) : []; }, (key) => { const st = plan.stages.find((x) => x.key === key); return st ? readableColumns(st).map((c) => c.key) : []; });
  // NO DATA PROVIDER IN A CUSTOMER FILE (providerHosts.ts): its addresses are taken out of every cell and an id built from one is replaced by a neutral id, the same wherever it is written
  const providers = providerContext();
  const cleaned = cleanRowsForCustomer(reconciled.rowsByStage, providers);
  // THE COMPANIES' OWN E-MAILS (role and generic mailboxes the people source gave: info@, customer_care@, webmaster@) are a COLUMN of the company's sheet, never rows of the people sheet: they add no row, so they are not counted and not charged
  const { rowsByStage, layoutPlan } = withCompanyMailboxes(plan, cleaned.rowsByStage, companyMailboxes);
  const layouts = layoutOf(layoutPlan, rowsByStage);
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
  // a delivery short of the CARD the customer approved is told against the card's total (the same number the final line and the notice say); one that fills a card with a lowered target is told against the request
  const requestedCount = deliveryDenominatorOf(deliveredCount, cardTotalOf(plan), requestedRowsOf(plan));
  const intro = summary.addRow([`تم تسليم ${deliveredOfAr(deliveredCount, requestedCount, itemNounOfPlan(plan))}.`]);
  summary.mergeCells(intro.number, 1, intro.number, 5);
  intro.alignment = { wrapText: true, readingOrder: "rtl" as any, vertical: "middle" };
  intro.height = 32;
  intro.font = { name: "Calibri", size: 11, bold: true };
  const parentLinked = layouts.some((l) => l.hasParent && sheetNameOf.has(l.stage.parent_key!) && (idCell.get(l.stage.parent_key!)?.size ?? 0) > 0);
  const note = summary.addRow([workbookNoteAr({ sheets: layouts.length, hasParentColumn: layouts.some((l) => l.hasParent), parentLinked, hasDateColumn, hasApproxDates, hasRowNumber: layouts.some((l) => l.columns[0]?.key === "__row_number") })]);
  summary.mergeCells(note.number, 1, note.number, 5);
  note.alignment = { wrapText: true, readingOrder: "rtl" as any };
  note.height = 34;
  addMethodologySection(summary, buildMethodology({ plan, layouts, rowsByStage, facts }));
  summary.autoFilter = { from: { row: 1, column: 1 }, to: { row: plan.stages.length + 1, column: 5 } };
  // THE LAST LOOK, at every cell of every sheet: an address of a provider is taken out; in the texts we write (the first sheet and the headings) a provider's name is taken out too
  let finalFixes = 0;
  wb.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        const ours = sheet.name === SUMMARY_SHEET_AR || rowNumber === 1;
        const fix = (t: string): string => { const a = withoutProviderUrls(t, providers); return ours ? withoutProviderNames(a, providers) : a; };
        if (typeof v === "string") { const f = fix(v); if (f !== v) { cell.value = f === "" ? null : f; finalFixes += 1; } }
        else if (v && typeof v === "object" && "hyperlink" in v && typeof (v as { hyperlink?: unknown }).hyperlink === "string") {
          const link = String((v as { hyperlink: string }).hyperlink);
          if (isProviderUrl(link, providers)) { cell.value = null; finalFixes += 1; }
        }
      });
    });
  });
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
  // the CSV gets the same last look
  const csvOut = withoutProviderUrls(`﻿${lines.join("\r\n")}`, providers);
  if (csvOut !== `﻿${lines.join("\r\n")}`) finalFixes += 1;
  return { xlsx, csv: csvOut, parentFixes: reconciled.fixes, providerFixes: { ...cleaned.report, final: finalFixes } };
}
