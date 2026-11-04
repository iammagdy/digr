import { describe, expect, it } from "vitest";
import { threadCounterLinesOfPlan } from "../agent/src/threadCounters";
import { alternativesGapLineAr, checkDeliveryContract, type ContractInput } from "../src/lib/agentMission/foundation/deliveryContract";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import { NO_ABOUT_OPTIONS_AR } from "../src/lib/agentMission/foundation/topicChoice";
import { runProductionPlanning } from "./helpers/productionPlanning";

/**
 * ROUND 19, ITEM 3 (smoke of 4 Nov 2026, Facebook msn_934781c56a01a96825af: «هات منشورين من صفحة قناة العربية ... مع ١٠ تعليقات من كل منشور», post counters 9 and 6).
 * The card promised ٢٢ (2 posts + 10 + 10) and «حدود هذا التسليم» held TWO lines for each post («طلبت ١٠ تعليقات وسُلّم ٤» and «المتوقع ٩ تعليقًا، وسُلّم ٤ ... جرّبنا المسار الرئيسي ومسارًا بديلًا»).
 * The rule now: the promise of a comments stage with a number per parent is the sum over the chosen parents of min(the number asked, the parent's own counter): 2 + 9 + 6 = 17; and ONE line per parent says the asked number or the counter, what was delivered, the gap and the routes tried, in one sentence.
 * SYNTHETIC counters on the stored real TikTok pages (the planning code is the same for the five platforms): the two chosen videos get the counters 9 and 6 (the live post counters).
 */
const REQUEST = "هات ٢ فيديو تيك توك من مصر بالعربي عن الذكاء الاصطناعي، مع ١٠ تعليقات من كل فيديو";
const M12 = "msn_5851abc92a1e6645a9cd";
const base = { fixture: M12, request: REQUEST, answer: NO_ABOUT_OPTIONS_AR.useAsIs, createdAt: "2026-11-04T07:00:25Z", platform: "tiktok" as const };

describe("the promise of a comments stage with a number per parent is min(asked, the parent's counter), summed", () => {
  it("counters 9 and 6 with ١٠ asked per video: the comments stage plans 15, the card 17 in all (not 22)", async () => {
    // the two videos the compiler chooses on the stored pages, then the same pages with their counters set to 9 and 6 (the others lower)
    const first = await runProductionPlanning(base);
    expect(first.plan).not.toBeNull();
    const ids = (first.plan!.stages[0].pinned_rows ?? []).map((r) => String(r.id));
    expect(ids).toHaveLength(2);
    const counters = new Map<string, number>([[ids[0], 9], [ids[1], 6]]);
    const set = (_endpoint: string, page: unknown): unknown => {
      const list = (page as { data?: { search_item_list?: Array<{ aweme_info: { aweme_id: string; statistics: { comment_count: number } } }> } }).data?.search_item_list;
      for (const it of list ?? []) it.aweme_info.statistics.comment_count = counters.get(String(it.aweme_info.aweme_id)) ?? 1;
      return page;
    };
    const r = await runProductionPlanning({ ...base, transformPlanningPage: set });
    expect(r.status).toBe("plan_ready");
    const plan = r.plan!;
    expect((plan.stages[0].pinned_rows ?? []).map((x) => String(x.id)).sort()).toEqual([...ids].sort());
    const comments = plan.stages.find((s) => s.key === "comments")!;
    expect(comments.per_parent_rows).toBe(10);
    expect(comments.planned_rows).toBe(15);
    expect(plan.compiled?.promises?.comments).toMatchObject({ type: "counter", n: 15 });
    expect(plan.price.deliveredRows).toBe(17);
    expect(plan.summary_ar + (plan.notes_ar ?? []).join(" ")).not.toMatch(/٢٢/);
  });
  it("counters above the number asked change nothing: ١٠ per video stays 20, 22 in all (the TikTok smoke's plan)", async () => {
    const r = await runProductionPlanning(base);
    const comments = r.plan!.stages.find((s) => s.key === "comments")!;
    expect(comments.planned_rows).toBe(20);
    expect(r.plan!.price.deliveredRows).toBe(22);
  });
});

