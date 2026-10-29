import { ProviderKeyCryptoError, decryptProviderKey, last4Of, type ProviderId } from "./providerKeyCrypto";
import { getTregKeyPool, type PoolKeyRef } from "./tregKeyPool";

/**
 * THE ONE place that reads a provider API key. Every call site (worker, chat catalog search, adapters, health
 * check, smoke test, assistant) goes through resolveProviderKey / peekProviderKey; a test greps the source for any
 * other read of these variables.
 *
 * TREG, with the key pool's rollout switch ON (docs/proposals/treg-key-pool): the pool's active key (tregKeyPool.ts, a 3-second view of the database), so every call
 * site follows an admin's switch on its next call. With the switch OFF, or when the pool cannot be read, everything below is exactly what it always was.
 *
 * Order: the active key from the encrypted store (decrypted here, kept in memory for at most 30 seconds per server
 * instance), else the environment variable. A missing table or function, or a missing encryption key, falls back to
 * the environment variable with one non-secret log line, so the code works before and after the migration.
 */
export const PROVIDER_KEY_CACHE_TTL_MS = 30_000;

export type KeySource = "store" | "env" | "none" | "pool";
export type StoreState =
  | "ok" // an active key was read and decrypted
  | "no_key" // the store is ready but holds no key for this provider
  | "not_ready" // table or function missing: migration not applied
  | "encryption_missing" // the store holds a key but the server cannot decrypt (variable not set)
  | "decrypt_failed" // the stored value fails authentication
  | "read_failed" // transient database error
  | "skipped"; // no database client available (tests, scripts)

export interface ResolvedProviderKey {
  provider: ProviderId;
  key: string;
  source: KeySource;
  last4: string | null;
  storeState: StoreState;
  resolvedAt: number;
  /** TREG with the key pool ON: which pool key this is (number and label for screens and call marks; never the key). */
  keyRef?: PoolKeyRef;
}

