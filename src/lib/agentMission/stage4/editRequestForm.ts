import { formatAr, normalizeDigits } from "../../arabicDigits";
import type { EditSchemaView } from "./editRequestLabels";

/**
 * STAGE B: WHAT THE CUSTOMER TYPES BECOMES THE SERVER'S REQUEST (client-safe: no server module). The form state is plain text from the inputs; `editInputOf` turns it into the body the route accepts, or says in Arabic what is missing. It carries the
 * customer's words and nothing else: no price, no item id (an item is named by its NUMBER in its sheet; the server finds its id), no plan, no owner. It is a convenience: the server checks everything again and is the only authority.
 */
export type EditForm =
  | { kind: "rename_column"; sheet: string; from: string; to: string }
  | { kind: "set_cells"; sheet: string; cells: Array<{ row: string; column: string; value: string }> }
  /** One entry per new item: the typed value of each column of the sheet. */
  | { kind: "add_rows"; sheet: string; rows: Array<Record<string, string>> }
  | { kind: "add_column"; sheet: string; titleAr: string };

/** The body the route accepts as `edit` (item numbers, not ids). */
export type EditInput =
  | { kind: "rename_column"; sheet: string; from: string; to: string }
  | { kind: "set_cells"; sheet: string; cells: Array<{ row: number; column: string; value: string }> }
  | { kind: "add_rows"; sheet: string; rows: Array<{ values: Record<string, string> }> }
  | { kind: "add_column"; sheet: string; titleAr: string };

export const EDIT_FORM_LIMITS = { cells: 100, rows: 50, value: 500 } as const;

export const EDIT_FORM_AR = {
  sheet: "اختر الورقة.",
  column: "اختر العمود.",
  newName: "اكتب الاسم الجديد للعمود.",
  columnTitle: "اكتب اسم العمود الجديد.",
  noCells: "أضف خانة واحدة على الأقل.",
  noRows: "أضف عنصرًا واحدًا على الأقل.",
  value: "اكتب القيمة الجديدة لكل خانة.",
  tooLong: "إحدى القيم طويلة؛ اختصرها.",
  twice: "لا يمكن تصحيح الخانة نفسها مرتين في طلب واحد.",
  tooMany: "هذا أكثر مما يمكن في طلب واحد؛ قسّمه إلى طلبين.",
  item: (items: number): string => `اكتب رقم عنصر موجود في الورقة، من ${formatAr(1)} إلى ${formatAr(items)}.`,
  missing: (columns: ReadonlyArray<string>): string => `املأ كل أعمدة العنصر الجديد؛ ينقصك: ${columns.map((c) => `«${c}»`).join("، ")}.`,
} as const;

export type EditInputResult = { ok: true; input: EditInput } | { ok: false; messageAr: string };
const no = (messageAr: string): EditInputResult => ({ ok: false, messageAr });

export function editInputOf(form: EditForm, schema: EditSchemaView): EditInputResult {
  const sheet = schema.sheets.find((s) => s.name === form.sheet);
  if (!sheet) return no(EDIT_FORM_AR.sheet);
  switch (form.kind) {
    case "rename_column": {
      const from = form.from.trim();
      const to = form.to.trim();
      if (from === "" || !sheet.columns.includes(from)) return no(EDIT_FORM_AR.column);
      if (to === "") return no(EDIT_FORM_AR.newName);
      return { ok: true, input: { kind: "rename_column", sheet: sheet.name, from, to } };
    }
    case "set_cells": {
      if (form.cells.length === 0) return no(EDIT_FORM_AR.noCells);
      if (form.cells.length > EDIT_FORM_LIMITS.cells) return no(EDIT_FORM_AR.tooMany);
      const seen = new Set<string>();
      const cells: Array<{ row: number; column: string; value: string }> = [];
      for (const c of form.cells) {
        const rowText = normalizeDigits(c.row.trim());
        if (!/^[1-9][0-9]{0,6}$/.test(rowText) || Number(rowText) > sheet.items) return no(EDIT_FORM_AR.item(sheet.items));
        const column = c.column.trim();
        if (column === "" || !sheet.columns.includes(column)) return no(EDIT_FORM_AR.column);
        const value = c.value.trim();
        if (value === "") return no(EDIT_FORM_AR.value);
        if (value.length > EDIT_FORM_LIMITS.value) return no(EDIT_FORM_AR.tooLong);
        const key = `${rowText}|${column}`;
        if (seen.has(key)) return no(EDIT_FORM_AR.twice);
        seen.add(key);
        cells.push({ row: Number(rowText), column, value });
      }
      return { ok: true, input: { kind: "set_cells", sheet: sheet.name, cells } };
    }
    case "add_rows": {
      if (form.rows.length === 0) return no(EDIT_FORM_AR.noRows);
      if (form.rows.length > EDIT_FORM_LIMITS.rows) return no(EDIT_FORM_AR.tooMany);
      const rows: Array<{ values: Record<string, string> }> = [];
      for (const r of form.rows) {
        const values: Record<string, string> = {};
        const missing: string[] = [];
        for (const column of sheet.columns) {
          const v = (r[column] ?? "").trim();
          if (v === "") missing.push(column);
          else if (v.length > EDIT_FORM_LIMITS.value) return no(EDIT_FORM_AR.tooLong);
          else values[column] = v;
        }
        if (missing.length > 0) return no(EDIT_FORM_AR.missing(missing));
        rows.push({ values });
      }
      return { ok: true, input: { kind: "add_rows", sheet: sheet.name, rows } };
    }
    case "add_column": {
      const titleAr = form.titleAr.trim();
      return titleAr === "" ? no(EDIT_FORM_AR.columnTitle) : { ok: true, input: { kind: "add_column", sheet: sheet.name, titleAr } };
    }
  }
}

/** A blank form of this kind on the given sheet (the first sheet by default). */
export function emptyForm(kind: EditForm["kind"], schema: EditSchemaView, sheet?: string): EditForm {
  const name = sheet !== undefined && schema.sheets.some((s) => s.name === sheet) ? sheet : (schema.sheets[0]?.name ?? "");
  switch (kind) {
    case "rename_column": return { kind, sheet: name, from: "", to: "" };
    case "set_cells": return { kind, sheet: name, cells: [{ row: "", column: "", value: "" }] };
    case "add_rows": return { kind, sheet: name, rows: [{}] };
    case "add_column": return { kind, sheet: name, titleAr: "" };
  }
}
