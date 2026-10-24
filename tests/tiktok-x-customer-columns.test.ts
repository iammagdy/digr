import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { generateCsvReport, generateExcelReport } from "../src/functions/shared/fileGenerators";

/**
 * The TikTok and X customer files carry no column of the platform's own source id («معرف المصدر الأصلي», a number nobody can use). The stored rows keep
 * it; the YouTube file keeps its column (not in this change). Checked in the workbook and in the CSV.
 */
const SOURCE_ID_TITLE = "معرف المصدر الأصلي";
const row = (i: number) => ({
  comment_id: `cid${i}`, tweet_id: `tw${i}`, video_id: `vd${i}`, text: `تعليق رقم ${i} عن الدوري`, author_name: `مستخدم ${i}`, username: `u${i}`,
  published_at: "2026-10-20T10:00:00Z", url: `https://www.tiktok.com/@a/video/${i}`, video_url: `https://www.tiktok.com/@a/video/${i}`,
  likes_count: i, replies_count: 0, video_title: "فيديو", video_caption: "فيديو",
});
const payload = (template: string, socialKind: "comments" | "posts") => ({
  metadata: { platform: template.split("-")[1], socialKind, template, title: template, collectedAt: "2026-10-24T00:00:00Z" },
  rows: [0, 1, 2].map(row),
});
const headersOf = async (buffer: Buffer): Promise<string[]> => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  return wb.worksheets.flatMap((sheet) => (sheet.getRow(1).values as any[]).slice(1).map(String));
};

describe("the source id column is kept out of the TikTok and X customer files only", () => {
  it("TikTok comments: no source id column, in the workbook and in the CSV", async () => {
    const data = payload("social-tiktok-comments", "comments");
    expect(await headersOf(await generateExcelReport(data))).not.toContain(SOURCE_ID_TITLE);
    expect(generateCsvReport(data).toString("utf-8")).not.toContain(SOURCE_ID_TITLE);
  });
  it("X posts: no source id column, in the workbook and in the CSV", async () => {
    const data = payload("social-x-posts", "posts");
    expect(await headersOf(await generateExcelReport(data))).not.toContain(SOURCE_ID_TITLE);
    expect(generateCsvReport(data).toString("utf-8")).not.toContain(SOURCE_ID_TITLE);
  });
  it("YouTube keeps its column (this change does not touch it)", async () => {
    const data = payload("social-youtube-comments", "comments");
    expect(await headersOf(await generateExcelReport(data))).toContain(SOURCE_ID_TITLE);
  });
});
