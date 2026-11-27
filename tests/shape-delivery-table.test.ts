import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DELIVERED_SHAPE_MAX_ROWS,
  deliveredColumnsOf,
  deliveredShapedCsv,
  deliveredShapedXlsx,
  readDeliveredTable,
} from "@/lib/agentMission/deliveredTable";
import { worldOf, type World } from "./helpers/round32Worlds";
import { parseCsv } from "@/lib/server/excelFromCsv";

describe("deliveredTable (P3 / T3)", () => {
  let xWorld: World;
  let ytWorld: World;

  beforeAll(async () => {
    xWorld = await worldOf("x");
    ytWorld = await worldOf("youtube");
  }, 120_000);

  it("reads real 1-stage world: columns = sheet-2 header, rowCount = sheet.rowCount-1 (M3)", async () => {
    const res = await readDeliveredTable(xWorld.xlsx);
    expect("error" in res).toBe(false);
    if ("error" in res) return;

    expect(res.sheetCount).toBe(1);
    expect(res.sheetName).toBe("التغريدات");
    // X world has 20 delivered rows
    expect(res.rows.length).toBe(20);
    expect(res.columns.length).toBeGreaterThan(0);
    expect(res.columns[0].key).toBe("col_1");
  });

  it("P3 does not dedupe rows: fixture with two identical rows preserves both rows (Gate 1 item 6)", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Summary");
    const ws = wb.addWorksheet("Data");
    ws.addRow(["الاسم", "المدينة"]);
    ws.addRow(["أحمد", "القاهرة"]);
    ws.addRow(["أحمد", "القاهرة"]); // Identical duplicate row

    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await readDeliveredTable(buf);
    expect("error" in res).toBe(false);
    if ("error" in res) return;

    expect(res.rows.length).toBe(2);
    expect(res.rows[0].col_1).toBe("أحمد");
    expect(res.rows[1].col_1).toBe("أحمد");

    // Shaped CSV and XLSX also preserve both rows
    const csvBuf = await deliveredShapedCsv(res, { columns: ["col_1", "col_2"] });
    const parsed = parseCsv(csvBuf.toString("utf8"));
    expect(parsed.length).toBe(3); // 1 header + 2 data rows
  });

  it("sorting, filtering, column picking, and splitting across sheets", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Summary");
    const ws = wb.addWorksheet("Data");
    ws.addRow(["الاسم", "العمر", "المدينة"]);
    ws.addRow(["سارة", 25, "الجيزة"]);
    ws.addRow(["محمد", 30, "القاهرة"]);
    ws.addRow(["علي", 20, "القاهرة"]);
    ws.addRow(["خالد", 35, "الإسكندرية"]);

    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await readDeliveredTable(buf);
    if ("error" in res) throw new Error("read failed");

    // 1. Pick columns + filter (age >= 25) + sort by age desc
    const spec = {
      columns: ["col_1", "col_2"],
      filters: [{ column: "col_2", op: "gte" as const, value: 25 }],
      sortBy: [{ column: "col_2", direction: "desc" as const }],
    };
    const csvBuf = await deliveredShapedCsv(res, spec);
    const parsedCsv = parseCsv(csvBuf.toString("utf8"));
    // Header + 3 matching records: خالد (35), محمد (30), سارة (25)
    expect(parsedCsv.length).toBe(4);
    expect(parsedCsv[1][0]).toBe("خالد");
    expect(parsedCsv[2][0]).toBe("محمد");
    expect(parsedCsv[3][0]).toBe("سارة");

    // 2. Split (groupBy City col_3)
    const splitSpec = {
      columns: ["col_1", "col_2", "col_3"],
      groupBy: { column: "col_3" },
    };
    const xlsxBuf = await deliveredShapedXlsx(res, splitSpec);
    const splitWb = new ExcelJS.Workbook();
    await splitWb.xlsx.load(xlsxBuf as unknown as ArrayBuffer);
    expect(splitWb.worksheets.length).toBe(3); // الجيزة, القاهرة, الإسكندرية
    const totalRows = splitWb.worksheets.reduce((acc, s) => acc + (s.rowCount - 1), 0);
    expect(totalRows).toBe(4);
  });

  it("CSV round trip with commas, newlines, quotes, and UTF-8 BOM", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Summary");
    const ws = wb.addWorksheet("Data");
    ws.addRow(["الوصف", "الملاحظات"]);
    ws.addRow(['نص به "علامات تنصيص"', "سطر أول\nسطر ثان, مع فاصلة"]);

    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await readDeliveredTable(buf);
    if ("error" in res) throw new Error("read failed");

    const csvBuf = await deliveredShapedCsv(res, { columns: ["col_1", "col_2"] });
    const str = csvBuf.toString("utf8");
    expect(str.startsWith("\uFEFF")).toBe(true);

    const parsed = parseCsv(str);
    expect(parsed.length).toBe(2);
    expect(parsed[1][0]).toBe('نص به "علامات تنصيص"');
    expect(parsed[1][1]).toBe("سطر أول\nسطر ثان, مع فاصلة");
  });

  it("text cell starting with «=» is formula-escaped and hyperlink is written as link", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Summary");
    const ws = wb.addWorksheet("Data");
    ws.addRow(["صيغة", "رابط"]);
    ws.addRow(["=SUM(A1:A10)", "https://diger.tech"]);

    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await readDeliveredTable(buf);
    if ("error" in res) throw new Error("read failed");

    const xlsxBuf = await deliveredShapedXlsx(res, { columns: ["col_1", "col_2"] });
    const outWb = new ExcelJS.Workbook();
    await outWb.xlsx.load(xlsxBuf as unknown as ArrayBuffer);
    const outSheet = outWb.worksheets[0];
    const formulaCell = outSheet.getRow(2).getCell(1);
    const linkCell = outSheet.getRow(2).getCell(2);

    expect(formulaCell.value).toBe("'=SUM(A1:A10)");
    expect(linkCell.hyperlink).toBe("https://diger.tech");
  });

  it("2-stage world: sheetCount=2, table = FIRST data sheet, original sha256 unchanged (M4)", async () => {
    const origHash = createHash("sha256").update(ytWorld.xlsx).digest("hex");
    const res = await readDeliveredTable(ytWorld.xlsx);
    expect("error" in res).toBe(false);
    if ("error" in res) return;

    expect(res.sheetCount).toBe(2);
    expect(res.sheetName).toBe("الفيديوهات"); // first stage
    // Original bytes not mutated
    expect(createHash("sha256").update(ytWorld.xlsx).digest("hex")).toBe(origHash);
  });

  it("empty header column is skipped", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Summary");
    const ws = wb.addWorksheet("Data");
    ws.addRow(["الاسم", "", "الهاتف"]);
    ws.addRow(["أحمد", "مهمل", "0100"]);

    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await readDeliveredTable(buf);
    if ("error" in res) throw new Error("read failed");

    expect(res.columns.length).toBe(2);
    expect(res.columns[0].titleAr).toBe("الاسم");
    expect(res.columns[1].titleAr).toBe("الهاتف");
    expect(res.rows[0].col_1).toBe("أحمد");
    expect(res.rows[0].col_2).toBe("0100");
  });

  it("exceeding maxRows returns too_many_rows", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Summary");
    const ws = wb.addWorksheet("Data");
    ws.addRow(["الاسم"]);
    for (let i = 0; i < 15; i++) {
      ws.addRow([`شخص ${i}`]);
    }

    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await readDeliveredTable(buf, { maxRows: 10 });
    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.error).toBe("too_many_rows");
      expect(res.rowCount).toBe(15);
    }
  });

  it("deliveredColumnsOf returns columns up to 60 without loading all rows", async () => {
    const cols = await deliveredColumnsOf(xWorld.xlsx);
    expect(cols.length).toBeGreaterThan(0);
    expect(cols[0].key).toBe("col_1");
  });

  it("20k x 15 generated workbook: read + shape time printed and < 30 s (C6)", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Summary");
    const ws = wb.addWorksheet("BigData");
    const headers = Array.from({ length: 15 }, (_, i) => `عمود ${i + 1}`);
    ws.addRow(headers);
    for (let r = 0; r < 20_000; r++) {
      ws.addRow(Array.from({ length: 15 }, (_, c) => `قيمة ${r}-${c}`));
    }
    const bigBytes = Buffer.from(await wb.xlsx.writeBuffer());

    const t0 = Date.now();
    const table = await readDeliveredTable(bigBytes);
    expect("error" in table).toBe(false);
    if ("error" in table) return;

    expect(table.rows.length).toBe(20_000);
    const shaped = await deliveredShapedCsv(table, { columns: ["col_1", "col_2"] });
    const elapsed = Date.now() - t0;
    console.info(`[shape-delivery-table] 20kx15 read+shape elapsed: ${elapsed}ms`);
    expect(shaped.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(30_000);
  }, 45_000);
});
