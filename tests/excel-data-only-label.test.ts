import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { generateExcelReport } from "../src/functions/shared/fileGenerators";

async function sheetNames(payload: any): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await generateExcelReport(payload)) as any);
  return workbook.worksheets.map((sheet) => sheet.name);
}

const NOT_DATA = /منهج|دليل|ملخص|تدقيق|ترميز|قاموس|codebook|methodology|summary/i;

describe("A3: the Excel label matches what the workbook really contains", () => {
  it("the label says data only, never data plus methodology, in every place a customer sees it", () => {
    for (const file of [
      "src/app/dashboard/chat/components/RunSections.tsx",
      "src/app/dashboard/chat/components/ResultsCanvas.tsx",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("البيانات + الدليل المنهجي");
      expect(source).not.toContain("جدول البيانات ودليل الحقول");
      expect(source).toContain("جدول البيانات فقط");
    }
  });

  it("a company workbook is one data sheet, plus the review sheet only when rows are uncertain", async () => {
    const rows = [{ company_name: "Northstar", industry: "Solar", city: "Cairo" }];
    expect(await sheetNames({ entityType: "companies", country: "Egypt", rows })).toEqual(["بيانات الشركات"]);
    const withReview = await sheetNames({
      entityType: "companies",
      country: "Egypt",
      rows,
      uncertainRows: [{ id: "r1", company_name: "Unknown", _relevance_reason: "يحتاج مراجعة" }],
    });
    expect(withReview).toEqual(["بيانات الشركات", "نتائج تحتاج مراجعة"]);
  });

  it("a people workbook is one data sheet", async () => {
    const names = await sheetNames({
      entityType: "people",
      rows: [{ full_name: "Sara Ali", job_title: "Director", company_name: "Northstar" }],
    });
    expect(names).toEqual(["بيانات المهنيين"]);
  });

  it("no workbook kind carries a methodology, summary or codebook sheet", async () => {
    const all = [
      ...(await sheetNames({ entityType: "companies", rows: [{ company_name: "A" }], uncertainRows: [{ id: "u" }] })),
      ...(await sheetNames({ entityType: "people", rows: [{ full_name: "B" }] })),
      ...(await sheetNames({ rows: [{ id: "x", title: "t", views: 5 }] })),
    ];
    expect(all.filter((name) => NOT_DATA.test(name))).toEqual([]);
  });

  it("the methodology is its own Arabic PDF, labelled as such", () => {
    const sections = readFileSync("src/app/dashboard/chat/components/RunSections.tsx", "utf8");
    expect(sections).toContain('desc: "الدليل المنهجي"');
    const generators = readFileSync("src/functions/shared/fileGenerators.ts", "utf8");
    expect(generators).toContain("Methodology is delivered separately as PDF");
  });
});
