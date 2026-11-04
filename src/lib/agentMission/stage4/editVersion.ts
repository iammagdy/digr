import { checkCustomerLabel } from "../text";
import { editQuote } from "./quotes";
import { deriveVersion, diffVersions, ID_HEADER, PARENT_HEADER, type FileVersion, type VersionDiff, type VersionRow, type VersionSheet } from "./versions";

/**
 * STAGE 4, AN EDIT AFTER DELIVERY IS A NEW VERSION OF THE SAME FILE (docs/STAGE-4.md, FOUNDATION-PLAN PR 6). The contract: the edit REQUEST in (already turned into data: a new column with
 * the values the re-read found, renamed columns, corrected cells, more items), the NEW VERSION and a DIFF SUMMARY out, and the part that had to be re-read. The delivered version is never
 * changed (versions.ts), and no row is ever removed (removing rows is not offered). NO CHARGE: when the real cost of the re-read is known, the price is SHOWN (quotes.ts `editQuote`: the
 * real cost times the markup, at least 100; our own mistake is not free); charging waits for the money PR. Pure.
 */
export type EditRequest =
  | { kind: "add_column"; sheet: string; titleAr: string; /** The new cell of each row (by the row's id), as the re-read found it. */ values: Readonly<Record<string, string>> }
  | { kind: "rename_column"; sheet: string; from: string; to: string }
  | { kind: "set_cells"; sheet: string; cells: ReadonlyArray<{ rowId: string; column: string; value: string }> }
  | { kind: "add_rows"; sheet: string; rows: ReadonlyArray<{ id: string; parentId?: string | null; values: Readonly<Record<string, string>> }> };

export const EDIT_REJECTIONS = ["unknown_sheet", "unknown_column", "column_exists", "unknown_row", "duplicate_row", "locked_column", "bad_title", "empty_edit", "row_removal_not_offered", "unknown_edit"] as const;
export type EditRejection = (typeof EDIT_REJECTIONS)[number];
export const EDIT_REJECTION_AR: Readonly<Record<EditRejection, string>> = {
  unknown_sheet: "هذه الورقة غير موجودة في ملفك.",
  unknown_column: "هذا العمود غير موجود في هذه الورقة.",
  column_exists: "يوجد عمود بهذا الاسم في هذه الورقة. اختر اسمًا آخر.",
  unknown_row: "أحد العناصر المطلوب تعديلها غير موجود في ملفك.",
  duplicate_row: "هذا العنصر موجود في ملفك من قبل.",
  locked_column: "لا يمكن تعديل أعمدة المعرّفات، فهي تربط أوراق الملف ببعضها.",
  bad_title: "اكتب اسم العمود بالعربية وبكلمات قليلة.",
  empty_edit: "لم نجد ما نعدّله في هذا الطلب.",
  row_removal_not_offered: "حذف عناصر من الملف غير متاح. يبقى ملفك كاملًا، ويمكنك طلب عمود أو تصحيح خانة.",
  unknown_edit: "هذا النوع من التعديل غير متاح.",
};
/** A row the re-read gave no value for: the gap is said, never an empty cell. */
export const EDIT_NOT_SEARCHED_AR = "لم يكتمل البحث";

export type EditResult =
  | { ok: true; version: FileVersion; diff: VersionDiff; reread: { sheet: string; columns: string[]; rows: number }; /** The price SHOWN by code (null when the real cost is not known yet). Never charged here. */ quotePoints: number | null }
  | { ok: false; reason: EditRejection };

const LOCKED = new Set([ID_HEADER, PARENT_HEADER]);
const no = (reason: EditRejection): EditResult => ({ ok: false, reason });
const badTitle = (t: unknown): boolean => typeof t !== "string" || t.trim() === "" || checkCustomerLabel(t).issues.length > 0;
/** Where a new column goes: before the id columns (the file keeps its ids last). */
const insertAt = (headers: ReadonlyArray<string>): number => { const i = headers.findIndex((h) => LOCKED.has(h)); return i < 0 ? headers.length : i; };

