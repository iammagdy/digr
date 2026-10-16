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
});
