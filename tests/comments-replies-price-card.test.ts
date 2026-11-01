import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { customerPlanView, planEditorView, stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { isRepliesStage, withRepliesStages } from "../src/lib/agentMission/replies";
import { repliesLinesAr, topLevelFactsOf } from "../src/lib/agentMission/repliesCard";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { DEFAULT_MISSION_PRICING_SETTINGS } from "../src/lib/missionPricing";
import { editsFromState, initialState } from "../src/components/mission/PlanEditor";

/**
 * REPLIES, item 3: THE COUNT, THE PRICE AND THE CARD. The customer's number («١٠ تعليقات») counts the TOP-LEVEL comments only (decided by code); the replies are delivered in addition, priced by code, and the card says so in Arabic; the plan editor switches them off to lower the price.
 */
const catalog = loadTregCatalog();
const SPEC = { endpoint_id: "tikhub.tiktok.video.comments", params: { count: 10 }, cursor_param: "cursor", map_code: "return []", map_file_id: "call_0002", parent_binding: { param: "aweme_id", from: "id" } };
const stage = (o: Partial<PricedStage> & Pick<PricedStage, "key" | "title_ar" | "endpoint_id" | "parent_key" | "planned_rows">): PricedStage => ({ expected_rows: o.planned_rows, deliver: true, columns: [], sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0.0002, measured_from_calls: [], ...o });
const COLUMNS = [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "صاحب التعليق" }, { key: "posted_at", title_ar: "تاريخ ووقت التعليق" }, { key: "likes", title_ar: "الإعجابات" }, { key: "replies_count", title_ar: "عدد الردود" }];
const SAMPLE = [{ id: "a", text: "x", replies_count: 6 }, { id: "b", text: "y", replies_count: 0 }, { id: "c", text: "z", replies_count: 4 }, { id: "d", text: "w", replies_count: 2 }];

