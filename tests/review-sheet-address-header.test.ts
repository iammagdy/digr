import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { generateExcelReport } from "../src/functions/shared/fileGenerators";

/**
 * The review sheet's column that holds the ADDRESS as the source gave it is titled «العنوان كما ورد» (it was «الموقع كما ورد», which reads as a website).
 * The delivered company sheet keeps «الموقع الإلكتروني» for websites and «العنوان» for addresses; the people sheet's «الدولة / الموقع» holds a city or a country.
 */
describe("the review sheet names its address column by what is in it", () => {
  it("the header reads «العنوان كما ورد» and the column carries the address text", async () => {
    const buffer = await generateExcelReport({
      title: "Company research", entityType: "companies",
      rows: [{ id: "m", company_name: "Accepted", industry: "Construction" }],
      uncertainRows: [{ id: "u", company_name: "Maybe", industry: "Utilities", location: "Cairo, Egypt", _relevance_reason: "x" }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const review = wb.getWorksheet("سجلات تحتاج مراجعة")!;
    const headers = (review.getRow(2).values as any[]).slice(1).map(String);
    expect(headers).toEqual(["معرّف السجل", "اسم الشركة", "مجال النشاط كما ورد", "العنوان كما ورد", "سبب المراجعة"]);
    expect(headers).not.toContain("الموقع كما ورد");
    expect(String(review.getRow(3).getCell(4).value)).toBe("القاهرة، مصر");
  });
});
