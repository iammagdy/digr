import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../agent/src/gateway";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { createMemorySpendGate } from "../src/lib/server/spendGate/gate";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { fakeRecorder, NOT_ADMIN, USER_ID, tregResult } from "./helpers/agentHarness";

/**
 * DT-20261119-11 Gate 2, F5: the smaller-amount ladder never tries another candidate until the release of the refused one is ACKNOWLEDGED; an unconfirmed release stops the ladder (one stale row at most, never several). No network.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const catalog = loadTregCatalog();
const T0 = Date.now();
const CLIENT = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({}) }), select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) }) };

function world(commitAnswers: Array<boolean | undefined>) {
  const store = createMemoryStore();
  store.missions.set("m", newMission({ id: "m", user_id: USER_ID, request_text: "x", status: "executing", job_id: "j" }));
  const rec = fakeRecorder({});
  const sg = createMemorySpendGate();
  // a grant that takes at most 0.05 per operation: the first (larger) amount is refused for room, so the ladder must release and go down
  sg.owner.issueGrant({ id: "g1", ceilingUsd: 1, perOpMaxUsd: 0.05, perMissionMaxUsd: 1, kinds: ["provider", "model"], opensAt: T0 - 60_000, closesAt: T0 + 3_600_000 } as never);
  const queue = [...commitAnswers];
  const commitCalls: number[] = [];
  const commit = vi.fn(async (client: unknown, args: Parameters<typeof rec.commit>[1]) => {
    const answer = queue.length ? queue.shift() : true;
    commitCalls.push(Number(args.costId));
    if (answer === false) return false; // the release was NOT acknowledged: the row stays pending
    await (rec.commit as any)(client, args);
    return answer ?? true;
  });
  const call = vi.fn(async (_o: TregCallOptions): Promise<TregCallResult> => tregResult([{ name: "A" }], 0.0198));
  const gateway = createGateway({ store, client: CLIENT, missionId: "m", userId: USER_ID, jobId: "j", phase: "execution", access: NOT_ADMIN, catalog, budget: createJobCallBudget({ ceilingUsd: 0.5, spentUsd: 0 }), recorder: rec.recorder, commit: commit as any, call, defaultPurpose: "x", counter: { seq: 0 }, spendGate: { gate: sg.gate, mode: "enforce" } } as any);
  const ask = () => gateway.tregCall({ endpoint_id: "findymail.search.employees", params: { website: "acme.example", job_titles: ["CEO"], count: 1 } });
  const pending = () => rec.rows.filter((r) => r.committedUsd === null).length;
  return { ask, call, rec, pending, commit, commitCalls };
}

describe("F5: the ladder never leaves a stale pending row behind a smaller candidate", () => {
  it("counter-case: releases acknowledged → the ladder goes down, the call goes out, no pending row is left", async () => {
    const w = world([]);
    expect((await w.ask()).ok).toBe(true);
    expect(w.call).toHaveBeenCalledTimes(1);
    expect(Number((w.call.mock.calls[0][0] as TregCallOptions).routeMaxCostUsd)).toBeLessThanOrEqual(0.05);
    expect(w.pending()).toBe(0);
  });
  it("one injected commit error: the release is tried once more and, acknowledged, the ladder continues; no pending row is left", async () => {
    const w = world([false]);
    expect((await w.ask()).ok).toBe(true);
    expect(w.pending()).toBe(0);
    expect(w.commitCalls[0]).toBe(w.commitCalls[1]); // the same row released twice, never abandoned
  });
  it("a release that stays unacknowledged STOPS the ladder: nothing is sent, no further candidate is tried (at most one stale row), and the call is refused", async () => {
    const w = world([false, false, false, false, false, false, false, false]);
    const r = await w.ask();
    expect(r).toMatchObject({ ok: false, refused: "spend_gate" });
    expect(w.call).not.toHaveBeenCalled();
    expect(w.rec.rows).toHaveLength(1); // no second reservation was made behind the stale one
    expect(w.pending()).toBe(1); // kept conservatively on the daily ledger, never zeroed without an acknowledgement
  });
});