function basePlan(): PricedPlan {
  const stages: PricedStage[] = [
    stage({ key: "videos", title_ar: "الفيديوهات", endpoint_id: "anyapi.tiktok.search.videos", parent_key: null, planned_rows: 5, columns: [{ key: "link", title_ar: "رابط الفيديو" }, { key: "caption", title_ar: "وصف الفيديو" }, { key: "comments_count", title_ar: "عدد التعليقات" }] }),
    stage({ key: "comments", title_ar: "تعليقات كل فيديو", endpoint_id: "tikhub.tiktok.video.comments", parent_key: "videos", planned_rows: 50, per_parent_rows: 10, columns: COLUMNS, engine: SPEC as never }),
  ];
  return { summary_ar: "ستحصل على فيديوهات وتعليقاتها.", stages, quantity: { requested: 50, stage_key: "comments", target: 50, source: "request" }, price: priceMissionByCode(stagePriceInputs(stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) };
}
const withReplies = (plan: PricedPlan = basePlan(), sample: Array<Record<string, unknown>> = SAMPLE) => withRepliesStages(plan, { catalog, isAllowed: () => true, sampleRowsOf: async () => sample });

describe("the count: the customer's number is the top-level comments", () => {
  it("the replies stage sits under the comments and is marked; its planned rows follow the comments' own reply counters (mean of the sample, 3 a comment) over all the comments asked for", async () => {
    const plan = await withReplies();
    const replies = plan.stages.find(isRepliesStage)!;
    expect(replies).toMatchObject({ parent_key: "comments", replies_of: "comments", deliver: true });
    expect(replies.replies_per_comment_expected).toBe(3);
    expect(replies.planned_rows).toBe(150);
    // the comments stage still carries the customer's number
    expect(plan.stages.find((s) => s.key === "comments")!.planned_rows).toBe(50);
  });

  it("the facts of a delivery split the replies from the top-level rows: the target and the request exclude the replies, so fewer replies than estimated never make a delivery partial", async () => {
    const plan = await withReplies();
    const facts = topLevelFactsOf(plan, { videos: 5, comments: 50, comments_replies: 61 });
    expect(facts).toMatchObject({ repliesPlanned: 150, repliesDelivered: 61, topLevelPlanned: 55, topLevelDelivered: 55 });
    expect(topLevelFactsOf(plan, { videos: 5, comments: 20, comments_replies: 61 })).toMatchObject({ topLevelDelivered: 25, topLevelPlanned: 55 });
  });
});

describe("the price: by code, replies in addition", () => {
  it("the replies' provider cost is added and their rows are delivered rows, but a stage code adds costs the model no planning or execution estimate", async () => {
    const before = basePlan();
    const after = await withReplies(before);
    expect(after.price.deliveredRows).toBe(before.price.deliveredRows + 150);
    expect(after.price.providerCostUsd!).toBeGreaterThan(before.price.providerCostUsd!);
    // the model's estimate is the one of the two stages the planner planned: the replies stage adds none
    expect(after.price.modelCostUsd).toBe(before.price.modelCostUsd);
    // the stored plan prices the same again (the approval re-prices the stored plan and must get the same number)
    const again = priceMissionByCode(stagePriceInputs(after.stages, after.contact_steps), { settings: after.price.settings });
    expect(again.reservePoints).toBe(after.price.reservePoints);
    expect(again.unitPricePoints).toBe(after.price.unitPricePoints);
    expect(after.price.reservePoints).toBeGreaterThanOrEqual(before.price.reservePoints);
  });

  it("the hold never exceeds the job limit: replies are cut before the comments are, and dropped (with a reason) when nothing fits", async () => {
    const big = basePlan();
    const wide = { ...big, stages: big.stages.map((s) => (s.key === "comments" ? { ...s, planned_rows: 4900, expected_rows: 4900 } : s)) };
    const plan = await withReplies({ ...wide, price: priceMissionByCode(stagePriceInputs(wide.stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) });
    expect(plan.price.overCap).toBe(false);
    expect(plan.stages.find((s) => s.key === "comments")!.planned_rows).toBe(4900);
  });

  it("no source for the platform, or no sampled comment with a reply: no replies stage, and the status says why", async () => {
    const fb = basePlan();
    const facebook = { ...fb, stages: fb.stages.map((s) => (s.key === "comments" ? { ...s, endpoint_id: "scrapecreators.x.v1-facebook-post-comments" } : s)) };
    expect((await withReplies(facebook)).replies_status).toBe("no_source");
    const none = await withReplies(basePlan(), [{ id: "a", text: "x", replies_count: 0 }, { id: "b", text: "y", replies_count: 0 }]);
    expect(none.replies_status).toBe("none_found");
    expect(none.stages.some(isRepliesStage)).toBe(false);
    // the sampled comments carry no reply counter at all: nothing says which comment has replies, so none is bought blind
    const blind = await withReplies(basePlan(), [{ id: "a", text: "x" }, { id: "b", text: "y" }]);
    expect(blind.replies_status).toBe("no_counter");
    expect(blind.stages.some(isRepliesStage)).toBe(false);
    expect(blind.price.reservePoints).toBe(basePlan().price.reservePoints);
  });
});

describe("the card says it, in Arabic, from the plan", () => {
  it("states that the number counts the comments only and the replies come in addition and are priced, and where to switch them off", async () => {
    const plan = await withReplies();
    const lines = repliesLinesAr(plan);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("التعليقات الأساسية");
    expect(lines[0]).toContain("ردودها");
    expect(lines[0]).toContain("السعر");
    expect(lines[0]).toContain("عدّل الخطة");
    // Arabic only, Arabic-Indic digits, no provider, no money in dollars
    expect(checkCustomerText(lines[0], { maxChars: 600 }).issues).toEqual([]);
    expect(lines[0]).not.toMatch(/[0-9]/);
    expect(lines[0]).not.toMatch(/tikhub|anyapi|USD|\$/i);
    expect(customerPlanView(plan).notes_ar).toEqual(expect.arrayContaining([lines[0]]));
  });

  it("says honestly why a plan has no replies: no source, none found, no room, or switched off", () => {
    const stages = basePlan().stages;
    for (const status of ["no_source", "no_counter", "none_found", "no_room", "off"] as const) {
      const lines = repliesLinesAr({ stages, replies_status: status });
      expect(lines, status).toHaveLength(1);
      expect(lines[0]).toContain("التعليقات الأساسية");
      expect(checkCustomerText(lines[0], { maxChars: 600 }).issues, status).toEqual([]);
      expect(lines[0]).not.toMatch(/[0-9]/);
    }
    expect(repliesLinesAr({ stages: basePlan().stages })).toEqual([]);
  });
});

describe("the plan editor: replies on or off", () => {
  it("shows one switch on the comments stage (the replies stage has no columns, filters or per-parent number of its own)", async () => {
    const plan = await withReplies();
    const view = planEditorView(plan);
    const comments = view.stages.find((s) => s.key === "comments")!;
    expect(comments.replies).toMatchObject({ on: true });
    expect(comments.replies!.label_ar).toContain("الردود");
    const replies = view.stages.find((s) => s.key === "comments_replies")!;
    expect(replies.columns).toEqual([]);
    expect(replies.filters).toEqual([]);
    expect(replies.per_parent).toBeUndefined();
  });

  it("switching them off removes the stage, lowers the price to the plan without replies, says so, and switching them on restores the stage and the price", async () => {
    const plain = basePlan();
    const plan = await withReplies(plain);
    const off = applyPlanEdits(plan, { stages: [{ key: "comments", replies: false }] });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.plan.stages.some(isRepliesStage)).toBe(false);
    expect(off.plan.replies_status).toBe("off");
    expect(off.plan.price.reservePoints).toBe(plain.price.reservePoints);
    expect(off.plan.price.deliveredRows).toBe(plain.price.deliveredRows);
    expect(repliesLinesAr(off.plan)[0]).toContain("أوقفت");
    expect(planEditorView(off.plan).stages.find((s) => s.key === "comments")!.replies).toMatchObject({ on: false });
    const on = applyPlanEdits(off.plan, { stages: [{ key: "comments", replies: true }] });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.plan.stages.find(isRepliesStage)!.planned_rows).toBe(plan.stages.find(isRepliesStage)!.planned_rows);
    expect(on.plan.price.reservePoints).toBe(plan.price.reservePoints);
    expect(on.plan.replies_status).toBeUndefined();
  });

  it("a change of the comments' number moves the replies with it (the same expected replies per comment), and the plan is priced again", async () => {
    const plan = await withReplies();
    const edited = applyPlanEdits(plan, { count: 20 });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.plan.stages.find((s) => s.key === "comments")!.planned_rows).toBe(20);
    expect(edited.plan.stages.find(isRepliesStage)!.planned_rows).toBe(60);
    const again = priceMissionByCode(stagePriceInputs(edited.plan.stages, edited.plan.contact_steps), { settings: edited.plan.price.settings });
    expect(edited.plan.price.reservePoints).toBe(again.reservePoints);
  });

  it("the replies stage's own number per comment is not the customer's to set (the cap is code's)", async () => {
    const plan = await withReplies();
    const r = applyPlanEdits(plan, { stages: [{ key: "comments_replies", per_parent: 5 }] });
    expect(r.ok).toBe(false);
  });
});

describe("the editor's checkbox", () => {
  it("is on while the replies are in the plan, sends nothing when untouched, and sends {replies: false} for the comments stage when it is unticked", async () => {
    const plan = await withReplies();
    const view = planEditorView(plan);
    const state = initialState(view);
    expect(state.replies).toEqual({ comments: true });
    expect(editsFromState(view, state)).toEqual({});
    expect(editsFromState(view, { ...state, replies: { comments: false } })).toEqual({ stages: [{ key: "comments", replies: false }] });
  });
});
