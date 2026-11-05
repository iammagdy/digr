import { describe, expect, it } from "vitest";
import { EDIT_REJECTIONS, EDIT_REJECTION_AR, applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import { firstVersionFromCells, type FileVersion } from "../src/lib/agentMission/stage4/versions";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { tiktokWorld } from "./helpers/round11Worlds";

/**
 * STAGE 4 (docs/STAGE-4.md), AN EDIT AFTER DELIVERY IS A NEW VERSION OF THE SAME FILE: the request in, the new version and a diff summary out, version 1 unchanged, and no charge (a price is
 * shown by code when the real cost is known). FOUNDATION-PLAN PR 6 acceptance: «ضيف عمود ...» on the stored result of M12 (msn_5851abc92a1e6645a9cd, rebuilt from its stored real rows).
 */
const v1 = async (): Promise<FileVersion> => firstVersionFromCells({ missionId: "msn_m12", cells: (await tiktokWorld()).cells, createdAt: "2026-11-04T10:00:00.000Z" });
const AT = { createdAt: "2026-11-04T12:00:00.000Z" };

describe("«ضيف عمود ...» on the M12 file", () => {
  it("version 2 has the new column on the comments sheet; only that part is new (re-read); version 1 is unchanged", async () => {
    const one = await v1();
    const before = JSON.stringify(one);
    const sheet = one.sheets[1];
    const values = Object.fromEntries(sheet.rows.map((r, i) => [r.id, i % 2 === 0 ? "إيجابي" : "محايد"]));
    const r = applyEditRequest(one, { kind: "add_column", sheet: sheet.nameAr, titleAr: "انطباع التعليق", values }, { ...AT, realCostUsd: 0.004 });
    if (!r.ok) throw new Error(r.reason);
    expect(JSON.stringify(one)).toBe(before);
    expect([r.version.version, r.version.parent, r.version.reason]).toEqual([2, 1, "edit"]);
    const s2 = r.version.sheets[1];
    // the new column sits before the id columns; every old cell is where it was
    expect(s2.headers).toEqual([...sheet.headers.slice(0, sheet.headers.indexOf("المعرّف")), "انطباع التعليق", ...sheet.headers.slice(sheet.headers.indexOf("المعرّف"))]);
    expect(r.diff).toMatchObject({ rowsAdded: 0, rowsRemoved: 0, rowsChanged: 0, cellsChanged: 0, cellsAdded: sheet.rows.length, columnsAdded: [{ sheet: sheet.nameAr, titleAr: "انطباع التعليق" }] });
    expect(r.reread).toEqual({ sheet: sheet.nameAr, columns: ["انطباع التعليق"], rows: sheet.rows.length });
    expect(r.version.sheets[0]).toEqual(one.sheets[0]);
    // no charge: a price shown by code (the real cost times the markup, at least 100) and nothing else
    expect(r.quotePoints).toBe(100);
    expect(r).not.toHaveProperty("charged");
  });
  it("a row the edit gives no value for says so («لم يكتمل البحث»), never an empty cell", async () => {
    const one = await v1();
    const sheet = one.sheets[1];
    const r = applyEditRequest(one, { kind: "add_column", sheet: sheet.nameAr, titleAr: "انطباع التعليق", values: { [sheet.rows[0].id]: "إيجابي" } }, AT);
    if (!r.ok) throw new Error(r.reason);
    const at = r.version.sheets[1].headers.indexOf("انطباع التعليق");
    expect(r.version.sheets[1].rows.slice(1).every((x) => x.cells[at] === "لم يكتمل البحث")).toBe(true);
    expect(r.quotePoints).toBeNull();
  });
});

describe("the other edits", () => {
  it("rename a column; correct cells; add rows: each a new version with its diff, never a removed row", async () => {
    const one = await v1();
    const s = one.sheets[0];
    const first = s.headers[0];
    const renamed = applyEditRequest(one, { kind: "rename_column", sheet: s.nameAr, from: first, to: "النص الكامل" }, AT);
    expect(renamed.ok && renamed.diff.columnsAdded.map((c) => c.titleAr)).toEqual(["النص الكامل"]);
    expect(renamed.ok && renamed.diff.rowsRemoved).toBe(0);
    const fixed = applyEditRequest(one, { kind: "set_cells", sheet: s.nameAr, cells: [{ rowId: s.rows[0].id, column: first, value: "نص مصحح" }] }, AT);
    expect(fixed.ok && [fixed.diff.rowsChanged, fixed.diff.cellsChanged]).toEqual([1, 1]);
    const added = applyEditRequest(one, { kind: "add_rows", sheet: s.nameAr, rows: [{ id: "new_1", values: { [first]: "عنصر إضافي" } }] }, AT);
    expect(added.ok && [added.diff.rowsAdded, added.version.sheets[0].rows.length]).toEqual([1, s.rows.length + 1]);
  });
  it("refusals are codes with fixed Arabic sentences; nothing is made", async () => {
    const one = await v1();
    const s = one.sheets[0];
    const cases: Array<[Parameters<typeof applyEditRequest>[1], string]> = [
      [{ kind: "add_column", sheet: "ورقة غير موجودة", titleAr: "عمود", values: {} }, "unknown_sheet"],
      [{ kind: "add_column", sheet: s.nameAr, titleAr: s.headers[0], values: {} }, "column_exists"],
      [{ kind: "add_column", sheet: s.nameAr, titleAr: "", values: {} }, "bad_title"],
      [{ kind: "add_column", sheet: s.nameAr, titleAr: "column_x", values: {} }, "bad_title"],
      [{ kind: "add_column", sheet: s.nameAr, titleAr: "عمود", values: { nope: "x" } }, "unknown_row"],
      [{ kind: "rename_column", sheet: s.nameAr, from: "المعرّف", to: "رقم" }, "locked_column"],
      [{ kind: "rename_column", sheet: s.nameAr, from: "لا يوجد", to: "رقم" }, "unknown_column"],
      [{ kind: "set_cells", sheet: s.nameAr, cells: [] }, "empty_edit"],
      [{ kind: "set_cells", sheet: s.nameAr, cells: [{ rowId: s.rows[0].id, column: "المعرّف", value: "x" }] }, "locked_column"],
      [{ kind: "add_rows", sheet: s.nameAr, rows: [{ id: s.rows[0].id, values: {} }] }, "duplicate_row"],
      [{ kind: "remove_rows", sheet: s.nameAr, ids: [s.rows[0].id] } as never, "row_removal_not_offered"],
    ];
    for (const [req, code] of cases) expect(applyEditRequest(one, req, AT), code).toEqual({ ok: false, reason: code });
    for (const code of EDIT_REJECTIONS) expect(checkCustomerText(EDIT_REJECTION_AR[code]).issues, code).toEqual([]);
  });
});