const col = (key: string, title_ar: string) => ({ key, title_ar });
const stage = (o: Record<string, unknown>): PricedStage => ({ endpoint_id: "e", parent_key: null, deliver: true, sample_rows: [], measured_by: [], columns: [col("text", "نص")], ...o }) as unknown as PricedStage;
const posts = stage({ key: "posts", title_ar: "المنشورات", expected_rows: 2, planned_rows: 2 });
const comments = (planned: number) => stage({ key: "comments", title_ar: "التعليقات", expected_rows: planned, planned_rows: planned, parent_key: "posts", per_parent_rows: 10 });
const planOf = (planned: number) => ({ summary_ar: "x", stages: [posts, comments(planned)], price: { deliveredRows: 2 + planned }, compiled: { by: "compiler", platform: "facebook", promises: {}, conditions: { named: false, period: false, language: false, country: false, topic: false } } }) as unknown as PricedPlan;
const rowsByStage = { posts: [{ id: "p0", comments: 9 }, { id: "p1", comments: 6 }], comments: [...Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, parent_id: "p0" })), ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, parent_id: "p1" }))] };
const nounOf = (t: string | undefined) => (t === "المنشورات" ? "منشور" : t === "التعليقات" ? "تعليق" : null);

describe("ONE gap line per parent (asked or counter, delivered, the gap, the routes tried)", () => {
  const heads = ["المنشور رقم ١:", "المنشور رقم ٢:"];
  it("two parents short after an alternative route was tried: exactly one line each, with the expected count, the delivered, the gap and the routes", () => {
    const { limitLines } = threadCounterLinesOfPlan(planOf(15), rowsByStage, nounOf, {}, { comments: { p0: 1, p1: 1 } });
    for (const [i, head] of heads.entries()) {
      const mine = limitLines.filter((l) => l.startsWith(head));
      expect(mine).toHaveLength(1);
      const expected = i === 0 ? "٩" : "٦";
      expect(mine[0]).toContain(`المتوقع ${expected}`);
      expect(mine[0]).toContain("وسُلّم ٤");
      expect(mine[0]).toContain(`والفرق ${i === 0 ? "٥" : "٢"}`);
      expect(mine[0]).toContain("المسار الرئيسي");
      expect(mine[0]).toContain("مسارًا بديلًا واحدًا");
      expect(mine[0]).not.toContain("طلبت");
    }
  });
  it("with no alternative tried it is still one line per parent, built from the asked number or the counter (the smaller)", () => {
    const { limitLines } = threadCounterLinesOfPlan(planOf(15), rowsByStage, nounOf, {}, {});
    for (const head of heads) expect(limitLines.filter((l) => l.startsWith(head))).toHaveLength(1);
    expect(limitLines.find((l) => l.startsWith(heads[0]))).toContain("٩");
  });
  it("a parent whose counter is above the number asked says the number asked (طلبت), once", () => {
    const rows = { ...rowsByStage, posts: [{ id: "p0", comments: 50 }, { id: "p1", comments: 6 }] };
    const { limitLines } = threadCounterLinesOfPlan(planOf(16), rows, nounOf, {}, {});
    const mine = limitLines.filter((l) => l.startsWith(heads[0]));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain("طلبت");
    expect(mine[0]).toContain("١٠");
  });
});

describe("delivery contract: R1/R2 catch two lines for one parent and a promise above the counters", () => {
  const input = (planned: number, limitLines: string[], routes?: ContractInput["routes"]): ContractInput => ({ plan: planOf(planned), rowsByStage, sheets: [], limitLines, ...(routes ? { routes } : {}), numbers: { card: null, file: null, chat: null, notice: null, orders: null, fileDelivered: null, deliveredRows: 10 }, now: Date.UTC(2026, 10, 4) });
  const one = [alternativesGapLineAr({ parentNoun: "منشور", n: 1, expected: 9, delivered: 4, alternatives: 1 }), alternativesGapLineAr({ parentNoun: "منشور", n: 2, expected: 6, delivered: 4, alternatives: 1 })];
  const routes = { comments: { p0: 1, p1: 1 } };
  it("one line per parent and a promise equal to the counters: no violation", () => {
    expect(checkDeliveryContract(input(15, one, routes)).filter((v) => v.rule === "R1" || (v.rule === "R2" && v.rowId !== null))).toEqual([]);
  });
  it("two lines for one parent is an R2 violation", () => {
    const v = checkDeliveryContract(input(15, [...one, "المنشور رقم ١: طلبت ١٠ تعليقات وسُلّم ٤؛ والفرق لم يعطِه المصدر"], routes)).filter((x) => x.rule === "R2");
    expect(v.length).toBeGreaterThan(0);
    expect(v.some((x) => /سطر واحد/.test(x.expected))).toBe(true);
  });
  it("a promise above the sum of min(asked, counter) is an R1 violation (the smoke: 20 promised, 15 possible)", () => {
    const v = checkDeliveryContract(input(20, one, routes)).filter((x) => x.rule === "R1");
    expect(v).toHaveLength(1);
    expect(v[0].expected).toContain("١٥");
    expect(v[0].found).toContain("٢٠");
  });
});

