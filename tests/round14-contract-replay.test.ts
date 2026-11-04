import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { violationTextAr } from "../src/lib/agentMission/foundation/deliveryContract";
import { replayMission, storedRows, type MissionReplay, type MissionReplayInput } from "./helpers/missionReplay";

/**
 * ROUND 14, PART A: THE DELIVERY CONTRACT ON EVERY STORED LIVE MISSION THAT HAS THE PAGES IT NEEDS. Each mission is replayed end to end (the compiler plans from the stored planning pages, the engine reads the stored execution pages, the real workbook is built as the worker builds it: no network, no model, no paid call)
 * and the four rules (one number, every gap stated, approximate dates marked, marks filled) are checked on the built file. ZERO violations. The missions that are NOT replayed (only planning pages or only some execution pages are stored) are listed with the reason, below.
 */
import { MISSIONS } from "./helpers/round14Missions";

/** Not replayed, with the reason (their pages are in tests/fixtures/live; a replay needs the stored pages of BOTH phases): */
export const NOT_REPLAYED: Record<string, string> = {
  msn_b060d3347ed7660f972e: "X: one stored execution page of the search; no replies pages (the X replies route is covered by tests/live-g-x-replies-verified.test.ts)",
  msn_50e3b83c44e7ebd7f577: "X: only the 14 replies pages of the pageable route, no search page",
  msn_97cdab58dc82fc2039ed: "Instagram: planning pages and two execution pages; the comments pages of the delivered file are not stored",
  msn_e3e7632e2fb2d42f9c19: "Facebook (older plan shape): 15 execution calls, planning pages incomplete",
  msn_9d196025e7929324983a: "Facebook round 11: the plan was never approved, no execution pages",
};

describe.each(MISSIONS)("the contract on $label", ({ id, input }) => {
  let r: MissionReplay;
  beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(input.readAt)); r = await replayMission(input); }, 240_000);
  afterAll(() => { vi.useRealTimers(); });

  it("the replay served every EXECUTION page from the stored ones (nothing invented); the only planning reads not served are the exposure reads of videos the live plan did not choose (the anonymised titles rank differently: the live videos are pinned)", () => {
    expect(r.unservedExecution).toBe(0);
    // CHANGED (round 20): the Facebook smoke's third page listing was REFUSED live (its call is stored as refused, so no page answers it); that call is the only other read allowed to stay unserved
    const refusedLive = (u: { endpointId: string; params: Record<string, unknown> }) => u.endpointId === "anyapi.facebook.user.posts" && u.params.cursor === "cur_i4fFhhf3mm6wbBBv9CSlxA";
    for (const u of r.unserved.filter((x) => !refusedLive(x))) expect(["VZqp9F8ed2s", "lLAE4Iy-JNI"]).toContain(String(u.params.video_id));
  });
  it("it delivered rows (a replay that delivers nothing proves nothing)", () => {
    const total = Object.values(r.rowsByStage).reduce((n, rows) => n + rows.length, 0);
    expect(total).toBeGreaterThan(0);
  });
  it("the contract ran (it did not fail on this plan)", () => { expect(r.built.contract.error).toBeUndefined(); });
  it("ZERO violations of R1 (one number), R2 (every gap stated), R3 (approximate dates marked), R4 (marks filled)", () => {
    expect(r.built.contract.violations.map(violationTextAr)).toEqual([]);
  });
  it("what was found to be missing is not completed behind the tests' back: the contract completed nothing on this file", () => {
    expect(r.built.contract.completed).toEqual([]);
  });
});

void storedRows;
