import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { generateCompanyExcelReport } from "../src/functions/shared/fileGenerators";

describe("company report email columns", () => {
  it("includes source work emails and a presence-only status in both customer data sheets", async () => {
    const buffer = await generateCompanyExcelReport({
      title: "شركات تقنية المعلومات في السعودية",
      country: "المملكة العربية السعودية",
      entityType: "companies",
      rows: [
        { company_name: "شركة البريد المتاح", work_email: "info@example.sa" },
        { company_name: "شركة بلا بريد", work_email: "", work_email_presence_status: "موجود" },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);

    for (const sheetName of ["دليل الشركات المعتمد", "بيانات الشركات للتصفية"]) {
      const sheet = workbook.getWorksheet(sheetName)!;
      const headers = sheet.getRow(1).values as string[];
      const emailColumn = headers.indexOf("بريد العمل (كما ورد من المصدر)");
      const presenceColumn = headers.indexOf("توفر البريد المهني");

      expect(emailColumn).toBeGreaterThan(0);
      expect(presenceColumn).toBeGreaterThan(0);
      expect(sheet.getRow(2).getCell(emailColumn).value).toBe("info@example.sa");
      expect(sheet.getRow(2).getCell(presenceColumn).value).toBe("موجود");
      expect(sheet.getRow(3).getCell(emailColumn).value).toBe("غير متاح");
      expect(sheet.getRow(3).getCell(presenceColumn).value).toBe("غير موجود");
    }
  });
});
