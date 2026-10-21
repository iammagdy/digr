import { getProviderBalanceStatus } from "../../functions/shared/providerSpend";
import { evaluateBusy, NOT_BUSY, type BusyState } from "../busyMode";
import { DEGRADED_CLOSED_AR, degradedLevel } from "../degradedMode";
import { readRealProviderBalance } from "./realProviderBalance";

/**
 * The live busy state: the daily limit left, the provider's real balance (only a fresh reading counts) and how many requests are waiting
 * or running. One set of reads per instance every BUSY_CACHE_MS however many visitors ask. It never throws: when it cannot read, the door
 * stays open (the plan gate and the worker still protect the money). Read only.
 */
export const BUSY_CACHE_MS = 15_000;

let cache: { at: number; state: BusyState } | null = null;
let override: BusyState | null | undefined;

/** Test-only: fix the answer (null = back to the real read; in tests the real read is «not busy» unless fixed here). */
export function setBusyStateForTesting(state: BusyState | null | undefined): void {
  override = state;
  cache = null;
}

export async function getBusyState(admin: any, now: number = Date.now()): Promise<BusyState> {
  // The owner closed the door by hand (DEGRADED_MODE=closed): no new request starts, whatever the provider says.
  if (degradedLevel() === "closed") return { busy: true, reason: "service_load", queueAhead: 0, position: 1, messageAr: DEGRADED_CLOSED_AR };
  if (override !== undefined && override !== null) return override;
  if (process.env.NODE_ENV === "test" && override === undefined) return NOT_BUSY;
  if (cache && now - cache.at < BUSY_CACHE_MS) return cache.state;
  let state: BusyState = NOT_BUSY;
  try {
    const [status, real, queued] = await Promise.all([
      getProviderBalanceStatus(admin),
      readRealProviderBalance(admin).catch(() => null),
      admin.from("jobs").select("id", { count: "exact", head: true }).in("status", ["queued", "running"]),
    ]);
    state = evaluateBusy({
      remainingDailyUsd: Math.max(0, status.todayCapUsd - status.todaySpendUsd),
      realBalanceUsd: real ? real.usd : null,
      queuedOrRunning: typeof queued?.count === "number" ? queued.count : 0,
    });
  } catch {
    state = NOT_BUSY;
  }
  cache = { at: now, state };
  return state;
}
