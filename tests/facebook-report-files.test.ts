import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { generateFacebookReportExcel, SUMMARY_SHEET_AR, POSTS_SHEET_AR, COMMENTS_SHEET_AR, POSTS_HEADERS_AR, COMMENTS_HEADERS_AR_BASE } from "../src/functions/shared/facebookReportExcel";
import { generateFacebookReportPdf } from "../src/functions/shared/facebookReportPdf";
import { buildFacebookReportExcelFrom, buildFacebookReportPdfFrom, facebookReportOf } from "../src/functions/shared/facebookReportFiles";
import { sheetNameFor, type ReportPayload } from "../src/lib/facebookReport/aggregate";
import { HEALTH_AXES } from "../src/lib/facebookReport/axes";
import { conclusionsAr, limitsAr, scopeLinesAr } from "../src/lib/facebookReport/conclusions";
import { buildReportModel } from "../src/lib/facebookReport/aggregate";

const pubs = ["الكونسلتو الطبي", "هيئة الدواء المصرية", "النقابة العامة لأطباء مصر", "القاهرة ٢٤", "مصراوي"];
const posts = Array.from({ length: 40 }, (_, i) => ({
  key: `https://www.facebook.com/p/${i}`, url: `https://www.facebook.com/p/${i}`, text: `منشور رقم ${i} عن ${HEALTH_AXES[i % HEALTH_AXES.length].nameAr}`, publisher: pubs[i % 5], publisherKey: `page:${i % 5}`,
  source: "page" as const, pageId: `eg_health_x${i % 5}`, publishedAtMs: Date.parse("2026-10-20T08:00:00Z") - i * 86_400_000, reactions: (i * 37) % 500, comments: (i * 11) % 60, shares: (i * 7) % 40,
  contentType: i % 9 === 0 ? ("video" as const) : ("text" as const), axis: i % 12 === 11 ? "general" : HEALTH_AXES[i % HEALTH_AXES.length].id, commentsDelivered: 2,
}));
const payload: ReportPayload = {
  v: 1, request: { topic: "الترندات الصحية", region: "EG", from: "2026-07-24", to: "2026-10-24", postsTarget: 40, perPost: 2, commentsTarget: 80 },
  collection: { pagesMatching: 6, pagesUsable: 5, pagesBrowsed: 5, pagesSkipped: 1, postsFound: 90, postsOutsideWindow: 12, postsUndated: 1, duplicates: 2, searchCalls: 0, searchPosts: 0, searchRejectedCountry: 0, selectionDropped: 35, shareConfigured: 0.2, shareEffective: 0.2, modelCalls: 1, modelBudgetStopped: 0, modelFailed: 0, commentsEmpty: 1, commentsDuplicates: 2, commentsLinkOnly: 1, commentsNotReturned: 3, stopped: "done" },
  posts, pages: [],
} as any;
const rows = posts.flatMap((p, i) => [0, 1].map((k) => ({
  comment_id: `c${i}_${k}`, text: k === 0 ? "=SUM(1,2) تعليق خطير" : `تعليق ${k} على ${i}`, author: `مستخدم ${k}`, published_at: new Date(p.publishedAtMs + 3_600_000).toISOString(),
  reactions: k, replies: k, video_url: p.url, post_key: p.key,
})));

const loadWorkbook = async (): Promise<ExcelJS.Workbook> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await generateFacebookReportExcel(payload, rows)) as any);
  return workbook;
};

