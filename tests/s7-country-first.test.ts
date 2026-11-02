import { describe, expect, it } from "vitest";
import type { MemoryStore } from "../agent/src/memoryStore";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { runS4, ENGLISH, RELEVANT } from "./helpers/s4World";
import { vid } from "./helpers/g4RepliesWorld";
import { stagePriceInputs, type PricedPlan, type PricedStage, type StageFilter } from "../src/lib/agentMission/plan";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { isRepliesStage, withRepliesStages } from "../src/lib/agentMission/replies";
import { withCompleteCount } from "../src/lib/agentMission/completeCount";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { matchesCustomerConditions } from "../src/lib/agentMission/customerConditions";
import { DEFAULT_MISSION_PRICING_SETTINGS } from "../src/lib/missionPricing";
import { editsFromState, initialState } from "../src/components/mission/PlanEditor";
import { planEditorView } from "../src/lib/agentMission/plan";

/**
 * S7, the live test of 2026-11-02 ~13:06 Cairo (docs/S1-LIVE-FINDINGS.md, S7): both videos were English AI cartoons (counters 3,553 and 1,560), not Arabic and not Egyptian; the most-engaged rule (S5) overrode the country and the language. Owner decision: THE CUSTOMER'S COUNTRY AND LANGUAGE COME FIRST; the most engaged
 * ordering applies only among the results that match them. A tool that takes the country and sorts by engagement is used only when its results match; otherwise the country-capable tool is read in its own order and its results are ordered by comment counter; never a tool without the country field. Ordering, never filtering.
 * Also: the plan editor's comments per video can be «all» (the videos' real counters) or any number up to the real counter, not capped at 100.
 */
const PLACE: StageFilter = { kind: "place", field: "country", fields: ["country"], places: ["EG"], values: ["مصر"] } as never;
const LANG: StageFilter = { kind: "language", lang: "ar" } as never;
const FILTERS = [LANG, PLACE];
const TEXT_KEYS = ["caption"];
const egArabic = { country: "EG", caption: "الذكاء الاصطناعي فيديو" };

describe("a result matches the customer's country and language", () => {
  it("an Egyptian Arabic result matches; a global English one does not; an Egyptian result in English does not; a result with no country evidence does not (never assumed)", () => {
    expect(matchesCustomerConditions(egArabic, FILTERS, TEXT_KEYS)).toBe(true);
    expect(matchesCustomerConditions({ country: "US", caption: "AI cartoon video" }, FILTERS, TEXT_KEYS)).toBe(false);
    expect(matchesCustomerConditions({ country: "EG", caption: "AI cartoon video" }, FILTERS, TEXT_KEYS)).toBe(false);
    expect(matchesCustomerConditions({ caption: "الذكاء الاصطناعي" }, FILTERS, TEXT_KEYS)).toBe(false);
  });
  it("only the conditions the customer asked for count: with none, everything matches", () => {
    expect(matchesCustomerConditions({ country: "US", caption: "x" }, [], TEXT_KEYS)).toBe(true);
    expect(matchesCustomerConditions({ country: "EG", caption: "AI cartoon" }, [PLACE], TEXT_KEYS)).toBe(true);
  });
  it("the language the source gives wins over the script of the text", () => {
    expect(matchesCustomerConditions({ country: "EG", language: "ar", caption: "AI" }, FILTERS, TEXT_KEYS)).toBe(true);
    expect(matchesCustomerConditions({ country: "EG", language: "en", caption: "الذكاء" }, FILTERS, TEXT_KEYS)).toBe(false);
  });
});

