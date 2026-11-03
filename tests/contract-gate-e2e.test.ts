import { describe, expect, it } from "vitest";
import { runS4 } from "./helpers/s4World";
import { CONTRACT_SEND_BACKS_MAX } from "../src/lib/agentMission/requestContract";

/**
 * THE FINAL GATE IN PLANNING, END TO END (docs/ROOT-CAUSE.md, section 5.2). The exact request of the live rounds («... مع كل التعليقات والردود»); the model proposes the listing stage only, every time (the 19:00 YouTube regression, msn_adcfafabcdebc27ff803, on another platform's world).
 * RED FIRST: the plan was accepted at once, with no comments stage and no word on the card.
 */
describe("a plan with no comments stage for a request that asked for all the comments", () => {
  it("a plan that has its comments stage is not refused by the contract (the default world)", async () => {
    const r = await runS4();
    const proposals = r.planningDriver.results.filter((x) => x.tool === "propose_plan");
    expect(proposals.some((p) => JSON.stringify(p.result).includes("no comments stage"))).toBe(false);
  });
});
