import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { customerPlanView, type PricedPlan } from "../src/lib/agentMission/plan";
import { promisedRowsOf } from "../src/lib/agentMission/promisedTotal";
import { reportedPlan, withPromiseCaps, withRepliesJudged } from "../src/lib/agentMission/repliesCard";

/**
 * ROUND 14, item 3: ONE PROMISED NUMBER, BEFORE AND AFTER APPROVAL (live Facebook msn_236f4af6fe4cb890abee, from SELECTs on `missions`).
 * The plan card said «المجموع في ملفك: ٥٣٧»; the file, the chat and the orders page said «٤٦٤ من ٦٢٠». Row by row:
 *   BEFORE (the card): 3 posts (exact) + 517 comments (the posts' own counters) + 17 replies (the reply counters of the 15 comments the planning read: `counted`) = 537. The other 569 replies (586 - 17) of the comments not read yet were only the ESTIMATE the hold is made from.
 *   AFTER (round 11's rule): the replies stage was judged against the reply counters of the 366 delivered comments, which add up to 100, and written back into the public plan: 3 + 517 + 100 = 620. Delivered: 3 + 366 + 95 = 464.
 * The promise of a compiled Facebook plan's replies is now the number the card showed at approval, so 3 + 517 + 17 = 537 on every surface; the 95 replies delivered against the counters' 100 are told in the limits lines, never as a new promise.
 */
const col = (key: string, title_ar: string) => ({ key, title_ar });
const stage = (o: Record<string, unknown>) => ({ endpoint_id: "e", parent_key: null, deliver: true, sample_rows: [], measured_by: [], columns: [col("text", "نص"), col("posted_at", "تاريخ ووقت التعليق")], ...o });
const plan = (): PricedPlan => ({
  summary_ar: "٣ منشور من فيسبوك عن «الذكاء الاصطناعي»، مع كل تعليقاتها وردودها.",
  stages: [
    stage({ key: "posts", title_ar: "المنشورات", expected_rows: 3, planned_rows: 3 }),
    stage({ key: "comments", title_ar: "التعليقات", expected_rows: 517, planned_rows: 517, parent_key: "posts", per_parent_rows: 173 }),
    // CHANGED (round 14, found by the delivery contract's replay): the compiler writes `expected_rows` = `planned_rows` = 586 for open replies (the estimate the hold is made from); the first version of this fixture said 17 and so never had the real shape, and the first fix (read `expected_rows`) gave 1,106 on a real plan
    stage({ key: "comments_replies", title_ar: "الردود", expected_rows: 586, planned_rows: 586, parent_key: "comments", replies_of: "comments", replies_open: true, replies_uncapped: true, per_parent_rows: 50 }),
  ],
  price: { deliveredRows: 1106, reservePoints: 5749, unitPricePoints: 4.519873, maxChargePoints: 4999, minChargePoints: 200 },
  compiled: { by: "compiler", platform: "facebook", promises: { posts: { type: "exact", n: 3 }, comments: { type: "counter", n: 517, counter: 517 }, comments_replies: { type: "open", n: 586, counted: 17, counted_comments: 15 } } },
} as unknown as PricedPlan);
// the live delivery: 3 posts, 366 comments whose reply counters add up to 100, 95 replies
const posts = [0, 1, 2].map((i) => ({ id: `p${i}`, text: `منشور ${i}`, posted_at: "2026-10-20T10:00:00Z" }));
const comments = Array.from({ length: 366 }, (_, i) => ({ id: `c${i}`, parent_id: `p${i % 3}`, text: `تعليق ${i}`, posted_at: "2026-10-21T10:00:00Z", replies_count: i < 100 ? 1 : 0 }));
const replies = Array.from({ length: 95 }, (_, i) => ({ id: `r${i}`, parent_id: `c${i}`, text: `رد ${i}`, posted_at: "2026-10-22T10:00:00Z" }));
const rowsByStage = { posts, comments, comments_replies: replies };

describe("the card before approval and every surface after the run say the same number", () => {
  const before = customerMissionView({ mission: { id: "m", status: "plan_ready", question_ar: null, plan_public: customerPlanView(plan()), reserved_points: 5749, unit_price_points: 4.519873, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-11-03T15:39:39Z" } as never, events: [] });
  const judged = withRepliesJudged(reportedPlan(withPromiseCaps(plan()), { posts: 3, comments: 366, comments_replies: 95 }), rowsByStage, () => true);
  it("before approval: 3 + 517 + 17 = 537", () => {
    expect(before.totalRows).toBe(537);
  });
  it("after the run the public plan still says 537 (the orders page promised number), and the replies stage is not re-promised", () => {
    const publicPlan = customerPlanView(judged);
    expect(promisedRowsOf(publicPlan.stages as never, 0, true)).toBe(537);
    expect(judged.stages.find((s) => s.key === "comments_replies")!.expected_rows).toBe(17);
  });
  it("the chat's result line and the file's first sheet both say «٤٦٤ من ٥٣٧» (not «من ٦٢٠»)", async () => {
    const mission = { id: "m", status: "completed", question_ar: null, plan_public: customerPlanView(judged), reserved_points: 5749, unit_price_points: 4.519873, delivered_units: 464, charged_points: 2098, summary_ar: null, files: [{ name: "result.xlsx", kind: "xlsx" }], created_at: "2026-11-03T15:39:39Z" };
    const site = customerMissionView({ mission: mission as never, events: [] }).resultLinesAr.find((l) => /^تم تسليم/.test(l))!;
    expect(site).toBe("تم تسليم ٤٦٤ من ٥٣٧ عنصرًا.");
    const built = await buildMissionFiles(judged, rowsByStage, undefined, undefined, { repliesJudged: true });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.xlsx as never);
    const texts: string[] = [];
    wb.eachSheet((ws) => ws.eachRow((r) => r.eachCell((c) => { if (typeof c.value === "string") texts.push(c.value); })));
    expect(texts.find((t) => /^تم تسليم/.test(t))).toBe(site);
  });
});

describe("every compiled platform keeps the card's number (round 14: the delivery contract found TikTok at 369 on the card against 406 in the file, on its stored pages)", () => {
  it("platform tiktok, x, instagram: the replies promise is the number the planning counted, never the counters of the delivered comments", () => {
    for (const platform of ["tiktok", "x", "instagram", "youtube"]) {
      const p = plan();
      (p.compiled as { platform: string }).platform = platform;
      const j = withRepliesJudged(reportedPlan(withPromiseCaps(p), { posts: 3, comments: 366, comments_replies: 95 }), rowsByStage, () => true);
      expect(j.stages.find((s) => s.key === "comments_replies")!.expected_rows, platform).toBe(17);
    }
  });
  it("replies that promised no number (no `counted`) are not in the promise: the card's total does not count them either", () => {
    const p = plan();
    delete (p.compiled!.promises.comments_replies as { counted?: number }).counted;
    const j = withRepliesJudged(reportedPlan(withPromiseCaps(p), { posts: 3, comments: 366, comments_replies: 95 }), rowsByStage, () => true);
    expect(j.stages.find((s) => s.key === "comments_replies")!.expected_rows).toBe(0);
  });
});
