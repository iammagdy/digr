import { randomBytes, randomUUID } from "node:crypto";
import { vi } from "vitest";
import { encryptPoolKey } from "../../src/lib/server/tregPoolCrypto";
import { configureTregKeyPool, resetTregKeyPoolForTests, type TregKeyPool } from "../../src/lib/server/tregKeyPool";

/** Synthetic values only: random per run, never a real credential. */
export const fakeSecret = (tag: string) => `testonly-${tag}-${randomBytes(9).toString("hex")}`;
export const ADMIN = "admin-1";

export const clock = { t: 1_800_000_000_000, now: () => clock.t, advance(ms: number) { clock.t += ms; } };

// ---------------------------------------------------------------------------------------------------------------------------------------
// A fake of the SQL functions of docs/proposals/treg-key-pool (03 and 06). The real SQL is exercised on a scratch Postgres; this model follows
// it function by function so the application code can be tested without a database. tests/treg-pool-contract.test.ts keeps the two in step.
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface FakeKey {
  id: string; number: number; label: string; is_main: boolean; in_chain: boolean; chain_position: number; ciphertext: string | null; last4: string; account_email: string | null;
  status: "unknown" | "connected" | "error" | "revoked" | "out_of_balance"; status_reason: string | null; status_checked_at: string | null; balance_micro: number | null; balance_checked_at: string | null; removed: boolean;
}
export interface FakeAlert { id: number; problem: string; scope: string; key_id: string | null; key_number: number | null; key_label: string | null; to_key_number: number | null; to_key_label: string | null; reason: string | null; created_at: number; cleared: boolean; emailed: boolean; attempts: number; lease: number }

