import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { missionDownloadName, missionFileTitleAr, missionTitleAr, subjectOfMission } from "../src/lib/agentMission/fileNames";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import { MEDIA_ONLY_COMMENT_AR, MEDIA_ONLY_POST_AR, buildMissionFiles } from "../agent/src/workbook";
import { ingestRows } from "../agent/src/items/ingest";
import { ItemStore } from "../agent/src/items/itemStore";
import { createMemoryStore } from "../agent/src/memoryStore";

/**
 * E. THE FILE'S NAME ALWAYS CARRIES THE MISSION'S SUBJECT (one function, every mission type). The live run had «تعليقات - ٣ - …» (the YouTube channel On Sport) and «تعليقات - ٥٥ - …» (the tweets of an account and their replies): the request names the
 * account or the channel with no «عن», and the name had only the noun.
 * F. A POST OR A COMMENT WITH NO TEXT (a picture, a video, a sticker) shows a clear Arabic marker in the file, not an empty cell.
 */
const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001, columns: [], ...over });
const plan = (stages: unknown[]): PricedPlan => ({ summary_ar: "ستحصل على نتائج.", stages: stages as any, price: { totalCostUsd: 0, deliveredRows: 1, costPerFinalRowUsd: 0.0001, unitPricePoints: 1, reservePoints: 2, maxChargePoints: 1, overCap: false } });
const DATE = new Date("2026-10-29T13:30:00Z");
const D = "٢٩ أكتوبر ٢٠٢٦";

describe("E: the subject is in the file's name for every mission type", () => {
  const cases: Array<{ name: string; request: string; stages: unknown[]; delivered: number; expected: string }> = [
    { name: "YouTube: videos of a channel and their comments (live: «تعليقات - ٣»)", request: "هات آخر ٣ فيديوهات من قناة أون سبورت على يوتيوب، ومن كل فيديو ١٠ تعليقات", stages: [stage({ key: "videos", title_ar: "آخر فيديوهات أون سبورت" }), stage({ key: "comments", title_ar: "تعليقات على كل فيديو", parent_key: "videos" })], delivered: 33, expected: `تعليقات عن أون سبورت - ٣٣ - ${D}` },
    { name: "X: tweets of an account and their replies (live: «تعليقات - ٥٥»)", request: "هات آخر ٥ تغريدات من حساب محمد صلاح على إكس، ومع كل تغريدة ١٠ ردود", stages: [stage({ key: "posts", title_ar: "آخر تغريدات محمد صلاح" }), stage({ key: "comments", title_ar: "تعليقات على كل تغريدة", parent_key: "posts" })], delivered: 55, expected: `تعليقات عن محمد صلاح - ٥٥ - ${D}` },
    { name: "TikTok: videos about a topic and their comments", request: "هات ٥ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات", stages: [stage({ key: "videos", title_ar: "فيديوهات تيك توك عن منتخب مصر" }), stage({ key: "comments", title_ar: "تعليقات على فيديوهات منتخب مصر", parent_key: "videos" })], delivered: 46, expected: `تعليقات عن منتخب مصر - ٤٦ - ${D}` },
    { name: "Facebook: posts about a topic and their comments", request: "هات ٥ بوستات فيسبوك عن غلاء الأسعار في مصر، ومع كل بوست ١٠ تعليقات", stages: [stage({ key: "posts", title_ar: "المنشورات" }), stage({ key: "comments", title_ar: "تعليقات كل بوست", parent_key: "posts" })], delivered: 50, expected: `تعليقات عن غلاء الأسعار - ٥٠ - ${D}` },
    { name: "tweets about a topic (relevance rule)", request: "هات ٣٠٠ تغريدة عن محمد صلاح", stages: [stage({ key: "tweets", title_ar: "التغريدات", relevance: { subject_ar: "محمد صلاح لاعب كرة القدم", terms: ["محمد صلاح"] } })], delivered: 300, expected: `تغريدات عن محمد صلاح - ٣٠٠ - ${D}` },
    { name: "reviews of a place", request: "هات ٣٠ تقييم من جوجل ماب لمطعم كشري أبو طارق في القاهرة", stages: [stage({ key: "reviews", title_ar: "التقييمات" })], delivered: 30, expected: `تقييمات عن مطعم كشري أبو طارق - ٣٠ - ${D}` },
    { name: "companies of a sector (no «عن»: the noun takes the sector)", request: "عايز ٣ شركات مقاولات في مصر، ومن كل شركة اتنين من المديرين", stages: [stage({ key: "companies", title_ar: "شركات المقاولات في مصر" })], delivered: 3, expected: `شركات المقاولات - ٣ - ${D}` },
    { name: "the same request with the code-built relevance rule (entity)", request: "عايز ٣ شركات مقاولات في مصر", stages: [stage({ key: "companies", title_ar: "الشركات", relevance: { subject_ar: "شركات مقاولات", terms: ["مقاولات", "مقاولة", "construction"], entity: true } })], delivered: 3, expected: `شركات مقاولات - ٣ - ${D}` },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const title = missionFileTitleAr({ plan: plan(c.stages), requestText: c.request, delivered: c.delivered, date: DATE });
      expect(title).toBe(c.expected);
      // never the bare noun with the count («تعليقات - ٣ - ...»)
      expect(title).not.toMatch(/^[^ ]+ - [٠-٩]+ - /);
      // the download of the Excel and of the CSV, and the notice's title, are the same words
      const base = { plan: plan(c.stages), requestText: c.request, deliveredUnits: c.delivered, date: DATE };
      expect(missionDownloadName({ ...base, kind: "xlsx" })).toBe(`${c.expected}.xlsx`);
      expect(missionDownloadName({ ...base, kind: "csv" })).toBe(`${c.expected}.csv`);
      expect(c.expected.startsWith(missionTitleAr({ plan: plan(c.stages), requestText: c.request }))).toBe(true);
    });
  }

  it("a request that names nothing about its subject gives the noun alone (nothing to say); the subject function never returns a platform, a verb or a number", () => {
    expect(missionFileTitleAr({ plan: plan([stage({ key: "t", title_ar: "التغريدات" })]), requestText: "هات ٥٠ تغريدة", delivered: 50, date: DATE })).toBe(`تغريدات - ٥٠ - ${D}`);
    for (const request of ["هات آخر ٥ تغريدات من حساب محمد صلاح على إكس، ومع كل تغريدة ١٠ ردود", "هات آخر ٣ فيديوهات من قناة أون سبورت على يوتيوب"]) {
      const subject = subjectOfMission({ plan: plan([stage({ key: "t", title_ar: "التغريدات" })]), requestText: request });
      expect(subject).not.toMatch(/إكس|يوتيوب|هات|[0-9٠-٩]|قناة|حساب/);
      expect(subject.length).toBeGreaterThan(0);
    }
  });
});

