import { checkProviderKey, extractProviderAccountEmail, extractTregOrgId, fetchTregBalance, type FetchLike } from "./providerStatus";
import type { TregKeyPool } from "./tregKeyPool";
import { decryptPoolKey } from "./tregPoolCrypto";

/**
 * The health check of the TREG key pool (docs/proposals/treg-key-pool/README.md). CHEAP, READ-ONLY calls only: the identity read (`GET /auth/me`, no metered cost) and the
 * balance read (`GET /orgs/{org}/balance`), per key. It never calls a billed endpoint. Results are written through treg_pool_record_check; a transient answer (timeout,
 * network, 5xx, 429) records only the time and leaves the status alone, so a blip never marks a key bad. The ACTIVE key found revoked or empty moves the pool on, exactly like
 * a failing call would.
 */
export type CheckStatus = "connected" | "error" | "revoked" | "out_of_balance";
export interface KeyCheckResult { status: CheckStatus | null; reason: string; balanceMicro: number | null; email: string | null }

export const HEALTH_DEFAULT_MIN_BALANCE_MICRO = 10_000;
export const HEALTH_MAX_KEYS_PER_RUN = 200;
export const HEALTH_CONCURRENCY = 8;
export const HEALTH_BUDGET_MS = 45_000;
const TRANSIENT = new Set(["timeout", "network_error", "server_error", "rate_limited"]);

export async function checkPoolKey(key: string, options: { fetchFn?: FetchLike; minBalanceMicro?: number; orgId?: string | null; timeoutMs?: number } = {}): Promise<KeyCheckResult> {
  const fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  const min = options.minBalanceMicro ?? HEALTH_DEFAULT_MIN_BALANCE_MICRO;
  let checked = await checkProviderKey("treg", key, fetchFn, options.timeoutMs);
  // one more try for a blip, as the provider tab's own check does
  if (!checked.health.ok && TRANSIENT.has(checked.health.reason)) checked = await checkProviderKey("treg", key, fetchFn, options.timeoutMs);
  const { health, body } = checked;
  if (!health.ok) {
    if (health.httpStatus === 401 || health.httpStatus === 403) return { status: "revoked", reason: `auth_${health.httpStatus}`, balanceMicro: null, email: null };
    if (TRANSIENT.has(health.reason)) return { status: null, reason: `transient_${health.reason}`.slice(0, 60), balanceMicro: null, email: null };
    return { status: "error", reason: `http_${health.httpStatus ?? "none"}`.slice(0, 60), balanceMicro: null, email: null };
  }
  const email = extractProviderAccountEmail(body);
  const org = options.orgId || extractTregOrgId(body);
  if (!org) return { status: "connected", reason: "org_unknown", balanceMicro: null, email };
  const balance = await fetchTregBalance(key, org, fetchFn, options.timeoutMs);
  if (!balance.available || typeof balance.balanceMicro !== "number") return { status: "connected", reason: "balance_unreadable", balanceMicro: null, email };
  return balance.balanceMicro <= min
    ? { status: "out_of_balance", reason: "balance_low", balanceMicro: balance.balanceMicro, email }
    : { status: "connected", reason: "ok", balanceMicro: balance.balanceMicro, email };
}

export interface HealthRunDeps {
  client: any;
  pool: TregKeyPool;
  fetchFn?: FetchLike;
  now?: () => number;
  /** Only these key ids (the admin's «فحص الآن» of one key); null = the keys not checked for the longest time, up to the limit. */
  only?: string[] | null;
  limit?: number;
  concurrency?: number;
  budgetMs?: number;
  /** The TREG team id the admin saved for the MAIN key (settings), used only for the main key. */
  mainOrgId?: string | null;
  source?: "health" | "admin";
}

export interface HealthRunResult {
  ok: boolean;
  /** Why nothing ran: the key function (SQL 06) or the Vault key is not available. */
  problem?: "sql_not_ready" | "encryption_unavailable" | "read_failed";
  checked: number;
  connected: number;
  broken: number;
  transient: number;
  failovers: number;
}

const isMissingFn = (e: any) => /PGRST202|42883|could not find the function|does not exist/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`);

export async function runPoolHealth(deps: HealthRunDeps): Promise<HealthRunResult> {
  const out: HealthRunResult = { ok: false, checked: 0, connected: 0, broken: 0, transient: 0, failovers: 0 };
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const budget = deps.budgetMs ?? HEALTH_BUDGET_MS;
  const enc = await deps.pool.encryptionKey();
  if (!enc) return { ...out, problem: "encryption_unavailable" };

  const listed = await deps.client.rpc("treg_pool_keys_for_check", { p_ids: deps.only ?? null, p_limit: Math.min(deps.limit ?? HEALTH_MAX_KEYS_PER_RUN, HEALTH_MAX_KEYS_PER_RUN) });
  if (listed.error) return { ...out, problem: isMissingFn(listed.error) ? "sql_not_ready" : "read_failed" };
  const keys: Array<{ id: string; number: number; label: string; is_main: boolean; status: string; ciphertext: string }> = Array.isArray(listed.data) ? listed.data : [];

  let minBalance = HEALTH_DEFAULT_MIN_BALANCE_MICRO;
  try {
    const rt = await deps.client.rpc("treg_pool_runtime", {});
    if (typeof rt.data?.min_balance_micro === "number") minBalance = rt.data.min_balance_micro;
  } catch { /* the default */ }

  const source = deps.source ?? "health";
  let next = 0;
  const worker = async () => {
    while (next < keys.length && now() - started < budget) {
      const k = keys[next++];
      let result: KeyCheckResult;
      try {
        const plain = decryptPoolKey(enc, k.id, k.ciphertext);
        result = await checkPoolKey(plain, { fetchFn: deps.fetchFn, minBalanceMicro: minBalance, orgId: k.is_main ? deps.mainOrgId ?? null : null });
      } catch {
        result = { status: "error", reason: "decrypt_failed", balanceMicro: null, email: null };
      }
      out.checked += 1;
      if (result.status === null) out.transient += 1;
      else if (result.status === "connected") out.connected += 1;
      else out.broken += 1;
      try {
        const rec = await deps.client.rpc("treg_pool_record_check", {
          p_key_id: k.id, p_status: result.status, p_reason: result.reason, p_balance_micro: result.balanceMicro, p_email: result.email, p_source: source,
        });
        if (rec.data?.needs_failover === true && (result.status === "revoked" || result.status === "out_of_balance")) {
          if (await deps.pool.failoverFromHealth(k.id, result.status, result.reason)) out.failovers += 1;
        }
      } catch { /* the next run records it again */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? HEALTH_CONCURRENCY, keys.length || 1)) }, worker));
  deps.pool.invalidate();
  return { ...out, ok: true };
}
