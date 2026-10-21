/**
 * A throttle on the FREE POINTS a new account can take (the invitation or promo code), per address and per device. Sign-up itself happens
 * in the visitor's browser against the sign-in service, so our code cannot count sign-ups; what an abuser wants from many accounts is the
 * free points, and that grant passes through our route. Two counters (only successful grants count):
 *  - per address: sized for a conference room behind ONE address (default 900 an hour, above a 500-person room with retries);
 *  - per device (a cookie): one phone making account after account (default 5 a day).
 * Both live in the memory of one server instance (instances do not share memory), so the effective limits are looser than written,
 * never tighter: this is friction against casual abuse, not a ledger. The real limits are in the database: a code's maximum number of
 * redemptions, one redemption per account, and the per-user daily provider cap. No points, price or cap is read or changed here.
 */
export const GRANTS_PER_IP_PER_HOUR_DEFAULT = 900;
export const GRANTS_PER_DEVICE_PER_DAY_DEFAULT = 5;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_KEYS = 20_000;

export const DEVICE_COOKIE = "diger_dev";
export const GRANT_THROTTLED_AR = "استُخدم كود الدعوة من هذا الجهاز أو هذه الشبكة مرات كثيرة اليوم. إن كنت في فعالية فاطلب المساعدة من المنظمين، وتبقى بقية الخدمة متاحة لك.";

function limitFrom(value: string | undefined, fallback: number, max: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
}

export function grantLimits(env: Record<string, string | undefined> = process.env): { perIpPerHour: number; perDevicePerDay: number } {
  return {
    perIpPerHour: limitFrom(env.PROMO_GRANTS_PER_IP_PER_HOUR, GRANTS_PER_IP_PER_HOUR_DEFAULT, 100_000),
    perDevicePerDay: limitFrom(env.PROMO_GRANTS_PER_DEVICE_PER_DAY, GRANTS_PER_DEVICE_PER_DAY_DEFAULT, 1000),
  };
}

const ipHits = new Map<string, number[]>();
const deviceHits = new Map<string, number[]>();

function recent(map: Map<string, number[]>, key: string, windowMs: number, now: number): number[] {
  const list = (map.get(key) ?? []).filter((at) => now - at < windowMs);
  map.set(key, list);
  return list;
}

/** Whether a grant to this address and device may go ahead now (counts nothing). */
export function grantAllowed(input: { ip: string; deviceId: string | null }, now: number = Date.now(), env: Record<string, string | undefined> = process.env): { allowed: boolean; why: "ip" | "device" | null } {
  const limits = grantLimits(env);
  if (recent(ipHits, input.ip, HOUR_MS, now).length >= limits.perIpPerHour) return { allowed: false, why: "ip" };
  if (input.deviceId && recent(deviceHits, input.deviceId, DAY_MS, now).length >= limits.perDevicePerDay) return { allowed: false, why: "device" };
  return { allowed: true, why: null };
}

/** Counts one SUCCESSFUL grant. */
export function recordGrant(input: { ip: string; deviceId: string | null }, now: number = Date.now()): void {
  recent(ipHits, input.ip, HOUR_MS, now).push(now);
  if (input.deviceId) recent(deviceHits, input.deviceId, DAY_MS, now).push(now);
  for (const map of [ipHits, deviceHits]) {
    while (map.size > MAX_KEYS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}

export function resetGrantThrottleForTesting(): void {
  ipHits.clear();
  deviceHits.clear();
}
