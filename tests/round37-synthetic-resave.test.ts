import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { csvExportFromWorkbook } from "../src/lib/server/csvFromExcel";
import { WORLDS, worldOf, type WorldName } from "./helpers/round32Worlds";

/**
 * SYNTHETIC COMPENSATING CONTROL for known gap E-37 (docs/launch/ROUND37-HISTORICAL-TEST-EXCEPTION.md).
 *
 * EVIDENCE LABEL: SYNTHETIC. Every file here is BUILT BY CODE AT TEST TIME from the stored real rows under tests/fixtures/live/missions/ (no committed binary).
 * The "re-save" is a second ExcelJS write pass (load, then write again), which rewrites shared strings, styles and hyperlink relationships the way a
 * viewer's re-save does. It is NOT the original Android-resaved file and DOES NOT PROVE COMPATIBILITY WITH EXCEL FOR ANDROID, or with any other
 * application. It reduces risks 1 and 2 of the exception (a re-save losing text ids / hyperlink targets / cell text / layout flags); it closes none of them.
 * Risk 3 (a spreadsheet's default CSV import turning a 19-digit id into 3.94E+18) is not covered and cannot be covered without a spreadsheet application.
 */
const NAMES = Object.keys(WORLDS) as WorldName[];
const ID_ONLY = /^\d{15,}$/;

async function resave(xlsx: Buffer): Promise<{ original: ExcelJS.Workbook; resaved: ExcelJS.Workbook; resavedBuffer: Buffer }> {
  const original = new ExcelJS.Workbook();
  await original.xlsx.load(xlsx as never);
  const middle = new ExcelJS.Workbook();
  await middle.xlsx.load(xlsx as never);
  const resavedBuffer = Buffer.from(await middle.xlsx.writeBuffer());
  const resaved = new ExcelJS.Workbook();
  await resaved.xlsx.load(resavedBuffer as never);
  return { original, resaved, resavedBuffer };
}
const linkTarget = (v: ExcelJS.CellValue): string | null => (v && typeof v === "object" && "hyperlink" in (v as object) ? String((v as { hyperlink: unknown }).hyperlink) : null);

describe.each(NAMES)("SYNTHETIC re-save of the %s workbook (NOT evidence about Excel for Android)", (name) => {
  it("ids stay TEXT cells, every hyperlink keeps text = target, every cell's text is unchanged, and the structure flags survive a second write pass", async () => {
    const w = await worldOf(name);
    const { original, resaved } = await resave(w.xlsx);
    expect(resaved.worksheets.map((s) => s.name)).toEqual(original.worksheets.map((s) => s.name));
    let idCells = 0, links = 0;
    for (const o of original.worksheets) {
      const r = resaved.getWorksheet(o.name)!;
      expect(r.rowCount).toBe(o.rowCount);
      expect(r.columnCount).toBe(o.columnCount);
      // structure a viewer needs
      expect(r.views[0]?.rightToLeft).toBe(o.views[0]?.rightToLeft);
      expect(r.views[0]?.state).toBe(o.views[0]?.state);
      expect((r.views[0] as { ySplit?: number } | undefined)?.ySplit).toBe((o.views[0] as { ySplit?: number } | undefined)?.ySplit);
      expect(Object.keys((r.model as unknown as { merges?: Record<string, unknown> }).merges ?? {}).length).toBe(Object.keys((o.model as unknown as { merges?: Record<string, unknown> }).merges ?? {}).length);
      for (let c = 1; c <= o.columnCount; c += 1) expect(r.getColumn(c).hidden).toBe(o.getColumn(c).hidden);
      for (let rr = 1; rr <= o.rowCount; rr += 1) {
        for (let c = 1; c <= o.columnCount; c += 1) {
          const a = o.getCell(rr, c), b = r.getCell(rr, c);
          expect(b.text, `${o.name}!${b.address}`).toBe(a.text);
          if (rr > 1 && typeof a.value === "string" && ID_ONLY.test(a.value)) {
            idCells += 1;
            expect(typeof b.value, `${o.name}!${b.address} id stays text`).toBe("string");
            expect(b.value).toBe(a.value);
          }
          const target = linkTarget(a.value);
          if (target !== null) {
            links += 1;
            expect(linkTarget(b.value), `${o.name}!${b.address}`).toBe(target);
            // an external link's visible address is its target; an internal anchor («#'sheet'!H2», the writer's link to the parent row) keeps its own target and its visible text (the parent's id), asserted above and by the text equality
            if (/^https?:\/\//i.test(target)) expect(b.text).toBe(target);
          }
        }
      }
    }
    // the control must actually have looked at something on the worlds that carry ids / links
    if (name !== "x") expect(idCells + links).toBeGreaterThan(0);
  });

  it("the customer's CSV of the re-saved workbook equals the CSV of the original, cell by cell (ids as strings)", async () => {
    const w = await worldOf(name);
    const { resavedBuffer } = await resave(w.xlsx);
    const before = await csvExportFromWorkbook(w.xlsx);
    const after = await csvExportFromWorkbook(resavedBuffer);
    expect(after.stages.map((s) => [s.sheet, s.rows])).toEqual(before.stages.map((s) => [s.sheet, s.rows]));
    for (let i = 0; i < before.stages.length; i += 1) expect(after.stages[i].csv).toBe(before.stages[i].csv);
    expect(after.methodologyCsv).toBe(before.methodologyCsv);
  });
});
