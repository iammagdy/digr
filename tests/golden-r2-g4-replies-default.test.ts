import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { planEditorView, stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { isRepliesStage, withRepliesStages } from "../src/lib/agentMission/replies";
import { repliesLinesAr } from "../src/lib/agentMission/repliesCard";
import { AGENT_REPLIES_PER_COMMENT_DEFAULT, AGENT_REPLIES_PER_COMMENT_MAX } from "../src/lib/agentMission/constants";
import { DEFAULT_MISSION_PRICING_SETTINGS } from "../src/lib/missionPricing";
import { editsFromState, initialState } from "../src/components/mission/PlanEditor";

/**
 * GOLDEN RUN ROUND 2, G4 (msn_32fc60fb7bab0c8c7869): the original plan was 1,605 points held (1,396 charged at most) because every sampled comment had more than fifty replies and the replies were estimated at the 50-per-comment cap: 50 comments x 50 = 2,500 replies.
 * OWNER DECISION: the default is TEN replies per comment, editable in the plan editor up to the existing cap of fifty; the price is computed by code from that number and the sampled reply counters.
 */
const catalog = loadTregCatalog();
const SPEC = { endpoint_id: "crawl4ai.tiktok.video.comments", params: { count: 10 }, cursor_param: "cursor", map_code: "return []", map_file_id: "call_0002", parent_binding: { param: "aweme_id", from: "id" } };
const stage = (o: Partial<PricedStage> & Pick<PricedStage, "key" | "title_ar" | "endpoint_id" | "parent_key" | "planned_rows">): PricedStage => ({ expected_rows: o.planned_rows, deliver: true, columns: [], sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0.0002, measured_from_calls: [], ...o });
const COLUMNS = [{ key: "text", title_ar: "النص" }, { key: "author", title_ar: "الكاتب" }, { key: "posted_at", title_ar: "التاريخ" }, { key: "likes", title_ar: "الإعجابات" }, { key: "replies_count", title_ar: "عدد الردود" }];
const LIVE_SAMPLE = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, text: "x", replies_count: 60 + i }));