export function fakePoolDb(options: { admins?: string[] } = {}) {
  const admins = new Set(options.admins ?? [ADMIN]);
  const encKey = randomBytes(32).toString("base64");
  const state = { rollout_on: false, active_key_id: null as string | null, generation: 0, min_balance_micro: 10_000, last_health_run_at: null as number | null, worker_env_last4: null as string | null };
  const keys: FakeKey[] = [];
  const events: Array<{ kind: string; key_number: number | null; to_key_number: number | null; reason: string | null; source: string }> = [];
  const alerts: FakeAlert[] = [];
  const calls = new Map<number, { key_id: string; key_number: number; key_label: string; source: string }>();
  const costs = new Map<number, number>();
  const costStatus = new Map<number, "success" | "failed" | "empty">();
  const costAt = new Map<number, number>();
  /** provider_costs as the two spend functions see it (reserve_provider_spend_atomic / commit_provider_spend_v2, modelled from the live definitions): today's spend and the open estimates. */
  const spend = { today: 0, nextCost: 1000, estimates: new Map<number, number>(), reserveCalls: [] as Array<{ job: string | null; provider: string; est: number; cap: number }> };
  const rpcLog: Array<{ fn: string; args: any }> = [];
  const flags = { down: false, missingFunctions: false, encMissing: false, noCheckFn: false, noCallHealth: false };
  let nextNumber = 1;
  let nextAlert = 1;

  const live = () => keys.filter((k) => !k.removed);
  const ordered = (list: FakeKey[]) => [...list].sort((a, b) => Number(a.is_main) - Number(b.is_main) || a.chain_position - b.chain_position || a.number - b.number);
  const byId = (id: unknown) => live().find((k) => k.id === id);
  const iso = () => new Date(clock.t).toISOString();
  const log = (kind: string, key: FakeKey | undefined, to: FakeKey | undefined, reason: string | null, source: string) => events.push({ kind, key_number: key?.number ?? null, to_key_number: to?.number ?? null, reason, source });

  function nextKey(failed: FakeKey): FakeKey | null {
    if (failed.is_main) return null;
    const after = ordered(live()).filter((k) => k.ciphertext && k.in_chain && !k.is_main && k.id !== failed.id && !["revoked", "out_of_balance"].includes(k.status)
      && (!failed.in_chain || k.chain_position > failed.chain_position || (k.chain_position === failed.chain_position && k.number > failed.number)));
    return after[0] ?? live().find((k) => k.is_main && k.ciphertext) ?? null;
  }

  function claimAlert(problem: string, keyId: string | null, reason: string | null, toKey?: FakeKey | null): boolean {
    const scope = keyId ?? "0";
    if (alerts.some((a) => a.problem === problem && a.scope === scope && clock.t - a.created_at < 30 * 60_000)) return false;
    const k = byId(keyId);
    alerts.push({ id: nextAlert++, problem, scope, key_id: keyId, key_number: k?.number ?? null, key_label: k?.label ?? null, to_key_number: toKey?.number ?? null, to_key_label: toKey?.label ?? null, reason, created_at: clock.t, cleared: false, emailed: false, attempts: 0, lease: 0 });
    return true;
  }
  const clearAlerts = (keyId: string, problems?: string[]) => alerts.forEach((a) => { if (!a.cleared && a.scope === keyId && (!problems || problems.includes(a.problem))) a.cleared = true; });
  const notAdmin = { success: false, error: "not_admin", error_ar: "هذا الإجراء مخصص للمسؤولين فقط." };
  const fail = (error: string, error_ar = "خطأ") => ({ success: false, error, error_ar });

  const handlers: Record<string, (a: any) => any> = {
    treg_pool_enc_key: () => (flags.encMissing ? null : encKey),
    treg_pool_runtime: () => ({
      rollout_on: state.rollout_on, active_id: state.active_key_id, generation: state.generation, min_balance_micro: state.min_balance_micro,
      keys: state.rollout_on ? ordered(live()).filter((k) => k.ciphertext && (k.in_chain || k.id === state.active_key_id)).map((k) => ({ id: k.id, number: k.number, label: k.label, is_main: k.is_main, in_chain: k.in_chain, status: k.status, ciphertext: k.ciphertext })) : [],
    }),
    treg_pool_record_failover: (a) => {
      if (!["revoked", "out_of_balance"].includes(a.p_new_status)) return { success: false, error: "invalid_status" };
      const failed = byId(a.p_failed_key_id);
      if (!failed) return { success: false, error: "unknown_key" };
      failed.status = a.p_new_status; failed.status_reason = String(a.p_reason).slice(0, 60); failed.status_checked_at = iso();
      let switched = false; let aFail = false; let aMain = false; let aMainFailed = false;
      if (state.rollout_on && state.active_key_id === failed.id) {
        const to = nextKey(failed);
        if (to) {
          state.active_key_id = to.id; state.generation += 1; switched = true;
          log("failover", failed, to, a.p_reason, a.p_source);
          aFail = claimAlert("failover", failed.id, a.p_new_status, to);
          if (to.is_main) aMain = claimAlert("chain_reached_main", to.id, "chain_reached_main");
        } else aMainFailed = claimAlert("main_failed", failed.id, a.p_new_status);
      }
      return { success: true, switched, active_id: state.active_key_id, alert_failover: aFail, alert_chain_reached_main: aMain, alert_main_failed: aMainFailed };
    },
    treg_pool_record_check: (a) => {
      const k = byId(a.p_key_id);
      if (!k) return { success: false, error: "unknown_key" };
      const prev = k.status;
      const active = state.rollout_on && state.active_key_id === k.id;
      if (a.p_status === null || a.p_status === undefined) { k.status_reason = String(a.p_reason).slice(0, 60); k.status_checked_at = iso(); return { success: true, status: prev, needs_failover: false, alert_health: false }; }
      k.status = a.p_status; k.status_reason = String(a.p_reason).slice(0, 60); k.status_checked_at = iso();
      if (a.p_balance_micro !== null && a.p_balance_micro !== undefined) { k.balance_micro = a.p_balance_micro; k.balance_checked_at = iso(); }
      if (a.p_email) k.account_email = a.p_email;
      let alert = false;
      if (a.p_status === "connected") clearAlerts(k.id, ["failover", "health_broken", "main_failed"]);
      else if (a.p_status !== prev && !active) alert = claimAlert("health_broken", k.id, a.p_status);
      return { success: true, status: a.p_status, needs_failover: active && ["revoked", "out_of_balance"].includes(a.p_status), alert_health: alert };
    },
    treg_pool_record_call: (a) => { const k = byId(a.p_key_id); if (k && !calls.has(a.p_cost_id)) calls.set(a.p_cost_id, { key_id: k.id, key_number: k.number, key_label: k.label, source: a.p_source }); return null; },
    treg_pool_claim_alert: (a) => claimAlert(a.p_problem, a.p_key_id, a.p_reason, byId(a.p_to_key_id)),
    treg_pool_keys_for_check: (a) => {
      const list = live().filter((k) => k.ciphertext && (!a.p_ids || a.p_ids.includes(k.id))).sort((x, y) => (x.status_checked_at ?? "").localeCompare(y.status_checked_at ?? "") || x.number - y.number).slice(0, Math.min(a.p_limit ?? 200, 500));
      return list.map((k) => ({ id: k.id, number: k.number, label: k.label, is_main: k.is_main, status: k.status, ciphertext: k.ciphertext }));
    },
    treg_pool_claim_health_run: (a) => {
      if (state.last_health_run_at === null || clock.t - state.last_health_run_at >= Math.max(a.p_min_interval_seconds ?? 600, 60) * 1000) { state.last_health_run_at = clock.t; return true; }
      return false;
    },
    treg_pool_note_worker: (a) => { state.worker_env_last4 = a.p_env_last4 ? String(a.p_env_last4).slice(0, 4) : null; return null; },
    treg_pool_take_pending_alerts: (a) => {
      const picked = alerts.filter((x) => !x.emailed && x.attempts < 5 && clock.t - x.created_at < 24 * 3600_000 && x.lease < clock.t).slice(0, Math.min(a.p_limit ?? 10, 25));
      picked.forEach((x) => { x.lease = clock.t + 180_000; x.attempts += 1; });
      return picked.map((x) => ({ id: x.id, problem: x.problem, key_number: x.key_number, key_label: x.key_label, to_key_number: x.to_key_number, to_key_label: x.to_key_label, reason: x.reason, created_at: new Date(x.created_at).toISOString() }));
    },
    treg_pool_mark_alert_emailed: (a) => { const x = alerts.find((y) => y.id === a.p_alert_id); if (x) { if (a.p_ok) x.emailed = true; else x.lease = 0; } return null; },
    treg_pool_overview: () => ({
      state: { rollout_on: state.rollout_on, active_key_id: state.active_key_id, generation: state.generation, min_balance_micro: state.min_balance_micro, last_health_run_at: state.last_health_run_at ? new Date(state.last_health_run_at).toISOString() : null, worker_env_last4: state.worker_env_last4, worker_seen_at: null },
      keys: [...live()].sort((a, b) => a.number - b.number).map((k) => ({ id: k.id, number: k.number, label: k.label, is_main: k.is_main, in_chain: k.in_chain, chain_position: k.chain_position, last4: k.last4, account_email: k.account_email, status: k.status, status_reason: k.status_reason, status_checked_at: k.status_checked_at, balance_micro: k.balance_micro, balance_checked_at: k.balance_checked_at, created_at: iso() })),
      events: events.slice(-20).reverse().map((e) => ({ at: iso(), ...e, key_label: null, to_key_label: null })),
    }),
    treg_pool_spend: () => {
      const by = new Map<number, { key_number: number; key_label: string; calls: number; spend_usd: number; spend_today_usd: number; last_call_at: string | null }>();
      for (const [cost, c] of calls) { const e = by.get(c.key_number) ?? { key_number: c.key_number, key_label: c.key_label, calls: 0, spend_usd: 0, spend_today_usd: 0, last_call_at: iso() }; e.calls += 1; e.spend_usd += costs.get(cost) ?? 0; e.spend_today_usd += costs.get(cost) ?? 0; by.set(c.key_number, e); }
      return [...by.values()];
    },
    reserve_provider_spend_atomic: (a) => {
      spend.reserveCalls.push({ job: a.p_job_id ?? null, provider: a.p_provider, est: a.p_estimated_cost_usd, cap: a.p_daily_cap_usd });
      if (spend.today + a.p_estimated_cost_usd > a.p_daily_cap_usd) return { allowed: false, current_spend: spend.today, daily_cap: a.p_daily_cap_usd, estimated_cost: a.p_estimated_cost_usd };
      const id = spend.nextCost++; spend.today += a.p_estimated_cost_usd; spend.estimates.set(id, a.p_estimated_cost_usd); costs.set(id, a.p_estimated_cost_usd); costAt.set(id, clock.t);
      return { allowed: true, cost_id: id, current_spend: spend.today, daily_cap: a.p_daily_cap_usd };
    },
    commit_provider_spend_v2: (a) => {
      if (!spend.estimates.has(a.p_cost_id)) throw new Error("not found or already committed");
      spend.today += a.p_actual_cost_usd - (spend.estimates.get(a.p_cost_id) ?? 0); spend.estimates.delete(a.p_cost_id);
      costs.set(a.p_cost_id, a.p_actual_cost_usd); costStatus.set(a.p_cost_id, a.p_status); costAt.set(a.p_cost_id, clock.t);
      return { success: true };
    },
    // SQL 07: when each key last ANSWERED a data call (success or empty) and the failures since; fed by `costStatus` per cost id
    treg_pool_call_health: () => {
      const by = new Map<number, { key_number: number; last_ok_at: string | null; last_failed_at: string | null; failed_since_ok: number }>();
      const list = [...calls.entries()].map(([cost, c]) => ({ cost, ...c, status: costStatus.get(cost) ?? "success", at: costAt.get(cost) ?? clock.t })).sort((a, b) => a.at - b.at);
      for (const c of list) {
        const e = by.get(c.key_number) ?? { key_number: c.key_number, last_ok_at: null, last_failed_at: null, failed_since_ok: 0 };
        if (c.status === "failed") { e.last_failed_at = new Date(c.at).toISOString(); e.failed_since_ok += 1; } else { e.last_ok_at = new Date(c.at).toISOString(); e.failed_since_ok = 0; }
        by.set(c.key_number, e);
      }
      return [...by.values()];
    },
    // ---- admin (role verified inside) ----
    admin_add_treg_pool_key: (a) => {
      if (!admins.has(a.p_admin_id)) return notAdmin;
      if (!/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{22}$/.test(String(a.p_ciphertext))) return fail("invalid_ciphertext");
      if (a.p_is_main && live().some((k) => k.is_main)) return fail("main_exists", "يوجد مفتاح رئيسي بالفعل؛ يمكن استبداله فقط.");
      const row: FakeKey = { id: a.p_id, number: nextNumber++, label: String(a.p_label).trim(), is_main: Boolean(a.p_is_main), in_chain: true, chain_position: Math.max(0, ...live().map((k) => k.chain_position)) + 1, ciphertext: a.p_ciphertext, last4: a.p_last4, account_email: a.p_email ?? null, status: "unknown", status_reason: null, status_checked_at: null, balance_micro: null, balance_checked_at: null, removed: false };
      keys.push(row); log("key_added", row, undefined, a.p_is_main ? "main" : "pool", "admin");
      return { success: true, id: row.id, number: row.number };
    },
    admin_replace_treg_pool_key: (a) => {
      if (!admins.has(a.p_admin_id)) return notAdmin;
      const k = byId(a.p_key_id); if (!k) return fail("unknown_key");
      k.ciphertext = a.p_ciphertext; k.last4 = a.p_last4; k.account_email = a.p_email ?? null; if (a.p_label) k.label = a.p_label; k.status = "unknown"; k.status_reason = null; k.balance_micro = null;
      clearAlerts(k.id); if (state.active_key_id === k.id) state.generation += 1; log("key_replaced", k, undefined, null, "admin");
      return { success: true, id: k.id };
    },
    admin_remove_treg_pool_key: (a) => {
      if (!admins.has(a.p_admin_id)) return notAdmin;
      const k = byId(a.p_key_id); if (!k) return fail("unknown_key");
      if (k.is_main) return fail("main_cannot_be_removed", "المفتاح الرئيسي لا يُحذف؛ يمكن استبداله فقط.");
      if (state.active_key_id === k.id) return fail("key_in_use", "هذا المفتاح هو المستخدم الآن؛ فعّل مفتاحًا آخر أولًا.");
      k.ciphertext = null; k.removed = true; k.in_chain = false; clearAlerts(k.id); log("key_removed", k, undefined, null, "admin");
      return { success: true, id: k.id };
    },
    admin_set_treg_active_key: (a) => {
      if (!admins.has(a.p_admin_id)) return notAdmin;
      const k = byId(a.p_key_id); if (!k || !k.ciphertext) return fail("unknown_key");
      if (["revoked", "out_of_balance"].includes(k.status) && !a.p_force) return { success: false, error: "key_not_usable", status: k.status, error_ar: "هذا المفتاح ملغى أو رصيده انتهى؛ لن يُفعَّل إلا بتأكيد صريح." };
      state.active_key_id = k.id; state.generation += 1; log("active_set", k, undefined, null, "admin");
      if (!k.is_main) { const m = live().find((x) => x.is_main); if (m) clearAlerts(m.id, ["chain_reached_main"]); }
      return { success: true, active_id: k.id, generation: state.generation };
    },
    admin_set_treg_chain: (a) => {
      if (!admins.has(a.p_admin_id)) return notAdmin;
      const ids: string[] = a.p_ordered ?? [];
      const pool = live().filter((k) => !k.is_main).map((k) => k.id);
      if (new Set(ids).size !== ids.length || !ids.every((i) => pool.includes(i))) return fail("invalid_chain");
      live().filter((k) => !k.is_main).forEach((k) => { k.in_chain = ids.includes(k.id); });
      ids.forEach((id, i) => { const k = byId(id)!; k.in_chain = true; k.chain_position = i + 1; });
      const m = live().find((k) => k.is_main); if (m) m.chain_position = ids.length + 1;
      state.generation += 1; log("chain_set", undefined, undefined, String(ids.length), "admin");
      return { success: true, length: ids.length };
    },
    admin_set_treg_rollout: (a) => {
      if (!admins.has(a.p_admin_id)) return notAdmin;
      const main = live().find((k) => k.is_main && k.ciphertext);
      if (a.p_on && !main) return fail("no_main_key", "أضف المفتاح الرئيسي أولًا قبل تشغيل المجمّع.");
      if (a.p_on && !byId(state.active_key_id)) state.active_key_id = main!.id;
      state.rollout_on = Boolean(a.p_on); state.generation += 1; log(a.p_on ? "rollout_on" : "rollout_off", byId(state.active_key_id), undefined, null, "admin");
      return { success: true, rollout_on: state.rollout_on, active_id: state.active_key_id };
    },
    admin_set_treg_pool_settings: (a) => { if (!admins.has(a.p_admin_id)) return notAdmin; state.min_balance_micro = a.p_min_balance_micro; return { success: true, min_balance_micro: a.p_min_balance_micro }; },
  };

  const client = {
    rpc: vi.fn(async (fn: string, args: any = {}) => {
      rpcLog.push({ fn, args });
      if (flags.down) return { data: null, error: { code: "08006", message: "connection failure" } };
      if (flags.missingFunctions || !handlers[fn] || (flags.noCheckFn && fn === "treg_pool_keys_for_check") || (flags.noCallHealth && fn === "treg_pool_call_health")) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } };
      try { return { data: handlers[fn](args), error: null }; } catch (e) { return { data: null, error: { code: "P0001", message: e instanceof Error ? e.message : "raised" } }; }
    }),
    from: (_table: string) => { const c: any = { select: () => c, eq: () => c, maybeSingle: async () => ({ data: null, error: null }), upsert: async () => ({ error: null }), insert: async () => ({ error: null }) }; return c; },
  };

  /** Seeds a key the way the admin action does (encrypted with the Vault key, bound to its row id). */
  function addKey(opts: { label?: string; plaintext?: string; isMain?: boolean; status?: FakeKey["status"]; balanceMicro?: number | null; inChain?: boolean; email?: string | null } = {}) {
    const id = randomUUID();
    const plaintext = opts.plaintext ?? fakeSecret(opts.isMain ? "main" : `k${nextNumber}`);
    const number = nextNumber++;
    const row: FakeKey = {
      id, number, label: opts.label ?? (opts.isMain ? "الرئيسي" : `اختبار-${number}`), is_main: Boolean(opts.isMain), in_chain: opts.inChain ?? true,
      chain_position: Math.max(0, ...live().map((k) => k.chain_position)) + 1, ciphertext: encryptPoolKey(encKey, id, plaintext), last4: plaintext.slice(-4),
      account_email: opts.email === undefined ? `k${number}@example.test` : opts.email, status: opts.status ?? "connected", status_reason: null, status_checked_at: null, balance_micro: opts.balanceMicro ?? null, balance_checked_at: null, removed: false,
    };
    keys.push(row);
    return { id, number, plaintext, row };
  }

  return { client, state, keys, events, alerts, calls, costs, spend, rpcLog, flags, encKey, addKey, byId, live, ordered, setCost: (costId: number, usd: number) => costs.set(costId, usd), setCostStatus: (costId: number, status: "success" | "failed" | "empty", at: number = clock.t) => { costStatus.set(costId, status); costAt.set(costId, at); }, rpcCount: (fn: string) => rpcLog.filter((r) => r.fn === fn).length };
}
export type FakePoolDb = ReturnType<typeof fakePoolDb>;

