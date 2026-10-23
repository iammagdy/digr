import type { ProviderId } from "./providerKeyCrypto";

/**
 * Real provider checks: an authenticated call, never a flag. The same call validates a candidate key before it is
 * saved. Documented endpoints (public docs):
 *   TREG      GET {base}/auth/me                     authenticated identity read, no metered cost (https://treg.to/openapi.json)
 *             GET {base}/orgs/{org_id}/balance       prepaid balance in integer micro-USD; any team member may read it
 *   Anthropic GET https://api.anthropic.com/v1/models?limit=1   list-models read, no tokens are billed
 *   Firecrawl GET https://api.firecrawl.dev/v2/team/credit-usage  free read: data.remainingCredits, data.planCredits, billing period
 *             (https://docs.firecrawl.dev/api-reference/endpoint/credit-usage)
 *   Context.dev GET https://api.context.dev/v1/org/usage           free read (key scope logs:read): credits_remaining, period.credits_used, next_refill
 *             (https://docs.context.dev/api-reference/usage/retrieve)
 * Anthropic exposes no balance API for a regular key, so none is shown for it. Firecrawl and Context.dev answer one call that is both the
 * health check and the real credit count.
 */
export const STATUS_CACHE_TTL_MS = 60_000;
export const CHECK_TIMEOUT_MS = 8_000;
export const DEFAULT_LOW_BALANCE_THRESHOLD_USD = 0.2;

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "network" | "timeout";
export type HealthReason = "ok" | "auth_rejected" | "rate_limited" | "server_error" | "network_error" | "timeout" | "unexpected" | "no_key" | "missing_scope";

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
  unavailableReason?: "no_balance_api" | "no_key" | "org_unknown" | "unreadable" | "check_failed" | "missing_scope";
  balanceMicro?: number;
  balanceUsd?: number;
  heldMicro?: number | null;
  orgId?: string | null;
  /** Credit-priced providers (Firecrawl, Context.dev): the provider's own count of remaining credits, as its usage endpoint answered. Never an estimate. */
  credits?: number;
  creditsUsedThisPeriod?: number | null;
  planCredits?: number | null;
  /** End of the billing period (Firecrawl) or the next refill (Context.dev), as the provider gave it. */
  periodEndsAt?: string | null;
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

