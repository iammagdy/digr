import { describe, expect, it } from "vitest";
import { depthCostPerRowUsd, stagePriceInputs, type PricedStage } from "../src/lib/agentMission/plan";
import { NAMES_STEP_USD_PER_PERSON } from "../src/lib/agentMission/constants";

/** ITEM 2: the price carries every page of the depth: pages x one page's cost (0.005 USD for aviato's 5 people) for each company, shared by the people asked for each company. */
const stage = (over: Partial<PricedStage> = {}): PricedStage => ({ key: "people", title_ar: "موظفو كل شركة", endpoint_id: "aviato.companies.employees", expected_rows: 10, parent_key: "companies", per_parent_rows: 2, role_preference: { role: "manager" }, deliver: true, columns: [], sample_rows: [], measured_by: [], planned_rows: 10, measured_cost_per_row_usd: 0.001, measured_from_calls: [], pages_per_parent: 3, page_cost_usd: 0.005, ...over } as PricedStage);

describe("the cost per delivered person of a stage read in depth", () => {
  it("3 pages x 0.005 USD for 2 people of each company = 0.0075 per person (before: the measured 0.001 per row)", () => {
    expect(depthCostPerRowUsd(stage())).toBeCloseTo(0.0075, 9);
  });
  it("one page (the customer lowered the depth), a stage with no depth, or a missing page cost: the measured cost per row", () => {
    expect(depthCostPerRowUsd(stage({ pages_per_parent: 1 }))).toBe(0.001);
    expect(depthCostPerRowUsd(stage({ pages_per_parent: undefined, page_cost_usd: undefined }))).toBe(0.001);
    expect(depthCostPerRowUsd(stage({ page_cost_usd: 0 }))).toBe(0.001);
  });
  it("more people for each company share the same pages: 4 people of each company cost less per person", () => {
    expect(depthCostPerRowUsd(stage({ per_parent_rows: 4 }))).toBeCloseTo(0.00375, 9);
  });
  it("the price inputs carry it (the one place every pricing path uses), and `withoutDepth` gives the price of the reading alone", () => {
    // CHANGED (PR 1 part c): a delivered decision-makers stage also carries the estimate of the one names request (NAMES_STEP_USD_PER_PERSON per person); the price of the reading alone (`withoutDepth`) does not
    expect(stagePriceInputs([stage()])[0].costPerRowUsd).toBeCloseTo(0.0075 + NAMES_STEP_USD_PER_PERSON, 9);
    expect(stagePriceInputs([stage()], undefined, { withoutDepth: true })[0].costPerRowUsd).toBe(0.001);
  });
});
