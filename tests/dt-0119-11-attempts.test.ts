import { describe, expect, it, vi } from "vitest";

// the client can make 4 requests (the call and 3 key-pool hops): the money of a call is reserved for each of them (D1)
vi.mock("../src/functions/shared/tregClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/functions/shared/tregClient")>()), maxTregAttempts: (o: { token?: string; singleAttempt?: boolean }) => (o.token || o.singleAttempt ? 1 : 4) }));

import { createGateway } from "../agent/src/gateway";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { createMemorySpendGate } from "../src/lib/server/spendGate/gate";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { TregCallOptions } from "../src/functions/shared/tregClient";
import { fakeRecorder, NOT_ADMIN, USER_ID, tregResult } from "./helpers/agentHarness";

const catalog = loadTregCatalog();
const T0 = Date.now();
const CLIENT = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({}) }), select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) }) };
function run(o: { budgetUsd: number; withGate?: boolean }) {
  const store = createMemoryStore();
  store.missions.set("m1", newMission({ id: "m1", user_id: USER_ID, request_text: "x", status: "executing", job_id: "j1" }));
  const rec = fakeRecorder({ dailyCapUsd: 100 });
  const budget = createJobCallBudget({ ceilingUsd: o.budgetUsd, spentUsd: 0 });
  const sg = createMemorySpendGate();
  sg.owner.issueGrant({ id: "g1", ceilingUsd: 5, perOpMaxUsd: 1, perMissionMaxUsd: 5, kinds: ["provider"], opensAt: T0 - 60_000, closesAt: T0 + 3_600_000 } as never);
  const reserves: number[] = [];
  const gate = { ...sg.gate, reserve: async (req: Parameters<typeof sg.gate.reserve>[0]) => { reserves.push(req.boundUsd); return sg.gate.reserve(req); } };
  const seen: { opts: TregCallOptions; held: number | null; daily: number }[] = [];
  const call = vi.fn(async (opts: TregCallOptions) => { seen.push({ opts, held: budget.leftUsd(0), daily: rec.rows[0]?.reservedUsd ?? 0 }); return tregResult([{ name: "A" }], 0.0198); });
  const gateway = createGateway({ store, client: CLIENT, missionId: "m1", userId: USER_ID, jobId: "j1", phase: "execution", access: NOT_ADMIN, catalog, budget, recorder: rec.recorder, commit: rec.commit, call, defaultPurpose: "t", counter: { seq: 0 }, ...(o.withGate ? { spendGate: { gate, mode: "enforce" as const } } : {}) });
  return { gateway, seen, reserves, budget, rec };
}
const ask = (g: ReturnType<typeof run>) => g.gateway.tregCall({ endpoint_id: "findymail.search.employees", params: { website: "acme.example", job_titles: ["CEO"], count: 1 } });

describe("key-pool hops: attempts x header is reserved on EVERY ledger, or the call makes one request (R3)", () => {
  it("0.4 of money, 4 possible requests: H is capped at 20 x the estimate (0.396), the header is 0.099 and 0.396 is held on the job, the daily ledger and the owner's grant before the request", async () => {
    const r = run({ budgetUsd: 0.4, withGate: true });
    expect((await ask(r)).ok).toBe(true);
    expect(Number(r.seen[0].opts.routeMaxCostUsd)).toBe(0.099);
    expect(r.seen[0].held).toBeCloseTo(0.004, 6); // 0.396 of the 0.4 is held while the call runs
    expect(r.seen[0].daily).toBe(0.396);
    expect(r.reserves).toEqual([0.396]);
    expect(r.seen[0].opts.singleAttempt).toBeUndefined();
  });
  it("money that does not stretch to every request for the call's own estimate: ONE request with all of it, and the client is told not to hop", async () => {
    const r = run({ budgetUsd: 0.05, withGate: true });
    expect((await ask(r)).ok).toBe(true);
    expect(Number(r.seen[0].opts.routeMaxCostUsd)).toBe(0.05);
    expect(r.seen[0].opts.singleAttempt).toBe(true);
    expect(r.reserves).toEqual([0.05]);
  });
});
