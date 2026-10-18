import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { generateCsvReport, generateExcelReport } from "../src/functions/shared/fileGenerators";
import { normalizeSocialComment, normalizeSocialVideo, parseCount, toIsoDate } from "../src/lib/server/socialRows";
import { normalizeDataset } from "../src/lib/server/normalizationPipeline";

const payloadFor = (socialKind: "comments" | "videos", platform: string, rows: any[]) => ({
  metadata: {
    platform,
    socialKind,
    title: socialKind === "comments" ? "تعليقات تيك توك" : "فيديوهات تيك توك",
    jobId: "job_x",
    collectedAt: "2026-10-17T10:00:00.000Z",
    rowsCount: rows.length,
    targetRequested: rows.length,
    reportContext: { scope: {}, collection: { methodLabel: "x", pagesFetched: 1, paginationStrategy: "cursor", stopReason: "target_reached" }, counts: { rawRows: rows.length, acceptedRows: rows.length, baselineExclusions: 0, relevanceExclusions: 0, uncertainRows: 0 } },
  },
  rows,
  uncertainRows: [],
  profile: null,
});

const headersOf = async (payload: any) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await generateExcelReport(payload)) as any);
  return { wb, sheet: wb.worksheets[0], headers: (wb.worksheets[0].getRow(1).values as any[]).slice(1) as string[] };
};

describe("counts and dates are read the way providers write them", () => {
  it("compact counts", () => {
    expect(parseCount("1.2M")).toBe(1_200_000);
    expect(parseCount("12K views")).toBe(12_000);
    expect(parseCount("3,400")).toBe(3400);
    expect(parseCount(17)).toBe(17);
    expect(parseCount("لا يوجد")).toBeUndefined();
  });

  it("unix seconds, milliseconds and ISO strings become a plain date; relative phrases are not shown", () => {
    expect(toIsoDate(1760000000)).toBe("2025-10-09");
    expect(toIsoDate("1760000000000")).toBe("2025-10-09");
    expect(toIsoDate("2026-09-10T08:00:00Z")).toBe("2026-09-10");
    expect(toIsoDate("3 years ago")).toBeUndefined();
    expect(toIsoDate("")).toBeUndefined();
  });
});

describe("comment and video rows get one fixed schema whatever source answered", () => {
  it("YouTube-style and TikTok-style comments map to the same facts", () => {
    const yt = normalizeSocialComment({ comment_id: "Ugx1", text: "رائع", author: "أحمد", likes: 12, replies: 2, published_date: "2026-09-10", published: "منذ شهر", hearted_by_creator: true });
    const tt = normalizeSocialComment({ cid: "7001", text: "حلو", user_nickname: "منى", user_unique_id: "mona", digg_count: 5, reply_comment_total: 1, create_time: 1760000000 });
    expect(yt).toMatchObject({ source_id: "Ugx1", comment_text: "رائع", author_name: "أحمد", likes_count: 12, replies_count: 2, published_at: "2026-09-10", hearted_by_creator: true });
    expect(tt).toMatchObject({ source_id: "7001", comment_text: "حلو", author_name: "منى", username: "@mona", likes_count: 5, replies_count: 1, published_at: "2025-10-09" });
    // Nothing else leaks through: no raw provider columns.
    expect(Object.keys(yt)).not.toContain("published");
    expect(Object.keys(tt)).not.toContain("digg_count");
  });

  it("video rows from TikTok and YouTube", () => {
    const tt = normalizeSocialVideo({ video_id: "7231337071831321903", desc: "قهوة", author_unique_id: "lab", author_nickname: "معمل", create_time: 1760000000, play_count: "1.2M", digg_count: 5400, comment_count: 230, share_count: 90, collect_count: 12, share_url: "https://www.tiktok.com/@lab/video/7231337071831321903" });
    expect(tt).toMatchObject({ video_caption: "قهوة", channel_name: "معمل", username: "@lab", views_count: 1_200_000, likes_count: 5400, comments_count: 230, shares_count: 90, saves_count: 12, published_at: "2025-10-09" });
    const yt = normalizeSocialVideo({ video_id: "abcdefghijk", title: "تحضير", channel: "قناة", published: "3 years ago", views: "12K views", url: "https://www.youtube.com/watch?v=abcdefghijk" });
    expect(yt).toMatchObject({ video_caption: "تحضير", channel_name: "قناة", views_count: 12_000 });
    expect(yt.published_at).toBeUndefined();
  });

  it("text that could run as a formula is neutralized, and plain handles and numbers are not touched", () => {
    const ds = normalizeDataset(payloadFor("comments", "youtube", [{ comment_id: "1", text: '=HYPERLINK("http://x")', author: "@sara", likes: 3 }]));
    expect(String(ds.rows[0].comment_text).startsWith("'")).toBe(true);
    expect(ds.rows[0].likes_count).toBe(3);
  });
});