// ---------------------------------------------------------------------------------------------------------------------------------------
// A fake TREG: answers by the token in the X-Treg-Token header. Never a real network call.
// ---------------------------------------------------------------------------------------------------------------------------------------

export type TregMode = "ok" | "revoked" | "revoked403" | "empty" | "endpoint402" | "forbid403" | "suspended403" | "route_max_cost" | "timeout" | "http503" | "http429" | "http400";
export interface FakeTregKey { mode: TregMode; balanceMicro: number; email: string; org: string; meMode?: "ok" | "http503" | "timeout"; /** «unreadable»: the balance answers with no number (seen live for four keys on 2026-10-30) */ balanceMode?: "ok" | "unreadable" }

export function fakeTreg() {
  const keys = new Map<string, FakeTregKey>();
  const requests: Array<{ path: string; token: string; method: string; idempotencyKey: string | null }> = [];
  const charged: Array<{ token: string; micro: number }> = [];
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetchFn = vi.fn(async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const headers = (init.headers ?? {}) as Record<string, string>;
    const token = headers["X-Treg-Token"] ?? "";
    requests.push({ path: url.pathname, token, method: String(init.method ?? "GET"), idempotencyKey: headers["Idempotency-Key"] ?? null });
    const k = keys.get(token);
    if (url.pathname === "/auth/me") {
      if (!k || k.mode === "revoked" || k.mode === "revoked403") return json({ error: "unauthorized" }, 401);
      if (k.meMode === "http503") return json({ error: "unavailable" }, 503);
      if (k.meMode === "timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      return json({ email: k.email, org_id: k.org });
    }
    const bal = /^\/orgs\/([^/]+)\/balance$/.exec(url.pathname);
    if (bal) return !k || k.mode === "revoked" ? json({ error: "unauthorized" }, 401) : k.balanceMode === "unreadable" ? json({ ok: true }) : json({ balance_micro: k.balanceMicro });
    if (url.pathname.startsWith("/call/")) {
      if (!k || k.mode === "revoked") return json({ error: "unauthorized" }, 401);
      switch (k.mode) {
        case "revoked403": return json({ error: "forbidden" }, 403);
        case "empty": return json({ error: "insufficient_balance" }, 402);
        // one endpoint refuses payment while the key's own balance is healthy (live, 2026-10-31 15:50: aiark.people.search, balance 6.64 USD)
        case "endpoint402": return json({ error: "payment_required" }, 402);
        case "route_max_cost": return json({ error: "route_max_cost" }, 402);
        case "forbid403": return json({ error: "forbidden" }, 403);
        // the incident of 2026-10-30: the identity and balance reads pass, every data call is refused with the account's own words
        case "suspended403": return json({ detail: "org suspended" }, 403);
        case "http503": return json({ error: "unavailable" }, 503);
        case "http429": return json({ error: "rate_limited" }, 429);
        case "http400": return json({ error: "bad_request" }, 400);
        case "timeout": throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
        default: charged.push({ token, micro: 1000 }); return json({ data: [{ id: "1", text: "row" }] }, 200, { "x-treg-cost-micro": "1000" });
      }
    }
    return json({ error: "not_found" }, 404);
  });
  return {
    fetch: fetchFn, requests, charged, keys,
    set(token: string, patch: Partial<FakeTregKey> = {}) { keys.set(token, { mode: "ok", balanceMicro: 1_000_000, email: "acct@example.test", org: "org1", ...keys.get(token), ...patch }); },
    tokensOfCalls: () => requests.filter((r) => r.path.startsWith("/call/")).map((r) => r.token),
    callCount: () => requests.filter((r) => r.path.startsWith("/call/")).length,
  };
}
export type FakeTreg = ReturnType<typeof fakeTreg>;

