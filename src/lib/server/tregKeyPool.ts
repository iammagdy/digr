import { decryptPoolKey, parsePoolEncryptionKey } from "./tregPoolCrypto";
import { checkProviderKey, extractTregOrgId, fetchTregBalance, type FetchLike } from "./providerStatus";

/**
 * THE TREG KEY POOL at call time (docs/proposals/treg-key-pool/README.md). One module shared by the website and the Heroku worker; it imports nothing of Next,
 * and it never reads an environment variable: the worker hands in its own legacy key (TREG_TOKEN) per call.
 *
 *  - choose(): which key this call uses. Rollout switch OFF (or the pool SQL not applied) = the LEGACY keys exactly as today (website: store key then env; worker: its
 *    TREG_TOKEN). ON = the active pool key, from a 3-second cache of treg_pool_runtime(), so a switch is live on the next call. When the pool cannot be read the
 *    MAIN key from the legacy source is used (never a non-main key after a 30-second grace on the admin's own active key) and the admin is told.
 *  - afterCall(): when the key used answered 401/403/402 (not a price cap) it is VERIFIED with the free identity/balance reads; a confirmed revoked or empty key
 *    is recorded and the active key moves to the next one of the chain (main last) in one transaction (treg_pool_record_failover); the caller retries on it.
 *    Timeouts, 5xx, 429, 400/404/422 and route caps never switch anything.
 *  - the plaintext key lives only in this process's memory and never leaves this module except as the header of the call that uses it.
 */
export const POOL_SNAPSHOT_TTL_MS = 3_000;
export const POOL_FAILED_READ_TTL_MS = 1_000;
export const POOL_NOT_READY_TTL_MS = 30_000;
export const POOL_ENC_KEY_TTL_MS = 600_000;
export const POOL_STALE_GRACE_MS = 30_000;
export const POOL_MAX_HOPS = 3;
export const POOL_RPC_TIMEOUT_MS = 2_500;
export const POOL_RECORD_TIMEOUT_MS = 1_500;
export const POOL_VERIFY_TIMEOUT_MS = 5_000;
export const POOL_VERDICT_MEMO_MS = 5_000;
export const POOL_EMERGENCY_REFLUSH_MS = 300_000;
export const POOL_DIRECT_ALERT_MIN_GAP_MS = 3_600_000;
const LAST_REF_MAX = 2_000;
const LAST_REF_TTL_MS = 30 * 60_000;

export interface PoolKeyRef { id: string; number: number; label: string; isMain: boolean }
export type ChoiceMode = "legacy" | "pool" | "emergency";
export interface KeyChoice {
  mode: ChoiceMode;
  /** The plaintext key to send; null = use the legacy source (the website's resolver, today's behaviour). */
  key: string | null;
  ref: PoolKeyRef | null;
  /** The pool could not be read for a moment and this is the admin's last active key (inside the grace window). */
  stale?: boolean;
  reason?: string;
}

export interface RuntimeKey { id: string; number: number; label: string; is_main: boolean; in_chain: boolean; status: string; ciphertext: string }
export interface RuntimeSnapshot { rollout_on: boolean; active_id: string | null; generation: number; min_balance_micro: number; keys: RuntimeKey[] }
type SnapshotResult = { state: "ok"; snap: RuntimeSnapshot } | { state: "not_ready" } | { state: "unreadable"; code: string };

export type FailureVerdict = { status: "revoked" | "out_of_balance"; reason: string };
export interface PoolCallOutcome { ok: boolean; httpStatus: number; isPlatformBalanceLow?: boolean; isRouteMaxCost?: boolean; blocked?: string; budgetStopped?: boolean }
export interface EmergencyInfo { reason: string; source: "website" | "worker" }

export interface TregKeyPoolDeps {
  source: "website" | "worker";
  getClient: () => Promise<any | null>;
  fetchFn?: FetchLike;
  now?: () => number;
  /** Direct notice (the worker's optional ADMIN_ALERT_EMAIL path), at most once per hour; never carries a key. */
  onEmergency?: (info: EmergencyInfo) => void | Promise<void>;
}

const isMissingFunction = (error: any): boolean => {
  const code = String(error?.code || "");
  const msg = String(error?.message || "");
  return code === "PGRST202" || code === "42883" || code === "42P01" || code === "PGRST205" || /could not find the function|does not exist|schema cache/i.test(msg);
};

