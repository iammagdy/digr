import { describe, expect, it } from "vitest";
import type { MemoryStore } from "../agent/src/memoryStore";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { runS4 } from "./helpers/s4World";
import { vid } from "./helpers/g4RepliesWorld";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { isRepliesStage, withRepliesStages } from "../src/lib/agentMission/replies";
import { withCompleteCount } from "../src/lib/agentMission/completeCount";
import { DEFAULT_MISSION_PRICING_SETTINGS } from "../src/lib/missionPricing";

/**
 * S5, the live test of 2026-11-02 11:33 Cairo (docs/S1-LIVE-FINDINGS.md, S5): the videos' counters were 5 and 1 (6 in all), the plan promised 308 (300 replies estimated on top), 5 were delivered and the customer read «تم تسليم ٥ عناصر من ٣٠٨»; the price followed the promise.
 * OWNER DECISIONS: (1) a video's comment counter counts comments AND replies together: the promise for comments + replies on a video is its counter, never more, and never a reply estimate on top; for comments only, never more than the counter; the price follows the promise.
 * (2) the default choice of videos for a comments request is the MOST ENGAGED (the highest comment counters), unless the customer asks for the newest or gives a date: the search tool's sort field when it has one, else the highest counters among the results (an order, never a filter).
 */
const run = () => runS4({ sortAware: true });
const resultOf = (r: Awaited<ReturnType<typeof run>>) => (r.store as MemoryStore).events.find((e) => e.kind === "result")!.counts as Record<string, number>;
const callsOf = (r: Awaited<ReturnType<typeof run>>) => (r.call.mock.calls as Array<[{ endpointId: string; params: Record<string, unknown> }]>).map((c) => c[0]);

