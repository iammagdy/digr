import { describe, expect, it } from "vitest";
import { AGENT_HEARTBEAT_HISTORY_EVERY_MS } from "../src/lib/agentMission/constants";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createWorker } from "../agent/src/worker";

/**
 * THE HEARTBEAT ROW IS ONE PER WORKER AND IS OVERWRITTEN: it only says «now». The worker also writes one small create-only object every five minutes under `_worker/heartbeat/` (no SQL), with the reading in its NAME, so the
 * history (worker, rss, tree, active missions) reads with a SELECT on the objects' names after the fact: the memory of last night, the worker that served a mission.
 */
describe("the worker keeps a short heartbeat history without any SQL", () => {
  const worker = (store: ReturnType<typeof createMemoryStore>, clock: { t: number }, mem = { rssMb: 231, treeRssMb: 298 }) =>
    createWorker({ store, workerId: "w_worker.1_88cac1e1", version: "v1", modelLabel: () => "m", runMission: () => new Promise(() => undefined), now: () => new Date(clock.t), readMemory: () => mem, memoryAdmitLimitMb: 500 });

  it("one object per five minutes, named with the reading; more beats in the same five minutes write nothing more", async () => {
    const store = createMemoryStore([newMission({ id: "msn_w0", user_id: "u", status: "queued" })]);
    const clock = { t: Date.parse("2026-10-29T04:42:10Z") };
    const w = worker(store, clock);
    await w.tick();
    await w.heartbeat();
    clock.t += 30_000; await w.heartbeat();
    clock.t += 30_000; await w.heartbeat();
    let names = (await store.listFiles("_worker", "heartbeat")).map((f) => f.name);
    expect(names).toHaveLength(1);
    expect(names[0]).toBe("heartbeat/2026-10-29T04-40-00-000Z_w_worker.1_88cac1e1_r231_t298_a1.json");
    // the next five-minute slot writes the next object, with the reading of that moment
    clock.t = Date.parse("2026-10-29T04:46:00Z");
    await w.heartbeat();
    names = (await store.listFiles("_worker", "heartbeat")).map((f) => f.name);
    expect(names).toHaveLength(2);
    expect(names[1]).toContain("2026-10-29T04-45-00-000Z");
    const body = JSON.parse((await store.getFile("_worker", names[0]))!);
    expect(body).toMatchObject({ worker: "w_worker.1_88cac1e1", rss_mb: 231, tree_rss_mb: 298, active: 1, version: "v1" });
    expect(AGENT_HEARTBEAT_HISTORY_EVERY_MS).toBe(300_000);
    // the row itself is still the one overwritten reading
    expect(store.heartbeats.length).toBeGreaterThan(2);
  });

  it("a tree that cannot be measured is written as «x»; a store that refuses the object never stops the heartbeat", async () => {
    const store = createMemoryStore();
    const clock = { t: Date.parse("2026-10-29T05:00:00Z") };
    const w = worker(store, clock, { rssMb: 200, treeRssMb: null as unknown as number });
    await w.heartbeat();
    expect((await store.listFiles("_worker", "heartbeat"))[0].name).toContain("_r200_tx_a0.json");
    const broken = createMemoryStore();
    broken.putNew = async () => { throw new Error("storage down"); };
    clock.t += 600_000;
    await worker(broken, clock).heartbeat();
    expect(broken.heartbeats).toHaveLength(1);
  });
});
