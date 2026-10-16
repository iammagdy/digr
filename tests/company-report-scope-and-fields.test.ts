import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { generateCompanyExcelReport } from "../src/functions/shared/fileGenerators";

describe("company workbook scope and field honesty", () => {
  it("does not invent Egypt, a city, or an industry when the source has no value", async () => {
    const buffer = await generateCompanyExcelReport({
      title: "Company research results",
      platform: "companies",
      entityType: "companies",
      rows: [{ company_name: "Northstar" }],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);

    const summary = workbook.getWorksheet("الملخص التنفيذي ومؤشرات السوق")!;
    expect(summary.getCell("G5").value).toBe("غير محدد");
    expect(String(summary.getCell("A3").value)).toContain("النطاق: غير محدد");

    const directory = workbook.getWorksheet("دليل الشركات المعتمد")!;
    expect(directory.getRow(2).getCell(3).value).toBe("غير متاح");
    expect(directory.getRow(2).getCell(6).value).toBe("غير متاح");
    const flat = workbook.getWorksheet("بيانات الشركات للتصفية")!;
    expect(flat.getRow(2).getCell(10).value).toBe("لم تُراجع الملاءمة");
  });

  it("keeps numeric phone values as text in the flat data sheet", async () => {
    const buffer = await generateCompanyExcelReport({
      title: "Company research in Germany",
      country: "Germany",
      entityType: "companies",
      rows: [{ company_name: "Northstar", phone: 491234567890 }],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const flat = workbook.getWorksheet("بيانات الشركات للتصفية")!;

    expect(flat.getRow(2).getCell(7).value).toBe("491234567890");
    expect(flat.getRow(2).getCell(7).type).toBe(ExcelJS.ValueType.String);
  });

  it("links source-provided branches to company IDs and adds data-only analysis counters", async () => {
    const buffer = await generateCompanyExcelReport({
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
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);

    const branches = workbook.getWorksheet("فروع الشركات")!;
    expect(branches.getRow(2).getCell(1).value).toBe("branch-1");
    expect(branches.getRow(2).getCell(2).value).toBe("company-1");
    expect(branches.getRow(2).getCell(3).value).toBe("Northstar");
    expect(workbook.getWorksheet("دليل الشركات المعتمد")!.getRow(2).getCell(11).value).toBe("company-1");

    const analysis = workbook.getWorksheet("تحليل وتوزيع الشركات")!;
    expect(analysis.getCell("B2").value).toBe(2);
    expect(analysis.getCell("B3").value).toBe(1);
    expect(analysis.getCell("B4").value).toBe(1);
    expect(analysis.getCell("B5").value).toBe(1);
  });

  it("keeps doubtful rows in a separate review sheet", async () => {
    const buffer = await generateCompanyExcelReport(
      { title: "Company research", entityType: "companies", rows: [{ id: "match-1", company_name: "Accepted Co", industry: "Solar", _relevance_status: "مطابق" }] },
      [],
      [{ id: "uncertain-1", company_name: "Maybe Co", industry: "Energy", _relevance_reason: "النشاط غير واضح" }],
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);

    const main = workbook.getWorksheet("دليل الشركات المعتمد")!;
    expect(main.rowCount).toBe(2);
    expect(main.getRow(2).getCell(2).value).toBe("Accepted Co");
    const review = workbook.getWorksheet("سجلات تحتاج مراجعة")!;
    expect(review.getRow(2).getCell(2).value).toBe("Maybe Co");
    expect(review.getRow(2).getCell(6).value).toBe("النشاط غير واضح");
  });
});
