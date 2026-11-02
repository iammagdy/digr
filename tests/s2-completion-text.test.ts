import { describe, expect, it } from "vitest";
import { repliesShortfallAr } from "../agent/src/repliesShortfall";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { FULL_WORLD, LIVE_WORLD, runG4 } from "./helpers/g4RepliesWorld";

/**
 * S2 ITEM 5 (docs/S1-LIVE-FINDINGS.md, L0.5). Live msn_48f6c7c80eb7068f2a38 promised 322 rows and delivered 42: 279 of the 280 promised replies were not delivered, yet the completion text said only «بعض الفيديوهات عليها تعليقات أقل من العدد المطلوب لكل فيديو». The text now states the true reason
 * for the replies too, from what the run recorded: the replies stage's own stop. The status rule is unchanged (a delivery is complete or partial by its top-level rows).
 */
describe("the sentence about the replies, from the replies stage's recorded stop", () => {
  const base = { planned: 280, delivered: 1, review: { pending: 0, stop: null as null } };
  it("nothing is said when the replies were delivered as planned (or more)", () => {
    expect(repliesShortfallAr({ ...base, delivered: 280, stop: "source_exhausted" })).toBe("");
    expect(repliesShortfallAr({ ...base, planned: 0, delivered: 0, stop: null })).toBe("");
  });
  it("the source gave fewer replies than the sample promised: the sentence says the replies were estimated from a sample of the comments and the source gave fewer", () => {
    const t = repliesShortfallAr({ ...base, stop: "source_exhausted" });
    expect(t).toContain("الردود");
    expect(t).toContain("عيّنة");
    expect(t).toContain("أقل مما قدّرناه");
    expect(checkCustomerText(t).issues).toEqual([]);
  });
  it("a recorded budget stop says the budget was reached, a recorded failure says the source could not be reached (the clause of the stop, never a guess)", () => {
    expect(repliesShortfallAr({ ...base, stop: "budget" })).toContain("ميزانية القراءة");
    expect(repliesShortfallAr({ ...base, stop: "failed" })).toContain("تعذّرت");
  });
  it("no number, no provider, no emoji (the owner's customer-text rules)", () => {
    for (const stop of ["source_exhausted", "budget", "failed", "time_limit", null] as const) {
      const t = repliesShortfallAr({ ...base, stop });
      expect(t).not.toMatch(/\d|[٠-٩]/);
      expect(checkCustomerText(t).issues, t).toEqual([]);
    }
  });
});

describe("the completion text of a mission, end to end", () => {
  it("top-level complete, replies below the estimate: the mission is completed, and the text names the replies (never a silent gap, never «fewer comments»)", async () => {
    const r = await runG4(FULL_WORLD);
    const text = String(r.mission.summary_ar ?? "");
    expect(r.mission.status).toBe("completed");
    expect(text).toContain("الردود");
    expect(text).toContain("أقل مما قدّرناه");
    expect(text).not.toMatch(/لم يكتمل|أقل مما طلبت|تعليقات أقل من العدد/);
  });
  it("a top-level shortfall AND fewer replies than estimated: the text names both reasons", async () => {
    const r = await runG4(LIVE_WORLD);
    const text = String(r.mission.summary_ar ?? "");
    expect(text).toMatch(/لم يكتمل العدد المطلوب/);
    expect(text).toContain("الردود");
  });
});
