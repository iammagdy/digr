/**
 * A small rate limiter for PUBLIC endpoints (the calculator and anything shown to visitors). Public endpoints never call
 * the model or the provider; this keeps them from being hammered. It is per server instance (serverless instances do not
 * share memory), so it is a best-effort guard on top of the platform's own limits, not a ledger.
 */
export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  /** Most keys kept in memory; the oldest are dropped. */
  maxKeys?: number;
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** Seconds until the oldest hit leaves the window (0 when allowed). */
  retryAfterSeconds: number;
}

export function createRateLimiter(options: RateLimiterOptions) {
  const hits = new Map<string, number[]>();
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 5000;
  return {
    check(key: string): RateLimitDecision {
      const t = now();
      const windowStart = t - options.windowMs;
      const recent = (hits.get(key) ?? []).filter((at) => at > windowStart);
      if (recent.length >= options.max) {
        hits.set(key, recent);
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + options.windowMs - t) / 1000)) };
      }
      recent.push(t);
      hits.delete(key);
      hits.set(key, recent);
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest === undefined) break;
        hits.delete(oldest);
      }
      return { allowed: true, remaining: options.max - recent.length, retryAfterSeconds: 0 };
    },
  };
}

/** The visitor's address as the platform reports it (first hop of x-forwarded-for), else a shared bucket. */
export function clientKey(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded ? forwarded.split(",")[0].trim() : "";
  return first || headers.get("x-real-ip") || "unknown";
}

/**
 * Requests per minute per visitor address for the public endpoints. A conference room, a university or an office reaches the site through
 * ONE address, so the numbers are sized for a whole room behind it, not for one person. Every counter lives in the memory of one server
 * instance (instances do not share memory): the limit is a guard against hammering, never a count of how many people are served; money
 * and chat limits are enforced in the database, not here.
 */
export const PUBLIC_LIMITS_PER_MINUTE = { estimate: 300, cap: 600, status: 1200 } as const;

export const RATE_LIMITED_MESSAGE_AR = "طلبات كثيرة في وقت قصير؛ انتظر قليلًا ثم حاول مرة أخرى.";
