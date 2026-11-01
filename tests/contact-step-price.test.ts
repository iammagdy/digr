import { describe, expect, it, vi } from "vitest";
import { replay } from "./helpers/agentReplay";
import { companiesPage, peopleAnswer, planFlow, request } from "./helpers/a1World";
import { tregResult } from "./helpers/agentFakeWorld";
import { stagePriceInputs, type PricedPlan } from "../src/lib/agentMission/plan";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { repriceStoredPlan } from "../src/lib/agentMission/lifecycle";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

/**
 * ITEM 3: THE PLAN PRICE ALREADY INCLUDES THE FINDER STEPS, COMPUTED BY CODE. The cost of a step is per_person_usd x the people of its stage; it is added to the people stage's cost per row, so the provider cost, the cost per delivered row and (above the minimum charge) the unit price and the reserve carry it.
 * No money function, no cap and no price rule changes: the same priceMissionByCode, the same inputs plus the step's cost. Every place that prices a plan (the plan check, the approval's re-price, the editor) goes through stagePriceInputs.
 */
const run = () => replay({ request, planning: planFlow(), execution: () => [], answers: Array.from({ length: 40 }, () => (o: any) => (o.endpointId.includes("waterfall") ? peopleAnswer(o) : tregResult(companiesPage, 0.0005))) });

describe("the finder steps are in the price", () => {
  it("provider cost of the plan = the stages' cost + per_person_usd x people, and stagePriceInputs is the one place that adds it", async () => {
    const r = await run();
    const plan = r.plannedPlan as PricedPlan;
    const steps = plan.contact_steps!;
    // CHANGED (PR 1 part b): the plan also carries the company-level steps (the company's e-mail and HQ phone), each priced per row of ITS OWN stage (the companies)
    expect(steps.filter((s) => s.level === undefined).length).toBe(2);
    expect(steps.filter((s) => s.level === "company").length).toBeGreaterThan(0);
    const rowsOf = (key: string) => plan.stages.find((s) => s.key === key)!.planned_rows;
    const without = priceMissionByCode(stagePriceInputs(plan.stages), { settings: plan.price.settings });
    const extra = steps.reduce((n, s) => n + s.per_person_usd * rowsOf(s.stage_key), 0);
    expect(extra).toBeGreaterThan(0);
    expect(plan.price.providerCostUsd).toBeCloseTo((without.providerCostUsd ?? 0) + extra, 9);
    expect(plan.price.costPerFinalRowUsd).toBeGreaterThan(without.costPerFinalRowUsd);
    expect(plan.price.deliveredRows).toBe(without.deliveredRows); // no row is added: the finder steps fill cells
  });
  it("the approval's re-price (the stored plan priced again) gives the same price as the plan check: the customer approves the price they saw", async () => {
    const r = await run();
    const plan = r.plannedPlan as PricedPlan;
    const again = repriceStoredPlan(plan);
    expect(again.reservePoints).toBe(plan.price.reservePoints);
    expect(again.providerCostUsd).toBeCloseTo(plan.price.providerCostUsd ?? 0, 9);
  });
  it("a plan with more people costs more: the step follows the people count", async () => {
    const r = await run();
    const plan = r.plannedPlan as PricedPlan;
    const more = plan.stages.map((s) => (s.key === "people" ? { ...s, planned_rows: s.planned_rows * 4 } : s));
    expect(priceMissionByCode(stagePriceInputs(more, plan.contact_steps), { settings: plan.price.settings }).providerCostUsd!).toBeGreaterThan(plan.price.providerCostUsd!);
  });
});