const withTimeout = <T,>(promise: PromiseLike<T>, ms: number, onTimeout: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(promise).catch(() => onTimeout),
    new Promise<T>((resolve) => { timer = setTimeout(() => resolve(onTimeout), ms); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
};

const validRuntime = (data: any): data is RuntimeSnapshot =>
  data && typeof data === "object" && typeof data.rollout_on === "boolean" && Array.isArray(data.keys) &&
  data.keys.every((k: any) => k && typeof k.id === "string" && typeof k.ciphertext === "string" && Number.isInteger(k.number));

export class TregKeyPool {
  readonly source: "website" | "worker";
  private readonly getClientFn: () => Promise<any | null>;
  private readonly fetchFn: FetchLike;
  private readonly nowFn: () => number;
  private readonly onEmergency?: TregKeyPoolDeps["onEmergency"];

  private cache: { at: number; ttl: number; result: SnapshotResult } | null = null;
  private inflight: Promise<SnapshotResult> | null = null;
  private lastGood: { snap: RuntimeSnapshot; at: number } | null = null;
  private enc: { key: string; at: number } | null = null;
  private readonly decrypted = new Map<string, { key: string; at: number }>();
  private readonly verdicts = new Map<string, { at: number; verdict: FailureVerdict | null }>();
  private readonly verifying = new Map<string, Promise<FailureVerdict | null>>();
  /** A failover just recorded for a key (a burst of calls failing on the same key records it once; the rest read the new active key). */
  private readonly recorded = new Map<string, { at: number; done: Promise<boolean> }>();
  private readonly lastRefs = new Map<string, { ref: PoolKeyRef; at: number }>();
  private lastChoice: { at: number; key: string | null; mode: ChoiceMode } | null = null;
  private lastLegacyToken: string | undefined;
  private emergency: { reason: string; flushedAt: number | null } | null = null;
  private lastDirectAlertAt = 0;
  private notReadyLogged = false;

  constructor(deps: TregKeyPoolDeps) {
    this.source = deps.source;
    this.getClientFn = deps.getClient;
    this.fetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init));
    this.nowFn = deps.now ?? (() => Date.now());
    this.onEmergency = deps.onEmergency;
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------------------------

  private async rpc(name: string, args: Record<string, unknown>, timeoutMs = POOL_RPC_TIMEOUT_MS): Promise<{ data: any; error: any }> {
    const client = await this.getClientFn().catch(() => null);
    if (!client) return { data: null, error: { code: "no_client" } };
    return withTimeout(client.rpc(name, args), timeoutMs, { data: null, error: { code: "timeout" } });
  }

  /** The cached view of treg_pool_runtime(); at most one read per 3 seconds per instance, shared by concurrent callers. */
  private async loadSnapshot(force = false): Promise<SnapshotResult> {
    const now = this.nowFn();
    if (!force && this.cache && now - this.cache.at < this.cache.ttl) return this.cache.result;
    if (!force && this.inflight) return this.inflight;
    const p = (async (): Promise<SnapshotResult> => {
      const client = await this.getClientFn().catch(() => null);
      if (!client) return { state: "not_ready" };
      const { data, error } = await withTimeout(client.rpc("treg_pool_runtime", {}), POOL_RPC_TIMEOUT_MS, { data: null, error: { code: "timeout" } });
      if (error) {
        if (isMissingFunction(error)) {
          if (!this.notReadyLogged) { this.notReadyLogged = true; console.warn("[treg_pool:not_ready] the pool SQL is not applied; legacy keys are used"); }
          return { state: "not_ready" };
        }
        return { state: "unreadable", code: String(error?.code || "error").slice(0, 40) };
      }
      if (!validRuntime(data)) return { state: "unreadable", code: "malformed" };
      return { state: "ok", snap: data };
    })()
      .then((result) => {
        const at = this.nowFn();
        const ttl = result.state === "ok" ? POOL_SNAPSHOT_TTL_MS : result.state === "not_ready" ? POOL_NOT_READY_TTL_MS : POOL_FAILED_READ_TTL_MS;
        this.cache = { at, ttl, result };
        if (result.state === "ok") this.lastGood = { snap: result.snap, at };
        return result;
      })
      .finally(() => { if (this.inflight === p) this.inflight = null; });
    this.inflight = p;
    return p;
  }

  /** Forget the cached view: the next call reads the database (after a switch, a failure verdict, an admin action). */
  invalidate(): void {
    this.cache = null;
    this.inflight = null;
  }

  /** The Vault key (treg_pool_enc_key), kept in memory for 10 minutes. Null when it cannot be read. */
  async encryptionKey(): Promise<string | null> {
    const now = this.nowFn();
    if (this.enc && now - this.enc.at < POOL_ENC_KEY_TTL_MS) return this.enc.key;
    const { data, error } = await this.rpc("treg_pool_enc_key", {});
    if (error || typeof data !== "string") return this.enc?.key ?? null;
    try { parsePoolEncryptionKey(data); } catch { return null; }
    this.enc = { key: data, at: now };
    return data;
  }

  private async decryptKey(k: RuntimeKey): Promise<string> {
    const cacheKey = `${k.id}:${k.ciphertext.slice(-22)}`;
    const hit = this.decrypted.get(cacheKey);
    if (hit) return hit.key;
    const enc = await this.encryptionKey();
    if (!enc) throw new Error("encryption_key_missing");
    const key = decryptPoolKey(enc, k.id, k.ciphertext);
    for (const stale of [...this.decrypted.keys()]) if (stale.startsWith(`${k.id}:`)) this.decrypted.delete(stale);
    this.decrypted.set(cacheKey, { key, at: this.nowFn() });
    return key;
  }

  private refOf(k: RuntimeKey): PoolKeyRef { return { id: k.id, number: k.number, label: k.label, isMain: k.is_main }; }

  // ---- choosing --------------------------------------------------------------------------------------------------------------------------

  /**
   * The key for ONE call. `legacyToken` is what the caller used before the pool existed (the worker's TREG_TOKEN); the website passes nothing and the legacy path is
   * its resolver (encrypted store, then environment).
   */
  async choose(legacyToken?: string): Promise<KeyChoice> {
    this.lastLegacyToken = legacyToken;
    const result = await this.loadSnapshot();
    const choice = await this.decide(result, legacyToken);
    this.lastChoice = { at: this.nowFn(), key: choice.mode === "pool" ? choice.key : null, mode: choice.mode };
    return choice;
  }

  private async decide(result: SnapshotResult, legacyToken?: string): Promise<KeyChoice> {
    const legacy: KeyChoice = { mode: "legacy", key: legacyToken || null, ref: null };
    if (result.state === "not_ready") return legacy;
    if (result.state === "unreadable") return this.whenUnreadable(result.code, legacyToken);

    const snap = result.snap;
    if (this.emergency && this.emergency.flushedAt === null) await this.flushEmergency();
    if (!snap.rollout_on) { this.emergency = null; return legacy; }

    const active = snap.keys.find((k) => k.id === snap.active_id);
    if (!active) return this.emergencyChoice("active_missing", legacyToken, true);
    try {
      const key = await this.decryptKey(active);
      this.emergency = null;
      return { mode: "pool", key, ref: this.refOf(active) };
    } catch (e) {
      const reason = e instanceof Error && e.message === "encryption_key_missing" ? "encryption_key_missing" : "decrypt_failed";
      return this.emergencyChoice(reason, legacyToken, true);
    }
  }

  private async whenUnreadable(code: string, legacyToken?: string): Promise<KeyChoice> {
    const lg = this.lastGood;
    // never known to be ON: behave exactly as today (no pool, no alert)
    if (!lg || !lg.snap.rollout_on) return { mode: "legacy", key: legacyToken || null, ref: null };
    if (this.nowFn() - lg.at <= POOL_STALE_GRACE_MS) {
      const active = lg.snap.keys.find((k) => k.id === lg.snap.active_id);
      const held = active ? this.decrypted.get(`${active.id}:${active.ciphertext.slice(-22)}`) : undefined;
      if (active && held) return { mode: "pool", key: held.key, ref: this.refOf(active), stale: true };
    }
    return this.emergencyChoice(`db_${code}`.slice(0, 60), legacyToken, false);
  }

  /** The MAIN key from the legacy source; the admin is told once per episode. Never a non-main key. */
  private async emergencyChoice(reason: string, legacyToken: string | undefined, dbReachable: boolean): Promise<KeyChoice> {
    if (!this.emergency) {
      this.emergency = { reason, flushedAt: null };
      console.warn(`[treg_pool:emergency] source=${this.source} reason=${reason} using the main key from the environment`);
      if (this.onEmergency && this.nowFn() - this.lastDirectAlertAt >= POOL_DIRECT_ALERT_MIN_GAP_MS) {
        this.lastDirectAlertAt = this.nowFn();
        try { await this.onEmergency({ reason, source: this.source }); } catch { /* a notice never changes a call */ }
      }
    }
    if (dbReachable && (this.emergency.flushedAt === null || this.nowFn() - this.emergency.flushedAt >= POOL_EMERGENCY_REFLUSH_MS)) await this.flushEmergency();
    return { mode: "emergency", key: legacyToken || null, ref: null, reason };
  }

  /** Opens the «store_unreadable» alert row (the cron route e-mails it). Only when the database answers. */
  private async flushEmergency(): Promise<void> {
    const e = this.emergency;
    if (!e) return;
    const { error } = await this.rpc("treg_pool_claim_alert", { p_problem: "store_unreadable", p_key_id: null, p_reason: e.reason.slice(0, 60), p_to_key_id: null }, POOL_RECORD_TIMEOUT_MS);
    if (!error) e.flushedAt = this.nowFn();
  }

  // ---- failure handling ------------------------------------------------------------------------------------------------------------------

  /**
   * After a call that FAILED on a pool key: the next key to retry on, or null (nothing to do, or the failure is not the key's). `forceMain` is the last allowed hop:
   * the retry goes straight to the main key.
   */
  async afterCall(choice: KeyChoice, outcome: PoolCallOutcome, options: { forceMain?: boolean } = {}): Promise<KeyChoice | null> {
    if (choice.mode !== "pool" || !choice.ref || !choice.key || outcome.ok || outcome.blocked || outcome.budgetStopped) return null;
    const balance402 = outcome.httpStatus === 402 && outcome.isPlatformBalanceLow === true && outcome.isRouteMaxCost !== true;
    const candidate = outcome.httpStatus === 401 || outcome.httpStatus === 403 || balance402;
    if (!candidate) return null;

    const verdict = await this.verdictFor(choice.ref, choice.key, balance402);
    if (!verdict) return null;
    // One recording per key per burst: later callers WAIT for it (they must read the new active key, not the one this switch is replacing)
    let entry = this.recorded.get(choice.ref.id);
    if (!entry || this.nowFn() - entry.at >= POOL_VERDICT_MEMO_MS) {
      const failedId = choice.ref.id;
      const done = (async () => {
        const recorded = await this.rpc("treg_pool_record_failover", { p_failed_key_id: failedId, p_new_status: verdict.status, p_reason: verdict.reason, p_source: this.source }, POOL_RECORD_TIMEOUT_MS + 1_000);
        if (recorded.error || !recorded.data?.success) return false;
        this.invalidate();
        return true;
      })();
      entry = { at: this.nowFn(), done };
      this.recorded.set(failedId, entry);
    }
    if (!(await entry.done)) { if (this.recorded.get(choice.ref.id) === entry) this.recorded.delete(choice.ref.id); return null; }
    if (options.forceMain) {
      const snap = await this.loadSnapshot(true);
      if (snap.state === "ok") {
        const main = snap.snap.keys.find((k) => k.is_main);
        if (main && main.id !== choice.ref.id) {
          try { return { mode: "pool", key: await this.decryptKey(main), ref: this.refOf(main) }; } catch { return null; }
        }
      }
      return null;
    }
    const next = await this.choose(this.lastLegacyToken);
    return next.mode === "pool" && next.ref && next.ref.id !== choice.ref.id ? next : null;
  }

  private verdictFor(ref: PoolKeyRef, key: string, balance402: boolean): Promise<FailureVerdict | null> {
    const memo = this.verdicts.get(ref.id);
    if (memo && this.nowFn() - memo.at < POOL_VERDICT_MEMO_MS) return Promise.resolve(memo.verdict);
    const running = this.verifying.get(ref.id);
    if (running) return running;
    const p = (async (): Promise<FailureVerdict | null> => {
      if (balance402) return { status: "out_of_balance", reason: "http_402" };
      const { health, body } = await checkProviderKey("treg", key, this.fetchFn, POOL_VERIFY_TIMEOUT_MS);
      if (!health.ok) return health.httpStatus === 401 || health.httpStatus === 403 ? { status: "revoked", reason: `auth_${health.httpStatus}` } : null;
      const org = extractTregOrgId(body);
      if (!org) return null;
      const min = this.cache?.result.state === "ok" ? this.cache.result.snap.min_balance_micro : 10_000;
      const balance = await fetchTregBalance(key, org, this.fetchFn, POOL_VERIFY_TIMEOUT_MS);
      return balance.available && typeof balance.balanceMicro === "number" && balance.balanceMicro <= min ? { status: "out_of_balance", reason: "balance_low" } : null;
    })()
      .catch(() => null)
      .then((verdict) => { this.verdicts.set(ref.id, { at: this.nowFn(), verdict }); return verdict; })
      .finally(() => { this.verifying.delete(ref.id); });
    this.verifying.set(ref.id, p);
    return p;
  }

  /** The health check found the ACTIVE key revoked or empty: the same switch a failing call would make. Returns whether the active key moved. */
  async failoverFromHealth(keyId: string, status: "revoked" | "out_of_balance", reason: string): Promise<boolean> {
    const { data, error } = await this.rpc("treg_pool_record_failover", { p_failed_key_id: keyId, p_new_status: status, p_reason: reason.slice(0, 60), p_source: "health" }, POOL_RECORD_TIMEOUT_MS + 1_000);
    this.invalidate();
    return !error && data?.success === true && data?.switched === true;
  }

  // ---- call marks ------------------------------------------------------------------------------------------------------------------------

  /** Remember the key a job's latest call used, so the cost row the job commits next carries the mark (the website's worker commits one row per chunk). */
  noteUse(jobId: string | null | undefined, ref: PoolKeyRef): void {
    if (!jobId) return;
    const now = this.nowFn();
    this.lastRefs.delete(jobId);
    this.lastRefs.set(jobId, { ref, at: now });
    while (this.lastRefs.size > LAST_REF_MAX) { const oldest = this.lastRefs.keys().next().value; if (oldest === undefined) break; this.lastRefs.delete(oldest); }
  }

  lastRefFor(jobId: string | null | undefined): PoolKeyRef | null {
    if (!jobId) return null;
    const hit = this.lastRefs.get(jobId);
    return hit && this.nowFn() - hit.at <= LAST_REF_TTL_MS ? hit.ref : null;
  }

  /** Which key made the call behind this cost row (number and label only). Never throws and never delays a call by more than 1.5 s. */
  async recordCall(ref: PoolKeyRef | null | undefined, costId: number | null | undefined): Promise<void> {
    if (!ref || costId === null || costId === undefined) return;
    await this.rpc("treg_pool_record_call", { p_cost_id: costId, p_key_id: ref.id, p_source: this.source }, POOL_RECORD_TIMEOUT_MS);
  }

  // ---- for the resolver, the redaction and the admin ------------------------------------------------------------------------------------

  /** The active pool key if one was chosen a moment ago (for synchronous readers); otherwise null. */
  peekKey(): string | null {
    const c = this.lastChoice;
    return c && c.mode === "pool" && c.key && this.nowFn() - c.at < 10_000 ? c.key : null;
  }

  /** Every pool key this process holds decrypted: used only to redact them from error text. */
  knownKeys(): string[] {
    return [...this.decrypted.values()].map((v) => v.key).filter((k) => k.length > 4);
  }
}

// ---- the process-wide pool --------------------------------------------------------------------------------------------------------------

let instance: TregKeyPool | null = null;
let websiteClient: any | null = null;

/** The pool of this process, or null in offline test runs (no database client) and when nothing configured one. The website creates it on first use. */
export function getTregKeyPool(): TregKeyPool | null {
  if (instance) return instance;
  if (process.env.VITEST === "true") return null;
  instance = new TregKeyPool({
    source: "website",
    getClient: async () => {
      if (websiteClient) return websiteClient;
      try { websiteClient = (await import("../supabase/server")).createAdminClient(); return websiteClient; } catch { return null; }
    },
  });
  return instance;
}

/** The Heroku worker (its own Supabase client, source «worker») and the tests. */
export function configureTregKeyPool(deps: TregKeyPoolDeps): TregKeyPool {
  instance = new TregKeyPool(deps);
  return instance;
}

export function resetTregKeyPoolForTests(): void {
  instance = null;
  websiteClient = null;
}
