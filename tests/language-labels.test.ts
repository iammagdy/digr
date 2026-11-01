import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import { MARKS_KEY, type RowMarks } from "../src/lib/agentMission/rawMarks";
import { isLanguageColumn, languageLabelAr } from "../src/lib/agentMission/languageLabel";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * S1 LIVE FINDINGS fix 4 (docs/S1-LIVE-FINDINGS.md section 6, item 7): the comments sheet of R3 showed `un`, `ar`, `fa` in «لغة التعليق». In a customer file every value is Arabic: a language code is mapped to an Arabic label: العربية, غير محددة, لغة أخرى.
 * Only a mission that ran the new pipeline is mapped (a file of the old pipeline stays byte for byte).
 */
describe("the language label", () => {
  it("Arabic codes and names are «العربية»", () => {
    for (const v of ["ar", "AR", "ara", "arb", "ar-EG", "ar_SA", "Arabic", "arabic", "عربي", "العربية"]) expect(languageLabelAr(v), v).toBe("العربية");
  });
  it("undetermined codes are «غير محددة»", () => {
    for (const v of ["un", "und", "UND", "unknown", "xx", "zxx", "mul", "mis", "-", "غير معروف"]) expect(languageLabelAr(v), v).toBe("غير محددة");
  });
  it("every other language, by code or by Latin name, is «لغة أخرى»", () => {
    for (const v of ["fa", "en", "en-US", "fr", "tr", "ur", "English", "Persian", "deu"]) expect(languageLabelAr(v), v).toBe("لغة أخرى");
  });
  it("an empty value stays empty (a missing value is an empty cell, never a word)", () => {
    expect(languageLabelAr(null)).toBeNull();
    expect(languageLabelAr("")).toBe("");
    expect(languageLabelAr(undefined)).toBeUndefined();
  });
  it("an Arabic word already there is kept; every label passes the customer-text guard", () => {
    expect(languageLabelAr("إنجليزي")).toBe("إنجليزي");
    for (const l of ["العربية", "غير محددة", "لغة أخرى"]) expect(checkCustomerText(l).issues).toEqual([]);
  });
  it("a language column is found by its Arabic title or its key", () => {
    expect(isLanguageColumn("لغة التعليق", "x")).toBe(true);
    expect(isLanguageColumn("اللغة", "x")).toBe(true);
    expect(isLanguageColumn("x", "comment_language")).toBe(true);
    expect(isLanguageColumn("x", "lang")).toBe(true);
    expect(isLanguageColumn("نص التعليق", "text")).toBe(false);
    expect(isLanguageColumn("لغة النص", "__mark_lang")).toBe(false);
  });
});

const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 3, planned_rows: 3, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001, ...over }) as never;
const plan = (stages: unknown[]): PricedPlan => ({ summary_ar: "ستحصل على فيديوهات وتعليقاتها. وتفاصيل أخرى.", stages: stages as never, price: { totalCostUsd: 0, deliveredRows: 3, costPerFinalRowUsd: 0.0001 } } as unknown as PricedPlan);
const VIDEOS = stage({ key: "videos", title_ar: "الفيديوهات", columns: [{ key: "caption", title_ar: "الوصف" }] });
const COMMENTS = stage({ key: "comments", title_ar: "التعليقات", parent_key: "videos", columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "lang", title_ar: "لغة التعليق" }] });
const marks: RowMarks = { reply: false, repost: false, lang: "ar", inPeriod: true, named: null };
const commentRows = [{ id: "c1", parent_id: "v1", text: "تعليق", lang: "un" }, { id: "c2", parent_id: "v1", text: "تعليق ثان", lang: "ar" }, { id: "c3", parent_id: "v1", text: "تعليق ثالث", lang: "fa" }];
const load = async (xlsx: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as unknown as ArrayBuffer); return wb; };
const langCells = (sheet: ExcelJS.Worksheet) => {
  const col = (sheet.getRow(1).values as unknown[]).findIndex((h) => h === "لغة التعليق");
  expect(col).toBeGreaterThan(0);
  return [2, 3, 4].map((r) => String(sheet.getRow(r).getCell(col).value));
};

describe("the comments sheet of a customer file", () => {
  it("a mission of the new pipeline: the language cells are Arabic words, never a code", async () => {
    const wb = await load((await buildMissionFiles(plan([VIDEOS, COMMENTS]), { videos: [{ id: "v1", caption: "فيديو", [MARKS_KEY]: marks }], comments: commentRows })).xlsx);
    expect(langCells(wb.getWorksheet("التعليقات")!)).toEqual(["غير محددة", "العربية", "لغة أخرى"]);
  });
  it("a mission of the old pipeline: the cells are exactly what the source gave (the old output does not change)", async () => {
    const wb = await load((await buildMissionFiles(plan([VIDEOS, COMMENTS]), { videos: [{ id: "v1", caption: "فيديو" }], comments: commentRows })).xlsx);
    expect(langCells(wb.getWorksheet("التعليقات")!)).toEqual(["un", "ar", "fa"]);
  });
});
