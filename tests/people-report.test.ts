import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { generateExcelReport, generateMethodologyText } from "../src/functions/shared/fileGenerators";
import { normalizeDataset } from "../src/lib/server/normalizationPipeline";

describe("professional people output", () => {
  it("keeps employees as people and includes name, title, work email, and phone in Excel", async () => {
    const payload = {
      metadata: { platform: "people", title: "بيانات صناع القرار والمهنيين", template: "professional-people-search" },
      rows: [{
        contact_name: "Mona Saleh", job_title: "Operations Director", company_name: "Example Ltd",
        work_email: "mona@example.com", phone: "+201000000000", linkedin_url: "https://www.linkedin.com/in/mona-saleh",
      }],
    };
    expect(normalizeDataset(payload).metadata.entityType).toBe("people");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generateExcelReport(payload) as any);
    const sheet = workbook.getWorksheet("بيانات المهنيين")!;
    const headers = sheet.getRow(4).values as string[];
    expect(headers).toContain("اسم جهة الاتصال");
    expect(headers).toContain("المسمى الوظيفي");
    expect(headers).toContain("البريد المهني");
    expect(headers).toContain("رقم الهاتف");
    expect(sheet.getRow(5).values).toContain("mona@example.com");
    expect(sheet.getRow(5).values).toContain("+201000000000");
  });

  it("reports only measured email and phone verification states in the Arabic methodology", () => {
    const methodology = generateMethodologyText({
      metadata: { platform: "people", title: "صناع القرار", template: "professional-people-search" },
      rows: [
        { contact_name: "A", work_email: "a@example.com", phone: "+491234", work_email_verification_status: "متحقق", phone_verification_status: "لم يتم التحقق" },
        { contact_name: "B", work_email: "b@example.com", phone: "+499876", work_email_verification_status: "غير صالح", phone_verification_status: "متحقق" },
      ],
    });
    expect(methodology).toContain("البريد المهني: ١ من ٢ حالة تحقق مسجلة (٥٠٪)");
    expect(methodology).toContain("الهاتف المهني: ١ من ٢ حالة تحقق مسجلة (٥٠٪)");
    expect(methodology).not.toContain("لم يُجرَ تحقق مستقل من بيانات الاتصال");
  });
});
