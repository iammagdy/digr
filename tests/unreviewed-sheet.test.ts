import { afterEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { generateExcelReport, UNREVIEWED_SHEET_NAME_AR, UNREVIEWED_SHEET_NOTICE_AR } from "../src/functions/shared/fileGenerators";
import { setScaleOverridesForTesting } from "../src/lib/scaleConfig";
import { UNREVIEWED_BY_BUDGET_REASON_AR } from "../src/lib/server/rowReviewAdvisor";

/** The rows the review budget did not reach are listed in their own sheet, «غير مراجَع»: never in the delivered data, never charged. */
const post = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, tweet_id: id, text, author: "حساب", ...extra });
const payload = (rows: any[], uncertainRows: any[], unreviewedRows: any[]) => ({
  metadata: {
    platform: "x", socialKind: "posts", title: "منشورات إكس", jobId: "job_x", collectedAt: "2026-10-21T10:00:00.000Z", rowsCount: rows.length, targetRequested: 50,
    reportContext: { scope: {}, collection: { methodLabel: "x", pagesFetched: 2, paginationStrategy: "cursor", stopReason: "call_cap" }, counts: { rawRows: 40, acceptedRows: rows.length, baselineExclusions: 0, relevanceExclusions: 0, uncertainRows: uncertainRows.length, unreviewedRows: unreviewedRows.length } },
  },
  rows,
  uncertainRows,
  unreviewedRows,
  profile: null,
});
const load = async (buffer: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as any); return wb; };

afterEach(() => setScaleOverridesForTesting(null as any));

describe.each([["in memory", 1_000_000], ["streamed", 0]])("the «غير مراجَع» sheet (%s)", (_label, streamAbove) => {
  const rows = [post("a1", "منشور مسلَّم ١"), post("a2", "منشور مسلَّم ٢")];
  const review = [post("r1", "منشور قيد المراجعة")];
  const unreviewed = [post("u1", "منشور لم يُراجَع ١", { _relevance_reason: UNREVIEWED_BY_BUDGET_REASON_AR }), post("u2", "منشور لم يُراجَع ٢", { _relevance_reason: UNREVIEWED_BY_BUDGET_REASON_AR })];

  it("is a sheet of its own after the review sheet, with the plain Arabic notice first, and the delivered data does not contain its rows", async () => {
    setScaleOverridesForTesting({ streamXlsxAboveRows: streamAbove });
    const wb = await load(await generateExcelReport(payload(rows, review, unreviewed)));
    expect(wb.worksheets.map((sheet) => sheet.name)).toEqual(["المنشورات", "نتائج تحتاج مراجعة", UNREVIEWED_SHEET_NAME_AR]);
    expect(UNREVIEWED_SHEET_NAME_AR).toBe("غير مراجَع");
    const apart = wb.getWorksheet(UNREVIEWED_SHEET_NAME_AR)!;
    expect(String(apart.getCell(1, 1).value)).toBe(UNREVIEWED_SHEET_NOTICE_AR);
    expect(UNREVIEWED_SHEET_NOTICE_AR).toContain("لم تُراجَع آلياً");
    expect(UNREVIEWED_SHEET_NOTICE_AR).toContain("لم تُحتسب عليك");
    expect(UNREVIEWED_SHEET_NOTICE_AR).toContain("لم تدخل ضمن الملف المُسلَّم");
    expect(apart.getRow(2).values).toEqual([undefined, "معرّف النتيجة", "ما ورد في النتيجة", "الرابط", "سبب عدم المراجعة"]);
    expect(apart.rowCount).toBe(2 + 2);
    expect(String(apart.getCell(3, 2).value)).toContain("منشور لم يُراجَع ١");
    expect(String(apart.getCell(3, 4).value)).toBe(UNREVIEWED_BY_BUDGET_REASON_AR);
    const delivered = wb.getWorksheet("المنشورات")!;
    expect(delivered.rowCount).toBe(1 + 2);
    const text = JSON.stringify(delivered.getSheetValues());
    expect(text).not.toContain("لم يُراجَع");
    expect(text).not.toContain("قيد المراجعة");
  });

  it("is absent when no row was left unreviewed, and the review sheet is as before", async () => {
    setScaleOverridesForTesting({ streamXlsxAboveRows: streamAbove });
    const wb = await load(await generateExcelReport(payload(rows, review, [])));
    expect(wb.worksheets.map((sheet) => sheet.name)).toEqual(["المنشورات", "نتائج تحتاج مراجعة"]);
    const none = await load(await generateExcelReport(payload(rows, [], [])));
    expect(none.worksheets.map((sheet) => sheet.name)).toEqual(["المنشورات"]);
  });
});
