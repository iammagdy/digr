import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../agent/src/gateway";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { fakeRecorder, NOT_ADMIN, USER_ID, tregResult } from "./helpers/agentHarness";
vi.stubGlobal("fetch", () => { throw new Error("no network"); });
const catalog = loadTregCatalog();
const CLIENT = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({}) }), select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) }) };
const people = [{ name: "A" }];
function w(budgetUsd: number, call: (o: TregCallOptions) => Promise<TregCallResult>) {
  const store = createMemoryStore(); store.missions.set("m", newMission({ id: "m", user_id: USER_ID, request_text: "x", status: "executing", job_id: "j" }));
  const rec = fakeRecorder({ dailyCapUsd: 100 }); const budget = createJobCallBudget({ ceilingUsd: budgetUsd, spentUsd: 0 });
  const c = vi.fn(call);
  return { c, budget, rec, g: createGateway({ store, client: CLIENT, missionId: "m", userId: USER_ID, jobId: "j", phase: "execution", access: NOT_ADMIN, catalog, budget, recorder: rec.recorder, commit: rec.commit, call: c, defaultPurpose: "t", counter: { seq: 0 } }) };
}
const ask = (x: ReturnType<typeof w>, count = 3) => x.g.tregCall({ endpoint_id: "findymail.search.employees", params: { website: "a.example", job_titles: ["CEO"], count } });
const provider = (real: number) => async (o: TregCallOptions): Promise<TregCallResult> => (Number(o.routeMaxCostUsd) >= real - 1e-12 ? tregResult(people, real) : ({ ok: false, httpStatus: 402, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, isRouteMaxCost: true, isPlatformBalanceLow: false } as TregCallResult));
describe("MAIN-COMPATIBLE PROBES (same assertions on main and on the branch)", () => {
  it("P-a: findymail count 3 (real 0.0594) with 0.30 of approved money SUCCEEDS", async () => { const x = w(0.3, provider(0.0594)); expect((await ask(x)).ok).toBe(true); });
  it("P-b: the header sent is the money left (0.3), never the estimate", async () => { const x = w(0.3, provider(0.0198)); await ask(x, 1); expect(Number(x.c.mock.calls[0][0].routeMaxCostUsd)).toBe(0.3); });
  it("P-c: two calls in flight on 0.1: only ONE is sent (the other finds no money)", async () => { let rel!: () => void; const gate = new Promise<void>((r) => { rel = r; }); const x = w(0.1, async (o) => { await gate; return provider(0.0198)(o); }); const a = ask(x, 1); await new Promise((r) => setTimeout(r, 20)); const b = await ask(x, 1); rel(); await a; expect(x.c).toHaveBeenCalledTimes(1); expect(b.ok).toBe(false); });
  it("P-d: a timeout keeps the WHOLE money held (0.3), not the 0.0198 estimate", async () => { const x = w(0.3, async () => ({ ok: false, httpStatus: 0, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, error: "timeout", timedOut: true, isRouteMaxCost: false, isPlatformBalanceLow: false } as TregCallResult)); await ask(x, 1); expect(x.budget.spentUsd()).toBe(0.3); });
  it("P-e: 200 points of money (0.145454545…) are sent as 0.145454, never 0.145455", async () => { const x = w(200 * 0.1 / 55 * 0.4, provider(0.0198)); await ask(x, 1); expect(Number(x.c.mock.calls[0][0].routeMaxCostUsd)).toBe(0.145454); });
});
