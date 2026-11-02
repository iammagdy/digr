import { describe, expect, it } from "vitest";
import { runS4 } from "./helpers/s4World";
import { CONTRACT_SEND_BACKS_MAX } from "../src/lib/agentMission/requestContract";

/**
 * THE FINAL GATE IN PLANNING, END TO END (docs/ROOT-CAUSE.md, section 5.2). The exact request of the live rounds («... مع كل التعليقات والردود»); the model proposes the listing stage only, every time (the 19:00 YouTube regression, msn_adcfafabcdebc27ff803, on another platform's world).
 * RED FIRST: the plan was accepted at once, with no comments stage and no word on the card.
 */
describe("a plan with no comments stage for a request that asked for all the comments", () => {
  it("is sent back to the planner, twice, naming the missing stage; the third time the plan is stored with the steps stated as NOT INCLUDED", async () => {
    const r = await runS4({ dropComments: true });
    const proposals = r.planningDriver.results.filter((x) => x.tool === "propose_plan");
    // the first proposal is the cheap-search plan the country rule refuses; then the contract refuses the plan twice
    const contract = proposals.filter((p) => JSON.stringify(p.result).includes("no comments stage"));
    expect(contract).toHaveLength(CONTRACT_SEND_BACKS_MAX);
    for (const c of contract) expect(c.result.ok).toBe(false);
    expect(proposals[proposals.length - 1].result.ok).toBe(true);
    const steps = (r.plannedPlan as { unserved_steps?: Array<{ what_ar: string; reason_ar: string }> }).unserved_steps ?? [];
    expect(steps.map((u) => u.what_ar).join("|")).toMatch(/التعليقات.*\|الردود/);
  });
  it("the customer's card shows both steps as not included, before approval", async () => {
    const r = await runS4({ dropComments: true });
    const unserved = ((r.planView as { unservedAr?: string[]; unserved_ar?: string[] }).unservedAr ?? (r.planView as { unserved_ar?: string[] }).unserved_ar ?? []) as string[];
    expect(unserved.join(" ")).toContain("لم تُضَف إلى الخطة خطوة");
    expect(unserved.join(" ")).toContain("التعليقات");
  });
  it("a plan that has its comments stage is not refused by the contract (the default world)", async () => {
    const r = await runS4();
    const proposals = r.planningDriver.results.filter((x) => x.tool === "propose_plan");
    expect(proposals.some((p) => JSON.stringify(p.result).includes("no comments stage"))).toBe(false);
  });
});
