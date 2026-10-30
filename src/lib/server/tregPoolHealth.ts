import { checkProviderKey, extractProviderAccountEmail, extractTregOrgId, fetchTregBalance, type FetchLike } from "./providerStatus";
import type { TregKeyPool } from "./tregKeyPool";
import { decryptPoolKey } from "./tregPoolCrypto";

/**
 * The health check of the TREG key pool (docs/proposals/treg-key-pool/README.md). CHEAP, READ-ONLY calls only: the identity read (`GET /auth/me`, no metered cost) and the
 * balance read (`GET /orgs/{org}/balance`), per key. It never calls a billed endpoint. Results are written through treg_pool_record_check; a transient answer (timeout,
 * network, 5xx, 429) records only the time and leaves the status alone, so a blip never marks a key bad. The ACTIVE key found revoked or empty moves the pool on, exactly like
 * a failing call would.
 *
 * What a read-only check may NOT do (incident of 2026-10-30): «connected» is claimed only with a NUMERIC balance above the minimum. An identity read that passes with a balance that
 * cannot be read says nothing about the key (a suspended organisation passes it, and an exhausted key's balance read can fail), so it records no status at all. And a key a call
 * proved refused (revoked, with the reason of that evidence) is never turned back to «connected» by free reads; only a successful DATA call (the admin's 3-step check) or a new key does.
 */
export type CheckStatus = "connected" | "error" | "revoked" | "out_of_balance";
export interface KeyCheckResult {
  status: CheckStatus | null; reason: string; balanceMicro: number | null; email: string | null;
  /** The identity read passed (status stays null when the balance could not be read: the key is real, but nothing says it works). */
  identityOk?: boolean;
}

export const HEALTH_DEFAULT_MIN_BALANCE_MICRO = 10_000;
export const HEALTH_MAX_KEYS_PER_RUN = 200;
export const HEALTH_CONCURRENCY = 8;
export const HEALTH_BUDGET_MS = 45_000;
const TRANSIENT = new Set(["timeout", "network_error", "server_error", "rate_limited"]);
/** The reasons of a refusal PROVED BY A DATA CALL (an account-level 403 text, a 403 streak, a refused probe call): free reads cannot clear these. A key revoked because its identity read failed is not here: when that read passes again it is connected again. */
export const CALL_PROVEN_REFUSALS: ReadonlySet<string> = new Set(["org_suspended", "account_disabled", "auth_403_repeated", "data_401", "data_403"]);

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
  if (!org) return { status: null, reason: "org_unknown", balanceMicro: null, email, identityOk: true };
  const balance = await fetchTregBalance(key, org, fetchFn, options.timeoutMs);
  if (!balance.available || typeof balance.balanceMicro !== "number") return { status: null, reason: "balance_unreadable", balanceMicro: null, email, identityOk: true };
  return balance.balanceMicro <= min
    ? { status: "out_of_balance", reason: "balance_low", balanceMicro: balance.balanceMicro, email, identityOk: true }
    : { status: "connected", reason: "ok", balanceMicro: balance.balanceMicro, email, identityOk: true };
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
  /** Keys whose status was left as it was: a free read cannot clear a refusal a call proved. */
  held: number;
}

const isMissingFn = (e: any) => /PGRST202|42883|could not find the function|does not exist/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`);

export async function runPoolHealth(deps: HealthRunDeps): Promise<HealthRunResult> {
  const out: HealthRunResult = { ok: false, checked: 0, connected: 0, broken: 0, transient: 0, failovers: 0, held: 0 };
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

  // The reason each key's status carries now: a refused key keeps it when a free read cannot clear it (null = unreadable: then nothing is written for such a key)
  const priorReason = new Map<string, string | null>();
  try {
    const ov = await deps.client.rpc("treg_pool_overview", {});
    for (const row of Array.isArray(ov.data?.keys) ? ov.data.keys : []) priorReason.set(String(row.id), typeof row.status_reason === "string" ? row.status_reason : null);
  } catch { /* nothing known: a refused key is then simply not written */ }

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
      // a key a CALL proved refused is not cleared by free reads: keep its reason (nothing is written when the reason cannot be read, to be safe)
      const prior = priorReason.get(k.id);
      const held = result.status === "connected" && k.status === "revoked" && (prior === undefined || (prior !== null && CALL_PROVEN_REFUSALS.has(prior)));
      if (held) {
        out.held += 1;
        if (!prior) continue;
        result = { status: null, reason: prior, balanceMicro: result.balanceMicro, email: result.email };
      } else if (result.status === null) {
        out.transient += 1;
        // an unreadable balance says nothing new about a key already known bad: it keeps the reason it has
        if (result.identityOk && (k.status === "out_of_balance" || k.status === "revoked") && prior) result = { ...result, reason: prior };
      } else if (result.status === "connected") out.connected += 1;
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
