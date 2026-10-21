import { effectiveDriverMode, longJobDriverMode, type DriverMode } from "../driverMode";

/**
 * The driver's heartbeat. The always-on driver route (`/api/cron/drive`) writes the time of each call to one row of `settings_private`
 * (`driver_tick`); the plan, the notices and the admin indicator read it, so «تقدر تقفل الصفحة» is said only when the driver was seen
 * working in the last three minutes. A data write to an existing table: no money table, no ledger, no SQL change.
 */
export const DRIVER_TICK_KEY = "driver_tick";
const READ_CACHE_MS = 20_000;

let cache: { at: number | null; readAt: number } | null = null;
export function resetDriverTickCacheForTesting(): void { cache = null; }

export async function recordDriverTick(admin: any, now: number = Date.now()): Promise<boolean> {
  try {
    const { error } = await admin.from("settings_private").upsert({ key: DRIVER_TICK_KEY, value: { at: new Date(now).toISOString() }, updated_at: new Date(now).toISOString() });
    if (error) return false;
    cache = { at: now, readAt: now };
    return true;
  } catch {
    return false;
  }
}

/** The time of the last tick in milliseconds, or null when there is none or it cannot be read. Cached for 20 seconds. */
export async function readDriverTickAt(admin: any, now: number = Date.now()): Promise<number | null> {
  if (cache && now - cache.readAt < READ_CACHE_MS) return cache.at;
  let at: number | null = null;
  try {
    if (admin && typeof admin.from === "function") {
      const { data } = await admin.from("settings_private").select("value").eq("key", DRIVER_TICK_KEY).maybeSingle();
      const raw = data?.value?.at;
      const parsed = typeof raw === "string" ? Date.parse(raw) : NaN;
      at = Number.isFinite(parsed) ? parsed : null;
    }
  } catch {
    at = null;
  }
  cache = { at, readAt: now };
  return at;
}

/** The driver the customer may be told about now (see `effectiveDriverMode`). Fails to «tab». */
export async function currentDriverMode(admin: any, env: Record<string, string | undefined> = process.env, now: number = Date.now()): Promise<DriverMode> {
  const configured = longJobDriverMode(env);
  if (configured !== "cron") return "tab";
  return effectiveDriverMode(configured, await readDriverTickAt(admin, now), now);
}

export async function driverStatus(admin: any, env: Record<string, string | undefined> = process.env, now: number = Date.now()) {
  const configured = longJobDriverMode(env);
  const lastTickAt = await readDriverTickAt(admin, now);
  return {
    configured,
    mode: effectiveDriverMode(configured, lastTickAt, now),
    lastTickAt,
    ageSeconds: lastTickAt === null ? null : Math.max(0, Math.round((now - lastTickAt) / 1000)),
  };
}