async function g4Plan(sample: Array<Record<string, unknown>> = LIVE_SAMPLE): Promise<PricedPlan> {
  const stages: PricedStage[] = [
    stage({ key: "videos", title_ar: "فيديوهات تيك توك عن منتخب مصر", endpoint_id: "anyapi.tiktok.search.videos", parent_key: null, planned_rows: 5, columns: [{ key: "link", title_ar: "الرابط" }, { key: "caption", title_ar: "الوصف" }, { key: "comments_count", title_ar: "عدد التعليقات" }] }),
    stage({ key: "comments", title_ar: "أعلى ١٠ تعليقات على كل فيديو", endpoint_id: "crawl4ai.tiktok.video.comments", parent_key: "videos", planned_rows: 50, per_parent_rows: 10, columns: COLUMNS, engine: SPEC as never }),
  ];
  const base: PricedPlan = { summary_ar: "٥ فيديوهات تيك توك عن منتخب مصر، ومع كل فيديو أول ١٠ تعليقات عليه.", stages, quantity: { requested: 50, stage_key: "comments", target: 50, source: "request" }, price: priceMissionByCode(stagePriceInputs(stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) } as PricedPlan;
  return withRepliesStages(base, { catalog, isAllowed: () => true, sampleRowsOf: async () => sample });
}
const must = (r: ReturnType<typeof applyPlanEdits>): PricedPlan => { if (!r.ok) throw new Error(r.errorAr); return r.plan; };
const repliesOf = (p: PricedPlan) => p.stages.find(isRepliesStage)!;

describe("the default is ten replies per comment", () => {
  it("the constants: default 10, cap 50 (unchanged)", () => {
    expect(AGENT_REPLIES_PER_COMMENT_DEFAULT).toBe(10);
    expect(AGENT_REPLIES_PER_COMMENT_MAX).toBe(50);
  });

  it("LIVE SHAPE: ten comments, every one with 60+ replies: 50 comments x 10 = 500 replies planned (not 2,500), each comment read for up to 10", async () => {
    const plan = await g4Plan();
    const replies = repliesOf(plan);
    expect(replies.per_parent_rows).toBe(10);
    expect(replies.planned_rows).toBe(500);
    expect(replies.replies_per_comment_expected).toBe(10);
  });

  it("a comment with fewer than ten replies counts what it has (mean of the sampled counters, capped at the number per comment)", async () => {
    const plan = await g4Plan([{ id: "a", text: "x", replies_count: 6 }, { id: "b", text: "x", replies_count: 0 }, { id: "c", text: "x", replies_count: 40 }, { id: "d", text: "x", replies_count: 2 }]);
    expect(repliesOf(plan).replies_per_comment_expected).toBe(4.5);
    expect(repliesOf(plan).planned_rows).toBe(225);
  });

  it("the price is far under the fifty-per-comment price, computed by code from the same function", async () => {
    const ten = await g4Plan();
    const fifty = must(applyPlanEdits(ten, { stages: [{ key: "comments", replies_per_comment: 50 }] }));
    expect(repliesOf(fifty).planned_rows).toBe(2500);
    expect(ten.price.reservePoints).toBeLessThan(fifty.price.reservePoints / 2);
    expect(ten.price.maxChargePoints).toBeLessThan(fifty.price.maxChargePoints / 2);
    // the stored plan prices the same again (approval re-prices the stored plan and must get the same number)
    const again = priceMissionByCode(stagePriceInputs(ten.stages, ten.contact_steps), { settings: ten.price.settings });
    expect(again.reservePoints).toBe(ten.price.reservePoints);
    expect(again.unitPricePoints).toBe(ten.price.unitPricePoints);
  });
});

describe("editable in the plan editor, up to the existing cap", () => {
  it("raising and lowering the number per comment changes the replies planned and the price, by code", async () => {
    const plan = await g4Plan();
    const thirty = must(applyPlanEdits(plan, { stages: [{ key: "comments", replies_per_comment: 30 }] }));
    expect(repliesOf(thirty).per_parent_rows).toBe(30);
    expect(repliesOf(thirty).planned_rows).toBe(1500);
    expect(thirty.price.providerCostUsd!).toBeGreaterThan(plan.price.providerCostUsd!);
    expect(thirty.price.reservePoints).toBeGreaterThanOrEqual(plan.price.reservePoints);
    const three = must(applyPlanEdits(plan, { stages: [{ key: "comments", replies_per_comment: 3 }] }));
    expect(repliesOf(three).planned_rows).toBe(150);
    // (the owner's minimum charge sets the floor of a small job: the provider cost the price rests on is what falls)
    // (a call gives a page of ten replies, so reading three or ten costs one call a comment: the cost never rises when the number falls)
    expect(three.price.providerCostUsd!).toBeLessThanOrEqual(plan.price.providerCostUsd!);
    expect(repliesOf(three).planned_rows).toBeLessThan(repliesOf(plan).planned_rows);
    expect(three.price.reservePoints).toBeLessThanOrEqual(plan.price.reservePoints);
  });

  it("refuses a number outside 1 to 50, a fraction, and an edit on a plan with no replies", async () => {
    const plan = await g4Plan();
    for (const bad of [0, 51, 2.5, -1, 1000]) expect(applyPlanEdits(plan, { stages: [{ key: "comments", replies_per_comment: bad }] }).ok, String(bad)).toBe(false);
    const off = must(applyPlanEdits(plan, { stages: [{ key: "comments", replies: false }] }));
    expect(applyPlanEdits(off, { stages: [{ key: "comments", replies_per_comment: 5 }] }).ok).toBe(false);
    // the replies stage is code's: its own number is not edited on it
    expect(applyPlanEdits(plan, { stages: [{ key: "comments_replies", replies_per_comment: 5 }] }).ok).toBe(false);
  });

  it("the replies follow the comments' number AND the number per comment: 5 videos x 2 comments x 10 = 100", async () => {
    const plan = await g4Plan();
    const edited = must(applyPlanEdits(plan, { stages: [{ key: "comments", per_parent: 2 }] }));
    expect(repliesOf(edited).planned_rows).toBe(100);
    const both = must(applyPlanEdits(edited, { stages: [{ key: "comments", replies_per_comment: 20 }] }));
    expect(repliesOf(both).planned_rows).toBe(200);
  });

  it("the editor shows the number (default 10, maximum 50) and sends only a change", async () => {
    const plan = await g4Plan();
    const view = planEditorView(plan);
    const c = view.stages.find((s) => s.key === "comments")!;
    expect(c.replies).toMatchObject({ on: true, per_comment: 10, per_comment_max: 50 });
    const state = initialState(view);
    expect(editsFromState(view, state)).toEqual({});
    const next = { ...state, repliesPer: { ...state.repliesPer, comments: "٢٥" } };
    expect(editsFromState(view, next)).toEqual({ stages: [{ key: "comments", replies_per_comment: 25 }] });
  });

  it("the card says the number per comment from the plan (10 by default, the edited one after an edit), never a fixed fifty", async () => {
    const plan = await g4Plan();
    expect(repliesLinesAr(plan).join(" ")).toContain("حتى ١٠ ردود");
    const thirty = must(applyPlanEdits(plan, { stages: [{ key: "comments", replies_per_comment: 30 }] }));
    expect(repliesLinesAr(thirty).join(" ")).toContain("حتى ٣٠ ردًا");
    expect(repliesLinesAr(plan).join(" ")).not.toContain("حتى ٥٠");
  });
});
