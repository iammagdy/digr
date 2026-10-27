import { createAdminClient } from "../supabase/server";
import { DRIVER_STATUS_CACHE_MS, driverForcedToTab, driverModeFromTick, type DriverMode } from "../driverMode";

/**
 * The always-on driver's proof of life. /api/cron/drive writes ONE row (id 1) on every authorised call, including a call with nothing
 * waiting, so "the driver is live" means "the scheduler called the route with the right secret a moment ago", not "a flag was set".
 * Nothing here touches a job, a balance or the ledger.
 */
export async function recordDriverTick(admin: any, dispatched: number, nowMs: number = Date.now()): Promise<void> {
  const at = new Date(nowMs).toISOString();
  try {
    await admin.from("driver_heartbeat").upsert({ id: 1, last_tick_at: at, last_dispatched: Math.max(0, Math.floor(dispatched)), updated_at: at }, { onConflict: "id" });
  } catch {
    // a missed heartbeat only makes the driver look off: the safe side
  }
}

export async function readDriverLastTick(admin: any): Promise<string | null> {
  try {
    const { data } = await admin.from("driver_heartbeat").select("last_tick_at").eq("id", 1).maybeSingle();
    return typeof data?.last_tick_at === "string" ? data.last_tick_at : null;
  } catch {
    return null;
  }
}

let cache: { at: number; mode: DriverMode } | null = null;
export const resetDriverModeCache = () => { cache = null; };

/** The mode to promise the customer: live heartbeat AND not forced to "tab". Cached in memory for at most DRIVER_STATUS_CACHE_MS. */
export async function liveDriverMode(admin?: any, nowMs: number = Date.now(), env: Record<string, string | undefined> = process.env): Promise<DriverMode> {
  if (driverForcedToTab(env)) return "tab";
  if (cache && nowMs - cache.at >= 0 && nowMs - cache.at < DRIVER_STATUS_CACHE_MS) return cache.mode;
  let db = admin;
  if (!db) {
    try { db = createAdminClient(); } catch { return "tab"; }
  }
  const mode = driverModeFromTick(await readDriverLastTick(db), nowMs, env);
  cache = { at: nowMs, mode };
  return mode;
}
