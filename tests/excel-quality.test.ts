import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { generateExcelReport, REVIEW_SHEET_NOTICE_AR } from "../src/functions/shared/fileGenerators";
import { resolveCompanyLinks } from "../src/lib/companyUrls";
import { localizeAddressAr, ADDRESS_NOT_TRANSLATED_AR } from "../src/lib/server/addressParser";
import { industryLabelForCell, INDUSTRY_NOT_TRANSLATED_AR } from "../src/lib/industryLabels";
import { evaluateDeterministicRelevance } from "../src/lib/server/relevanceValidationLayer";
import { detectIndustryFromText } from "../src/lib/planParameters";

async function load(payload: any) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await generateExcelReport(payload)) as any);
  return workbook;
}
const cellText = (value: ExcelJS.CellValue) =>
  value && typeof value === "object" && "text" in (value as any) ? String((value as any).text) : String(value ?? "");
const cellLink = (value: ExcelJS.CellValue) =>
  value && typeof value === "object" && "hyperlink" in (value as any) ? String((value as any).hyperlink) : "";

describe("item 7: company Excel quality", () => {
  it("never puts a LinkedIn URL in the website column; it moves to the LinkedIn column", async () => {
    const workbook = await load({
      title: "Company research", entityType: "companies",
      rows: [
        { id: "a", company_name: "Alpha", website: "https://www.linkedin.com/company/alpha", industry: "Construction" },
        { id: "b", company_name: "Beta", website: "https://beta.example", linkedin_url: "https://www.linkedin.com/company/beta" },
        { id: "c", company_name: "Gamma", domain: "gamma.example" },
      ],
    });
    const sheet = workbook.getWorksheet("بيانات الشركات")!;
    const headers = sheet.getRow(1).values as string[];
    const web = headers.indexOf("الموقع الإلكتروني");
    const li = headers.indexOf("صفحة لينكد إن");
    const row = (n: number) => sheet.getRow(n);
    expect(cellText(row(2).getCell(web).value)).toBe("غير متاح");
    expect(cellLink(row(2).getCell(li).value)).toBe("https://www.linkedin.com/company/alpha");
    expect(cellLink(row(3).getCell(web).value)).toBe("https://beta.example");
    expect(cellLink(row(3).getCell(li).value)).toContain("linkedin.com/company/beta");
    expect(cellLink(row(4).getCell(web).value)).toBe("https://gamma.example");
    for (let n = 2; n <= 4; n += 1) {
      expect(`${cellText(row(n).getCell(web).value)} ${cellLink(row(n).getCell(web).value)}`).not.toMatch(/linkedin/i);
    }
  });

  it("resolveCompanyLinks keeps the two columns apart", () => {
    expect(resolveCompanyLinks({ website: "linkedin.com/company/x" })).toEqual({ website: "", linkedin: "https://linkedin.com/company/x" });
    expect(resolveCompanyLinks({ website: "https://acme.example", linkedin: "https://www.linkedin.com/company/acme" }))
      .toEqual({ website: "https://acme.example", linkedin: "https://www.linkedin.com/company/acme" });
  });

  it("translates addresses with a deterministic map and marks the rest in Arabic", () => {
    expect(localizeAddressAr("Cairo, Egypt")).toBe("القاهرة، مصر");
    expect(localizeAddressAr("12 Road, Dubai, UAE")).toBe("12 طريق، دبي، الإمارات");
    expect(localizeAddressAr("شارع التحرير، القاهرة")).toBe("شارع التحرير، القاهرة");
    const unknown = localizeAddressAr("Tahrir Tower 5, Cairo");
    expect(unknown.startsWith(ADDRESS_NOT_TRANSLATED_AR)).toBe(true);
    expect(unknown).toContain("Tahrir Tower 5, Cairo");
    expect(localizeAddressAr("")).toBe("غير متاح");
  });

  it("translates the category or marks an unknown one in Arabic", () => {
    expect(industryLabelForCell("Construction")).toBe("المقاولات والتشييد");
    // The delivered file never carries the English source label (PHASE 3): an unknown one is a plain Arabic marker.
    expect(industryLabelForCell("Fancy Niche Widgets")).toBe(INDUSTRY_NOT_TRANSLATED_AR);
    expect(industryLabelForCell("Fancy Niche Widgets")).not.toMatch(/[A-Za-z]/);
    expect(industryLabelForCell("")).toBe("غير متاح");
  });

  it("the delivered sheet has Arabic address and category cells", async () => {
    const workbook = await load({
      title: "Company research", entityType: "companies",
      rows: [{ id: "a", company_name: "Alpha", industry: "Construction", address: "Cairo, Egypt" },
             { id: "b", company_name: "Beta", industry: "Odd Trade", address: "1 Foo Lane, Cairo" }],
    });
    const sheet = workbook.getWorksheet("بيانات الشركات")!;
    const headers = sheet.getRow(1).values as string[];
    const ind = headers.indexOf("مجال النشاط");
    const addr = headers.indexOf("العنوان");
    expect(sheet.getRow(2).getCell(ind).value).toBe("المقاولات والتشييد");
    expect(sheet.getRow(2).getCell(addr).value).toBe("القاهرة، مصر");
    expect(String(sheet.getRow(3).getCell(ind).value)).toContain(INDUSTRY_NOT_TRANSLATED_AR);
    expect(String(sheet.getRow(3).getCell(addr).value)).toContain(ADDRESS_NOT_TRANSLATED_AR);
  });

  it("the review sheet header says plainly that those rows were not charged", async () => {
    const workbook = await load({
      title: "Company research", entityType: "companies",
      rows: [{ id: "m", company_name: "Accepted", industry: "Construction" }],
      uncertainRows: [{ id: "u", company_name: "Maybe", industry: "Utilities", location: "Cairo, Egypt", _relevance_reason: "x" }],
    });
    const review = workbook.getWorksheet("سجلات تحتاج مراجعة")!;
    expect(String(review.getRow(1).getCell(1).value)).toBe(REVIEW_SHEET_NOTICE_AR);
    expect(REVIEW_SHEET_NOTICE_AR).toContain("لم تُحتسب عليك");
    expect(REVIEW_SHEET_NOTICE_AR).toContain("لم تُخصم");
    expect(review.getRow(2).getCell(1).value).toBe("معرّف السجل");
    expect(review.getRow(3).getCell(4).value).toBe("القاهرة، مصر");
  });
});

describe("item 7: unrelated industries go to review for an electricity request", () => {
  it("HVAC under an energy or utilities label is reviewed, not delivered", () => {
    for (const industry of ["Utilities", "Oil & Energy", "Mechanical or Industrial Engineering", "Electrical/Electronic Manufacturing"]) {
      const r = evaluateDeterministicRelevance(
        { company_name: "Cool Air Co", industry, description: "HVAC and air conditioning installation", location: "Cairo, Egypt", country: "Egypt" },
        "Egypt", detectIndustryFromText("الكهرباء").arabicLabel,
      );
      expect(r.decision, industry).toBe("uncertain");
    }
  });

  it("a real electrical company is still delivered", () => {
    const r = evaluateDeterministicRelevance(
      { company_name: "Delta Electric", industry: "Utilities", description: "Electrical power distribution and electrical contracting", location: "Cairo, Egypt", country: "Egypt" },
      "Egypt", detectIndustryFromText("الكهرباء").arabicLabel,
    );
    expect(r.decision).toBe("match");
  });
});
