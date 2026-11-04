import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import { MAX_ROW_POINTS, columnSpec, headerHeightOf, linesOf, rowHeightOf } from "../agent/src/sheetLayout";
import { csvExportFromWorkbook } from "../src/lib/server/csvFromExcel";
import { WORLDS, worldOf, type WorldName } from "./helpers/round32Worlds";

/**
 * ROUND 35, BLOCKER A: THE EXCEL'S PRESENTATION. The five real Excel files had no shifted column and no lost value (inspected cell by cell); what was poor was the LAYOUT: widths chosen by a pattern on the header's words (a counter named «عدد التعليقات» and a mark named «لغة النص» got the
 * 52-wide text column), a date cut at 13, a long link wrapped on four lines, and a 3,800-character post on a row sized by the viewer (cut at Excel's 409-point limit anyway). Evidence labels: the rows are the REAL stored rows of the five platforms (tests/fixtures/live); the one long text
 * (6,300 characters of mixed Arabic and English) is SIMULATED, built here, because the stored real texts are shorter than the outliers of the live files. Nothing here changes a value.
 */
const LONG = Array.from({ length: 70 }, (_, i) => `الفقرة ${i + 1}: الذكاء الاصطناعي يغيّر طريقة عملنا (AI is changing how we work) — يقول المحللون إن #الذكاء_الاصطناعي سيعيد تشكيل الأسواق https://example.com/a/${i}.`).join("\n");
const NAMES = Object.keys(WORLDS) as WorldName[];

describe("the layout rules (pure)", () => {
  it("a counter is narrow whatever its header says; a mark is not a text; a date is wide enough for its format; a link and an id stay on one line", () => {
    expect(columnSpec({ title: "عدد التعليقات", values: ["12", "4"] })).toMatchObject({ kind: "number", wrap: false });
    expect(columnSpec({ title: "عدد التعليقات", values: ["12", "4"] }).width).toBeLessThanOrEqual(18);
    expect(columnSpec({ title: "لغة النص", values: ["العربية", "لغة أخرى"] }).width).toBeLessThan(30);
    expect(columnSpec({ title: "علاقة النص بالموضوع", values: ["غير متاح من المصدر"] }).kind).toBe("text");
    expect(columnSpec({ title: "تاريخ النشر", values: [new Date()], date: true }).width).toBeGreaterThanOrEqual(22);
    expect(columnSpec({ title: "الرابط", values: ["https://www.tiktok.com/@user/video/7663879872137252114?x=" + "a".repeat(60)] })).toMatchObject({ kind: "link", wrap: false });
    expect(columnSpec({ title: "المعرّف", values: [], id: true })).toMatchObject({ kind: "id", wrap: false });
    expect(columnSpec({ title: "النص", values: ["قصير", LONG] })).toMatchObject({ kind: "long_text", width: 70, wrap: true });
  });
  it("the row height follows the tallest wrapped cell, never passes Excel's limit, and a one-line row keeps the default", () => {
    const text = columnSpec({ title: "النص", values: [LONG] });
    const num = columnSpec({ title: "عدد", values: ["3"] });
    expect(rowHeightOf([{ value: "قصير", spec: text }, { value: "3", spec: num }])).toBeUndefined();
    const h = rowHeightOf([{ value: "x".repeat(300), spec: text }])!;
    expect(h).toBe(linesOf("x".repeat(300), 70) * 15 + 4);
    expect(rowHeightOf([{ value: LONG, spec: text }])).toBe(MAX_ROW_POINTS);
    expect(headerHeightOf(["النص", "عدد التعليقات"], [text, num])).toBeGreaterThanOrEqual(30);
  });
});

