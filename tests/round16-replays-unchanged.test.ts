import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { violationTextAr } from "../src/lib/agentMission/foundation/deliveryContract";
import { ALTERNATIVE_LINE_AR } from "../src/lib/agentMission/foundation/alternatives";
import { replayMission, storedRows, type MissionReplay } from "./helpers/missionReplay";
import { MISSIONS } from "./helpers/round14Missions";

/**
 * ROUND 16: THE OFFLINE REPLAYS OF THE FOUR STORED LIVE MISSIONS STAY UNCHANGED where no compatible alternative exists (TikTok msn_5851abc92a1e6645a9cd, YouTube msn_41a73a6b2c0b4a76ef0a and msn_5d5a9b2a933aeaa47d81, Facebook msn_236f4af6fe4cb890abee): no stage carries an alternative, the card has no line about one,
 * the rows delivered are exactly the rows the live run delivered (counts per stage, from the stored `rows/*.json`), no alternative route is on the persisted record, and the delivery contract finds ZERO violations. Nothing here is a model or a network call.
 */
const STORED: Record<string, Record<string, number>> = {
  msn_5851abc92a1e6645a9cd: { videos: 2, comments: 300, comments_replies: 67 },
  msn_41a73a6b2c0b4a76ef0a: {},
  msn_5d5a9b2a933aeaa47d81: {},
  msn_236f4af6fe4cb890abee: {},
};

describe.each(MISSIONS)("$label: unchanged by the alternatives", ({ id, input }) => {
  let r: MissionReplay;
  beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(input.readAt)); r = await replayMission(input); }, 240_000);
  afterAll(() => { vi.useRealTimers(); });

  it("no stage of the approved plan carries an alternative, and the card has no line about a next source", () => {
    for (const s of r.planned.plan.stages) expect(s.engine?.alternatives, `${id} ${s.key}`).toBeUndefined();
    expect(r.planned.plan.notes_ar ?? []).not.toContain(ALTERNATIVE_LINE_AR);
  });
  it("the replay served every execution page from the stored ones, and delivered rows", () => {
    expect(r.unservedExecution).toBe(0);
    expect(Object.values(r.rowsByStage).reduce((n, rows) => n + rows.length, 0)).toBeGreaterThan(0);
  });
  it("the delivered rows per stage are the live run's own (where its rows are stored in full), and none is delivered twice", () => {
    for (const [stage, rows] of Object.entries(r.rowsByStage)) {
      expect(new Set(rows.map((x) => String(x.id))).size, `${id} ${stage}`).toBe(rows.length);
      const live = STORED[id][stage];
      if (live !== undefined) expect(rows.length, `${id} ${stage}`).toBe(live);
    }
  });
  it("ZERO delivery-contract violations, and nothing completed behind the test's back", () => {
    expect(r.built.contract.violations.map(violationTextAr)).toEqual([]);
    expect(r.built.contract.completed).toEqual([]);
  });
});
void storedRows;
