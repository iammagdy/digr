import type { ProviderId } from "./providerKeyCrypto";

/**
 * Real provider checks: an authenticated call, never a flag. The same call validates a candidate key before it is
 * saved. Documented endpoints (public docs):
 *   TREG      GET {base}/auth/me                     authenticated identity read, no metered cost (https://treg.to/openapi.json)
 *             GET {base}/orgs/{org_id}/balance       prepaid balance in integer micro-USD; any team member may read it
 *   Anthropic GET https://api.anthropic.com/v1/models?limit=1   list-models read, no tokens are billed
 * Anthropic exposes no balance API for a regular key, so none is shown for it.
 */
export const STATUS_CACHE_TTL_MS = 60_000;
export const CHECK_TIMEOUT_MS = 8_000;
export const DEFAULT_LOW_BALANCE_THRESHOLD_USD = 0.2;

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "network" | "timeout";
export type HealthReason = "ok" | "auth_rejected" | "rate_limited" | "server_error" | "network_error" | "timeout" | "unexpected" | "no_key";

export interface HealthResult {
  ok: boolean;
  reason: HealthReason;
  httpStatus: number | null;
  statusClass: StatusClass;
  latencyMs: number | null;
  checkedAt: string;
}

export interface BalanceResult {
  available: boolean;
  /** Why no number is shown: the provider has no balance API, the team id is unknown, or the answer was not readable. */
  unavailableReason?: "no_balance_api" | "no_key" | "org_unknown" | "unreadable" | "check_failed";
  balanceMicro?: number;
  balanceUsd?: number;
  heldMicro?: number | null;
  orgId?: string | null;
  checkedAt: string;
}

export interface ProviderStatusSnapshot {
  provider: ProviderId;
  health: HealthResult;
  balance: BalanceResult;
  cachedAt: string;
  cacheTtlMs: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type FetchFn = FetchLike;

export function tregBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.TREG_BASE_URL || "https://treg.to").trim().replace(/\/$/, "");
  try { return new URL(raw).protocol === "https:" ? raw : "https://treg.to"; } catch { return "https://treg.to"; }
}

function classOf(status: number): StatusClass {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

function reasonOf(status: number): HealthReason {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "auth_rejected";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "unexpected";
}

async function timedGet(url: string, headers: Record<string, string>, fetchFn: FetchFn): Promise<{ health: HealthResult; body: unknown }> {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetchFn(url, { method: "GET", headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    const latencyMs = Date.now() - started;
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    return { health: { ok: res.status >= 200 && res.status < 300, reason: reasonOf(res.status), httpStatus: res.status, statusClass: classOf(res.status), latencyMs, checkedAt }, body };
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    const timeout = name === "TimeoutError" || name === "AbortError";
    return { health: { ok: false, reason: timeout ? "timeout" : "network_error", httpStatus: null, statusClass: timeout ? "timeout" : "network", latencyMs: Date.now() - started, checkedAt }, body: null };
  }
}

export const noKeyHealth = (): HealthResult => ({ ok: false, reason: "no_key", httpStatus: null, statusClass: "network", latencyMs: null, checkedAt: new Date().toISOString() });

/** Real authenticated call. Also used, unchanged, to validate a candidate key before saving it. */
export async function checkProviderKey(provider: ProviderId, key: string, fetchFn: FetchFn = fetch): Promise<{ health: HealthResult; body: unknown }> {
  if (!key) return { health: noKeyHealth(), body: null };
  if (provider === "treg") return timedGet(`${tregBaseUrl()}/auth/me`, { "X-Treg-Token": key, Accept: "application/json" }, fetchFn);
  return timedGet("https://api.anthropic.com/v1/models?limit=1", { "x-api-key": key, "anthropic-version": "2023-06-01", Accept: "application/json" }, fetchFn);
}

const ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The team id the token belongs to, read from the identity answer. No guess: null when the answer has none. */
export function extractTregOrgId(body: unknown): string | null {
  const b = body as any;
  const candidates = [b?.org_id, b?.active_org_id, b?.org?.id, b?.active_org?.id, b?.orgs?.[0]?.id, b?.orgs?.[0]?.org_id, b?.memberships?.[0]?.org_id];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
    if (typeof c === "string" && ORG_ID.test(c)) return c;
  }
  return null;
}

const MICRO_KEYS = ["balance_micro", "available_micro", "available_balance_micro"];
const HELD_KEYS = ["held_micro", "holds_micro", "in_flight_micro", "inflight_micro", "reserved_micro"];

function findInteger(node: any, keys: string[], depth = 0): number | null {
  if (!node || typeof node !== "object" || depth > 3) return null;
  for (const k of keys) {
    const v = node[k];
    if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)) return v;
    if (typeof v === "string" && /^-?\d{1,15}$/.test(v.trim())) return Number(v.trim());
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = findInteger(v, keys, depth + 1);
      if (inner !== null) return inner;
    }
  }
  return null;
}

