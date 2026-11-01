import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { customerPlanView, stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { isRepliesStage, withRepliesStages } from "../src/lib/agentMission/replies";
import { repliesLinesAr } from "../src/lib/agentMission/repliesCard";
import { DEFAULT_MISSION_PRICING_SETTINGS } from "../src/lib/missionPricing";

/**
 * GOLDEN RUN ROUND 2, G4 (msn_32fc60fb7bab0c8c7869, TikTok, 2026-11-01 15:38 UTC). The customer edited the comments per video from 10 to 2 in the plan editor; the plan was priced again (rows 2555 -> 770 -> 515) but the stored stage was still titled
 * «أعلى ١٠ تعليقات على كل فيديو» and its replies stage «ردود أعلى ١٠ تعليقات على كل فيديو» (the title is the sheet's name and the stage's line on the card), and the headline said «أول ١٠ تعليقات». `planEdit.ts` moved the count only in the
 * summary/how/assumptions sentences by digits and left the titles; with 5 videos x 2 comments the planned rows were 10 too, so the «stale» check found 10 among the plan's own numbers and kept the sentence.
 * Every text derived from a count follows the edit: titles, the replies stage's title (it is built from the comments' title), the headline, the explanation lines, the card.
 */
const catalog = loadTregCatalog();
const SPEC = { endpoint_id: "crawl4ai.tiktok.video.comments", params: { count: 10 }, cursor_param: "cursor", map_code: "return []", map_file_id: "call_0002", parent_binding: { param: "aweme_id", from: "id" } };
const stage = (o: Partial<PricedStage> & Pick<PricedStage, "key" | "title_ar" | "endpoint_id" | "parent_key" | "planned_rows">): PricedStage => ({ expected_rows: o.planned_rows, deliver: true, columns: [], sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0.0002, measured_from_calls: [], ...o });
const COLUMNS = [{ key: "text", title_ar: "النص" }, { key: "author", title_ar: "الكاتب" }, { key: "posted_at", title_ar: "التاريخ" }, { key: "likes", title_ar: "الإعجابات" }, { key: "replies_count", title_ar: "عدد الردود" }];
/** The ten sampled comments of the live video: every one has more than fifty replies (the plan estimated 2,500 replies). */
const SAMPLE = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, text: "x", replies_count: 60 + i }));

async function g4Plan(): Promise<PricedPlan> {
  const stages: PricedStage[] = [
    stage({ key: "videos", title_ar: "فيديوهات تيك توك عن منتخب مصر", endpoint_id: "anyapi.tiktok.search.videos", parent_key: null, planned_rows: 5, columns: [{ key: "link", title_ar: "الرابط" }, { key: "caption", title_ar: "الوصف" }, { key: "comments_count", title_ar: "عدد التعليقات" }] }),
    stage({ key: "comments", title_ar: "أعلى ١٠ تعليقات على كل فيديو", endpoint_id: "crawl4ai.tiktok.video.comments", parent_key: "videos", planned_rows: 50, per_parent_rows: 10, columns: COLUMNS, engine: SPEC as never }),
  ];
  const base: PricedPlan = { summary_ar: "٥ فيديوهات تيك توك عن منتخب مصر، ومع كل فيديو أول ١٠ تعليقات عليه.", assumptions_ar: ["اعتمدنا ١٠ لكل فيديو."], stages, quantity: { requested: 50, stage_key: "comments", target: 50, source: "request" }, price: priceMissionByCode(stagePriceInputs(stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) } as PricedPlan;
  return withRepliesStages(base, { catalog, isAllowed: () => true, sampleRowsOf: async () => SAMPLE });
}

describe("G4: the comments per video edited 10 -> 2", () => {
  it("the stage title, the replies stage's title and the headline say two, not ten", async () => {
    const plan = await g4Plan();
    expect(plan.stages.find((s) => s.key === "comments")!.title_ar).toBe("أعلى ١٠ تعليقات على كل فيديو");
    const r = applyPlanEdits(plan, { stages: [{ key: "comments", per_parent: 2 }] });
    if (!r.ok) throw new Error(r.errorAr);
    const comments = r.plan.stages.find((s) => s.key === "comments")!;
    const replies = r.plan.stages.find(isRepliesStage)!;
    expect(comments.per_parent_rows).toBe(2);
    expect(comments.title_ar).toBe("أعلى تعليقين على كل فيديو");
    expect(replies.title_ar).toBe("ردود أعلى تعليقين على كل فيديو");
    expect(r.plan.summary_ar).toContain("أول تعليقين");
    expect(r.plan.summary_ar).not.toContain("١٠");
    // nothing the customer reads still carries the old number
    const view = customerPlanView(r.plan);
    const text = JSON.stringify([view, repliesLinesAr(r.plan)]);
    expect(text).not.toContain("١٠ تعليقات");
  });

  it("a number that is not the comments' (the replies' own, the videos') is never rewritten", async () => {
    const plan = await g4Plan();
    const r = applyPlanEdits(plan, { stages: [{ key: "comments", per_parent: 3 }] });
    if (!r.ok) throw new Error(r.errorAr);
    expect(r.plan.stages.find((s) => s.key === "comments")!.title_ar).toBe("أعلى ٣ تعليقات على كل فيديو");
    expect(r.plan.stages.find((s) => s.key === "videos")!.title_ar).toBe("فيديوهات تيك توك عن منتخب مصر");
    expect(r.plan.summary_ar).toContain("٥ فيديوهات");
    expect(r.plan.summary_ar).toContain("أول ٣ تعليقات");
  });

  it("one comment per video reads «تعليق واحد», and eleven or more «١١ تعليقًا»", async () => {
    const plan = await g4Plan();
    const one = applyPlanEdits(plan, { stages: [{ key: "comments", per_parent: 1 }] });
    const many = applyPlanEdits(plan, { stages: [{ key: "comments", per_parent: 12 }] });
    if (!one.ok || !many.ok) throw new Error("edit refused");
    expect(one.plan.stages.find((s) => s.key === "comments")!.title_ar).toBe("أعلى تعليق واحد على كل فيديو");
    expect(many.plan.stages.find((s) => s.key === "comments")!.title_ar).toBe("أعلى ١٢ تعليقًا على كل فيديو");
  });
});

describe("the total count edited: a title that carries the count follows it", () => {
  it("«٥٠ تغريدة عن الذكاء الاصطناعي» 50 -> 20", () => {
    const stages: PricedStage[] = [stage({ key: "tweets", title_ar: "٥٠ تغريدة عن الذكاء الاصطناعي في مصر", endpoint_id: "anyapi.x.search.tweets", parent_key: null, planned_rows: 50, columns: [{ key: "text", title_ar: "النص" }] })];
    const plan = { summary_ar: "تجمع لك ٥٠ تغريدة عن الذكاء الاصطناعي.", stages, quantity: { requested: 50, stage_key: "tweets", target: 50, source: "request" }, price: priceMissionByCode(stagePriceInputs(stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) } as PricedPlan;
    const r = applyPlanEdits(plan, { count: 20 });
    if (!r.ok) throw new Error(r.errorAr);
    expect(r.plan.stages[0].title_ar).toBe("٢٠ تغريدة عن الذكاء الاصطناعي في مصر");
    expect(r.plan.summary_ar).toContain("٢٠ تغريدة");
  });
});
