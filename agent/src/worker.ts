import {
  AGENT_HEARTBEAT_INTERVAL_MS, AGENT_MEMORY_ADMIT_LIMIT_MB, AGENT_MEMORY_HARD_LIMIT_MB, AGENT_MEMORY_WATCH_MS, AGENT_MISSION_LEASE_SECONDS, AGENT_POLL_INTERVAL_MS, AGENT_WORKER_CONCURRENCY,
} from "../../src/lib/agentMission/constants";
import { readMemory as readProcessMemory, type MemoryReading } from "./memory";
import type { AgentStore, MissionRecord } from "./types";

/**
 * THE WORKER LOOP. A long-running process (a Heroku worker dyno) that
 *  - polls Supabase for a mission to PLAN (`queued`) or EXECUTE (`approved`), at most AGENT_WORKER_CONCURRENCY at a time (default 1: AGENT_CONCURRENCY);
 *  - leases each mission it takes (agent_claim_mission) and renews every lease with each heartbeat, so a dead worker's mission is taken over when the lease ends;
 *  - takes NO new mission while the memory of the worker and its processes is at or above AGENT_MEMORY_ADMIT_LIMIT_MB (the mission stays queued, nothing is leased; it starts when the memory falls), and
 *    watches the memory of a running mission: at AGENT_MEMORY_HARD_LIMIT_MB it calls `onMemoryPressure` (the entry point stops the model run and the mission goes back to the queue) BEFORE the platform kills the dyno;
 *  - writes a heartbeat row every 30 seconds, with the memory it uses (rss_mb and tree_rss_mb) (the admin page calls the worker alive while the last beat is younger than 90 seconds).
 * It is written over an injected store, run function and clock, so the tests drive it with no database and no timers.
 */
export interface WorkerDeps {
  store: AgentStore;
  workerId: string;
  version: string;
  /** The model name shown on the heartbeat. */
  modelLabel: () => string;
  /** Plans or executes one claimed mission, by its status (`planning` or `executing`). Must not throw. */
  runMission: (mission: MissionRecord) => Promise<void>;
  /** How many missions at once (the entry point passes AGENT_CONCURRENCY; default 1). */
  concurrency?: number;
  /** Memory reading for the heartbeat row; defaults to the real process. */
  readMemory?: () => MemoryReading;
  /** A new mission is not taken at or above this tree memory (MB). */
  memoryAdmitLimitMb?: number;
  /** A running mission is stopped at or above this tree memory (MB). */
  memoryHardLimitMb?: number;
  /** Called (once per reading above the hard limit) while a mission runs: stop the model run so the mission can be put back in the queue. */
  onMemoryPressure?: (reading: MemoryReading) => void;
  leaseSeconds?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export function createWorker(deps: WorkerDeps) {
  const concurrency = deps.concurrency ?? AGENT_WORKER_CONCURRENCY;
  const leaseSeconds = deps.leaseSeconds ?? AGENT_MISSION_LEASE_SECONDS;
  const now = deps.now ?? (() => new Date());
  const active = new Map<string, Promise<void>>();
  const readMem = () => (deps.readMemory ?? readProcessMemory)();
  const admitLimit = deps.memoryAdmitLimitMb ?? AGENT_MEMORY_ADMIT_LIMIT_MB;
  const hardLimit = deps.memoryHardLimitMb ?? AGENT_MEMORY_HARD_LIMIT_MB;
  /** What the dyno counts: the worker and the processes it started; the worker alone where the tree cannot be read. */
  const usedMb = (m: MemoryReading) => (m.treeRssMb !== null && Number.isFinite(m.treeRssMb) ? m.treeRssMb : m.rssMb);
  let waitingForMemory = false;
  let stopping = false;

  async function heartbeat(): Promise<void> {
    try {
      const memory = (deps.readMemory ?? readProcessMemory)();
      await deps.store.writeHeartbeat({ worker_id: deps.workerId, beat_at: now().toISOString(), active_missions: active.size, model: deps.modelLabel(), version: deps.version, rss_mb: memory.rssMb, tree_rss_mb: memory.treeRssMb });
      await deps.store.renewLeases(deps.workerId, leaseSeconds);
    } catch (e) {
      deps.log?.(`heartbeat_failed ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }

  /** True while the memory is too high to start another mission (logged once per wait). */
  function memoryBlocksAdmission(): boolean {
    let reading: MemoryReading;
    try { reading = readMem(); } catch { return false; }
    const blocked = usedMb(reading) >= admitLimit;
    if (blocked && !waitingForMemory) deps.log?.(`memory_wait tree=${usedMb(reading)}MB limit=${admitLimit}MB: no new mission is taken until it falls`);
    if (!blocked && waitingForMemory) deps.log?.(`memory_ok tree=${usedMb(reading)}MB: taking missions again`);
    waitingForMemory = blocked;
    return blocked;
  }

  /** While a mission runs: at the hard limit the entry point is told to stop the model run (the mission goes back to the queue). Returns whether the limit was reached. */
  function watchMemory(): boolean {
    if (active.size === 0) return false;
    let reading: MemoryReading;
    try { reading = readMem(); } catch { return false; }
    if (usedMb(reading) < hardLimit) return false;
    deps.log?.(`memory_pressure tree=${usedMb(reading)}MB limit=${hardLimit}MB: stopping the running mission so it can wait in the queue`);
    try { deps.onMemoryPressure?.(reading); } catch { /* the stop is best effort */ }
    return true;
  }

  /** Takes missions while there is a free slot; returns how many it started. */
  async function tick(): Promise<number> {
    let started = 0;
    while (!stopping && active.size < concurrency) {
      // a mission that would not fit in the memory stays queued: nothing is leased, nothing is started
      if (memoryBlocksAdmission()) break;
      let mission: MissionRecord | null = null;
      try {
        mission = await deps.store.claimMission(deps.workerId, leaseSeconds);
      } catch (e) {
        deps.log?.(`claim_failed ${String((e as Error)?.message ?? e).slice(0, 120)}`);
        break;
      }
      if (!mission) break;
      const run = deps.runMission(mission).catch((e) => deps.log?.(`mission_crashed ${mission!.id} ${String((e as Error)?.message ?? e).slice(0, 160)}`)).finally(() => { active.delete(mission!.id); });
      active.set(mission.id, run);
      started += 1;
    }
    return started;
  }

  return {
    heartbeat,
    tick,
    watchMemory,
    /** True while a new mission is held back for want of memory. */
    waitingForMemory: () => waitingForMemory,
    activeCount: () => active.size,
    /** Resolves when every running mission has ended. */
    async idle(): Promise<void> { await Promise.all([...active.values()]); },
    stop(): void { stopping = true; },
    /** The production loop: a tick every poll interval, and a heartbeat on its OWN timer every 30 s (a slow poll never delays it), until stop(). */
    async run(options: { pollMs?: number; heartbeatMs?: number; watchMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
      const pollMs = options.pollMs ?? AGENT_POLL_INTERVAL_MS;
      const beatMs = options.heartbeatMs ?? AGENT_HEARTBEAT_INTERVAL_MS;
      const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      await heartbeat();
      const timer = setInterval(() => { void heartbeat(); }, beatMs);
      const watcher = setInterval(() => { watchMemory(); }, options.watchMs ?? AGENT_MEMORY_WATCH_MS);
      watcher.unref?.();
      try {
        while (!stopping) {
          await tick();
          await sleep(pollMs);
        }
      } finally {
        clearInterval(timer);
        clearInterval(watcher);
      }
      await heartbeat();
    },
  };
}
