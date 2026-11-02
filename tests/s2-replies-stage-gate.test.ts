import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { isRepliesStage, withRepliesStages } from "../src/lib/agentMission/replies";
import { DEFAULT_MISSION_PRICING_SETTINGS } from "../src/lib/missionPricing";
import { redesignStagesOf } from "../agent/src/redesign";
import type { RedesignFlags } from "../src/lib/agentMission/redesignFlags";

/**
 * S2 ITEM 1 (docs/S1-LIVE-FINDINGS.md, «Live run of 2026-11-02», L0.2). The live mission msn_48f6c7c80eb7068f2a38 planned in the redesigned mode (stages 1 and 2 `built_by: "code"`) but ran the OLD pipeline (`pipe_new = 0`): the replies stage, written by code
 * in replies.ts, carried no `built_by`, and the ordering gate needs EVERY stage of the plan to be built by code. A plan with a replies stage must pass the gate when the stages it sits on do.
 */
const catalog = loadTregCatalog();
const FLAGS: RedesignFlags = { social_posts: "test", social_account: "test", social_comments: "test", companies: "off", people: "off", places: "off" } as RedesignFlags;
const VIDEOS_SPEC = { endpoint_id: "tikhub.tiktok.search.videos", params: { count: 2 }, cursor_param: "offset", map_code: "return []", map_file_id: "call_0002", parent_binding: null, built_by: "code" };
const COMMENTS_SPEC = { endpoint_id: "tikhub.tiktok.video.comments", params: {}, cursor_param: "cursor", map_code: "return []", map_file_id: "call_0003", parent_binding: { param: "aweme_id", from: "id" }, built_by: "code" };
const stage = (o: Partial<PricedStage> & Pick<PricedStage, "key" | "title_ar" | "endpoint_id" | "parent_key" | "planned_rows">): PricedStage => ({ expected_rows: o.planned_rows, deliver: true, columns: [], sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0.0002, measured_from_calls: [], ...o });
const COLUMNS = [{ key: "text", title_ar: "نص التعليق" }, { key: "replies_count", title_ar: "عدد الردود" }];
const SAMPLE = [{ id: "a", text: "x", replies_count: 1 }, { id: "b", text: "y", replies_count: 0 }, { id: "c", text: "z", replies_count: 2 }, { id: "d", text: "w", replies_count: 0 }];

function basePlan(): PricedPlan {
  const stages: PricedStage[] = [
    stage({ key: "videos", title_ar: "الفيديوهات", endpoint_id: "tikhub.tiktok.search.videos", parent_key: null, planned_rows: 2, columns: [{ key: "link", title_ar: "رابط الفيديو" }, { key: "comments_count", title_ar: "عدد التعليقات" }], engine: VIDEOS_SPEC as never }),
    stage({ key: "comments", title_ar: "تعليقات كل فيديو", endpoint_id: "tikhub.tiktok.video.comments", parent_key: "videos", planned_rows: 40, per_parent_rows: 20, columns: COLUMNS, engine: COMMENTS_SPEC as never }),
  ];
  return { summary_ar: "ستحصل على فيديوهات وتعليقاتها.", stages, price: priceMissionByCode(stagePriceInputs(stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) };
}
const withReplies = () => withRepliesStages(basePlan(), { catalog, isAllowed: () => true, sampleRowsOf: async () => SAMPLE });

describe("a plan with a replies stage passes the redesign gate", () => {
  it("the replies stage is built by code, so the stage that code wrote carries the mark", async () => {
    const plan = await withReplies();
    const replies = plan.stages.find(isRepliesStage)!;
    expect(replies).toBeDefined();
    expect(replies.engine!.built_by).toBe("code");
  });
  it("the whole mission (videos, comments, replies) runs the new pipeline for a test account with the flag on test", async () => {
    const plan = await withReplies();
    expect([...redesignStagesOf(plan, FLAGS, true)].sort()).toEqual(["comments", "comments_replies", "videos"]);
  });
  it("it never switches on for a real customer, nor with the flag off", async () => {
    const plan = await withReplies();
    expect(redesignStagesOf(plan, FLAGS, false).size).toBe(0);
    expect(redesignStagesOf(plan, { ...FLAGS, social_comments: "off" }, true).size).toBe(0);
  });
  it("a comments stage the MODEL built keeps the whole mission on the old path (the gate is unchanged)", async () => {
    const plan = await withReplies();
    plan.stages[1].engine = { ...plan.stages[1].engine!, built_by: "model" };
    expect(redesignStagesOf(plan, FLAGS, true).size).toBe(0);
  });
});
