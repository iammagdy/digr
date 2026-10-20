/**
 * How many provider calls a chunk may still start, from the time the calls of THIS chunk actually took.
 *
 * A chunk must end well inside the platform's limit (the worker's deadline is 45 s inside a 60 s function). The calls of a chunk are
 * sequential, so the time one call takes decides how many fit. The rule was a fixed «start another call only if 9 s remain»; a source
 * that answers in 14 s therefore got a third call started with 12 s left, which then timed out (a billed call and no rows). Now a call is
 * started only if the time left covers the slowest call seen so far in this chunk plus a margin, and never less than the fixed 9 s that
 * covers the first call of a chunk (nothing is known yet).
 *
 * Pure: no price, no cap, no provider limit; the number of calls per chunk stays SOCIAL_MAX_CALLS_PER_CHUNK, the basis of the spend estimate.
 */

/** The floor, used before any call of the chunk is measured. */
export const MIN_TIME_FOR_ANOTHER_CALL_MS = 9_000;
/** The most that is ever asked to remain (a source slower than this is limited by its own timeout instead). */
export const MAX_TIME_FOR_ANOTHER_CALL_MS = 20_000;
/** The slowest call seen is multiplied by this: one call can be a little slower than the one before. */
export const CALL_TIME_MARGIN = 1.25;

export function timeNeededForAnotherCallMs(slowestCallMs: number): number {
  const measured = Number.isFinite(slowestCallMs) && slowestCallMs > 0 ? slowestCallMs * CALL_TIME_MARGIN : 0;
  return Math.min(MAX_TIME_FOR_ANOTHER_CALL_MS, Math.max(MIN_TIME_FOR_ANOTHER_CALL_MS, Math.ceil(measured)));
}

/** How many calls of `callMs` each fit in a chunk of `budgetMs`, at most `maxCalls` (what a planner may promise). */
export function callsThatFit(callMs: number, budgetMs: number, maxCalls: number): number {
  if (!(callMs > 0)) return maxCalls;
  let calls = 0;
  let spent = 0;
  while (calls < maxCalls) {
    const remaining = budgetMs - spent;
    if (calls > 0 && remaining < timeNeededForAnotherCallMs(callMs)) break;
    if (remaining < callMs) break;
    calls += 1;
    spent += callMs;
  }
  return Math.max(1, calls);
}
