import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { generateExcelReport } from "../src/functions/shared/fileGenerators";

describe("company report email columns", () => {
  it("includes the source work email; the verification-status columns are NOT in the company workbook (owner decision: the Excel follows the screen)", async () => {
    const buffer = await generateExcelReport({
      title: "شركات تقنية المعلومات في السعودية",
      country: "المملكة العربية السعودية",
      entityType: "companies",
      rows: [
        { company_name: "شركة البريد المتاح", work_email: "info@example.sa" },
        { company_name: "شركة بلا بريد", work_email: "" },
        { company_name: "شركة بريد متحقق", work_email: "sales@verified.sa", work_email_verification_status: "valid" },
        { company_name: "شركة بريد مرفوض", work_email: "x@bad.sa", work_email_verification_status: "invalid" },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);

    const sheet = workbook.getWorksheet("بيانات الشركات")!;
    const headers = sheet.getRow(1).values as string[];
    const emailColumn = headers.indexOf("البريد المهني");
    const statusColumn = headers.indexOf("حالة تحقق البريد المهني");

    expect(emailColumn).toBeGreaterThan(0);
    expect(statusColumn).toBe(-1);
    expect(headers.some((header) => /^حالة تحقق/.test(String(header ?? "")))).toBe(false);
    expect(sheet.getRow(2).getCell(emailColumn).value).toBe("info@example.sa");
    expect(sheet.getRow(3).getCell(emailColumn).value).toBe("غير متاح");
    expect(sheet.getRow(4).getCell(emailColumn).value).toBe("sales@verified.sa");
    // With no status column the sheet never claims a field was verified.
    sheet.eachRow((row) => row.eachCell((cell) => expect(String(cell.value)).not.toBe("متحقق")));
  });
});
