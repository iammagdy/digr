import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseExclusionFile } from "../src/lib/server/exclusionFileParser";

describe("Exclusion File Parser", () => {
  it("parses CSV exclusion file with Arabic headers and scrubs personal data", async () => {
    // CSV containing company name, corporate domain, CR, but also personal contact info that MUST be ignored
    const csvContent = `اسم الشركة,الموقع الإلكتروني,السجل التجاري,البريد الشخصي للمدير,رقم هاتف مسؤول المشتريات
شركة المقاولون العرب,https://www.arabcont.com,101010,ceo@gmail.com,01012345678
شركة حسن علام للمقاولات,hassanallam.com,202020,eng.hassan@yahoo.com,01198765432
بتروجت للمشروعات البترولية,http://petrojet.com.eg,303030,contact@petrojet.com,01234567890`;

    const buffer = Buffer.from(csvContent, "utf-8");
    const spec = await parseExclusionFile(buffer, "csv");

    expect(spec.baselineRowCount).toBe(3);
    expect(spec.companyNames).toContain("شركة المقاولون العرب");
    expect(spec.companyNames).toContain("شركة حسن علام للمقاولات");
    expect(spec.companyNames).toContain("بتروجت للمشروعات البترولية");

    // Domains normalized cleanly
    expect(spec.corporateDomains).toContain("arabcont.com");
    expect(spec.corporateDomains).toContain("hassanallam.com");
    expect(spec.corporateDomains).toContain("petrojet.com.eg");

    // Strict privacy boundary: verify personal contact information was NEVER harvested or indexed in records
    for (const record of spec.normalizedEntities) {
      expect((record as any).personalEmail).toBeUndefined();
      expect((record as any).personalPhone).toBeUndefined();
      expect(JSON.stringify(record)).not.toContain("ceo@gmail.com");
      expect(JSON.stringify(record)).not.toContain("01012345678");
      expect(JSON.stringify(record)).not.toContain("eng.hassan@yahoo.com");
    }
  });

  it("parses XLSX exclusion spreadsheet with auto-detected columns", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("قائمة الشركات المستبعدة");

    ws.addRow(["م", "Company Name", "Website", "CR Number", "Contact Person"]);
    ws.addRow([1, "Orascom Construction", "https://orascom.com", "998877", "Eng. Nassef"]);
    ws.addRow([2, "Elsewedy Electric", "www.elsewedy.com", "887766", "Eng. Ahmed"]);

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const spec = await parseExclusionFile(buffer, "xlsx");

    expect(spec.baselineRowCount).toBe(2);
    expect(spec.companyNames).toContain("Orascom Construction");
    expect(spec.companyNames).toContain("Elsewedy Electric");

    expect(spec.corporateDomains).toContain("orascom.com");
    expect(spec.corporateDomains).toContain("elsewedy.com");

    expect(spec.normalizedEntities[0].crNumber).toBe("998877");
    expect(spec.normalizedEntities[1].crNumber).toBe("887766");

    // Verify personal name column was not included in entity records
    expect(JSON.stringify(spec.normalizedEntities)).not.toContain("Eng. Nassef");
  });
});
