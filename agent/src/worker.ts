import {
  AGENT_HEARTBEAT_INTERVAL_MS, AGENT_MISSION_LEASE_SECONDS, AGENT_POLL_INTERVAL_MS, AGENT_WORKER_CONCURRENCY,
} from "../../src/lib/agentMission/constants";
import { readMemory as readProcessMemory, type MemoryReading } from "./memory";
import type { AgentStore, MissionRecord } from "./types";

/**
 * THE WORKER LOOP. A long-running process (a Heroku worker dyno) that
 *  - polls Supabase for a mission to PLAN (`queued`) or EXECUTE (`approved`), at most AGENT_WORKER_CONCURRENCY at a time (default 1: AGENT_CONCURRENCY);
 *  - leases each mission it takes (agent_claim_mission) and renews every lease with each heartbeat, so a dead worker's mission is taken over when the lease ends;
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
  leaseSeconds?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export function createWorker(deps: WorkerDeps) {
  const concurrency = deps.concurrency ?? AGENT_WORKER_CONCURRENCY;
  const leaseSeconds = deps.leaseSeconds ?? AGENT_MISSION_LEASE_SECONDS;
  const now = deps.now ?? (() => new Date());
  const active = new Map<string, Promise<void>>();
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

  /** Takes missions while there is a free slot; returns how many it started. */
  async function tick(): Promise<number> {
    let started = 0;
    while (!stopping && active.size < concurrency) {
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
    activeCount: () => active.size,
    /** Resolves when every running mission has ended. */
    async idle(): Promise<void> { await Promise.all([...active.values()]); },
    stop(): void { stopping = true; },
    /** The production loop: a tick every poll interval, and a heartbeat on its OWN timer every 30 s (a slow poll never delays it), until stop(). */
    async run(options: { pollMs?: number; heartbeatMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
      const pollMs = options.pollMs ?? AGENT_POLL_INTERVAL_MS;
      const beatMs = options.heartbeatMs ?? AGENT_HEARTBEAT_INTERVAL_MS;
      const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      await heartbeat();
      const timer = setInterval(() => { void heartbeat(); }, beatMs);
      try {
        while (!stopping) {
          await tick();
          await sleep(pollMs);
        }
      } finally {
        clearInterval(timer);
      }
      await heartbeat();
    },
  };
}