describe("F: a post or a comment with no text shows an Arabic marker in the file", () => {
  const posts = stage({ key: "posts", title_ar: "آخر تغريدات محمد صلاح", columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }] });
  const replies = stage({ key: "replies", title_ar: "الردود على كل تغريدة", parent_key: "posts", columns: [{ key: "text", title_ar: "نص الرد" }, { key: "author", title_ar: "الكاتب" }] });
  const rows = {
    posts: [
      { id: "t1", text: "هدف رائع من محمد صلاح اليوم", url: "https://x.example/t1", author: "mosalah" },
      { id: "t2", text: "", url: "https://x.example/t2", author: "mosalah" },
      { id: "t3", text: "   ", url: "https://x.example/t3", author: "mosalah" },
    ],
    replies: [
      { id: "r1", parent_id: "t1", text: "ما شاء الله", author: "قارئ" },
      { id: "r2", parent_id: "t2", text: "", author: "قارئ آخر" },
    ],
  };
  const load = async (xlsx: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as unknown as ArrayBuffer); return wb; };
  const column = (sheet: ExcelJS.Worksheet, header: string): string[] => {
    const at = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? "")).indexOf(header);
    const out: string[] = [];
    sheet.eachRow((row, n) => { if (n > 1) out.push(String(row.getCell(at).value ?? "")); });
    return out;
  };

  it("the cell says «منشور بصورة أو فيديو دون نص» for a post (a blank or a spaces-only text), «تعليق بصورة أو ملصق دون نص» for a reply; a real text is untouched", async () => {
    const { xlsx, csv } = await buildMissionFiles(plan([posts, replies]), rows as never);
    const wb = await load(xlsx);
    expect(column(wb.getWorksheet("آخر تغريدات محمد صلاح")!, "نص التغريدة")).toEqual(["هدف رائع من محمد صلاح اليوم", MEDIA_ONLY_POST_AR, MEDIA_ONLY_POST_AR]);
    expect(column(wb.getWorksheet("الردود على كل تغريدة")!, "نص الرد")).toEqual(["ما شاء الله", MEDIA_ONLY_COMMENT_AR]);
    expect(MEDIA_ONLY_POST_AR).toBe("منشور بصورة أو فيديو دون نص");
    // the CSV is the deepest stage: the reply's marker is there too
    expect(csv).toContain(MEDIA_ONLY_COMMENT_AR);
    // the parent's text next to each reply (the context column) says it too
    const context = column(wb.getWorksheet("الردود على كل تغريدة")!, "نص التغريدة");
    expect(context).toContain(MEDIA_ONLY_POST_AR);
  });

  it("a stage that is not a text stage (companies) keeps its empty cells empty: the marker is only for posts and comments", async () => {
    const companies = stage({ key: "c", title_ar: "الشركات", columns: [{ key: "name", title_ar: "الاسم" }, { key: "text", title_ar: "الوصف" }] });
    const { xlsx } = await buildMissionFiles(plan([companies]), { c: [{ id: "a", name: "شركة", text: "" }] } as never);
    const wb = await load(xlsx);
    expect(column(wb.getWorksheet("الشركات")!, "الوصف")).toEqual([""]);
  });

  it("the marker is a display of the file only: the item keeps its empty text and a text-less item is not merged with another by the repeated-text rule", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_f1", { legacyStages: ["posts"] });
    const p = { ...posts, planned_rows: 5 } as never;
    const result = await ingestRows({ items, plan: plan([posts]), addEvent: async () => undefined }, p, [{ id: "t1", text: "", url: "u1", author: "a" }, { id: "t2", text: "", url: "u2", author: "a" }], { silent: true, idField: null });
    expect(result.counts.accepted).toBe(2);
    expect(items.acceptedRows("posts").map((r) => r.text)).toEqual(["", ""]);
  });
});
