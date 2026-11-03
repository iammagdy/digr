import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { isRepliesStage, wantsReplies, withRepliesStages } from "../src/lib/agentMission/replies";

import { DEFAULT_MISSION_PRICING_SETTINGS } from "../src/lib/missionPricing";

/**
 * S3 ITEM 2 (owner rule): when the request mentions replies («والردود»), the replies stage is ALWAYS in the plan. The live plan of 2026-11-02 09:25 had none («غير مشمولة»); a sample whose comments carry no reply counter, or show no replies, used to drop the stage whatever the request said.
 * The replies are then read for every comment by its own counter at execution, only what exists is delivered and charged, and the plan's number is an estimate the card says so.
 */
const catalog = loadTregCatalog();
const SPEC = { endpoint_id: "tikhub.tiktok.video.comments", params: {}, cursor_param: "cursor", map_code: "return []", map_file_id: "call_0003", parent_binding: { param: "aweme_id", from: "id" }, built_by: "code" };
const stage = (o: Partial<PricedStage> & Pick<PricedStage, "key" | "title_ar" | "endpoint_id" | "parent_key" | "planned_rows">): PricedStage => ({ expected_rows: o.planned_rows, deliver: true, columns: [], sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0.0002, measured_from_calls: [], ...o });
const plan = (): PricedPlan => {
  const stages: PricedStage[] = [
    stage({ key: "videos", title_ar: "الفيديوهات", endpoint_id: "tikhub.tiktok.search.videos", parent_key: null, planned_rows: 2, columns: [{ key: "link", title_ar: "رابط الفيديو" }, { key: "comments_count", title_ar: "عدد التعليقات" }], engine: { ...SPEC, endpoint_id: "tikhub.tiktok.search.videos", parent_binding: null, cursor_param: "offset" } as never }),
    stage({ key: "comments", title_ar: "التعليقات", endpoint_id: "tikhub.tiktok.video.comments", parent_key: "videos", planned_rows: 40, per_parent_rows: 20, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "replies_count", title_ar: "عدد الردود" }], engine: SPEC as never }),
  ];
  return { summary_ar: "x", stages, price: priceMissionByCode(stagePriceInputs(stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) };
};
const silent = [0, 0, 0, 0].map((n, i) => ({ id: `s${i}`, text: "x", replies_count: n }));
const noCounter = [0, 1].map((_, i) => ({ id: `s${i}`, text: "x" }));
const build = (rows: Array<Record<string, unknown>>, o: { requested?: boolean; all?: boolean } = {}) => withRepliesStages(plan(), { catalog, isAllowed: () => true, sampleRowsOf: async () => rows, ...o });

describe("the words that ask for replies", () => {
  it("«والردود»، «ردودها»، «مع الردود» ask; a request about comments only does not", () => {
    for (const t of ["هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود.", "عايز التعليقات مع ردودها", "هات الردود كمان"]) expect(wantsReplies(t), t).toBe(true);
    for (const t of ["هات ٥ فيديوهات ومن كل فيديو ١٠ تعليقات", "كل التعليقات على فيديوهين"]) expect(wantsReplies(t), t).toBe(false);
  });
});

describe("the replies stage is always in the plan when the request mentions replies", () => {
  it("a sample that shows no replies: without the words the stage is dropped (as before), with them it stays", async () => {
    const dropped = await build(silent);
    expect(dropped.stages.some(isRepliesStage)).toBe(false);
    expect(dropped.replies_status).toBe("none_found");
    const kept = await build(silent, { requested: true });
    expect(kept.stages.some(isRepliesStage)).toBe(true);
    expect(kept.replies_status).toBeUndefined();
  });
  it("a sample whose comments carry no reply counter: the same", async () => {
    expect((await build(noCounter)).stages.some(isRepliesStage)).toBe(false);
    expect((await build(noCounter, { requested: true })).stages.some(isRepliesStage)).toBe(true);
  });
  it("«all» replies: each comment is read to the end of its replies (the largest number per comment the job allows), not to the default of ten", async () => {
    expect((await build(silent, { requested: true, all: true })).stages.find(isRepliesStage)!.per_parent_rows).toBe(50);
    expect((await build(silent, { requested: true })).stages.find(isRepliesStage)!.per_parent_rows).toBe(10);
  });
  it("a platform with no reply source still says so (nothing can be read): the stage cannot exist", async () => {
    const p = plan();
    p.stages[1].endpoint_id = "youtube.video.comments";
    const out = await withRepliesStages(p, { catalog, isAllowed: () => true, sampleRowsOf: async () => silent, requested: true });
    expect(out.stages.some(isRepliesStage)).toBe(false);
  });
});