describe("the delivered files", () => {
  const ytComments = [
    { comment_id: "Ugx1", video_id: "dQw4w9WgXcQ", text: "فيديو رائع", author: "أحمد", likes: 12, replies: 2, published_date: "2026-09-10", published: "منذ شهر", hearted_by_creator: true, pinned: false, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&lc=Ugx1", video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", video_title: "عنوان الفيديو" },
    { comment_id: "Ugx2", video_id: "dQw4w9WgXcQ", text: "جميل", author: "@sara", likes: 0, replies: 0, published_date: "2026-10-15", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&lc=Ugx2", video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", video_title: "عنوان الفيديو" },
  ];

  it("comments: one sheet, Arabic headers only, no raw provider columns, no duplicated column, readable date", async () => {
    const { wb, sheet, headers } = await headersOf(payloadFor("comments", "youtube", ytComments));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["التعليقات"]);
    expect(headers.every((h) => !/[A-Za-z]/.test(h))).toBe(true);
    expect(headers).not.toContain("حقل published");
    expect(new Set(headers).size).toBe(headers.length);
    for (const wanted of ["نص التعليق", "الاسم المعروض", "تاريخ ووقت النشر", "عدد الإعجابات", "عدد الردود", "رابط الفيديو أو المنشور"]) expect(headers).toContain(wanted);
    const dateCol = headers.indexOf("تاريخ ووقت النشر") + 1;
    expect(sheet.getRow(2).getCell(dateCol).value).toBe("2026-09-10");
    expect(sheet.rowCount).toBe(3);
  });

  it("the CSV has the same columns as the workbook", async () => {
    const payload = payloadFor("comments", "youtube", ytComments);
    const { headers } = await headersOf(payload);
    const csvHeader = generateCsvReport(payload).toString("utf-8").replace(/^﻿/, "").split("\n")[0].split(",").map((h) => h.replace(/"/g, ""));
    expect(csvHeader).toEqual(headers);
  });

  it("videos: one sheet named for videos with views, likes, comments and a live link", async () => {
    const { wb, sheet, headers } = await headersOf(payloadFor("videos", "tiktok", [
      { video_id: "7231337071831321903", desc: "قهوة", author_unique_id: "lab", author_nickname: "معمل", create_time: 1760000000, play_count: "1.2M", digg_count: 5400, comment_count: 230, share_url: "https://www.tiktok.com/@lab/video/7231337071831321903" },
    ]));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["الفيديوهات والمنشورات"]);
    expect(headers.every((h) => !/[A-Za-z]/.test(h))).toBe(true);
    for (const wanted of ["عدد المشاهدات", "عدد الإعجابات", "عدد التعليقات", "القناة أو الحساب", "الرابط المباشر"]) expect(headers).toContain(wanted);
    expect(sheet.getRow(2).getCell(headers.indexOf("عدد المشاهدات") + 1).value).toBe(1_200_000);
    const linkCell = sheet.getRow(2).getCell(headers.indexOf("الرابط المباشر") + 1);
    expect(linkCell.hyperlink).toContain("tiktok.com");
  });

  it("customer files never contain a provider name", async () => {
    const buf = (await generateExcelReport(payloadFor("comments", "youtube", ytComments))).toString("utf-8");
    for (const word of ["crawl4ai", "tikhub", "scrapecreators", "anyapi", "treg"]) expect(buf.toLowerCase()).not.toContain(word);
  });
});
