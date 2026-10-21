import { describe, expect, it } from "vitest";
import { chatOnlyKbPerVisitor, DEFAULT_EGRESS_ASSUMPTIONS, EGRESS_ALLOWANCE_GB, EGRESS_SCENARIOS, egressGb, missionKbPerVisitor } from "../scripts/capacity/egressModel";

describe("egress for 500 visitors against the 5 GB allowance (docs/SUPABASE_FREE_PLAN.md section 5)", () => {
  it("per visitor: chat about 0.45 MB, a mission with its results about 2 MB more", () => {
    expect(chatOnlyKbPerVisitor() / 1024).toBeGreaterThan(0.4);
    expect(chatOnlyKbPerVisitor() / 1024).toBeLessThan(0.5);
    expect(missionKbPerVisitor() / 1024).toBeGreaterThan(1.9);
    expect(missionKbPerVisitor() / 1024).toBeLessThan(2.1);
  });
  it("the three scenarios stay far under the allowance", () => {
    const gb = Object.fromEntries(EGRESS_SCENARIOS.map((s) => [s.id, egressGb(s.scenario)]));
    expect(gb.chat_only).toBeCloseTo(0.2, 1);
    expect(gb.quarter_missions).toBeCloseTo(0.45, 1);
    expect(gb.all_missions).toBeCloseTo(1.2, 1);
    for (const value of Object.values(gb)) expect(value).toBeLessThan(EGRESS_ALLOWANCE_GB * 0.3);
  });
  it("doubling every payload size, or asking twice as often, still keeps the worst scenario under the allowance", () => {
    const bigger = Object.fromEntries(Object.entries(DEFAULT_EGRESS_ASSUMPTIONS).map(([k, v]) => [k, /Kb$/.test(k) ? v * 2 : v])) as typeof DEFAULT_EGRESS_ASSUMPTIONS;
    const oftener = Object.fromEntries(Object.entries(DEFAULT_EGRESS_ASSUMPTIONS).map(([k, v]) => [k, /EverySeconds$/.test(k) ? v / 2 : v])) as typeof DEFAULT_EGRESS_ASSUMPTIONS;
    expect(egressGb({ visitors: 500, missionShare: 1 }, bigger)).toBeLessThan(EGRESS_ALLOWANCE_GB);
    expect(egressGb({ visitors: 500, missionShare: 1 }, oftener)).toBeLessThan(EGRESS_ALLOWANCE_GB);
  });
});
