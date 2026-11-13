import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createWorker } from "../agent/src/worker";
import { assertOwned, ensureOwned, LeaseLostError, OwnershipUnverifiedError, ownedStore, STORE_WRITE_METHODS } from "../agent/src/ownership";
import { abortRunsOf, trackRun, untrackRun } from "../agent/src/sessions";
import { runMissionSafely, type RunnerDeps } from "../agent/src/runMission";
import type { MissionRecord } from "../agent/src/types";

/**
 * WORKER OWNERSHIP (round 55). A worker whose lease lapsed (a stall or a database outage over 120 s) kept writing a mission another worker had taken over through the
 * claim's expired-lease branch: `updateMission` filtered on the id only, and a renewal that matched no row went unnoticed. With concurrency above 1 the same worker
 * could even claim its own running mission again and start a SECOND run of it. These tests pin the fix (agent/src/ownership.ts, worker.ts, main.ts).
 */
const U = "00000000-0000-0000-0000-0000000000aa";
const mem = () => ({ rssMb: 150, treeRssMb: 200 });
const expire = (m: MissionRecord) => { m.lease_until = new Date(Date.now() - 1000).toISOString(); };

describe("ownedStore: a revoked run writes nothing", () => {
  it("before revoke every call passes; after revoke every write is refused, the note is dropped, reads go on", async () => {
    const base = createMemoryStore([newMission({ id: "msn_o", user_id: U, status: "executing", worker_id: "w1" })]);
    const view = ownedStore(base, "msn_o");
    await view.store.updateMission("msn_o", { summary_ar: "قبل" });
    expect(base.missions.get("msn_o")!.summary_ar).toBe("قبل");
    view.revoke();
    expect(view.revoked()).toBe(true);
    await expect(view.store.updateMission("msn_o", { status: "failed" })).rejects.toBeInstanceOf(LeaseLostError);
    await expect(view.store.putNew("msn_o", "items/x.json", "{}", "application/json")).rejects.toBeInstanceOf(LeaseLostError);
    await expect(view.store.putFile("msn_o", "x.json", "{}", "application/json")).rejects.toBeInstanceOf(LeaseLostError);
    const before = base.events.length;
    await expect(view.store.addEvent("msn_o", { kind: "system", message_ar: "x" })).resolves.toBeUndefined();
    expect(base.events.length).toBe(before);
    expect(base.missions.get("msn_o")!.status).toBe("executing"); // the new owner's row is untouched
    expect((await view.store.getMission("msn_o"))!.id).toBe("msn_o"); // reads go on
  });

  it("covers every write method of the store interface", () => {
    const iface = readFileSync(path.join(__dirname, "..", "agent", "src", "types.ts"), "utf8").split("export interface AgentStore {")[1].split("\n}")[0];
    const methods = [...iface.matchAll(/^\s{2}(\w+)\??\(/gm)].map((m) => m[1]);
    const reads = new Set(["listFiles", "getFile", "getFileBytes", "listCalls", "recentCalls", "getMission", "readSettings", "readUserEmail", "addEvent"]);
    expect(methods.filter((m) => !reads.has(m)).sort()).toEqual([...STORE_WRITE_METHODS].sort());
  });
});

describe("the money guard", () => {
  it("assertOwned throws only once the run lost its mission", () => {
    expect(() => assertOwned(undefined, "m")).not.toThrow();
    expect(() => assertOwned(() => false, "m")).not.toThrow();
    expect(() => assertOwned(() => true, "m")).toThrow(LeaseLostError);
  });

  it("ensureOwned: another worker's row revokes and throws; this worker passes; no worker or an unreadable row is REFUSED (round 56: fail-closed)", async () => {
    const store = createMemoryStore([newMission({ id: "msn_m", user_id: U, status: "executing", worker_id: "w2" })]);
    let revoked = 0;
    const deps = { store, ownerId: "w1", leaseLost: () => false, revokeOwnership: () => { revoked += 1; } };
    await expect(ensureOwned(deps, "msn_m")).rejects.toBeInstanceOf(LeaseLostError); // the heartbeat has not noticed yet: the row decides
    expect(revoked).toBe(1);
    store.missions.get("msn_m")!.worker_id = "w1";
    await expect(ensureOwned(deps, "msn_m")).resolves.toBeUndefined();
    store.missions.get("msn_m")!.worker_id = null;
    await expect(ensureOwned(deps, "msn_m")).rejects.toBeInstanceOf(OwnershipUnverifiedError);
    await expect(ensureOwned({ ...deps, leaseLost: () => true }, "msn_m")).rejects.toBeInstanceOf(LeaseLostError);
    store.missions.get("msn_m")!.worker_id = "w1";
    store.renewLeases = async () => { throw new Error("db down"); };
    store.getMission = async () => { throw new Error("db down"); };
    await expect(ensureOwned(deps, "msn_m")).rejects.toBeInstanceOf(OwnershipUnverifiedError);
  });

  it("every settlement call in the worker is guarded on the line before it", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
    walk(path.join(__dirname, "..", "agent", "src"));
    let calls = 0;
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => {
        if (!/\bawait (settleMission|settleAddon)\(/.test(l)) return;
        calls += 1;
        expect(lines[i - 1], `${path.basename(f)}:${i + 1} settles without assertOwned on the line before`).toMatch(/await ensureOwned\(deps, /);
      });
    }
    expect(calls).toBe(5);
  });
});

