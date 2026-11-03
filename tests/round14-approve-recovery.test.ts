import { describe, expect, it } from "vitest";
import { APPROVE_UNKNOWN_AR, approveWithRecovery, type ApproveDeps } from "../src/lib/missionApprove";
import { checkCustomerText } from "../src/lib/agentMission/text";

/** ROUND 14, item 4: the approve click recovers from a first request that fails before the money step. */
const make = (posts: Array<{ status: number; body: { success?: boolean; error?: string } | null } | null | "throw">, approved: Array<boolean | null> = []) => {
  const log: string[] = [];
  const queue = [...posts];
  const reads = [...approved];
  const deps: ApproveDeps = {
    post: async () => { log.push("post"); const n = queue.shift(); if (n === "throw") throw new Error("Failed to fetch"); return n ?? null; },
    refreshSession: async () => { log.push("refresh"); },
    isApproved: async () => { log.push("read"); return reads.length ? reads.shift()! : null; },
    sleep: async () => { log.push("sleep"); },
  };
  return { deps, log };
};

describe("the approve click", () => {
  it("a first request that works is one request and nothing else", async () => {
    const { deps, log } = make([{ status: 200, body: { success: true } }]);
    expect(await approveWithRecovery(deps)).toEqual({ ok: true, viaRead: false });
    expect(log).toEqual(["post"]);
  });
  it("a first request that never completes (the live «browser error») is retried ONCE with a fresh session, and the second works: the customer sees one click succeed", async () => {
    const { deps, log } = make(["throw", { status: 200, body: { success: true } }]);
    expect(await approveWithRecovery(deps)).toEqual({ ok: true, viaRead: false });
    expect(log).toEqual(["post", "refresh", "sleep", "post"]);
  });
  it("a 401 (the session was being refreshed, no token went out) is retried once the same way", async () => {
    const { deps, log } = make([{ status: 401, body: { success: false, error: "غير مصرح" } }, { status: 200, body: { success: true } }]);
    expect((await approveWithRecovery(deps)).ok).toBe(true);
    expect(log).toEqual(["post", "refresh", "sleep", "post"]);
  });
  it("«already approved» (409) means the first request got through: the mission is read and the click is a success", async () => {
    const { deps } = make([{ status: 409, body: { success: false, error: "هذه المهمة معتمدة وتعمل بالفعل." } }], [true]);
    expect(await approveWithRecovery(deps)).toEqual({ ok: true, viaRead: true });
  });
  it("a business refusal (402, balance) is final: no retry, and its own Arabic words", async () => {
    const { deps, log } = make([{ status: 402, body: { success: false, error: "رصيدك لا يكفي لحجز هذه المهمة." } }], [false]);
    const r = await approveWithRecovery(deps);
    expect(r).toEqual({ ok: false, error: "رصيدك لا يكفي لحجز هذه المهمة.", retriable: false });
    expect(log).not.toContain("refresh");
  });
  it("two failed requests and a mission that still waits: «nothing was held» is told; when the mission cannot be read, nothing is promised", async () => {
    const waiting = make(["throw", "throw"], [false]);
    expect((await approveWithRecovery(waiting.deps)) as { ok: boolean; error: string }).toMatchObject({ ok: false, error: "تعذّر اعتماد الخطة الآن؛ حاول بعد قليل. لم يُخصم شيء." });
    const unknown = make(["throw", "throw"], [null]);
    expect(await approveWithRecovery(unknown.deps)).toEqual({ ok: false, error: APPROVE_UNKNOWN_AR, retriable: true });
    expect(APPROVE_UNKNOWN_AR).not.toContain("لم يُخصم");
    expect(checkCustomerText(APPROVE_UNKNOWN_AR, { maxChars: 400 }).issues).toEqual([]);
  });
  it("two failed requests but the mission is running: it WAS approved, so it is a success", async () => {
    const { deps } = make(["throw", "throw"], [true]);
    expect(await approveWithRecovery(deps)).toEqual({ ok: true, viaRead: true });
  });
});
