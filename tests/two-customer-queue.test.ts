import { describe, expect, it } from "vitest";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createWorker } from "../agent/src/worker";
import type { MissionRecord } from "../agent/src/types";

/**
 * TWO CUSTOMERS SUBMIT AT THE SAME TIME (Heroku capacity audit, 12 Nov 2026). Simulated with the real worker loop (createWorker) and the
 * in-memory store, whose claim mirrors the live `agent_claim_mission` (FIFO by created_at, FOR UPDATE SKIP LOCKED, 120 s lease):
 *  - one worker at the production concurrency (1): the second customer waits for the first mission, then BOTH complete, each run exactly once;
 *  - a worker that dies mid-mission: its lease runs out and the next worker finishes the mission (no stuck mission);
 *  - two worker processes against one queue: they never run the same mission.
 * No model, provider, database or Heroku call is made.
 */
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A runMission whose missions finish only when the test says so; records every start. */
function controlledRuns(store: ReturnType<typeof createMemoryStore>) {
  const starts: Array<{ id: string; worker: string; phase: string }> = [];
  const finish = new Map<string, () => void>();
  const runFor = (worker: string) => (m: MissionRecord) => new Promise<void>((resolve) => {
    starts.push({ id: m.id, worker, phase: m.status });
    finish.set(m.id, () => { void store.updateMission(m.id, { status: "completed", lease_until: null }).then(() => resolve()); });
  });
  return { starts, finish, runFor };
}

describe("two customers submit missions at the same time", () => {
  it("one worker at concurrency 1: B waits for A (head-of-line), then both complete, each started exactly once", async () => {
    const store = createMemoryStore([newMission({ id: "msn_A", user_id: A, status: "queued" }), newMission({ id: "msn_B", user_id: B, status: "queued" })]);
    const runs = controlledRuns(store);
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", runMission: runs.runFor("w1"), readMemory: () => ({ rssMb: 150, treeRssMb: 200 }) });

    expect(await worker.tick()).toBe(1);
    expect(store.missions.get("msn_A")!.status).toBe("planning");
    expect(store.missions.get("msn_B")!.status).toBe("queued"); // B waits: the only slot is A's
    expect(await worker.tick()).toBe(0);

    runs.finish.get("msn_A")!();
    await flush(); await flush();
    expect(await worker.tick()).toBe(1);
    expect(store.missions.get("msn_B")!.status).toBe("planning");
    runs.finish.get("msn_B")!();
    await worker.idle();

    expect([...store.missions.values()].map((m) => m.status)).toEqual(["completed", "completed"]);
    expect(runs.starts.map((s) => s.id)).toEqual(["msn_A", "msn_B"]); // FIFO, no duplicate start
  });

  it("with concurrency 2 both customers start at once (what a second slot buys)", async () => {
    const store = createMemoryStore([newMission({ id: "msn_A", user_id: A, status: "queued" }), newMission({ id: "msn_B", user_id: B, status: "queued" })]);
    const runs = controlledRuns(store);
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", concurrency: 2, runMission: runs.runFor("w1"), readMemory: () => ({ rssMb: 150, treeRssMb: 200 }) });
    expect(await worker.tick()).toBe(2);
    runs.finish.get("msn_B")!(); runs.finish.get("msn_A")!();
    await worker.idle();
    expect([...store.missions.values()].every((m) => m.status === "completed")).toBe(true);
    expect(runs.starts).toHaveLength(2);
  });

  it("while memory is at the admission limit nothing is claimed: both missions stay queued with no lease (never stuck in planning)", async () => {
    const store = createMemoryStore([newMission({ id: "msn_A", user_id: A, status: "queued" }), newMission({ id: "msn_B", user_id: B, status: "queued" })]);
    const runs = controlledRuns(store);
    let tree = 340; // the measured idle tree right after a Heroku boot (memory_wait tree=339MB limit=300MB)
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", runMission: runs.runFor("w1"), readMemory: () => ({ rssMb: 150, treeRssMb: tree }) });
    expect(await worker.tick()).toBe(0);
    expect([...store.missions.values()].map((m) => [m.status, m.lease_until])).toEqual([["queued", null], ["queued", null]]);
    tree = 290;
    expect(await worker.tick()).toBe(1);
    expect(runs.starts.map((s) => s.id)).toEqual(["msn_A"]);
  });

  it("a worker that dies mid-mission: the lease runs out, the next worker finishes it, then the other customer's mission", async () => {
    const store = createMemoryStore([newMission({ id: "msn_A", user_id: A, status: "queued" }), newMission({ id: "msn_B", user_id: B, status: "queued" })]);
    const runs = controlledRuns(store);
    const dead = createWorker({ store, workerId: "w_old", version: "t", modelLabel: () => "m", runMission: runs.runFor("w_old"), readMemory: () => ({ rssMb: 150, treeRssMb: 200 }) });
    expect(await dead.tick()).toBe(1);
    // the dyno is killed (no SIGTERM requeue): nothing renews the lease; 120 s later it has expired
    store.missions.get("msn_A")!.lease_until = new Date(Date.now() - 1000).toISOString();

    const next = createWorker({ store, workerId: "w_new", version: "t", modelLabel: () => "m", runMission: runs.runFor("w_new"), readMemory: () => ({ rssMb: 150, treeRssMb: 200 }) });
    expect(await next.tick()).toBe(1);
    expect(store.missions.get("msn_A")).toMatchObject({ worker_id: "w_new", status: "planning" });
    runs.finish.get("msn_A")!();
    await flush(); await flush();
    expect(await next.tick()).toBe(1);
    runs.finish.get("msn_B")!();
    await next.idle();
    expect([...store.missions.values()].map((m) => m.status)).toEqual(["completed", "completed"]);
    expect(runs.starts.map((s) => `${s.id}@${s.worker}`)).toEqual(["msn_A@w_old", "msn_A@w_new", "msn_B@w_new"]);
  });

  it("two worker processes on one queue never run the same mission", async () => {
    const store = createMemoryStore([newMission({ id: "msn_A", user_id: A, status: "queued" }), newMission({ id: "msn_B", user_id: B, status: "approved", job_id: "job_b" })]);
    const runs = controlledRuns(store);
    const w1 = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", runMission: runs.runFor("w1"), readMemory: () => ({ rssMb: 150, treeRssMb: 200 }) });
    const w2 = createWorker({ store, workerId: "w2", version: "t", modelLabel: () => "m", runMission: runs.runFor("w2"), readMemory: () => ({ rssMb: 150, treeRssMb: 200 }) });
    const [n1, n2] = await Promise.all([w1.tick(), w2.tick()]);
    expect(n1 + n2).toBe(2);
    expect(new Set(runs.starts.map((s) => s.id)).size).toBe(2);
    expect(new Set(runs.starts.map((s) => s.worker)).size).toBe(2);
    expect(await w1.tick()).toBe(0);
    expect(await w2.tick()).toBe(0);
  });
});