describe("the worker finds a mission it lost", () => {
  it("another worker took the mission over: onLeaseLost once, with the new owner", async () => {
    const store = createMemoryStore([newMission({ id: "msn_A", user_id: U, status: "queued" })]);
    const lost: Array<[string, string]> = []; const logs: string[] = [];
    const w1 = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", readMemory: mem, runMission: () => new Promise(() => undefined), onLeaseLost: (id, owner) => lost.push([id, owner]), log: (l) => logs.push(l) });
    expect(await w1.tick()).toBe(1);
    await w1.heartbeat();
    expect(lost).toEqual([]); // still ours: renewed
    expire(store.missions.get("msn_A")!); // w1 stalled past its lease
    expect(await store.claimMission("w2", 120)).toMatchObject({ id: "msn_A", worker_id: "w2" });
    await w1.heartbeat();
    expect(lost).toEqual([["msn_A", "w2"]]);
    expect(logs.some((l) => l.startsWith("lease_lost msn_A now w2"))).toBe(true);
    await w1.heartbeat();
    expect(lost).toHaveLength(1); // reported once
  });

  it("our own run released the mission (no worker on the row): not a loss", async () => {
    const store = createMemoryStore([newMission({ id: "msn_B", user_id: U, status: "queued" })]);
    const lost: string[] = [];
    const w1 = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", readMemory: mem, runMission: () => new Promise(() => undefined), onLeaseLost: (id) => lost.push(id) });
    await w1.tick();
    await store.updateMission("msn_B", { status: "completed", worker_id: null, lease_until: null }); // the run's final write; it has not returned yet
    await w1.heartbeat();
    expect(lost).toEqual([]);
  });

  it("a store that cannot tell which leases it renewed never reports a loss", async () => {
    const store = createMemoryStore([newMission({ id: "msn_C", user_id: U, status: "queued" })]);
    store.renewLeases = async () => undefined;
    const lost: string[] = [];
    const w1 = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", readMemory: mem, runMission: () => new Promise(() => undefined), onLeaseLost: (id) => lost.push(id) });
    await w1.tick();
    store.missions.get("msn_C")!.worker_id = "w2";
    await w1.heartbeat();
    expect(lost).toEqual([]);
  });
});

describe("a worker never runs the same mission twice", () => {
  it("its own lapsed mission claimed again is not started a second time", async () => {
    const store = createMemoryStore([newMission({ id: "msn_D", user_id: U, status: "queued" })]);
    let starts = 0; const logs: string[] = [];
    const w1 = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", concurrency: 2, readMemory: mem, runMission: () => { starts += 1; return new Promise(() => undefined); }, log: (l) => logs.push(l) });
    expect(await w1.tick()).toBe(1);
    expire(store.missions.get("msn_D")!);
    expect(await w1.tick()).toBe(0);
    expect(starts).toBe(1);
    expect(w1.activeCount()).toBe(1);
    expect(logs.some((l) => l.startsWith("reclaimed_own msn_D"))).toBe(true);
    expect(store.missions.get("msn_D")).toMatchObject({ worker_id: "w1", status: "planning" }); // ours again, with a fresh lease
  });
});

describe("a lost run's error recovery writes nothing", () => {
  const failingRun = (leaseLost: boolean) => {
    const store = createMemoryStore([newMission({ id: "msn_E", user_id: U, status: "planning", worker_id: "w1", lease_until: new Date(Date.now() + 60_000).toISOString() })]);
    const writes: string[] = [];
    const update = store.updateMission.bind(store);
    store.updateMission = async (id, patch) => { writes.push(String(patch.status ?? "")); return update(id, patch); };
    store.getFile = async () => { throw new Error("storage down"); }; // the planning run fails at once
    const deps = { store, client: null, catalog: [], log: () => undefined, leaseLost: () => leaseLost } as unknown as RunnerDeps;
    return { store, writes, run: () => runMissionSafely(deps, store.missions.get("msn_E")!) };
  };
  it("owned: the failed run is recovered (control)", async () => {
    const r = failingRun(false);
    await r.run();
    expect(r.writes.length).toBeGreaterThan(0);
  });
  it("lost: no recovery write at all", async () => {
    const r = failingRun(true);
    await r.run();
    expect(r.writes).toEqual([]);
    expect(r.store.missions.get("msn_E")!.status).toBe("planning");
  });
});

describe("only the lost mission's run is stopped", () => {
  it("abortRunsOf stops that mission's runs and no other", () => {
    const a = trackRun("msn_a"); const b = trackRun("msn_b"); const anon = trackRun();
    try {
      expect(abortRunsOf("msn_a", "lease_lost")).toBe(1);
      expect(a.abort.signal.aborted).toBe(true);
      expect(a.reason.value).toBe("lease_lost");
      expect(b.abort.signal.aborted).toBe(false);
      expect(anon.abort.signal.aborted).toBe(false);
    } finally { untrackRun(a); untrackRun(b); untrackRun(anon); }
  });
});
