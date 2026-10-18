import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { generateExcelReport } from "../src/functions/shared/fileGenerators";

async function load(payload: any, ...extra: any[]) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await generateExcelReport(payload, ...(extra as []))) as any);
  return workbook;
}

describe("company workbook scope and field honesty", () => {
  it("does not invent Egypt, a city, or an industry when the source has no value", async () => {
    const workbook = await load({
      title: "Company research results",
      platform: "companies",
      entityType: "companies",
      rows: [{ company_name: "Northstar" }],
    });

    // Owner decision D4: the workbook is data only, with no executive-summary sheet.
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["بيانات الشركات"]);
    const sheet = workbook.getWorksheet("بيانات الشركات")!;
    const headers = sheet.getRow(1).values as string[];
    expect(sheet.getRow(2).getCell(headers.indexOf("مجال النشاط")).value).toBe("غير متاح");
    expect(sheet.getRow(2).getCell(headers.indexOf("المدينة")).value).toBe("غير متاح");
    let text = "";
    sheet.eachRow((row) => row.eachCell((cell) => { text += ` ${String(cell.value)}`; }));
    expect(text).not.toContain("مصر");
  });

  it("keeps numeric phone values as text without a leading apostrophe", async () => {
    const workbook = await load({
      title: "Company research in Germany",
      country: "Germany",
      entityType: "companies",
      rows: [{ company_name: "Northstar", phone: 491234567890 }],
    });
    const sheet = workbook.getWorksheet("بيانات الشركات")!;
    const phoneColumn = (sheet.getRow(1).values as string[]).indexOf("الهاتف التجاري");

    expect(sheet.getRow(2).getCell(phoneColumn).value).toBe("491234567890");
    expect(sheet.getRow(2).getCell(phoneColumn).type).toBe(ExcelJS.ValueType.String);
  });

  it("links source-provided branches to company IDs and keeps analysis out of the Excel file", async () => {
    const workbook = await load({
      title: "Company research in Germany",
      country: "Germany",
      entityType: "companies",
      rows: [
        {
          id: "company-1",
          company_name: "Northstar",
          industry: "Solar",
          city: "Berlin",
          email: "info@northstar.example",
          branches: [{ id: "branch-1", name: "Berlin Office", city: "Berlin", address: "Musterstrasse 1" }],
        },
        { id: "company-2", company_name: "Southstar", industry: "Solar", city: "Munich" },
      ],
    });

    const branches = workbook.getWorksheet("فروع الشركات")!;
    expect(branches.getRow(2).getCell(1).value).toBe("branch-1");
    expect(branches.getRow(2).getCell(2).value).toBe("company-1");
    expect(branches.getRow(2).getCell(3).value).toBe("Northstar");
    expect(branches.getRow(2).getCell(5).value).toBe("برلين");
    expect(workbook.getWorksheet("بيانات الشركات")!.getRow(2).getCell(1).value).toBe("company-1");

    // Counters and distributions belong to the methodology PDF, not the data workbook (D4).
    const names = workbook.worksheets.map((sheet) => sheet.name);
    expect(names).not.toContain("تحليل وتوزيع الشركات");
    expect(names).not.toContain("الملخص التنفيذي ومؤشرات السوق");
  });

  it("keeps doubtful rows in a separate review sheet", async () => {
    const workbook = await load({
      title: "Company research",
      entityType: "companies",
      rows: [{ id: "match-1", company_name: "Accepted Co", industry: "Solar", _relevance_status: "مطابق" }],
      uncertainRows: [{ id: "uncertain-1", company_name: "Maybe Co", industry: "Energy", _relevance_reason: "النشاط غير واضح" }],
    });

    const main = workbook.getWorksheet("بيانات الشركات")!;
    expect(main.rowCount).toBe(2);
    expect(main.getRow(2).getCell(2).value).toBe("Accepted Co");
    const review = workbook.getWorksheet("سجلات تحتاج مراجعة")!;
    // Row 1 is the plain «not charged» notice, row 2 the headers, rows from 3 the records.
    expect(review.getRow(3).getCell(2).value).toBe("Maybe Co");
    expect(review.getRow(3).getCell(5).value).toBe("النشاط غير واضح");
  });
});
