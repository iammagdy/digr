import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { isRepliesStage, plannedRepliesFor, withRepliesStages } from "../src/lib/agentMission/replies";
import { withCompleteCount, type Candidate } from "../src/lib/agentMission/completeCount";
import { DEFAULT_MISSION_PRICING_SETTINGS } from "../src/lib/missionPricing";

/**
 * S2 ITEM 2 (docs/S1-LIVE-FINDINGS.md, L0.4 and L2). Live msn_48f6c7c80eb7068f2a38: the model planned 800 comments, the replies stage was priced on that number (800 x 0.35 replies per comment, the sample's mean = 280), the complete-count step cut the comments
 * to 40 and never derived the replies again, so the card promised 280 replies for 40 comments. The replies promise is derived from the FINAL comments count and nothing the sample does not support.
 * CHANGED (S5, owner decision): the first version pinned «the sample's mean replies per comment x the final comments, ON TOP of the counters». A video's counter counts comments AND replies together, so comments + replies = the counters (the sample only splits the total); the tests below pin that.
 */
const catalog = loadTregCatalog();
// the live sample: 20 comments, 5 of them with replies (1, 2, 1, 1, 2 = 7 replies in all: 0.35 a comment)
const SAMPLE = [0, 0, 1, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0].map((n, i) => ({ id: `s${i}`, text: `تعليق ${i}`, replies_count: n }));
const SPEC = { endpoint_id: "crawl4ai.tiktok.video.comments", params: { limit: 20 }, cursor_param: null, map_code: "return []", map_file_id: "call_0003", parent_binding: { param: "post", from: "id" }, built_by: "code" };
const stage = (o: Partial<PricedStage> & Pick<PricedStage, "key" | "title_ar" | "endpoint_id" | "parent_key" | "planned_rows">): PricedStage => ({ expected_rows: o.planned_rows, deliver: true, columns: [], sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0.0002, measured_from_calls: [], ...o });

async function modelPlan(commentsRows: number): Promise<PricedPlan> {
  const stages: PricedStage[] = [
    stage({ key: "videos", title_ar: "فيديوهات تيك توك", endpoint_id: "tikhub.tiktok.search.videos", parent_key: null, planned_rows: 2, columns: [{ key: "link", title_ar: "رابط الفيديو" }, { key: "comments_count", title_ar: "عدد التعليقات" }], engine: { ...SPEC, endpoint_id: "tikhub.tiktok.search.videos", params: {}, parent_binding: null } as never }),
    stage({ key: "comments", title_ar: "تعليقات الفيديوهات", endpoint_id: "crawl4ai.tiktok.video.comments", parent_key: "videos", planned_rows: commentsRows, per_parent_rows: 400, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "replies_count", title_ar: "عدد الردود" }], engine: SPEC as never }),
  ];
  const plan: PricedPlan = { summary_ar: "ستحصل على فيديوهات وتعليقاتها.", stages, price: priceMissionByCode(stagePriceInputs(stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) };
  return withRepliesStages(plan, { catalog, isAllowed: () => true, sampleRowsOf: async () => SAMPLE });
}
const counters = (v1: number, v2: number): Candidate[] => [{ id: "v1", counter: v1 }, { id: "v2", counter: v2 }];
const finalPlan = (cands: Candidate[], pageCap: number | null, request = "كل التعليقات والردود") => modelPlan(800).then((p) => withCompleteCount(p, { request, candidatesOf: async () => cands, pageCapOf: async () => pageCap }));
const repliesOf = (p: PricedPlan) => p.stages.find(isRepliesStage)!;

describe("the replies promise follows the FINAL comments count", () => {
  it("the live case: replies were priced on 800 comments (280); the counters (168 + 20, one call gives 20 each: 40 in all) fix the total: comments + replies = 40, the replies a share of it", async () => {
    const before = await modelPlan(800);
    expect(repliesOf(before).planned_rows).toBe(280);
    const after = await finalPlan(counters(168, 20), 20);
    const c = after.stages.find((s) => s.key === "comments")!.planned_rows;
    expect(c + repliesOf(after).planned_rows).toBe(40);
    // the sample's mean (0.35 a comment) splits the total: replies are 0.35 / 1.35 of it
    expect(repliesOf(after).planned_rows).toBe(Math.round(40 * (0.35 / 1.35)));
    expect(repliesOf(after).expected_rows).toBe(repliesOf(after).planned_rows);
  });
  it("with no cap per call the total is the real counters, 188, split by the sample's measured share, never above it", async () => {
    const after = await finalPlan(counters(168, 20), null);
    const comments = after.stages.find((s) => s.key === "comments")!.planned_rows;
    expect(comments + repliesOf(after).planned_rows).toBe(188);
    expect(repliesOf(after).planned_rows).toBe(Math.round(188 * (0.35 / 1.35)));
  });
  it("the price follows the promise: the card's rows are the videos and the counters (2 + 40), and the approval re-prices the same plan to the same number", async () => {
    const after = await finalPlan(counters(168, 20), 20);
    expect(after.price.deliveredRows).toBe(2 + 40);
    const again = priceMissionByCode(stagePriceInputs(after.stages, after.contact_steps), { settings: after.price.settings });
    expect(again.reservePoints).toBe(after.price.reservePoints);
    expect(again.maxChargePoints).toBe(after.price.maxChargePoints);
    // the replies' own cost per row follows their count (calls over rows), so a smaller promise is not priced as a big one
    const r = repliesOf(after);
    const comments = after.stages.find((s) => s.key === "comments")!.planned_rows;
    expect(r.measured_cost_per_row_usd).toBeCloseTo((0.0009 * comments * 0.25) / r.planned_rows, 8);
  });
  it("a numbered request (the customer asked for 30, not «all») is derived the same way: the comments stay 30, the replies never above what is left of the counters", async () => {
    const after = await modelPlan(30).then((p) => withCompleteCount(p, { request: "٣٠ تعليق على فيديوهين مع ردودها", candidatesOf: async () => counters(168, 20), pageCapOf: async () => null }));
    const comments = after.stages.find((s) => s.key === "comments")!.planned_rows;
    expect(comments).toBe(30);
    expect(comments + repliesOf(after).planned_rows).toBeLessThanOrEqual(168 + 20);
  });
  it("replies are never promised for a sample that shows none: no replies stage at all", async () => {
    const stages = (await modelPlan(800)).stages.filter((s) => !isRepliesStage(s));
    const plan: PricedPlan = { summary_ar: "x", stages, price: priceMissionByCode(stagePriceInputs(stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) };
    const quiet = await withRepliesStages(plan, { catalog, isAllowed: () => true, sampleRowsOf: async () => SAMPLE.map((r) => ({ ...r, replies_count: 0 })) });
    expect(quiet.stages.some(isRepliesStage)).toBe(false);
  });
});
