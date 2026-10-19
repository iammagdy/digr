import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { generateExcelReport } from "../src/functions/shared/fileGenerators";
import { resolveCompanyLinks } from "../src/lib/companyUrls";
import { normalizeDataset } from "../src/lib/server/normalizationPipeline";

async function companySheet(rows: any[]) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await generateExcelReport({ title: "Company research in Egypt", country: "Egypt", entityType: "companies", rows } as any)) as any);
  const sheet = workbook.getWorksheet("بيانات الشركات")!;
  const headers = sheet.getRow(1).values as string[];
  return { workbook, sheet, col: (name: string) => headers.indexOf(name) };
}

describe("QA Excel fixes", () => {
  it("a social or video page is never the company's website", () => {
    expect(resolveCompanyLinks({ website: "https://www.youtube.com/@acme" }).website).toBe("");
    expect(resolveCompanyLinks({ website: "https://facebook.com/acme", domain: "acme.com" }).website).toBe("https://acme.com");
    expect(resolveCompanyLinks({ website: "https://acme.com" }).website).toBe("https://acme.com");
  });

  it("the record id is a plain number, the city is never the country, the phone stays text", async () => {
    const { sheet, col } = await companySheet([
      { id: "rec_1", company_name: "Delta Power", website: "https://youtube.com/@delta", city: "Egypt", phone: 20123456789 },
      { id: "rec_2", company_name: "Nile Energy", website: "https://nile.example", location: "Cairo, Egypt" },
    ]);
    expect(sheet.getRow(2).getCell(col("معرّف السجل")).value).toBe(1);
    expect(sheet.getRow(3).getCell(col("معرّف السجل")).value).toBe(2);
    expect(sheet.getRow(2).getCell(col("المدينة")).value).toBe("غير متاح");
    expect(sheet.getRow(3).getCell(col("المدينة")).value).toBe("القاهرة");
    expect(sheet.getRow(2).getCell(col("الموقع الإلكتروني")).value).toBe("غير متاح");
    expect(sheet.getRow(2).getCell(col("الهاتف التجاري")).type).toBe(ExcelJS.ValueType.String);
  });

  it("the delivered dataset carries a «المدينة» column so file shaping can split by it", () => {
    const norm = normalizeDataset({ rows: [{ company_name: "Nile Energy", website: "https://nile.example", location: "Cairo, Egypt" }], metadata: { country: "Egypt", entityType: "companies" } }, { title: "شركات" });
    expect(norm.columns).toContain("city");
    expect(norm.codebook.find((c) => c.field === "city")?.titleAr).toBe("المدينة");
    expect(norm.rows[0].city).toBe("القاهرة");
  });
});
