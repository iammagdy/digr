import { AGENT_SDK_SESSIONS_AT_ONCE } from "../../src/lib/agentMission/constants";

/**
 * The SDK sessions of this process, kept apart from the SDK itself (sdkRuntime.ts imports it; the tests do not): ONE session at a time, because each one is a native process of its own on a 512 MB dyno,
 * and a registry of the runs in flight so the worker can stop them when the dyno's memory gets too high.
 */
export interface TrackedRun { abort: AbortController; reason: { value: string | null } }

const activeRuns = new Set<TrackedRun>();
const waiting: Array<() => void> = [];
let openSessions = 0;

export function trackRun(): TrackedRun {
  const run: TrackedRun = { abort: new AbortController(), reason: { value: null } };
  activeRuns.add(run);
  return run;
}
export function untrackRun(run: TrackedRun): void { activeRuns.delete(run); }

/** Stops every run in flight, naming the reason (the run then ends with that stop reason). Returns how many were stopped. */
export function abortActiveRuns(reason: string): number {
  let n = 0;
  for (const r of activeRuns) { r.reason.value = reason; r.abort.abort(); n += 1; }
  return n;
}

export async function acquireSession(limit: number = AGENT_SDK_SESSIONS_AT_ONCE): Promise<void> {
  if (openSessions < limit) { openSessions += 1; return; }
  await new Promise<void>((resolve) => waiting.push(resolve));
  openSessions += 1;
}
export function releaseSession(): void {
  openSessions = Math.max(0, openSessions - 1);
  waiting.shift()?.();
}
export const openSessionCount = (): number => openSessions;
export const waitingSessionCount = (): number => waiting.length;

/** What one tool result may put in the model's context (and so in the SDK process's memory): a page is never sent whole, only its digest and first rows. */
export const MAX_TOOL_RESULT_CHARS = 10_000;
export const clipToolResult = (text: string): string => (text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…(cut)` : text);