describe("the report workbook, read back from the real file", () => {
  it("has the summary, the posts and the comments sheets (and one per axis only when asked), Arabic names within Excel's 31 characters, right-to-left", async () => {
    const workbook = await loadWorkbook();
    const names = workbook.worksheets.map((sheet) => sheet.name);
    expect(names.slice(0, 3)).toEqual([SUMMARY_SHEET_AR, POSTS_SHEET_AR, COMMENTS_SHEET_AR]);
    for (const name of names) { expect(name.length).toBeLessThanOrEqual(31); expect(name).toMatch(/[؀-ۿ]/); expect(name).not.toMatch(/[\\/?*[\]:]/); }
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    for (const sheet of workbook.worksheets) expect(sheet.views[0]?.rightToLeft).toBe(true);
    // a long axis name is cut to a legal, unique sheet name
    expect(sheetNameFor("أدوية وحقن التخسيس وبدائل التكميم والمراكز الطبية الكبيرة", new Set()).length).toBeLessThanOrEqual(31);
  });
  it("the posts sheet: the specified Arabic headers, a frozen header row, a filter, numbers as numbers, dates as dates, working hyperlinks", async () => {
    const sheet = (await loadWorkbook()).getWorksheet(POSTS_SHEET_AR)!;
    expect((sheet.getRow(1).values as any[]).slice(1)).toEqual(POSTS_HEADERS_AR);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.autoFilter).toBeTruthy();
    expect(sheet.rowCount).toBe(41);
    const first = sheet.getRow(2);
    expect(typeof first.getCell(1).value).toBe("number");
    expect(first.getCell(5).value).toBeInstanceOf(Date);
    const numericColumns = [7, 8, 9];
    for (const col of numericColumns) expect(typeof first.getCell(col).value).toBe("number");
    const linkCells = [...Array(sheet.columnCount)].map((_, i) => first.getCell(i + 1).value).filter((v: any) => v && typeof v === "object" && "hyperlink" in v);
    expect(linkCells).toHaveLength(1);
    expect((linkCells[0] as any).hyperlink).toMatch(/^https:\/\/www\.facebook\.com\//);
  });
  it("the comments sheet: one row per delivered comment, a formula-looking comment is stored as text (never evaluated), Arabic headers", async () => {
    const sheet = (await loadWorkbook()).getWorksheet(COMMENTS_SHEET_AR)!;
    expect((sheet.getRow(1).values as any[]).slice(1, 1 + COMMENTS_HEADERS_AR_BASE.length)).toEqual(COMMENTS_HEADERS_AR_BASE);
    expect(sheet.rowCount).toBe(1 + rows.length);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    const texts = [...Array(rows.length)].map((_, i) => sheet.getRow(i + 2).getCell(7).value);
    expect(texts.every((value) => typeof value === "string")).toBe(true);
    expect(texts.some((value) => String(value).startsWith("=") && !String(value).startsWith("'="))).toBe(false);
  });
  it("is data only: no internal id, no provider or endpoint name, no methodology text, no English words in any text cell", async () => {
    const workbook = await loadWorkbook();
    const all: string[] = [];
    workbook.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((cell) => {
      const v: any = cell.value;
      if (typeof v === "string") all.push(v); else if (v && typeof v === "object" && "text" in v) all.push(String(v.text));
    })));
    const joined = all.join("\n");
    expect(joined).not.toMatch(/eg_health_|page:\d|anyapi|scrapecreators|justoneapi|treg|apify|res_|rel_|chg_|top_/i);
    expect(joined).not.toMatch(/منهجية|المنهجية/);
    // the only Latin text allowed is the web address of a post (a link) and the formula-guard apostrophe of a comment
    const withoutLinks = joined.replace(/https?:\/\/\S+/g, "").replace(/=SUM\(1,2\)/g, "");
    expect(withoutLinks).not.toMatch(/[A-Za-z]{3,}/);
  });
  it("the file is built from saved data alone at download time (the same payload and rows give the same sheets)", async () => {
    const saved = { rows, metadata: { facebookReport: payload } };
    expect(facebookReportOf(saved)).toBeTruthy();
    expect(facebookReportOf({ rows, metadata: {} })).toBeNull();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await buildFacebookReportExcelFrom(saved)) as any);
    expect(workbook.getWorksheet(COMMENTS_SHEET_AR)!.rowCount).toBe(1 + rows.length);
  });
});

describe("the methodology PDF", () => {
  it("is a real PDF with an embedded Arabic font, several pages, and builds from the saved data", async () => {
    const pdf = await generateFacebookReportPdf(payload);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(20_000);
    const raw = pdf.toString("latin1");
    expect(raw).toMatch(/\/FontFile2|\/FontFile3/);
    expect((raw.match(/\/Type \/Page\b/g) || []).length).toBeGreaterThanOrEqual(2);
    const again = await buildFacebookReportPdfFrom({ rows, metadata: { facebookReport: payload } });
    expect(again.subarray(0, 5).toString()).toBe("%PDF-");
  });
  it("its conclusions and limits are templates over the real counts: Arabic only, Arabic-Indic digits, no vendor, no markdown, no emoji, no money", () => {
    const model = buildReportModel(payload);
    const lines = [...conclusionsAr(payload, model), ...limitsAr(payload, model), ...scopeLinesAr(payload, model)];
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      expect(line).not.toMatch(/[A-Za-z0-9]/);
      expect(line).not.toMatch(/[*_#`]|\p{Extended_Pictographic}/u);
      expect(line).not.toMatch(/نقطة|نقاط|جنيه|دولار|سعر/);
    }
    // an interpretation the numbers do not prove is always labelled as a guess, up front
    for (const line of lines.filter((l) => /تفسير محتمل/.test(l))) expect(line.startsWith("اجتهاد (غير مقاس)")).toBe(true);
  });
});