async function timedGet(url: string, headers: Record<string, string>, fetchFn: FetchFn, timeoutMs: number = CHECK_TIMEOUT_MS): Promise<{ health: HealthResult; body: unknown }> {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetchFn(url, { method: "GET", headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
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
export async function checkProviderKey(provider: ProviderId, key: string, fetchFn: FetchFn = fetch, timeoutMs: number = CHECK_TIMEOUT_MS): Promise<{ health: HealthResult; body: unknown }> {
  if (!key) return { health: noKeyHealth(), body: null };
  if (provider === "treg") return timedGet(`${tregBaseUrl()}/auth/me`, { "X-Treg-Token": key, Accept: "application/json" }, fetchFn, timeoutMs);
  if (provider === "firecrawl") return timedGet("https://api.firecrawl.dev/v2/team/credit-usage", { Authorization: `Bearer ${key}`, Accept: "application/json" }, fetchFn, timeoutMs);
  if (provider === "contextdev") return contextDevCheck(await timedGet("https://api.context.dev/v1/org/usage", { Authorization: `Bearer ${key}`, Accept: "application/json" }, fetchFn, timeoutMs));
  return timedGet("https://api.anthropic.com/v1/models?limit=1", { "x-api-key": key, "anthropic-version": "2023-06-01", Accept: "application/json" }, fetchFn, timeoutMs);
}

/**
 * Context.dev's usage read needs the key scope `logs:read`; a key without it answers 403 and names the permission it lacks. Such a key IS
 * accepted by the provider (a rejected key answers 401), so it is healthy for scraping and searching: only the credit balance is unavailable.
 * Any other 403 stays a rejected key.
 */
export function contextDevCheck(result: { health: HealthResult; body: unknown }): { health: HealthResult; body: unknown } {
  if (result.health.httpStatus !== 403) return result;
  const text = JSON.stringify(result.body ?? "");
  if (!/required_permission|logs:read/i.test(text)) return result;
  return { health: { ...result.health, ok: true, reason: "missing_scope" }, body: result.body };
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

async function fetchTregBalanceWithBody(key: string, orgId: string | null, fetchFn: FetchFn, timeoutMs: number): Promise<{ result: BalanceResult; body: unknown }> {
  const checkedAt = new Date().toISOString();
  if (!key) return { result: { available: false, unavailableReason: "no_key", checkedAt }, body: null };
  if (!orgId) return { result: { available: false, unavailableReason: "org_unknown", orgId: null, checkedAt }, body: null };
  const { health, body } = await timedGet(`${tregBaseUrl()}/orgs/${encodeURIComponent(orgId)}/balance?limit=1`, { "X-Treg-Token": key, Accept: "application/json" }, fetchFn, timeoutMs);
  if (!health.ok) return { result: { available: false, unavailableReason: "check_failed", orgId, checkedAt }, body: null };
  const parsed = parseTregBalance(body);
  if (!parsed) return { result: { available: false, unavailableReason: "unreadable", orgId, checkedAt }, body };
  return { result: { available: true, balanceMicro: parsed.balanceMicro, balanceUsd: parsed.balanceMicro / 1_000_000, heldMicro: parsed.heldMicro, orgId, checkedAt }, body };
}

export async function fetchTregBalance(key: string, orgId: string | null, fetchFn: FetchFn = fetch, timeoutMs: number = CHECK_TIMEOUT_MS): Promise<BalanceResult> {
  return (await fetchTregBalanceWithBody(key, orgId, fetchFn, timeoutMs)).result;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Firecrawl's credit-usage answer: the remaining credits of the team, as an integer the provider gave. Null when the answer has none. */
export function parseFirecrawlCredits(body: unknown): { credits: number; planCredits: number | null; periodEndsAt: string | null } | null {
  const d = (body as any)?.data;
  if (!d || !isCount(d.remainingCredits)) return null;
  return { credits: d.remainingCredits, planCredits: isCount(d.planCredits) ? d.planCredits : null, periodEndsAt: typeof d.billingPeriodEnd === "string" ? d.billingPeriodEnd : null };
}

/** Context.dev's usage answer: the organisation's balance in credits, the credits used this period and the next refill. */
export function parseContextDevCredits(body: unknown): { credits: number; usedThisPeriod: number | null; refillAt: string | null } | null {
  const b = body as any;
  if (!b || !isCount(b.credits_remaining)) return null;
  return { credits: b.credits_remaining, usedThisPeriod: isCount(b.period?.credits_used) ? b.period.credits_used : null, refillAt: typeof b.next_refill?.at === "string" ? b.next_refill.at : null };
}

/** The real credit count of a credit-priced provider from the health call's own answer, or why none is shown. */
function creditBalanceFrom(provider: "firecrawl" | "contextdev", body: unknown, checkedAt: string): BalanceResult {
  if (provider === "firecrawl") {
    const p = parseFirecrawlCredits(body);
    return p ? { available: true, credits: p.credits, planCredits: p.planCredits, periodEndsAt: p.periodEndsAt, checkedAt } : { available: false, unavailableReason: "unreadable", checkedAt };
  }
  const p = parseContextDevCredits(body);
  return p ? { available: true, credits: p.credits, creditsUsedThisPeriod: p.usedThisPeriod, periodEndsAt: p.refillAt, checkedAt } : { available: false, unavailableReason: "unreadable", checkedAt };
}

const statusCache = new Map<ProviderId, { at: number; snapshot: ProviderStatusSnapshot }>();

/**
 * The e-mail of the connected provider account, exactly as the provider's own identity or balance answer gives it. It is kept in memory only,
 * beside the cached read it came from, and is NOT part of any snapshot or balance object: it never reaches the database, a log line, a job
 * event, a customer screen or a plain-text export. Only the admin routes read it, through getProviderAccountEmail.
 */
const accountEmails = new Map<ProviderId, string | null>();

const EMAIL_RE = /^[^\s@<>"'`,;()\[\]\\]{1,64}@[^\s@<>"'`,;()\[\]\\]{1,190}\.[A-Za-z]{2,24}$/;

/**
 * The account's own e-mail from the answer body, from the few places an identity answer puts the signed-in account (never a list of
 * members or teams, so another person's address cannot be picked up). Null when the answer has none: no guess from a name or an id.
 */
export function extractProviderAccountEmail(body: unknown): string | null {
  const b = body as any;
  if (!b || typeof b !== "object") return null;
  const candidates = [b.email, b.user?.email, b.account?.email, b.me?.email, b.profile?.email, b.owner?.email, b.current_user?.email, b.data?.email, b.data?.user?.email, b.data?.account?.email];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (value.length <= 254 && EMAIL_RE.test(value)) return value;
  }
  return null;
}

/** The connected account's e-mail from the latest read of this provider, or null when the provider's answer had none. Admin routes only. */
export function getProviderAccountEmail(provider: ProviderId): string | null {
  return accountEmails.get(provider) ?? null;
}

/** The last balance the provider really answered, kept past the 60 s cache (and past a later failed check) for the plan capacity gate. */
let lastGoodTregBalance: { balanceMicro: number; at: number } | null = null;

export function lastGoodProviderBalance(): { balanceMicro: number; at: number } | null {
  return lastGoodTregBalance;
}

export function resetLastGoodProviderBalanceForTests(): void {
  lastGoodTregBalance = null;
}

export function invalidateProviderStatusCache(provider?: ProviderId): void {
  if (provider) { statusCache.delete(provider); accountEmails.delete(provider); } else { statusCache.clear(); accountEmails.clear(); }
}

/** Health plus balance, cached 60 seconds per server instance; the refresh button bypasses the cache. */
export async function getProviderStatus(
  provider: ProviderId,
  key: string,
  options?: { forceRefresh?: boolean; orgIdOverride?: string | null; fetchFn?: FetchFn; now?: () => number; timeoutMs?: number },
): Promise<ProviderStatusSnapshot> {
  const now = options?.now ?? (() => Date.now());
  const hit = statusCache.get(provider);
  if (!options?.forceRefresh && hit && now() - hit.at < STATUS_CACHE_TTL_MS) return hit.snapshot;

  const fetchFn = options?.fetchFn ?? fetch;
  const timeoutMs = options?.timeoutMs ?? CHECK_TIMEOUT_MS;
  const { health, body } = await checkProviderKey(provider, key, fetchFn, timeoutMs);
  let balance: BalanceResult;
  if (provider === "anthropic") {
    balance = { available: false, unavailableReason: "no_balance_api", checkedAt: health.checkedAt };
  } else if (provider === "firecrawl" || provider === "contextdev") {
    balance = !health.ok ? { available: false, unavailableReason: key ? "check_failed" : "no_key", checkedAt: health.checkedAt }
      : health.reason === "missing_scope" ? { available: false, unavailableReason: "missing_scope", checkedAt: health.checkedAt }
      : creditBalanceFrom(provider, body, health.checkedAt);
  } else if (!health.ok) {
    balance = { available: false, unavailableReason: key ? "check_failed" : "no_key", checkedAt: health.checkedAt };
  } else {
    const fetched = await fetchTregBalanceWithBody(key, options?.orgIdOverride || extractTregOrgId(body), fetchFn, timeoutMs);
    balance = fetched.result;
    // The account's e-mail comes only from what these two answers already carry: the identity answer first, then the balance answer.
    if (provider === "treg") accountEmails.set(provider, extractProviderAccountEmail(body) ?? extractProviderAccountEmail(fetched.body));
  }
  if (provider === "treg" && !health.ok) accountEmails.set(provider, null);
  const snapshot: ProviderStatusSnapshot = { provider, health, balance, cachedAt: new Date(now()).toISOString(), cacheTtlMs: STATUS_CACHE_TTL_MS };
  statusCache.set(provider, { at: now(), snapshot });
  if (provider === "treg" && balance.available && typeof balance.balanceMicro === "number") lastGoodTregBalance = { balanceMicro: balance.balanceMicro, at: now() };
  return snapshot;
}

export function isLowBalance(balance: BalanceResult, thresholdUsd: number): boolean {
  return balance.available && typeof balance.balanceUsd === "number" && balance.balanceUsd < thresholdUsd;
}
