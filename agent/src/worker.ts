import {
  AGENT_HEARTBEAT_HISTORY_EVERY_MS, AGENT_HEARTBEAT_HISTORY_FOLDER, AGENT_HEARTBEAT_HISTORY_SPACE, AGENT_HEARTBEAT_INTERVAL_MS, AGENT_MEMORY_ADMIT_LIMIT_MB, AGENT_MEMORY_HARD_LIMIT_MB, AGENT_MEMORY_RECYCLE_AFTER_MS, AGENT_MEMORY_RECYCLE_MIN_UPTIME_MS, AGENT_MEMORY_WATCH_MS, AGENT_MISSION_LEASE_SECONDS, AGENT_POLL_INTERVAL_MS, AGENT_WORKER_CONCURRENCY,
} from "../../src/lib/agentMission/constants";
import { readMemory as readProcessMemory, type MemoryReading } from "./memory";
import type { AgentStore, MissionRecord } from "./types";

/**
 * THE WORKER LOOP. A long-running process (a Heroku worker dyno) that
 *  - polls Supabase for a mission to PLAN (`queued`) or EXECUTE (`approved`), at most AGENT_WORKER_CONCURRENCY at a time (default 1: AGENT_CONCURRENCY);
 *  - leases each mission it takes (agent_claim_mission) and renews, with each heartbeat, the lease of EXACTLY the missions it is running in memory right now: a mission this worker no longer runs (it ended, crashed, or the
 *    worker restarted and a new one has another id) is not renewed, its lease ends and another run takes it over;
 *  - records the real peak memory of every run (the worker, and the worker with its processes) as an internal event of the mission (admin only);
 *  - takes NO new mission while the memory of the worker and its processes is at or above AGENT_MEMORY_ADMIT_LIMIT_MB (the mission stays queued, nothing is leased; it starts when the memory falls), and
 *    an IDLE worker (up for at least AGENT_MEMORY_RECYCLE_MIN_UPTIME_MS) that stays at or above that limit for AGENT_MEMORY_RECYCLE_AFTER_MS asks to be restarted (`onRecycle`) so the queue never waits for ever on a swollen heap; it
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
  /** Called once when the IDLE worker has stayed at or above the admit limit for the recycle time: the entry point stops the loop so the platform restarts the process with a fresh heap. */
  onRecycle?: (reading: MemoryReading) => void;
  memoryRecycleAfterMs?: number;
  /** A worker younger than this never asks to be restarted (a process that boots above the limit must not restart in a loop). */
  memoryRecycleMinUptimeMs?: number;
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
  const recycleAfterMs = deps.memoryRecycleAfterMs ?? AGENT_MEMORY_RECYCLE_AFTER_MS;
  const recycleMinUptimeMs = deps.memoryRecycleMinUptimeMs ?? AGENT_MEMORY_RECYCLE_MIN_UPTIME_MS;
  const startedAt = now().getTime();
  let waitingForMemory = false;
  let waitingSince: number | null = null;
  let recycled = false;
  let stopping = false;
  /** The measured memory of each running mission: where it started, its highest readings, and whether the worker had to stop it. */
  const peaks = new Map<string, { phase: 0 | 1; startedAt: number; startRss: number; startTree: number | null; peakRss: number; peakTree: number | null; samples: number; stopped: boolean }>();
  const sample = (reading: MemoryReading) => {
    for (const p of peaks.values()) {
      p.samples += 1;
      p.peakRss = Math.max(p.peakRss, reading.rssMb);
      if (reading.treeRssMb !== null && Number.isFinite(reading.treeRssMb)) p.peakTree = Math.max(p.peakTree ?? 0, reading.treeRssMb);
    }
  };

  let historyBucket = -1;
  /** One create-only object per worker per few minutes, the reading in its NAME (see AGENT_HEARTBEAT_HISTORY_EVERY_MS): the history the overwritten heartbeat row cannot give. Never throws. */
  async function writeHistory(memory: MemoryReading): Promise<void> {
    try {
      const t = now().getTime();
      const bucket = Math.floor(t / AGENT_HEARTBEAT_HISTORY_EVERY_MS);
      if (bucket === historyBucket) return;
      historyBucket = bucket;
      const at = new Date(bucket * AGENT_HEARTBEAT_HISTORY_EVERY_MS).toISOString().replace(/[:.]/g, "-");
      const name = `${AGENT_HEARTBEAT_HISTORY_FOLDER}/${at}_${deps.workerId}_r${Math.round(memory.rssMb)}_t${memory.treeRssMb === null ? "x" : Math.round(memory.treeRssMb)}_a${active.size}.json`;
      await deps.store.putNew(AGENT_HEARTBEAT_HISTORY_SPACE, name, JSON.stringify({ worker: deps.workerId, at: now().toISOString(), rss_mb: memory.rssMb, tree_rss_mb: memory.treeRssMb, active: active.size, version: deps.version }), "application/json");
    } catch (e) {
      historyBucket = -1;
      deps.log?.(`heartbeat_history_failed ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }

  async function heartbeat(): Promise<void> {
    try {
      const memory = (deps.readMemory ?? readProcessMemory)();
      await deps.store.writeHeartbeat({ worker_id: deps.workerId, beat_at: now().toISOString(), active_missions: active.size, model: deps.modelLabel(), version: deps.version, rss_mb: memory.rssMb, tree_rss_mb: memory.treeRssMb });
      await writeHistory(memory);
      await deps.store.renewLeases(deps.workerId, leaseSeconds, [...active.keys()]);
    } catch (e) {
      deps.log?.(`heartbeat_failed ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }

  /** True while the memory is too high to start another mission (logged once per wait). An idle worker that stays above the limit for the recycle time asks to be restarted. */
  function memoryBlocksAdmission(): boolean {
    let reading: MemoryReading;
    try { reading = readMem(); } catch { return false; }
    const blocked = usedMb(reading) >= admitLimit;
    if (blocked && !waitingForMemory) deps.log?.(`memory_wait tree=${usedMb(reading)}MB limit=${admitLimit}MB: no new mission is taken until it falls`);
    if (!blocked && waitingForMemory) deps.log?.(`memory_ok tree=${usedMb(reading)}MB: taking missions again`);
    waitingForMemory = blocked;
    if (!blocked) waitingSince = null;
    else if (active.size === 0) {
      waitingSince = waitingSince ?? now().getTime();
      if (!recycled && now().getTime() - waitingSince >= recycleAfterMs && now().getTime() - startedAt >= recycleMinUptimeMs) {
        recycled = true;
        deps.log?.(`memory_recycle tree=${usedMb(reading)}MB: idle for ${Math.round((now().getTime() - waitingSince) / 1000)}s at or above ${admitLimit}MB, asking for a restart with a fresh heap`);
        try { deps.onRecycle?.(reading); } catch { /* best effort */ }
      }
    }
    return blocked;
  }

  /** While a mission runs: every reading counts toward its peak; at the hard limit the entry point is told to stop the model run (the mission goes back to the queue). Returns whether the limit was reached. */
  function watchMemory(): boolean {
    if (active.size === 0) return false;
    let reading: MemoryReading;
    try { reading = readMem(); } catch { return false; }
    sample(reading);
    if (usedMb(reading) < hardLimit) return false;
    for (const p of peaks.values()) p.stopped = true;
    deps.log?.(`memory_pressure tree=${usedMb(reading)}MB limit=${hardLimit}MB: stopping the running mission so it can wait in the queue`);
    try { deps.onMemoryPressure?.(reading); } catch { /* the stop is best effort */ }
    return true;
  }

  /** The run ended: its measured memory goes on the mission as an INTERNAL event (the admin page reads it; the customer's screen never does). Never throws. */
  async function recordPeak(missionId: string): Promise<void> {
    const p = peaks.get(missionId);
    peaks.delete(missionId);
    if (!p) return;
    try {
      let last: MemoryReading | null = null;
      try { last = readMem(); } catch { last = null; }
      if (last) { p.samples += 1; p.peakRss = Math.max(p.peakRss, last.rssMb); if (last.treeRssMb !== null) p.peakTree = Math.max(p.peakTree ?? 0, last.treeRssMb); }
      const counts: Record<string, number> = { mem_phase: p.phase, mem_start_rss_mb: p.startRss, mem_peak_rss_mb: p.peakRss, mem_samples: p.samples, mem_seconds: Math.max(0, Math.round((now().getTime() - p.startedAt) / 1000)) };
      if (p.startTree !== null) counts.mem_start_tree_mb = p.startTree;
      if (p.peakTree !== null) counts.mem_peak_tree_mb = p.peakTree;
      if (p.stopped) counts.mem_stopped = 1;
      await deps.store.addEvent(missionId, { kind: "call", message_ar: "قياس داخلي لذاكرة الخدمة أثناء هذه الخطوة.", counts });
    } catch (e) {
      deps.log?.(`peak_not_recorded ${missionId} ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
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
      let startReading: MemoryReading | null = null;
      try { startReading = readMem(); } catch { startReading = null; }
      const claimed = mission;
      if (startReading) peaks.set(claimed.id, { phase: claimed.status === "executing" ? 1 : 0, startedAt: now().getTime(), startRss: startReading.rssMb, startTree: startReading.treeRssMb, peakRss: startReading.rssMb, peakTree: startReading.treeRssMb, samples: 1, stopped: false });
      const run = deps.runMission(claimed).catch((e) => deps.log?.(`mission_crashed ${claimed.id} ${String((e as Error)?.message ?? e).slice(0, 160)}`)).then(() => recordPeak(claimed.id)).finally(() => { active.delete(claimed.id); });
      active.set(claimed.id, run);
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
