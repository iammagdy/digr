/**
 * The page side of a planning SESSION: a chat answer of kind «planning_pending» means the planner has more steps to take (see src/lib/modelPlanner/planningSession.ts). The page asks for the next
 * step until the session is done, then carries on with the final answer exactly as if the chat route had given it. Each step is its own short request, so no single request holds the whole plan.
 */
export const PLANNING_CLIENT_MAX_MS = 10 * 60_000;
export const PLANNING_STEP_RETRY_MS = 1_500;

export interface PlanningPending { outputType: string; planning?: { sessionId?: string }; [key: string]: unknown }

export async function resolvePlanningPending(first: PlanningPending, opts: { headers: Record<string, string>; signal?: AbortSignal; fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void>; maxMs?: number; now?: () => number }): Promise<Record<string, unknown>> {
  const id = first?.planning?.sessionId;
  if (first?.outputType !== "planning_pending" || !id) return first;
  const doFetch = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  while (now() - startedAt < (opts.maxMs ?? PLANNING_CLIENT_MAX_MS)) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    let json: any = null;
    try {
      const res = await doFetch(`/api/chat/planning/${encodeURIComponent(id)}/step`, { method: "POST", headers: opts.headers, signal: opts.signal });
      json = await res.json().catch(() => null);
    } catch (err) {
      if ((err as any)?.name === "AbortError") throw err;
      json = null; // a step that did not arrive is asked again: the session keeps its state
    }
    if (json?.status === "done" && json.response) return { ...first, ...json.response, planning: undefined };
    if (json?.status === "failed") throw new Error("planning_failed");
    await sleep(json?.status === "running" ? 250 : PLANNING_STEP_RETRY_MS);
  }
  throw new Error("planning_timeout");
}
