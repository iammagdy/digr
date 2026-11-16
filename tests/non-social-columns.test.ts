import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import { checkFieldMap, enrichedMap, withoutTwinPaths } from "../agent/src/llmPlanner/planner";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import { MARKS_KEY, MARK_COLUMN_ORDER, markColumnsOf, type RowMarks } from "../src/lib/agentMission/rawMarks";

/**
 * LIVE, 16 Nov 2026 (40 Google Maps restaurants in Maadi): the data was right, but the sheet read like a social-media export. The rating sat under «الإعجابات» AND «التقييم», the number of reviews under «عدد التعليقات» AND
 * «عدد المراجعات», the name under «النص» AND «العنوان», and five post marks («رد أم أصلي = أصلي», «إعادة نشر = لا», «لغة النص = لغة أخرى», two «غير محدد») filled every row.
 */
const PLACE = { place_id: "ChIJ1", name: "Ovio Maadi Restaurant", rating: 4.4, reviews: 4293, phone: "+20 10 22231095", type: "Modern European restaurant", website: "http://ovio.eu/" };

describe("one source field, one column (the planner's field map)", () => {
  const modelAnswer = {
    fields: { id: ["place_id"], text: ["name"], title: ["name"], likes: ["rating"], comments_count: ["reviews"] },
    extra: [
      { key: "phone", title_ar: "رقم الهاتف", path: ["phone"] },
      { key: "rating", title_ar: "التقييم", path: ["rating"] },
      { key: "reviews", title_ar: "عدد المراجعات", path: ["reviews"] },
      { key: "category", title_ar: "التصنيف", path: ["type"] },
    ],
  };
  it("a counter that repeats an extra column is dropped; the extra keeps its own title", () => {
    const map = checkFieldMap(modelAnswer, [PLACE])!;
    expect(Object.keys(map.fields).sort()).toEqual(["id", "text"]);
    expect(map.extra.map((e) => e.title_ar)).toEqual(["رقم الهاتف", "التقييم", "عدد المراجعات", "التصنيف"]);
  });
  it("the code's fallback guesses do not bring a twin back", () => {
    const map = enrichedMap(checkFieldMap(modelAnswer, [PLACE]), [PLACE])!;
    const paths = [...Object.entries(map.fields).filter(([k]) => k !== "id").map(([, p]) => p.join(".")), ...map.extra.map((e) => e.path.join("."))];
    expect(new Set(paths).size).toBe(paths.length);
  });
  it("a post's distinct counters are untouched", () => {
    const map = withoutTwinPaths({ fields: { id: ["id"], text: ["text"], likes: ["likeCount"], comments_count: ["replyCount"], views: ["viewCount"] }, linkTemplate: null, extra: [{ key: "x_lang", title_ar: "اللغة", path: ["lang"] }] });
    expect(Object.keys(map.fields)).toEqual(["id", "text", "likes", "comments_count", "views"]);
    expect(map.extra).toHaveLength(1);
  });
  it("the id may share its path with the link (a place's URL is its id)", () => {
    const map = withoutTwinPaths({ fields: { id: ["url"], link: ["url"], text: ["name"] }, linkTemplate: null, extra: [] });
    expect(map.fields).toEqual({ id: ["url"], link: ["url"], text: ["name"] });
  });
});

describe("the post marks belong to posts and comments", () => {
  const marked = (m: Partial<RowMarks>) => ({ [MARKS_KEY]: { reply: false, repost: false, lang: "other", inPeriod: null, named: null, ...m } });
  it("places, products, prices, repositories: no post mark unless the request asked for it", () => {
    for (const cap of ["google.serp.maps", "amazon.search.products", "crypto.price.history", "github.trending.repositories", "linkedin.search.jobs"]) expect(markColumnsOf(cap, [marked({})])).toEqual([]);
  });
  it("a condition the request set keeps its mark (the delivery contract checks it)", () => {
    expect(markColumnsOf("google.serp.maps", [marked({ inPeriod: true })], { period: true, named: false, language: false })).toEqual(["inPeriod"]);
    expect(markColumnsOf("amazon.product.reviews", [marked({})], { language: true })).toEqual(["lang"]);
  });
  it("reviews keep the language of their text when the rows hold it", () => {
    expect(markColumnsOf("google.maps.reviews", [marked({ lang: "ar" })])).toEqual(["lang"]);
  });
  it("posts, comments, videos and stages with no capability keep all five", () => {
    for (const cap of ["x.search.posts", "tiktok.video.comments", "youtube.search.videos", "reddit.post.comments", "instagram.user.reels", undefined]) expect(markColumnsOf(cap, [marked({})])).toEqual([...MARK_COLUMN_ORDER]);
  });
});

describe("the delivered file of a places request", () => {
  it("has the place's own columns and no post mark", async () => {
    const stage = { key: "places", title_ar: "المطاعم", endpoint_id: "anyapi.google.serp.maps", capability: "google.serp.maps", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001,
      columns: [{ key: "text", title_ar: "النص" }, { key: "x_phone", title_ar: "رقم الهاتف" }, { key: "x_rating", title_ar: "التقييم" }] };
    const plan = { summary_ar: "ستحصل على مطاعم.", stages: [stage], price: { totalCostUsd: 0, deliveredRows: 1, costPerFinalRowUsd: 0.0001, unitPricePoints: 1, reservePoints: 1, maxChargePoints: 1 } } as unknown as PricedPlan;
    const rows = [{ id: "ChIJ1", text: PLACE.name, x_phone: PLACE.phone, x_rating: "4.4", [MARKS_KEY]: { reply: false, repost: false, lang: "other", inPeriod: null, named: null } }];
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildMissionFiles(plan, { places: rows })).xlsx as unknown as ArrayBuffer);
    const header = (wb.getWorksheet("المطاعم")!.getRow(1).values as unknown[]).slice(1).map(String);
    expect(header).toContain("رقم الهاتف");
    expect(header).toContain("التقييم");
    for (const t of ["رد أم أصلي", "إعادة نشر", "لغة النص", "ضمن الفترة المطلوبة", "المصدر المسمّى", "الإعجابات"]) expect(header).not.toContain(t);
  });
});

describe("the card describes what is collected, not the person", () => {
  it("a leading «الطالب يريد» becomes «المطلوب»", async () => {
    const { impersonalAr } = await import("../agent/src/llmPlanner/planner");
    expect(impersonalAr("الطالب يريد قائمة بأربعين مطعمًا في المعادي")).toBe("المطلوب: قائمة بأربعين مطعمًا في المعادي");
    expect(impersonalAr("العميل يطلب ١٠٠ تعليق")).toBe("المطلوب: ١٠٠ تعليق");
    expect(impersonalAr("جمع ٢٠٠ تقييم لتطبيق طلبات")).toBe("جمع ٢٠٠ تقييم لتطبيق طلبات");
  });
});