/** Integer micro-USD as the provider documents it; the dollar figure is derived for display only. */
export function parseTregBalance(body: unknown): { balanceMicro: number; heldMicro: number | null } | null {
  const balanceMicro = findInteger(body, MICRO_KEYS);
  if (balanceMicro === null) return null;
  return { balanceMicro, heldMicro: findInteger(body, HELD_KEYS) };
}

export async function fetchTregBalance(key: string, orgId: string | null, fetchFn: FetchFn = fetch): Promise<BalanceResult> {
  const checkedAt = new Date().toISOString();
  if (!key) return { available: false, unavailableReason: "no_key", checkedAt };
  if (!orgId) return { available: false, unavailableReason: "org_unknown", orgId: null, checkedAt };
  const { health, body } = await timedGet(`${tregBaseUrl()}/orgs/${encodeURIComponent(orgId)}/balance?limit=1`, { "X-Treg-Token": key, Accept: "application/json" }, fetchFn);
  if (!health.ok) return { available: false, unavailableReason: "check_failed", orgId, checkedAt };
  const parsed = parseTregBalance(body);
  if (!parsed) return { available: false, unavailableReason: "unreadable", orgId, checkedAt };
  return { available: true, balanceMicro: parsed.balanceMicro, balanceUsd: parsed.balanceMicro / 1_000_000, heldMicro: parsed.heldMicro, orgId, checkedAt };
}

const statusCache = new Map<ProviderId, { at: number; snapshot: ProviderStatusSnapshot }>();

export function invalidateProviderStatusCache(provider?: ProviderId): void {
  if (provider) statusCache.delete(provider); else statusCache.clear();
}

/** Health plus balance, cached 60 seconds per server instance; the refresh button bypasses the cache. */
export async function getProviderStatus(
  provider: ProviderId,
  key: string,
  options?: { forceRefresh?: boolean; orgIdOverride?: string | null; fetchFn?: FetchFn; now?: () => number },
): Promise<ProviderStatusSnapshot> {
  const now = options?.now ?? (() => Date.now());
  const hit = statusCache.get(provider);
  if (!options?.forceRefresh && hit && now() - hit.at < STATUS_CACHE_TTL_MS) return hit.snapshot;

  const fetchFn = options?.fetchFn ?? fetch;
  const { health, body } = await checkProviderKey(provider, key, fetchFn);
  let balance: BalanceResult;
  if (provider === "anthropic") {
    balance = { available: false, unavailableReason: "no_balance_api", checkedAt: health.checkedAt };
  } else if (!health.ok) {
    balance = { available: false, unavailableReason: key ? "check_failed" : "no_key", checkedAt: health.checkedAt };
  } else {
    balance = await fetchTregBalance(key, options?.orgIdOverride || extractTregOrgId(body), fetchFn);
  }
  const snapshot: ProviderStatusSnapshot = { provider, health, balance, cachedAt: new Date(now()).toISOString(), cacheTtlMs: STATUS_CACHE_TTL_MS };
  statusCache.set(provider, { at: now(), snapshot });
  return snapshot;
}

export function isLowBalance(balance: BalanceResult, thresholdUsd: number): boolean {
  return balance.available && typeof balance.balanceUsd === "number" && balance.balanceUsd < thresholdUsd;
}