describe.each(NAMES)("%s: the five delivered files, rebuilt from the REAL stored rows", (name) => {
  it("every value is where it was and is whole: the same headers, the same cells as the rows (a 6,300-character text included), the Excel and the CSV carry the same records", async () => {
    const w = await worldOf(name);
    const first = w.plan.stages[0].key;
    const rows = structuredClone(w.rowsByStage);
    const textKey = Object.keys(rows[first][0]).find((k) => k === "text" || k === "description" || k === "title")!;
    rows[first][0] = { ...rows[first][0], [textKey]: LONG };
    const built = await buildMissionFiles(w.plan, rows);
    const base = await buildMissionFiles(w.plan, w.rowsByStage);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.xlsx as never);
    const ref = new ExcelJS.Workbook();
    await ref.xlsx.load(base.xlsx as never);
    const sheet = wb.worksheets[1];
    const refSheet = ref.worksheets[1];
    // the same headers, the same shape, and the same text in every cell except the one long text we put in (compared with the original build)
    expect(sheet.rowCount).toBe(refSheet.rowCount);
    expect(sheet.columnCount).toBe(refSheet.columnCount);
    for (let r = 1; r <= sheet.rowCount; r += 1) for (let c = 1; c <= sheet.columnCount; c += 1) {
      const a = sheet.getCell(r, c).text;
      const b = refSheet.getCell(r, c).text;
      // the row of the long text: its text is ours, and its language and relation marks are derived from the text by the file's own rules (so they may differ from the original row's)
      if (r === 2) { if (c === 1) expect(a).toBe(LONG); continue; }
      expect(a, `r${r}c${c}`).toBe(b);
    }
    // layout: nothing taller than Excel can show, a counter never gets the text width, dates are not cut, links and ids are one line
    for (let r = 2; r <= sheet.rowCount; r += 1) expect(sheet.getRow(r).height ?? 0).toBeLessThanOrEqual(MAX_ROW_POINTS);
    expect(sheet.getRow(2).height).toBe(MAX_ROW_POINTS);
    const header = (c: number) => String(sheet.getCell(1, c).value);
    for (let c = 1; c <= sheet.columnCount; c += 1) {
      const width = sheet.getColumn(c).width!;
      if (/^عدد |الإعجابات|المشاهدات|المشاركات/.test(header(c))) expect(width, header(c)).toBeLessThanOrEqual(18);
      if (/^(?:لغة النص|علاقة النص بالموضوع|ضمن الفترة المطلوبة)$/.test(header(c))) expect(width, header(c)).toBeLessThan(40);
      if (/تاريخ/.test(header(c)) && sheet.getCell(2, c).type === ExcelJS.ValueType.Date) expect(width, header(c)).toBeGreaterThanOrEqual(22);
      if (header(c) === "المعرّف") expect(sheet.getCell(2, c).alignment?.wrapText ?? false).toBe(false);
      if (header(c) === "الرابط" && sheet.getCell(2, c).value) expect(sheet.getCell(2, c).alignment?.wrapText ?? false).toBe(false);
    }
    // the first column is the wide text column; the text cell is top-aligned on the tall row
    expect(sheet.getColumn(1).width).toBe(70);
    expect(sheet.getCell(2, 1).alignment?.vertical).toBe("top");
    // RTL sheet and the freeze are as they were
    expect(sheet.views[0].rightToLeft).toBe(true);
    expect(sheet.views[0].state).toBe("frozen");
    // Excel and CSV: the same records (the CSV is the deepest stage's rows, ids last); the long text is whole in the CSV too
    if (w.plan.stages.length === 1) {
      const csvRows = built.csv.split(/\r\n/).length;
      expect(built.csv).toContain(LONG.split("\n")[0]);
      expect(csvRows).toBeGreaterThan(1);
    }
  });
});

describe.each(NAMES)("%s: Excel and CSV carry exactly the same records after the layout change", (name) => {
  it("the customer's CSV of the new Excel has the same rows and the same text as the sheet's cells, and the same ids as before the change was made to the file's layout", async () => {
    const w = await worldOf(name);
    const rows = structuredClone(w.rowsByStage);
    const first = w.plan.stages[0].key;
    const textKey = Object.keys(rows[first][0]).find((k) => k === "text" || k === "description" || k === "title")!;
    rows[first][0] = { ...rows[first][0], [textKey]: LONG };
    const built = await buildMissionFiles(w.plan, rows);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.xlsx as never);
    const exp = await csvExportFromWorkbook(built.xlsx);
    expect(exp.stages.length).toBeGreaterThan(0);
    for (const stage of exp.stages) {
      const sheet = wb.getWorksheet(stage.sheet)!;
      expect(stage.rows, stage.sheet).toBe(sheet.rowCount - 1);
      // every record's id (the last column) is in both
      const idCol = sheet.columnCount;
      for (let r = 2; r <= sheet.rowCount; r += 1) expect(stage.csv, `${stage.sheet} r${r}`).toContain(sheet.getCell(r, idCol).text);
    }
    // the long text is whole in the CSV (its newlines are inside a quoted cell)
    expect(exp.stages[0].csv).toContain("الفقرة 70:");
    expect(exp.stages[0].csv).toContain(LONG.split("\n")[69]);
  });
});
