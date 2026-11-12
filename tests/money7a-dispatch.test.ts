import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runMissionSafely, type RunnerDeps } from "../agent/src/runMission";
import { runClaimedSafely } from "../agent/src/stage4/dispatch";
import { isAddonMission } from "../agent/src/stage4/runAddon";
import { createWorker } from "../agent/src/worker";
import { addonRowOf } from "./helpers/addonWorld";
import { fakeMoneyClient } from "./helpers/agentMoney";

/**
 * MONEY PR 7a, PHASE 2B-1: THE DISPATCH OF THE WORKER. A claimed row whose plan has an `addon` key goes to the add-on runner; EVERY OTHER row goes to the mission runner exactly as it does today. With the Stage 4 flags unset (they
 * gate creation and approval, not the run) an ordinary mission is identical to what it is without the dispatch, and the add-on runner is never reached.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => vi.unstubAllGlobals());
const USER = "11111111-1111-4111-8111-111111111111";
const deps = { store: createMemoryStore(), client: fakeMoneyClient().client, models: { planning: "none", execution: "none" }, resolveAccess: async () => ({ isAdmin: false, verifiedBusiness: false }), log: () => undefined } as unknown as RunnerDeps;

describe("which row is an add-on", () => {
  it("only a plan with an `addon` key", () => {
    expect(isAddonMission(addonRowOf({}))).toBe(true);
    for (const m of [{ plan: null }, { plan: undefined }, {}, null, undefined, { plan: {} }, { plan: { stages: [], price: {} } }, { plan: "addon" as unknown }]) expect(isAddonMission(m as never)).toBe(false);
  });
});

describe("the dispatch", () => {
  const mission = (plan: unknown) => newMission({ id: "msn_x", user_id: USER, status: "executing", plan: plan as never });
  it("an add-on row goes to the add-on runner only, and an ordinary row to the mission runner only (with the same arguments)", async () => {
    const runners = { mission: vi.fn(async () => undefined), addon: vi.fn(async () => undefined) };
    const a = mission(addonRowOf({}).plan);
    await runClaimedSafely(deps, a, runners as never);
    expect(runners.addon).toHaveBeenCalledWith(deps, a);
    expect(runners.mission).not.toHaveBeenCalled();
    runners.addon.mockClear();
    for (const plan of [null, { stages: [], price: {} }]) {
      const m = mission(plan);
      await runClaimedSafely(deps, m, runners as never);
      expect(runners.mission).toHaveBeenLastCalledWith(deps, m);
    }
    expect(runners.addon).not.toHaveBeenCalled();
  });
  it("by default the runners are the real ones", async () => {
    // an ordinary row with no plan: the real mission runner ends it (failed: no approved plan), the add-on runner is not involved
    const store = createMemoryStore([newMission({ id: "msn_plain", user_id: USER, status: "executing", plan: null })]);
    await runClaimedSafely({ ...deps, store } as RunnerDeps, store.missions.get("msn_plain")!);
    expect(store.missions.get("msn_plain")).toMatchObject({ status: "failed", error: "the mission has no approved plan or reserve" });
  });
});

describe("with the flags unset an ordinary mission is identical with and without the dispatch, through the worker loop", () => {
  const norm = (v: unknown) => JSON.stringify(v).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>").replace(/w_[A-Za-z0-9_-]+/g, "<worker>");
  async function viaWorker(run: (d: RunnerDeps, m: never) => Promise<void>) {
    const store = createMemoryStore([
      newMission({ id: "msn_a", user_id: USER, status: "approved", plan: null, job_id: "job_a", reserved_points: 100, unit_price_points: 1 }),
      newMission({ id: "msn_b", user_id: USER, status: "approved", plan: { stages: [], price: {} } as never, job_id: null }),
    ]);
    const d = { ...deps, store } as RunnerDeps;
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", runMission: (m) => run(d, m as never), concurrency: 2 });
    const claimed = [await store.claimMission("w1", 120), await store.claimMission("w1", 120)];
    for (const m of claimed) if (m) await run(d, m as never);
    void worker;
    return { missions: [...store.missions.values()].map((m) => ({ id: m.id, status: m.status, error: m.error, worker_id: m.worker_id, lease_until: m.lease_until, charged_points: m.charged_points })), events: store.events.map((e) => [e.mission_id, e.kind, e.message_ar]), files: [...store.files.keys()].sort() };
  }
  it("the same missions, events and files", async () => {
    delete process.env.DIGER_STAGE4_REVIEW;
    delete process.env.DIGER_STAGE4_EDITS;
    const direct = await viaWorker((d, m) => runMissionSafely(d, m));
    const dispatched = await viaWorker((d, m) => runClaimedSafely(d, m));
    expect(norm(dispatched)).toBe(norm(direct));
    expect(direct.missions.some((m) => m.status === "failed")).toBe(true);
  });
});

describe("main.ts: the one small change", () => {
  const main = readFileSync(new URL("../agent/src/main.ts", import.meta.url), "utf8");
  it("the worker's run function is the dispatch; main.ts names no add-on module and no longer calls runMissionSafely itself", () => {
    // round 55: the dispatch gets the run's OWN view of the store (ownership.ts), still through runClaimedSafely only
    expect(main).toMatch(/runMission: async \(mission\) => \{/);
    expect(main).toMatch(/runClaimedSafely\(\{ \.\.\.deps\(\), store: view\.store, leaseLost: view\.revoked, ownerId: workerId, revokeOwnership \}, mission\)/);
    expect(main).toContain('from "./stage4/dispatch"');
    expect(main).not.toMatch(/import[^;]*runMissionSafely|runMissionSafely\(|runAddon|addonSettlement/);
    expect([...main.matchAll(/runClaimedSafely/g)]).toHaveLength(2);
  });
});
