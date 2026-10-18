import { describe, expect, it, vi } from "vitest";
import {
  createDecisionMakerSpendBudget,
  DECISION_MAKER_PROVIDER_SPEND_CAP_USD,
  DECISION_MAKER_ROUTE_COST_CAP_USD,
  estimateDecisionMakerChunkSpendUsd,
  readDecisionMakerSpendToDate,
  remainingDecisionMakerSpendUsd,
} from "../src/lib/server/decisionMakerSpend";

describe("decision-maker live provider spend ceiling", () => {
  it("sets a strict 0.04 USD ceiling and estimates a three-person job at 0.035 USD", () => {
    expect(DECISION_MAKER_PROVIDER_SPEND_CAP_USD).toBe(0.04);
    expect(DECISION_MAKER_ROUTE_COST_CAP_USD).toBe(0.005);
    expect(estimateDecisionMakerChunkSpendUsd(3)).toBe(0.035);
    expect(estimateDecisionMakerChunkSpendUsd(30)).toBe(0.04);
  });

  it("allows no more calls than the remaining ceiling can cover at the route cap", () => {
    const budget = createDecisionMakerSpendBudget(0.04);
    const allowedCalls = Array.from({ length: 10 }, () => budget.reserveCall()).filter(Boolean).length;
    expect(allowedCalls).toBe(8);
    expect(budget.remainingUsd()).toBe(0);

    const threePersonBudget = createDecisionMakerSpendBudget(estimateDecisionMakerChunkSpendUsd(3));
    expect(Array.from({ length: 8 }, () => threePersonBudget.reserveCall()).filter(Boolean)).toHaveLength(7);
  });

  it("retains each prior job call's route-cap estimate across chunks", async () => {
    const eq = vi.fn(async () => ({
      data: [
        { cost_usd: 0.001, units: 3, is_estimate: false },
        { cost_usd: 0.01, units: 1, is_estimate: true },
      ],
      error: null,
    }));
    const client = { from: vi.fn(() => ({ select: vi.fn(() => ({ eq })) })) };
    const spent = await readDecisionMakerSpendToDate(client, "job_people");
    expect(spent).toBeCloseTo(0.025);
    expect(remainingDecisionMakerSpendUsd(spent)).toBeCloseTo(0.015);
    expect(client.from).toHaveBeenCalledWith("provider_costs");
    expect(eq).toHaveBeenCalledWith("job_id", "job_people");
  });

  it("fails closed if the worker cannot read prior spend", async () => {
    const client = { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(async () => ({ data: null, error: new Error("db unavailable") })) })) })) };
    await expect(readDecisionMakerSpendToDate(client, "job_people")).rejects.toThrow("تعذر التحقق من سقف إنفاق المهمة");
  });
});
