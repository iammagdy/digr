import { describe, expect, it } from "vitest";
import { shortfallClauseAr } from "../agent/src/finalize";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { withAllChildren } from "../src/lib/agentMission/allChildren";
import { GAP_CHOICE_LINE_AR } from "../src/lib/agentMission/gapLines";
import { MARK_COLUMNS_AR, MARK_COLUMN_ORDER, markCellAr } from "../src/lib/agentMission/rawMarks";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";

/** S1: EVERY NEW CUSTOMER-FACING STRING GOES THROUGH checkCustomerText (Arabic only, no source names, no dollar amount, no internal id, no Latin word, no spreadsheet word). The strings of the other items are checked beside their own tests; these are the rest. */
const ok = (text: string) => expect(checkCustomerText(text).issues, text).toEqual([]);
describe("the new customer strings", () => {
  it("the closing sentence of a stage that stopped at the reserve edge", () => {
    ok(`سُلّم أقل من المطلوب ${shortfallClauseAr("need_new_plan", { pending: 0, stop: null })}.`);
  });
  it("the choice line of the gap statement", () => ok(GAP_CHOICE_LINE_AR));
  it("every mark cell the file can hold", () => {
    for (const k of MARK_COLUMN_ORDER) { ok(MARK_COLUMNS_AR[k]); for (const v of [true, false, null, "ar", "other"]) ok(markCellAr(k, { [k]: v } as never)); }
  });
  it("the all-comments lines (the estimate line and the cap line)", async () => {
    const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0005, ...over }) as unknown as PricedStage;
    const videos = stage({ key: "videos", title_ar: "الفيديوهات", planned_rows: 5, columns: [{ key: "caption", title_ar: "الوصف" }] });
    const comments = stage({ key: "comments", title_ar: "التعليقات", parent_key: "videos", per_parent_rows: 10, planned_rows: 50, columns: [{ key: "text", title_ar: "نص التعليق" }], engine: { endpoint_id: "c", params: {}, cursor_param: null, map_code: "", map_file_id: "page", parent_binding: { param: "v", from: "id" } } });
    const stages = [videos, comments];
    const plan = { summary_ar: "x", stages, price: priceMissionByCode(stagePriceInputs(stages, undefined), {}) } as unknown as PricedPlan;
    for (const counters of [[12, 40, 7, 0, 100], [40000, 40000, 40000, 40000, 40000]]) {
      const out = await withAllChildren(plan, { request: "كل التعليقات", parentCountersOf: async () => counters });
      for (const n of out.notes_ar ?? []) ok(n);
      expect((out.notes_ar ?? []).length).toBe(1);
    }
  });
});