describe("2. the default choice of videos for a comments request is the most engaged", () => {
  it("the planner sampled the newest (counters 5 and 1): the plan is refused and the search is sampled with its most-liked sort; the stage's request carries it", async () => {
    const r = await run();
    const proposals = r.planningDriver.results.filter((x) => x.tool === "propose_plan");
    expect(proposals[0].result.ok).toBe(false);
    expect(JSON.stringify(proposals[0].result)).toContain("sort_type");
    expect(proposals[1].result.ok).toBe(true);
    expect(r.plannedPlan.stages[0].engine!.params.sort_type).toBe(1);
    expect(callsOf(r).some((c) => c.endpointId === "tikhub.tiktok.search.videos" && c.params.sort_type === 1)).toBe(true);
  });
  it("the chosen videos are the two highest-commented results of Egypt about the topic (counters 66 and 33), never the newest ones", async () => {
    const r = await run();
    expect(r.plannedPlan.stages.find((s) => s.key === "comments")!.parent_pins).toEqual([vid(0), vid(1)]);
    expect(r.plannedPlan.stages[0].engine!.params.region).toBe("EG");
  });
  it("by order only: with several results the highest counters are taken whatever their position; without the default (the customer asked for the newest) the source's order stands", async () => {
    const catalog = loadTregCatalog();
    const stage = (o: Partial<PricedStage> & Pick<PricedStage, "key" | "title_ar" | "endpoint_id" | "parent_key" | "planned_rows">): PricedStage => ({ expected_rows: o.planned_rows, deliver: true, columns: [], sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0.0002, measured_from_calls: [], ...o });
    const mk = (): PricedPlan => {
      const stages = [
        stage({ key: "videos", title_ar: "الفيديوهات", endpoint_id: "tikhub.tiktok.search.videos", parent_key: null, planned_rows: 2, columns: [{ key: "link", title_ar: "رابط" }], engine: { endpoint_id: "x", params: {}, cursor_param: null, map_code: "return []", map_file_id: "p", parent_binding: null, built_by: "code" } as never }),
        stage({ key: "comments", title_ar: "التعليقات", endpoint_id: "tikhub.tiktok.video.comments", parent_key: "videos", planned_rows: 40, per_parent_rows: 20, columns: [{ key: "text", title_ar: "نص" }], engine: { endpoint_id: "tikhub.tiktok.video.comments", params: {}, cursor_param: "cursor", map_code: "return []", map_file_id: "p", parent_binding: { param: "aweme_id", from: "id" }, built_by: "code" } as never }),
      ];
      return { summary_ar: "x", stages, price: priceMissionByCode(stagePriceInputs(stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) } as unknown as PricedPlan;
    };
    void catalog;
    const cands = [{ id: "a", counter: 12 }, { id: "b", counter: 66 }, { id: "c", counter: 9 }, { id: "d", counter: 33 }];
    const engaged = await withCompleteCount(mk(), { request: "كل التعليقات على فيديوهين", candidatesOf: async () => cands, pageCapOf: async () => null, mostEngaged: true });
    expect(engaged.stages.find((s) => s.key === "comments")!.parent_pins).toEqual(["b", "d"]);
    const newest = await withCompleteCount(mk(), { request: "كل التعليقات على فيديوهين", candidatesOf: async () => cands, pageCapOf: async () => null });
    expect(newest.stages.find((s) => s.key === "comments")!.parent_pins).toEqual(["a", "b"]);
  });
});

describe("1. the promise for comments and replies is the counter, never more", () => {
  it("the live case on the real plan: counters 66 + 33 = 99: comments + replies promised = 99 (not the counter plus a reply estimate); 2 videos + 99 rows are priced", async () => {
    const r = await run();
    const comments = r.plannedPlan.stages.find((s) => s.key === "comments")!;
    const replies = r.plannedPlan.stages.find(isRepliesStage)!;
    expect(comments.planned_rows + replies.planned_rows).toBe(66 + 33);
    expect(r.plannedPlan.price.deliveredRows).toBe(2 + 99);
  });
  it("delivered == promised: 2 videos + 90 comments + 9 replies = 101, and the notice says exactly that (never «٥ من ٣٠٨»)", async () => {
    const r = await run();
    expect(resultOf(r).delivered).toBe(101);
    const facts = r.notices[0].facts as { delivered: number; planned: number };
    expect(facts.planned).toBe(101);
    expect(facts.delivered).toBe(101);
    expect(r.notices[0].kind).toBe("completed");
  });
  it("no number of the card or of the completion text is above the counters (101 in all)", async () => {
    const r = await run();
    const text = [...((r.planView.notesAr ?? []) as string[]), String(r.mission.summary_ar ?? ""), ...r.planView.stages.map((s) => `${s.titleAr}`)].join(" ");
    const numbers = [...text.matchAll(/[٠-٩]+/g)].map((m) => Number(m[0].replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))));
    expect(Math.max(0, ...numbers)).toBeLessThanOrEqual(101);
  });
  it("the unit case of the live test: counters 5 and 1, a model that planned 800 comments, replies asked: 6 in all, not 308", async () => {
    const catalog = loadTregCatalog();
    const SPEC = { endpoint_id: "tikhub.tiktok.video.comments", params: {}, cursor_param: "cursor", map_code: "return []", map_file_id: "p", parent_binding: { param: "aweme_id", from: "id" }, built_by: "code" };
    const stage = (o: Partial<PricedStage> & Pick<PricedStage, "key" | "title_ar" | "endpoint_id" | "parent_key" | "planned_rows">): PricedStage => ({ expected_rows: o.planned_rows, deliver: true, columns: [], sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0.0002, measured_from_calls: [], ...o });
    const stages = [
      stage({ key: "videos", title_ar: "الفيديوهات", endpoint_id: "tikhub.tiktok.search.videos", parent_key: null, planned_rows: 2, columns: [{ key: "link", title_ar: "رابط" }, { key: "comments_count", title_ar: "عدد التعليقات" }], engine: { ...SPEC, endpoint_id: "tikhub.tiktok.search.videos", parent_binding: null } as never }),
      stage({ key: "comments", title_ar: "التعليقات", endpoint_id: "tikhub.tiktok.video.comments", parent_key: "videos", planned_rows: 800, per_parent_rows: 400, columns: [{ key: "text", title_ar: "نص" }, { key: "replies_count", title_ar: "عدد الردود" }], engine: SPEC as never }),
    ];
    let p = { summary_ar: "x", stages, price: priceMissionByCode(stagePriceInputs(stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) } as unknown as PricedPlan;
    p = await withRepliesStages(p, { catalog, isAllowed: () => true, requested: true, all: true, sampleRowsOf: async () => [3, 0, 1, 0, 0, 2, 0, 0, 0, 0].map((n, i) => ({ id: `s${i}`, text: "x", replies_count: n })) });
    const final = await withCompleteCount(p, { request: "كل التعليقات والردود", candidatesOf: async () => [{ id: "a", counter: 5 }, { id: "b", counter: 1 }], pageCapOf: async () => null });
    const c = final.stages.find((s) => s.key === "comments")!;
    const rep = final.stages.find(isRepliesStage)!;
    expect(c.planned_rows + rep.planned_rows).toBe(6);
    expect(final.price.deliveredRows).toBe(2 + 6);
  });
  it("comments only: never more than the counter", async () => {
    const SPEC = { endpoint_id: "tikhub.tiktok.video.comments", params: {}, cursor_param: "cursor", map_code: "return []", map_file_id: "p", parent_binding: { param: "aweme_id", from: "id" }, built_by: "code" };
    const stage = (o: Partial<PricedStage> & Pick<PricedStage, "key" | "title_ar" | "endpoint_id" | "parent_key" | "planned_rows">): PricedStage => ({ expected_rows: o.planned_rows, deliver: true, columns: [], sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0.0002, measured_from_calls: [], ...o });
    const stages = [
      stage({ key: "videos", title_ar: "الفيديوهات", endpoint_id: "tikhub.tiktok.search.videos", parent_key: null, planned_rows: 2, columns: [{ key: "link", title_ar: "رابط" }], engine: { ...SPEC, endpoint_id: "tikhub.tiktok.search.videos", parent_binding: null } as never }),
      stage({ key: "comments", title_ar: "التعليقات", endpoint_id: "tikhub.tiktok.video.comments", parent_key: "videos", planned_rows: 800, per_parent_rows: 400, columns: [{ key: "text", title_ar: "نص" }], engine: SPEC as never }),
    ];
    const p = { summary_ar: "x", stages, price: priceMissionByCode(stagePriceInputs(stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) } as unknown as PricedPlan;
    const final = await withCompleteCount(p, { request: "كل التعليقات", candidatesOf: async () => [{ id: "a", counter: 5 }, { id: "b", counter: 1 }], pageCapOf: async () => null });
    expect(final.stages.find((s) => s.key === "comments")!.planned_rows).toBe(6);
  });
});
