import { describe, expect, it } from "vitest";
import type { MemoryStore } from "../agent/src/memoryStore";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { runS4, ENGLISH, RELEVANT } from "./helpers/s4World";
import { vid } from "./helpers/g4RepliesWorld";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import type { StageFilter } from "../src/lib/agentMission/filters";
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


const resultOf = (r: Awaited<ReturnType<typeof runS4>>) => (r.store as MemoryStore).events.find((e) => e.kind === "result")!.counts as Record<string, number>;
const callsOf = (r: Awaited<ReturnType<typeof runS4>>) => (r.call.mock.calls as Array<[{ endpointId: string; params: Record<string, unknown> }]>).map((c) => c[0]);


