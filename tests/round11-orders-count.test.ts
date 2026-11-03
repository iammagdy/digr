import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { promisedRowsOf } from "../src/lib/agentMission/promisedTotal";
import { deliveredOfAr, knownItemNoun } from "../src/lib/agentMission/itemNoun";

/**
 * LIVE ROUND 11 (3 Nov 2026), item 1: the orders page still said «٤١ من ٤٢» for Instagram `msn_97cdab58dc82fc2039ed` while the file and the chat said «٤١ من ٤٩». Round 10's `promisedRowsOf` asked for `replies_open` on the stages, but the stages the
 * orders page reads are the PUBLIC plan's (`plan_public->stages`: key, title, expected_rows, deliver, columns ... no `replies_open`), so the function always returned the job's own number. The public plan stored AFTER the run already holds the judged
 * numbers (replies 9, not the card's estimate 2). These tests run on the two stored public plans, read by SELECT (tests/fixtures/live/round11/stored-public-plans.json).
 */
const stored = JSON.parse(readFileSync(new URL("./fixtures/live/round11/stored-public-plans.json", import.meta.url), "utf8")) as { missions: Record<string, { compiled: boolean; job_target: number; delivered: number; file_total: number; stages: Array<{ key: string; deliver: boolean; expected_rows: number }> }> };

describe("the orders page promises the same number as the file and the chat, from the stored public plan", () => {
  for (const [id, m] of Object.entries(stored.missions)) {
    it(`${id} (${"stages"}): the promised number is the file's ${"total"}`, () => {
      expect(promisedRowsOf(m.stages, m.job_target, m.compiled)).toBe(m.file_total);
    });
  }
  it("Instagram: «٤١ من ٤٩», never «٤١ من ٤٢»", () => {
    const m = stored.missions.msn_97cdab58dc82fc2039ed;
    expect(deliveredOfAr(m.delivered, promisedRowsOf(m.stages, m.job_target, m.compiled), knownItemNoun("منشور")!)).toContain("٤١ من ٤٩");
  });
  it("YouTube: «١٠١ من ١٠١» (the job's 220 was the card's maximum, never a promise)", () => {
    const m = stored.missions.msn_41a73a6b2c0b4a76ef0a;
    expect(promisedRowsOf(m.stages, m.job_target, m.compiled)).toBe(101);
  });
  it("a mission that is not compiled keeps the job's number; so does a plan with no stages", () => {
    const m = stored.missions.msn_97cdab58dc82fc2039ed;
    expect(promisedRowsOf(m.stages, 42, false)).toBe(42);
    expect(promisedRowsOf([], 42, true)).toBe(42);
    expect(promisedRowsOf(null, 42, true)).toBe(42);
  });
  it("a compiled plan that is still waiting or running (the card's own numbers) promises the job's number", () => {
    // before the run the public plan holds the card's estimate (replies 2): 2 + 38 + 2 = 42 = the job's number
    const waiting = stored.missions.msn_97cdab58dc82fc2039ed.stages.map((s) => (s.key === "comments_replies" ? { ...s, expected_rows: 2 } : s));
    expect(promisedRowsOf(waiting, 42, true)).toBe(42);
  });
});