/** `meta.reason`: «edit» (default) or «review_fix» (an edit that corrects the cells of one review issue: same rules, its own reason on the version). */
export function applyEditRequest(prev: FileVersion, req: EditRequest, meta: { createdAt: string; realCostUsd?: number; reason?: "edit" | "review_fix" }): EditResult {
  const kind = (req as { kind?: unknown }).kind;
  if (kind === "remove_rows" || kind === "delete_rows") return no("row_removal_not_offered");
  if (kind !== "add_column" && kind !== "rename_column" && kind !== "set_cells" && kind !== "add_rows") return no("unknown_edit");
  const sheetAt = prev.sheets.findIndex((s) => s.nameAr === req.sheet);
  if (sheetAt < 0) return no("unknown_sheet");
  const sheet = prev.sheets[sheetAt];
  const ids = new Set(sheet.rows.map((r) => r.id));
  let make: (s: VersionSheet) => VersionSheet;
  let reread: { sheet: string; columns: string[]; rows: number };
  switch (req.kind) {
    case "add_column": {
      if (badTitle(req.titleAr)) return no("bad_title");
      const title = req.titleAr.trim();
      if (sheet.headers.includes(title)) return no("column_exists");
      if (Object.keys(req.values).some((id) => !ids.has(id))) return no("unknown_row");
      const at = insertAt(sheet.headers);
      make = (s) => ({ ...s, headers: [...s.headers.slice(0, at), title, ...s.headers.slice(at)], rows: s.rows.map((r) => ({ ...r, cells: [...r.cells.slice(0, at), String(req.values[r.id] ?? EDIT_NOT_SEARCHED_AR), ...r.cells.slice(at)] })) });
      reread = { sheet: sheet.nameAr, columns: [title], rows: sheet.rows.length };
      break;
    }
    case "rename_column": {
      if (LOCKED.has(req.from)) return no("locked_column");
      const at = sheet.headers.indexOf(req.from);
      if (at < 0) return no("unknown_column");
      if (badTitle(req.to)) return no("bad_title");
      const to = req.to.trim();
      if (sheet.headers.includes(to)) return no("column_exists");
      make = (s) => ({ ...s, headers: s.headers.map((h, i) => (i === at ? to : h)) });
      reread = { sheet: sheet.nameAr, columns: [], rows: 0 };
      break;
    }
    case "set_cells": {
      if (req.cells.length === 0) return no("empty_edit");
      for (const c of req.cells) {
        if (LOCKED.has(c.column)) return no("locked_column");
        if (!sheet.headers.includes(c.column)) return no("unknown_column");
        if (!ids.has(c.rowId)) return no("unknown_row");
      }
      const byKey = new Map(req.cells.map((c) => [`${c.rowId}|${sheet.headers.indexOf(c.column)}`, String(c.value)]));
      make = (s) => ({ ...s, rows: s.rows.map((r) => ({ ...r, cells: r.cells.map((v, j) => byKey.get(`${r.id}|${j}`) ?? v) })) });
      reread = { sheet: sheet.nameAr, columns: [...new Set(req.cells.map((c) => c.column))], rows: new Set(req.cells.map((c) => c.rowId)).size };
      break;
    }
    case "add_rows": {
      if (req.rows.length === 0) return no("empty_edit");
      const seen = new Set<string>();
      for (const r of req.rows) {
        if (typeof r.id !== "string" || r.id === "" || ids.has(r.id) || seen.has(r.id)) return no("duplicate_row");
        seen.add(r.id);
        if (Object.keys(r.values).some((h) => !sheet.headers.includes(h) || LOCKED.has(h))) return no(Object.keys(r.values).some((h) => LOCKED.has(h)) ? "locked_column" : "unknown_column");
      }
      const idAt = sheet.headers.indexOf(ID_HEADER), parentAt = sheet.headers.indexOf(PARENT_HEADER);
      const newRows: VersionRow[] = req.rows.map((r) => ({
        id: r.id, parentId: r.parentId ?? null,
        cells: sheet.headers.map((h, j) => (j === idAt ? r.id : j === parentAt ? String(r.parentId ?? "") : String(r.values[h] ?? EDIT_NOT_SEARCHED_AR))),
      }));
      make = (s) => ({ ...s, rows: [...s.rows, ...newRows] });
      reread = { sheet: sheet.nameAr, columns: [], rows: newRows.length };
      break;
    }
  }
  const version = deriveVersion(prev, (sheets) => sheets.map((s, i) => (i === sheetAt ? make(s) : s)), { reason: meta.reason ?? "edit", createdAt: meta.createdAt });
  return { ok: true, version, diff: diffVersions(prev, version), reread, quotePoints: typeof meta.realCostUsd === "number" ? editQuote(meta.realCostUsd) : null };
}