const stage = (o: Partial<PricedStage> & Pick<PricedStage, "key" | "title_ar" | "endpoint_id" | "parent_key" | "planned_rows">): PricedStage => ({ expected_rows: o.planned_rows, deliver: true, columns: [], sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0.00005, measured_from_calls: [], ...o });
const SPEC = { endpoint_id: "tikhub.tiktok.video.comments", params: {}, cursor_param: "cursor", map_code: "return []", map_file_id: "p", parent_binding: { param: "aweme_id", from: "id" }, built_by: "code" };
const basePlan = (): PricedPlan => {
  const stages = [
    stage({ key: "videos", title_ar: "الفيديوهات", endpoint_id: "tikhub.tiktok.search.videos", parent_key: null, planned_rows: 2, columns: [{ key: "caption", title_ar: "وصف" }, { key: "country", title_ar: "الدولة" }, { key: "comments", title_ar: "التعليقات" }], filters: FILTERS, engine: { ...SPEC, endpoint_id: "tikhub.tiktok.search.videos", parent_binding: null } as never }),
    stage({ key: "comments", title_ar: "التعليقات", endpoint_id: "tikhub.tiktok.video.comments", parent_key: "videos", planned_rows: 800, per_parent_rows: 400, columns: [{ key: "comments", title_ar: "التعليق" }, { key: "replies_count", title_ar: "عدد الردود" }], engine: SPEC as never }),
  ];
  return { summary_ar: "x", stages, price: priceMissionByCode(stagePriceInputs(stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) } as unknown as PricedPlan;
};
const cand = (id: string, counter: number, o: Record<string, unknown>) => ({ id, counter, row: { id, comments: counter, ...o } });
const live = [cand("en1", 3553, { country: "US", caption: "AI cartoon" }), cand("en2", 1560, { country: "US", caption: "AI cartoon 2" }), cand("a", 12, egArabic), cand("b", 66, egArabic), cand("c", 9, egArabic), cand("d", 33, egArabic)];
const final = (cands = live, o: { mostEngaged?: boolean } = {}) => withCompleteCount(basePlan(), { request: "كل التعليقات على فيديوهين", candidatesOf: async () => cands, pageCapOf: async () => null, mostEngaged: o.mostEngaged ?? true, matchesOf: async (p) => (row) => matchesCustomerConditions(row, p.filters ?? [], TEXT_KEYS) });

describe("the most engaged applies only among the results that match", () => {
  it("the live case: 3,553 and 1,560 are English and global, so the two highest-commented MATCHING videos (66 and 33) are chosen", async () => {
    const p = await final();
    expect(p.stages.find((s) => s.key === "comments")!.parent_pins).toEqual(["b", "d"]);
    expect(p.stages.find((s) => s.key === "comments")!.planned_rows).toBe(99);
  });
  it("the card says how they were chosen: the most commented among the results that match Egypt and Arabic", async () => {
    const p = await final();
    expect((p.notes_ar ?? []).join(" ")).toContain("المطابقة");
  });
  it("when fewer results match than videos are needed, the matching ones come first and the highest-commented of the rest fill the places, and the card says how many matched (nothing is dropped)", async () => {
    const p = await final([live[0], live[1], live[3]]);
    expect(p.stages.find((s) => s.key === "comments")!.parent_pins).toEqual(["b", "en1"]);
    expect((p.notes_ar ?? []).join(" ")).toMatch(/١ من/);
  });
  it("without the most-engaged default (the customer asked for the newest) the source's order stands", async () => {
    const p = await final(live, { mostEngaged: false });
    expect(p.stages.find((s) => s.key === "comments")!.parent_pins).toEqual(["en1", "en2"]);
  });
});

const resultOf = (r: Awaited<ReturnType<typeof runS4>>) => (r.store as MemoryStore).events.find((e) => e.kind === "result")!.counts as Record<string, number>;
const callsOf = (r: Awaited<ReturnType<typeof runS4>>) => (r.call.mock.calls as Array<[{ endpointId: string; params: Record<string, unknown> }]>).map((c) => c[0]);

describe("the exact request: the chosen tool receives Egypt, the videos are ordered by comments within the matching results", () => {
  const run = () => runS4({ conditions: true });
  it("the plan on the most-liked sample (global English videos) is refused; the search is read again in its default order, with Egypt, and the plan is accepted", async () => {
    const r = await run();
    const proposals = r.planningDriver.results.filter((x) => x.tool === "propose_plan");
    const verdicts = proposals.map((p) => p.result.ok);
    expect(verdicts.slice(-1)).toEqual([true]);
    expect(proposals.some((p) => JSON.stringify(p.result).includes("country") && JSON.stringify(p.result).includes("language"))).toBe(true);
    const search = callsOf(r).filter((c) => c.endpointId === "tikhub.tiktok.search.videos");
    expect(search.length).toBeGreaterThanOrEqual(3);
    expect(search.every((c) => c.params.region === "EG")).toBe(true);
  });
  it("the chosen tool has the country field and carries Egypt; the videos are the two highest-commented of the matching results (66 and 33), never the English ones", async () => {
    const r = await run();
    const videos = r.plannedPlan.stages[0];
    expect(videos.engine!.endpoint_id).toBe("tikhub.tiktok.search.videos");
    expect(videos.engine!.params.region).toBe("EG");
    expect(r.plannedPlan.stages.find((s) => s.key === "comments")!.parent_pins).toEqual([vid(0), vid(1)]);
    expect(ENGLISH.length + RELEVANT.length).toBeGreaterThan(0);
  });
  it("comments + replies = the counters of those videos (66 + 33), delivered == promised", async () => {
    const r = await run();
    const comments = r.plannedPlan.stages.find((s) => s.key === "comments")!.planned_rows;
    const replies = r.plannedPlan.stages.find(isRepliesStage)!.planned_rows;
    expect(comments + replies).toBe(99);
    expect(resultOf(r).delivered).toBe(2 + 99);
  });
});

describe("the plan editor: «all» or the real counter, not capped at 100", () => {
  const planned = async (): Promise<PricedPlan> => {
    const catalog = loadTregCatalog();
    let p = basePlan();
    p = await withRepliesStages(p, { catalog, isAllowed: () => true, requested: true, all: true, sampleRowsOf: async () => [1, 0, 0, 0, 1, 0, 0, 0, 0, 0].map((n, i) => ({ id: `s${i}`, comments: "x", replies_count: n })) });
    return withCompleteCount(p, { request: "كل التعليقات والردود", candidatesOf: async () => [cand("a", 329, egArabic), cand("b", 163, egArabic)], pageCapOf: async () => null, mostEngaged: true });
  };
  const edit = (plan: PricedPlan, per: unknown) => applyPlanEdits(plan, { stages: [{ key: "comments", per_parent: per }] });
  it("«all»: comments + replies are the real counters again (329 + 163 = 492), the price shown is the plan's new price", async () => {
    const p100 = await edit(await planned(), 100);
    expect(p100.ok).toBe(true);
    const back = edit((p100 as { plan: PricedPlan }).plan, "all");
    expect(back.ok).toBe(true);
    const plan = (back as { plan: PricedPlan }).plan;
    const c = plan.stages.find((s) => s.key === "comments")!;
    const r = plan.stages.find(isRepliesStage)!;
    expect(c.planned_rows + r.planned_rows).toBe(492);
    expect(c.per_parent_rows).toBe(329);
    expect(plan.price.deliveredRows).toBe(2 + 492);
    const again = priceMissionByCode(stagePriceInputs(plan.stages, plan.contact_steps), { settings: plan.price.settings });
    expect(again.reservePoints).toBe(plan.price.reservePoints);
  });
  it("a number above 100 up to the video's real counter is allowed (300 of 329); above the largest counter it is refused with the real number in the message", async () => {
    const ok = edit(await planned(), 300);
    expect(ok.ok).toBe(true);
    expect((ok as { plan: PricedPlan }).plan.stages.find((s) => s.key === "comments")!.per_parent_rows).toBe(300);
    const bad = edit(await planned(), 400);
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).toContain("٣٢٩");
  });
  it("the editor sends «all» when the customer writes «كل» in the box", async () => {
    const plan = await planned();
    const view = planEditorView(plan);
    const state = initialState(view);
    state.perParent.comments = "كل";
    const edits = editsFromState(view, state);
    expect(edits.stages?.find((s) => s.key === "comments")?.per_parent).toBe("all");
  });
});
