import { AGENT_RUN_STATE_FILE } from "../../src/lib/agentMission/constants";
import type { AgentStore } from "./types";

/**
 * WHAT A MISSION REMEMBERS ABOUT ITS OWN RUNS: how many times each phase started and how many times it was put back in the queue, by cause. One small JSON file in the mission's own folder of the bucket
 * (application/json is one of the three types the bucket accepts), with an in-process copy beside it: this note is NEVER critical, so a failed read or write falls back to the copy and never breaks the mission.
 * The counters are what stops a mission that keeps failing (or keeps killing its worker) from looping for ever.
 */
export interface RunState { planningStarts: number; executionStarts: number; memoryRequeues: number; errorRequeues: number; /** Put back in the queue because the platform restarted the worker (a deploy): counted apart, with its own limit. */ restartRequeues: number }
const EMPTY: RunState = { planningStarts: 0, executionStarts: 0, memoryRequeues: 0, errorRequeues: 0, restartRequeues: 0 };

/** One copy per store (a store is one database; the copies of one never leak into another). */
const copiesOf = new WeakMap<AgentStore, Map<string, RunState>>();
const copies = (store: AgentStore): Map<string, RunState> => { let m = copiesOf.get(store); if (!m) { m = new Map(); copiesOf.set(store, m); } return m; };
const clean = (v: unknown): RunState => {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
  return { planningStarts: n(o.planningStarts), executionStarts: n(o.executionStarts), memoryRequeues: n(o.memoryRequeues), errorRequeues: n(o.errorRequeues), restartRequeues: n(o.restartRequeues) };
};

export async function readRunState(store: AgentStore, missionId: string): Promise<RunState> {
  let stored: RunState | null = null;
  try {
    const text = await store.getFile(missionId, AGENT_RUN_STATE_FILE);
    if (text) stored = clean(JSON.parse(text));
  } catch { /* a missing or broken note is read as the in-process copy */ }
  const copy = copies(store).get(missionId);
  // the larger of the two (the file survives a restart, the copy survives a failed write)
  if (!stored) return copy ? { ...copy } : { ...EMPTY };
  if (!copy) return stored;
  return { planningStarts: Math.max(stored.planningStarts, copy.planningStarts), executionStarts: Math.max(stored.executionStarts, copy.executionStarts), memoryRequeues: Math.max(stored.memoryRequeues, copy.memoryRequeues), errorRequeues: Math.max(stored.errorRequeues, copy.errorRequeues), restartRequeues: Math.max(stored.restartRequeues, copy.restartRequeues) };
}

/** Applies `change` to the note and saves it; returns the new state. Never throws. */
export async function updateRunState(store: AgentStore, missionId: string, change: (s: RunState) => RunState, log?: (line: string) => void): Promise<RunState> {
  const next = clean(change(await readRunState(store, missionId)));
  copies(store).set(missionId, next);
  try { await store.putFile(missionId, AGENT_RUN_STATE_FILE, JSON.stringify(next), "application/json"); } catch (e) { log?.(`run_state_not_saved ${missionId} ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
  return next;
}

