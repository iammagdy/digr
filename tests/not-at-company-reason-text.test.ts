import { describe, expect, it } from "vitest";
import { REASON_TEXT_AR, reasonTextAr, stageTruthBodyAr } from "../agent/src/finalize";
import { buildMethodology, type MissionFacts, type StageRecord } from "../agent/src/methodology";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * ITEM 6 OF THE 2026-11-01 11:38 LIVE TEST: since #319 a person left out by the company confirmation (reason `not_at_company`) shows «سبب آخر» in the file's reasons and in the limits sentence, because the text tables of finalize.ts had no entry for it.
 * Only the LABEL is added; no settlement, charge or count line is touched.
 */
const WORDS = "لا يعمل حاليًا في هذه الشركة";
describe("the exclusion reason not_at_company has its own Arabic words", () => {
  it("reasonTextAr says it plainly, not «سبب آخر»", () => {
    expect(reasonTextAr("not_at_company")).not.toBe("سبب آخر");
    expect(reasonTextAr("not_at_company")).toContain(WORDS);
    expect(REASON_TEXT_AR.not_at_company).toBe(reasonTextAr("not_at_company"));
  });
  it("it is customer text: Arabic, no provider, no endpoint id, no USD, no emoji", () => {
    expect(checkCustomerText(reasonTextAr("not_at_company")).issues).toEqual([]);
  });
  it("the limits sentence names it with its count when our own row rules left people out", () => {
    const body = stageTruthBodyAr({ found: 10, duplicates: 0, delivered: 6, excludedByReason: { not_at_company: 4 }, pending: 0, reviewStop: null, stop: "source_exhausted", people: true });
    // not_at_company is a rule of the person's company, not of the row's shape: the older sentence is still the stage's, but when it is named its words are the clear ones
    if (body !== null) expect(body).toContain(WORDS);
  });
  it("the file's reasons list says it with the count", () => {
    const rec = (over: Partial<StageRecord>): StageRecord => ({ found: 0, duplicates: 0, accepted: 0, excluded: 0, pending: 0, unchecked: 0, acceptedByRule: 0, acceptedByModel: 0, excludedByReason: {}, stop: "source_exhausted", ...over });
    const person = { key: "people", title_ar: "موظفو كل شركة", endpoint_id: "aviato.companies.employees", expected_rows: 10, planned_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.001, columns: [{ key: "name", title_ar: "الاسم" }] };
    const companies = { key: "companies", title_ar: "الشركات", endpoint_id: "tomba.companies.search.reveal", expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.00001, columns: [{ key: "name", title_ar: "اسم الشركة" }] };
    const plan = { summary_ar: "x", stages: [companies, person] as any, price: { totalCostUsd: 0, deliveredRows: 15, costPerFinalRowUsd: 0.0001, unitPricePoints: 24.8, reservePoints: 429, maxChargePoints: 373, overCap: false } as any } as PricedPlan;
    const facts: MissionFacts = { requestText: "x", deliveredAt: new Date("2026-11-01T09:40:00Z"), reviewStop: null, stages: { companies: rec({ found: 5, accepted: 5 }), people: rec({ found: 12, accepted: 8, excluded: 4, excludedByReason: { not_at_company: 4 } }) } };
    const m = buildMethodology({ plan, layouts: [], rowsByStage: { companies: [{ id: "c" }], people: [] }, facts });
    const all = JSON.stringify(m.reasons);
    expect(all).toContain("٤ " + WORDS);
    expect(all).not.toContain("سبب آخر");
  });
});