/** A whole world: the fake database, the fake TREG, a fake clock and a configured pool. `source` is the process the pool runs in. */
export function makePoolWorld(options: { source?: "website" | "worker"; onEmergency?: (info: { reason: string; source: string }) => void } = {}) {
  const db = fakePoolDb();
  const treg = fakeTreg();
  clock.t = 1_800_000_000_000;
  vi.stubGlobal("fetch", treg.fetch);
  const pool: TregKeyPool = configureTregKeyPool({ source: options.source ?? "website", getClient: async () => db.client, fetchFn: treg.fetch as any, now: clock.now, ...(options.onEmergency ? { onEmergency: options.onEmergency as any } : {}) });
  /** A key the pool holds AND the fake TREG knows. */
  const addKey = (opts: Parameters<typeof db.addKey>[0] & { tregMode?: TregMode; balanceMicro?: number } = {}) => {
    const k = db.addKey(opts);
    treg.set(k.plaintext, { mode: opts.tregMode ?? "ok", balanceMicro: opts.balanceMicro ?? (opts.tregMode === "empty" ? 0 : 1_000_000), email: k.row.account_email ?? "acct@example.test", org: `org${k.number}` });
    return k;
  };
  const switchOn = (activeId?: string) => { db.state.rollout_on = true; if (activeId) db.state.active_key_id = activeId; db.state.generation += 1; pool.invalidate(); };
  return { db, treg, pool, addKey, switchOn };
}

export function teardownPoolWorld(): void {
  resetTregKeyPoolForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
}

export const callOptions = (over: Record<string, unknown> = {}) => ({ endpointId: "anyapi.x.search.posts", params: { query: "q" }, userId: "u1", jobId: "job_1", ...over }) as any;