const ENV_NAMES: Record<ProviderId, readonly string[]> = {
  treg: ["TREG_TOKEN", "TREG_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  firecrawl: ["FIRECRAWL_API_KEY"],
  contextdev: ["CONTEXT_DEV_API_KEY"],
};

interface CacheEntry { value: ResolvedProviderKey; expiresAt: number }
const cache = new Map<ProviderId, CacheEntry>();
/** The last key that came from the store, kept past expiry so a database blip never flips to a possibly revoked env key. */
const lastGoodStore = new Map<ProviderId, ResolvedProviderKey>();
const inflight = new Map<ProviderId, Promise<ResolvedProviderKey>>();
const loggedOnce = new Set<string>();
let testClient: any = null;
let nowFn: () => number = () => Date.now();

export function __setProviderKeyStoreForTests(client: any | null, now?: () => number): void {
  testClient = client;
  nowFn = now ?? (() => Date.now());
  resetProviderKeyCache();
}

/** For a process that is not the website (the agent worker): the Supabase client the key store is read through, so nothing of Next is loaded to resolve a key. */
export function useProviderKeyStoreClient(client: any): void {
  testClient = client;
  resetProviderKeyCache();
}

export function resetProviderKeyCache(): void {
  cache.clear();
  lastGoodStore.clear();
  inflight.clear();
  loggedOnce.clear();
  authRejections.clear();
}

export function invalidateProviderKeyCache(provider?: ProviderId): void {
  if (provider) { cache.delete(provider); lastGoodStore.delete(provider); inflight.delete(provider); }
  else { cache.clear(); lastGoodStore.clear(); inflight.clear(); }
}

function logOnce(id: string, line: string): void {
  if (loggedOnce.has(id)) return;
  loggedOnce.add(id);
  console.warn(line);
}

export function readEnvProviderKey(provider: ProviderId): string {
  for (const name of ENV_NAMES[provider]) {
    const raw = process.env[name];
    const v = (raw || "").trim().replace(/^["']|["']$/g, "").trim();
    if (v) return v;
  }
  return "";
}

function isMissingStore(error: any): boolean {
  const code = String(error?.code || "");
  const msg = String(error?.message || "");
  return code === "42P01" || code === "PGRST205" || code === "PGRST202" || code === "42883" ||
    /does not exist|schema cache|could not find the (table|function)/i.test(msg);
}

async function getClient(): Promise<any | null> {
  if (testClient) return testClient;
  // Offline test runs and plain scripts have no store; they use the environment variable as before.
  if (process.env.VITEST === "true") return null;
  try {
    const mod = await import("../supabase/server");
    return mod.createAdminClient();
  } catch {
    return null;
  }
}

function fromEnv(provider: ProviderId, storeState: StoreState): ResolvedProviderKey {
  const key = readEnvProviderKey(provider);
  return { provider, key, source: key ? "env" : "none", last4: last4Of(key), storeState, resolvedAt: nowFn() };
}

async function loadFresh(provider: ProviderId): Promise<ResolvedProviderKey> {
  const client = await getClient();
  if (!client) return fromEnv(provider, "skipped");

  let row: any = null;
  try {
    const { data, error } = await client
      .from("provider_api_keys")
      .select("active_ciphertext, active_last4")
      .eq("provider", provider)
      .maybeSingle();
    if (error) {
      if (isMissingStore(error)) {
        logOnce(`not_ready:${provider}`, `[provider_key:store_not_ready] provider=${provider} using environment key until the migration is applied`);
        return fromEnv(provider, "not_ready");
      }
      logOnce(`read_failed:${provider}`, `[provider_key:store_read_failed] provider=${provider} code=${String(error?.code || "unknown")}`);
      const stale = lastGoodStore.get(provider);
      return stale ? { ...stale, storeState: "read_failed" } : fromEnv(provider, "read_failed");
    }
    row = data;
  } catch {
    logOnce(`read_failed:${provider}`, `[provider_key:store_read_failed] provider=${provider} code=exception`);
    const stale = lastGoodStore.get(provider);
    return stale ? { ...stale, storeState: "read_failed" } : fromEnv(provider, "read_failed");
  }

  const ciphertext = typeof row?.active_ciphertext === "string" ? row.active_ciphertext : "";
  if (!ciphertext) {
    lastGoodStore.delete(provider);
    return fromEnv(provider, "no_key");
  }

  try {
    const key = decryptProviderKey(provider, ciphertext);
    const resolved: ResolvedProviderKey = { provider, key, source: "store", last4: last4Of(key) || (row.active_last4 ?? null), storeState: "ok", resolvedAt: nowFn() };
    lastGoodStore.set(provider, resolved);
    return resolved;
  } catch (e) {
    const code = e instanceof ProviderKeyCryptoError ? e.code : "decrypt_failed";
    const state: StoreState = code === "encryption_key_missing" || code === "encryption_key_invalid" ? "encryption_missing" : "decrypt_failed";
    logOnce(`${state}:${provider}`, `[provider_key:${state}] provider=${provider} reason=${code} using environment key`);
    return fromEnv(provider, state);
  }
}

/** Async resolver for every provider call. Cached for 30 seconds per server instance (TREG with the key pool ON: the pool's active key, read every 3 seconds). */
export async function resolveProviderKey(provider: ProviderId, options?: { forceRefresh?: boolean }): Promise<ResolvedProviderKey> {
  if (provider === "treg") {
    const pool = getTregKeyPool();
    if (pool) {
      const choice = await pool.choose();
      if (choice.mode === "pool" && choice.key && choice.ref) {
        return { provider, key: choice.key, source: "pool", last4: last4Of(choice.key), storeState: "ok", resolvedAt: nowFn(), keyRef: choice.ref };
      }
    }
  }
  return resolveLegacyProviderKey(provider, options);
}

/** The key as it was before the pool: the encrypted store, then the environment. Used by the pool's own adoption of the main key and by the OFF/emergency paths. */
export async function resolveLegacyProviderKey(provider: ProviderId, options?: { forceRefresh?: boolean }): Promise<ResolvedProviderKey> {
  const now = nowFn();
  const hit = cache.get(provider);
  // Only a key that came from the store is held in memory. When the store gave nothing, the environment variable is
  // read again each time (it is free), so a variable changed at runtime is never hidden behind the cache.
  if (!options?.forceRefresh && hit && hit.expiresAt > now) return hit.value.source === "store" ? hit.value : fromEnv(provider, hit.value.storeState);
  const pending = inflight.get(provider);
  if (pending && !options?.forceRefresh) return pending;
  const p = loadFresh(provider)
    .then((value) => { cache.set(provider, { value, expiresAt: nowFn() + PROVIDER_KEY_CACHE_TTL_MS }); return value; })
    .finally(() => { if (inflight.get(provider) === p) inflight.delete(provider); });
  inflight.set(provider, p);
  return p;
}

/** Convenience for call sites that only need the key string. */
export async function getProviderKey(provider: ProviderId): Promise<string> {
  return (await resolveProviderKey(provider)).key;
}

/**
 * Synchronous best guess for code that cannot await (status snapshots, gate checks): the last resolved value, else
 * the environment variable. Callers that matter prime it with resolveProviderKey first.
 */
export function peekProviderKey(provider: ProviderId): string {
  if (provider === "treg") {
    const held = getTregKeyPool()?.peekKey();
    if (held) return held;
  }
  const hit = cache.get(provider)?.value ?? lastGoodStore.get(provider);
  if (hit && hit.source === "store" && hit.key) return hit.key;
  return readEnvProviderKey(provider);
}

// ---- Authentication rejections (401 / 403) -------------------------------------------------------------------

export interface AuthRejection { provider: ProviderId; httpStatus: number; source: KeySource; at: string; count: number }
const authRejections = new Map<ProviderId, AuthRejection>();

/**
 * A provider answered 401 or 403 for the key we used. We never switch keys on our own: a safe reason code is logged
 * and kept so the admin tab can show it. A good answer clears it.
 */
export function reportProviderHttpStatus(provider: ProviderId, httpStatus: number, source: KeySource): void {
  if (httpStatus === 401 || httpStatus === 403) {
    const prev = authRejections.get(provider);
    authRejections.set(provider, { provider, httpStatus, source, at: new Date(nowFn()).toISOString(), count: (prev?.count ?? 0) + 1 });
    console.error(`[provider_key:auth_rejected] provider=${provider} source=${source} status=${httpStatus}`);
  } else if (httpStatus >= 200 && httpStatus < 300) {
    authRejections.delete(provider);
  }
}

export function getLastAuthRejection(provider: ProviderId): AuthRejection | null {
  return authRejections.get(provider) ?? null;
}

export function envKeyConfigured(provider: ProviderId): boolean {
  return Boolean(readEnvProviderKey(provider));
}
