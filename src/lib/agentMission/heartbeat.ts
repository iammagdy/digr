import { AGENT_HEARTBEAT_ALIVE_MS } from "./constants";

/** Is the worker alive? Its last heartbeat (written every 30 s) must be younger than AGENT_HEARTBEAT_ALIVE_MS (90 s, three missed beats). Nothing known means not alive. */
export function workerAlive(lastBeatIso: string | null | undefined, now: number = Date.now()): { alive: boolean; ageSeconds: number | null } {
  if (!lastBeatIso) return { alive: false, ageSeconds: null };
  const t = new Date(lastBeatIso).getTime();
  if (!Number.isFinite(t)) return { alive: false, ageSeconds: null };
  const age = Math.max(0, now - t);
  return { alive: age <= AGENT_HEARTBEAT_ALIVE_MS, ageSeconds: Math.round(age / 1000) };
}

/** The freshest heartbeat among the rows (several workers may beat). */
export function latestBeat(rows: ReadonlyArray<{ beat_at?: string | null }>): string | null {
  let best: string | null = null;
  for (const r of rows) if (r.beat_at && (best === null || r.beat_at > best)) best = r.beat_at;
  return best;
}