describe("a counter that counts comments only is not made whole by replies (the Instagram replay of round 19)", () => {
  // all the comments and the replies: no number per parent, so the stage's own counter line is the gap line
  const allComments = stage({ key: "comments", title_ar: "التعليقات", expected_rows: 9, planned_rows: 9, parent_key: "posts" });
  const replies = stage({ key: "comments_replies", title_ar: "الردود", expected_rows: 3, planned_rows: 3, parent_key: "comments", replies_of: "comments" });
  const planFor = (platform: string) => ({ summary_ar: "x", stages: [stage({ key: "posts", title_ar: "المنشورات", expected_rows: 1, planned_rows: 1 }), allComments, replies], price: { deliveredRows: 13 }, compiled: { by: "compiler", platform, promises: {}, conditions: { named: false, period: false, language: false, country: false, topic: false } } }) as unknown as PricedPlan;
  const rows = { posts: [{ id: "p0", comments: 9 }], comments: Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, parent_id: "p0", replies_count: i === 0 ? 1 : 0 })), comments_replies: [{ id: "r0", parent_id: "c0" }] };
  const nounOf2 = (t: string | undefined) => (t === "المنشورات" ? "منشور" : t === "التعليقات" ? "تعليق" : t === "الردود" ? "رد" : null);
  it("Instagram (the counter counts comments): 8 comments and 1 reply against a counter of 9 is a gap of one comment, said", () => {
    const { limitLines } = threadCounterLinesOfPlan(planFor("instagram"), rows, nounOf2, {}, {});
    expect(limitLines.filter((l) => l.startsWith("المنشور رقم ١:"))).toHaveLength(1);
  });
  it("TikTok (the counter counts comments and replies): the same numbers are complete, no gap line", () => {
    const { limitLines } = threadCounterLinesOfPlan(planFor("tiktok"), rows, nounOf2, {}, {});
    expect(limitLines.filter((l) => l.startsWith("المنشور رقم ١:"))).toHaveLength(0);
  });
});

describe("a gap line that says one or two in words is a line (the YouTube smoke: R2 added a second line to every video that delivered one)", () => {
  // msn_2cc97612deaf5e7f7d6d: ٥ comments asked per video, videos 2 and 5 gave 1: the stage's own line said «تعليق واحد» (a word, no digit) and R2 looked for «١», found none and ADDED a second line for the same video
  const plan = { summary_ar: "x", stages: [stage({ key: "videos", title_ar: "الفيديوهات", expected_rows: 2, planned_rows: 2 }), stage({ key: "comments", title_ar: "التعليقات", expected_rows: 10, planned_rows: 10, parent_key: "videos", per_parent_rows: 5 })], price: { deliveredRows: 12 } } as unknown as PricedPlan;
  const rows = { videos: [{ id: "v0", comments: 40 }, { id: "v1", comments: 40 }], comments: [...Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, parent_id: "v0" })), { id: "b0", parent_id: "v1" }] };
  const run = (limitLines: string[]) => checkDeliveryContract({ plan, rowsByStage: rows, sheets: [], limitLines, numbers: { card: null, file: null, chat: null, notice: null, orders: null, fileDelivered: null, deliveredRows: 8 }, now: Date.UTC(2026, 10, 4) }).filter((v) => v.rule === "R2" && v.rowId !== null);
  it("the line with the delivered number in words satisfies R2 (no completion, so no second line)", () => {
    expect(run(["الفيديو رقم ٢: طلبت ٥ تعليقات وسُلّم تعليق واحد؛ والفرق لم يعطِه المصدر"])).toEqual([]);
  });
  it("two comments delivered in words too", () => {
    const two = { ...rows, comments: [...Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, parent_id: "v0" })), { id: "b0", parent_id: "v1" }, { id: "b1", parent_id: "v1" }] };
    const v = checkDeliveryContract({ plan, rowsByStage: two, sheets: [], limitLines: ["الفيديو رقم ٢: طلبت ٥ تعليقات وسُلّم تعليقان؛ والفرق لم يعطِه المصدر"], numbers: { card: null, file: null, chat: null, notice: null, orders: null, fileDelivered: null, deliveredRows: 9 }, now: Date.UTC(2026, 10, 4) }).filter((x) => x.rule === "R2" && x.rowId !== null);
    expect(v).toEqual([]);
  });
  it("a line with a different number is still missing", () => {
    expect(run(["الفيديو رقم ٢: طلبت ٥ تعليقات وسُلّم ٣؛ والفرق لم يعطِه المصدر"]).length).toBe(1);
  });
});
