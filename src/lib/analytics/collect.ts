import { SESSION_ID_RE, VISITOR_ID_RE, VISIT_KINDS, clampDuration, countryOf, deviceClassOf, isBotUserAgent, isExcludedPath, referrerHostOf, respectsDoNotTrack, sanitizePath, type DeviceClass, type VisitKind } from "./privacy";

/**
 * The decision the visit beacon's route makes, as a pure function: what (if anything) is stored for a beacon, and whether a visitor cookie must be set.
 * Nothing here reads the network or the clock except through its arguments, so every privacy rule is tested without a server.
 */
export const VISITOR_COOKIE = "dgr_v";
export const VISITOR_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
export const MAX_BEACON_BYTES = 1024;

export interface VisitRow {
  visitor_id: string;
  session_id: string;
  kind: VisitKind;
  path: string;
  referrer_host: string | null;
  country: string | null;
  device_class: DeviceClass;
  duration_seconds: number | null;
  user_id: string | null;
}

export type CollectIgnored = "do_not_track" | "bot" | "excluded_path" | "admin" | "invalid" | "rate_limited";
export interface CollectDecision {
  /** 204: nothing to say (stored or ignored); 400: the beacon is malformed; 429: too many from one visitor. */
  status: 204 | 400 | 429;
  row?: VisitRow;
  /** The visitor id to put in a first-party cookie (only when the visitor has none that is valid). */
  setVisitorId?: string;
  ignored?: CollectIgnored;
}

export interface RateLimiter { allow(key: string): boolean }

/** A small in-memory limiter: at most `max` beacons per key in each window. Memory is bounded (old windows are dropped). */
export function createRateLimiter(options: { max: number; windowMs: number; now?: () => number; maxKeys?: number }): RateLimiter {
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { start: number; count: number }>();
  const maxKeys = options.maxKeys ?? 5000;
  return {
    allow(key: string): boolean {
      const t = now();
      if (buckets.size > maxKeys) {
        for (const [k, bucket] of buckets) if (t - bucket.start >= options.windowMs) buckets.delete(k);
        if (buckets.size > maxKeys) buckets.clear();
      }
      const bucket = buckets.get(key);
      if (!bucket || t - bucket.start >= options.windowMs) { buckets.set(key, { start: t, count: 1 }); return true; }
      bucket.count += 1;
      return bucket.count <= options.max;
    },
  };
}

export interface CollectInput {
  body: unknown;
  headers: { get(name: string): string | null };
  /** The value of the visitor cookie the request carried, if any. */
  cookieVisitorId?: string | null;
  /** This site's own host, so a link from the site itself is not a referrer. */
  ownHost?: string | null;
  /** For «login» and «signup»: the account the SERVER verified (never the page's claim). Null when none could be verified. */
  verifiedUserId?: string | null;
  /** The verified account is an admin: nothing is stored. */
  verifiedIsAdmin?: boolean;
  newVisitorId?: () => string;
}

export const newVisitorId = (): string => crypto.randomUUID().replace(/-/g, "");

export function decideCollect(input: CollectInput, limiters: { perVisitor: RateLimiter; global: RateLimiter }): CollectDecision {
  const { headers } = input;
  // 1. The visitor's own choice, and who is not a visitor, come before anything is read.
  if (respectsDoNotTrack(headers)) return { status: 204, ignored: "do_not_track" };
  if (isBotUserAgent(headers.get("user-agent"))) return { status: 204, ignored: "bot" };

  // 2. The beacon's shape.
  const body = input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>) : null;
  const kind = String(body?.k ?? "") as VisitKind;
  const sessionId = String(body?.s ?? "");
  if (!body || !VISIT_KINDS.includes(kind) || !SESSION_ID_RE.test(sessionId)) return { status: 400, ignored: "invalid" };
  const isAuthKind = kind === "login" || kind === "signup";
  const path = isAuthKind ? (kind === "login" ? "/login" : "/register") : sanitizePath(body.p);
  if (!isAuthKind && isExcludedPath(String(body.p ?? "/"))) return { status: 204, ignored: "excluded_path" };
  if (input.verifiedIsAdmin) return { status: 204, ignored: "admin" };
  const duration = kind === "leave" ? clampDuration(body.d) : null;
  if (kind === "leave" && duration === null) return { status: 400, ignored: "invalid" };

  // 3. The visitor's anonymous id: the cookie's when it is valid, else a new one (which the route puts in a first-party cookie).
  const existing = input.cookieVisitorId && VISITOR_ID_RE.test(input.cookieVisitorId) ? input.cookieVisitorId : null;
  const visitorId = existing ?? (input.newVisitorId ?? newVisitorId)();

  // 4. Limits: per visitor (a page that loops) and per instance (a flood), counted before anything is stored.
  if (!limiters.perVisitor.allow(`${visitorId}:${sessionId}`) || !limiters.global.allow("all")) return { status: 429, ignored: "rate_limited" };

  const row: VisitRow = {
    visitor_id: visitorId,
    session_id: sessionId,
    kind,
    path,
    referrer_host: kind === "view" ? referrerHostOf(body.r, input.ownHost) : null,
    country: countryOf(headers),
    device_class: deviceClassOf(headers.get("user-agent")),
    duration_seconds: duration,
    user_id: kind === "login" && input.verifiedUserId ? input.verifiedUserId : null,
  };
  return { status: 204, row, ...(existing ? {} : { setVisitorId: visitorId }) };
}
