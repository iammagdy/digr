/**
 * ROUND 61, HARD SPEND GATE: the contract every paid operation goes through (docs/proposals/spend-gate/SPEC-v2.md), and an in-memory REFERENCE MODEL
 * of the database functions (docs/proposals/spend-gate/sql/001_spend_gate.sql) with the same rules, used by the offline tests and the model gate's tests.
 *
 * NOT WIRED. No production call site uses this file (tests/spend-gate-r61.test.ts pins that). Default mode is OFF; production behaviour is unchanged.
 *
 * The rules (each one is a test):
 *  - A grant is ISSUED BY THE OWNER, outside the service role: nothing in `SpendGate` (what a worker or the website holds) can create, raise, reopen or
 *    extend one. A missing, not-yet-open, expired, revoked or tripped grant refuses every reservation (fail closed). Starting a mission creates nothing.
 *  - reserve: one transaction under the grant's lock. Refused unless reserved + spent + bound <= ceiling, the operation kind is covered, the bound is within
 *    the grant's per-operation maximum and the mission's total stays within the grant's per-mission maximum. Idempotent by key: the same key returns the
 *    same reservation; the same key with another amount is refused.
 *  - settle: idempotent. A charge that is NOT known keeps the whole bound as spent. A known charge at or under the bound releases the rest. A charge ABOVE
 *    the bound counts the bound as spent (the ceiling invariant holds), records the excess as `overrun`, and TRIPS the grant: nothing more is reserved
 *    until the owner looks. The excess is never hidden and never «absorbed» by the ceiling.
 *  - expiry: a reservation still held after its time keeps its whole bound as spent (the call may have gone out). It is never released by expiry.
 *    Every reserve expires the grant's stale reservations first, so no scheduled job is needed for safety.
 *  - The customer's credit ledger is not touched: the gate holds owner money (provider and model spend), never points.
 */

export type SpendKind = "provider" | "model" | "chat" | "eval";
export type SpendGateMode = "off" | "observe" | "enforce";

export type RefusalReason =
  | "no_grant" | "grant_not_open" | "grant_expired" | "grant_revoked" | "grant_tripped" | "kind_not_covered"
  | "over_ceiling" | "over_mission_ceiling" | "over_op_max" | "bad_input" | "key_conflict" | "no_safe_bound" | "gate_unavailable";

export interface ReserveRequest {
  /** Idempotency key: the same logical call keeps the same key across retries of the DATABASE call (a new provider attempt is a new key). */
  key: string;
  kind: SpendKind;
  op: string;
  boundUsd: number;
  missionId: string | null;
  ttlSeconds: number;
}
export type ReserveResult = { ok: true; reservationId: string; grantId: string; replay: boolean } | { ok: false; reason: RefusalReason; detail?: string };
export type SettleResult = { ok: true; state: "settled" | "expired"; countedUsd: number; overrunUsd: number; replay: boolean } | { ok: false; reason: "unknown_reservation" | "bad_input" | "gate_unavailable" };

/** What a worker or the website holds. Deliberately no issue, raise, reopen or extend. */
export interface SpendGate {
  reserve(req: ReserveRequest): Promise<ReserveResult>;
  /** `actualUsd` null = the charge is not known (no answer, cut stream, provider silent): the whole bound stays spent. */
  settle(reservationId: string, actualUsd: number | null): Promise<SettleResult>;
  /** The kill switch the service role MAY hold: it can only stop spending (trip the open grant), never allow more. */
  stop(reason: string): Promise<void>;
}

/** DIGER_SPEND_GATE: unset, "", "off", "0" -> off (today's behaviour). "observe" -> observe. ANY other value -> enforce (a typo fails closed, never open). */
export function spendGateMode(env: Record<string, string | undefined> = process.env): SpendGateMode {
  const raw = String(env.DIGER_SPEND_GATE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "off" || raw === "0") return "off";
  if (raw === "observe") return "observe";
  return "enforce";
}

export const RESERVE_TIMEOUT_MS = 2000;
export const MIN_TTL_SECONDS = 5;
export const MAX_TTL_SECONDS = 900;

export interface Grant {
  id: string;
  ceilingUsd: number;
  perOpMaxUsd: number;
  perMissionMaxUsd: number;
  kinds: SpendKind[];
  opensAt: number;
  closesAt: number;
  reservedUsd: number;
  spentUsd: number;
  overrunUsd: number;
  state: "open" | "revoked" | "tripped";
  issuedBy: string;
  reason: string;
}
interface Reservation { id: string; key: string; grantId: string; kind: SpendKind; op: string; boundUsd: number; missionId: string | null; state: "held" | "settled" | "expired"; actualUsd: number | null; countedUsd: number; overrunUsd: number; expiresAt: number }

const EPS = 1e-9;
const r6 = (n: number) => Number(n.toFixed(6));

/**
 * The in-memory model. `owner` is what ONLY the owner holds (the database role that is not the service role, SPEC-v2 §5); `gate` is what callers hold.
 * Single-threaded JavaScript runs each method to completion, which is what the database's row lock gives the SQL version.
 */
export function createMemorySpendGate(opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const grants = new Map<string, Grant>();
  const reservations = new Map<string, Reservation>();
  const byKey = new Map<string, Reservation>();
  const missionSpent = new Map<string, number>();
  let seq = 0;

  const openGrant = (): Grant | null => [...grants.values()].find((g) => g.state === "open") ?? null;

  function expireStale(g: Grant) {
    for (const r of reservations.values()) {
      if (r.grantId !== g.id || r.state !== "held" || r.expiresAt > now()) continue;
      r.state = "expired"; r.countedUsd = r.boundUsd;
      g.reservedUsd = r6(g.reservedUsd - r.boundUsd); g.spentUsd = r6(g.spentUsd + r.boundUsd);
      if (r.missionId !== null) missionSpent.set(missionKey(g, r.missionId), r6((missionSpent.get(missionKey(g, r.missionId)) ?? 0) + r.boundUsd));
    }
  }
  const missionKey = (g: Grant, m: string) => `${g.id}|${m}`;
  const missionUse = (g: Grant, m: string) => {
    let held = 0;
    for (const r of reservations.values()) if (r.grantId === g.id && r.missionId === m) held += r.state === "held" ? r.boundUsd : 0;
    return (missionSpent.get(missionKey(g, m)) ?? 0) + held;
  };

  const gate: SpendGate = {
    async reserve(req) {
      if (!req || typeof req.key !== "string" || !req.key || !(Number(req.boundUsd) > 0) || !Number.isFinite(Number(req.boundUsd))) return { ok: false, reason: "bad_input" };
      if (!(req.ttlSeconds >= MIN_TTL_SECONDS && req.ttlSeconds <= MAX_TTL_SECONDS)) return { ok: false, reason: "bad_input", detail: "ttl" };
      const prior = byKey.get(req.key);
      if (prior) return prior.boundUsd === r6(req.boundUsd) && prior.kind === req.kind && prior.missionId === req.missionId ? { ok: true, reservationId: prior.id, grantId: prior.grantId, replay: true } : { ok: false, reason: "key_conflict" };
      const tripped = [...grants.values()].find((g) => g.state === "tripped");
      const g = openGrant();
      if (!g) return { ok: false, reason: tripped ? "grant_tripped" : grants.size ? "grant_revoked" : "no_grant" };
      if (now() < g.opensAt) return { ok: false, reason: "grant_not_open" };
      if (now() >= g.closesAt) return { ok: false, reason: "grant_expired" };
      expireStale(g);
      const bound = r6(req.boundUsd);
      if (!g.kinds.includes(req.kind)) return { ok: false, reason: "kind_not_covered" };
      if (bound > g.perOpMaxUsd + EPS) return { ok: false, reason: "over_op_max" };
      if (g.reservedUsd + g.spentUsd + bound > g.ceilingUsd + EPS) return { ok: false, reason: "over_ceiling" };
      if (req.missionId !== null && missionUse(g, req.missionId) + bound > g.perMissionMaxUsd + EPS) return { ok: false, reason: "over_mission_ceiling" };
      seq += 1;
      const r: Reservation = { id: `res_${seq}`, key: req.key, grantId: g.id, kind: req.kind, op: req.op, boundUsd: bound, missionId: req.missionId, state: "held", actualUsd: null, countedUsd: 0, overrunUsd: 0, expiresAt: now() + req.ttlSeconds * 1000 };
      reservations.set(r.id, r); byKey.set(r.key, r);
      g.reservedUsd = r6(g.reservedUsd + bound);
      return { ok: true, reservationId: r.id, grantId: g.id, replay: false };
    },
    async settle(id, actualUsd) {
      const r = reservations.get(id);
      if (!r) return { ok: false, reason: "unknown_reservation" };
      if (actualUsd !== null && !(Number.isFinite(actualUsd) && actualUsd >= 0)) return { ok: false, reason: "bad_input" };
      const g = grants.get(r.grantId)!;
      if (r.state === "held" && r.expiresAt <= now()) expireStale(g);
      if (r.state !== "held") return { ok: true, state: r.state === "expired" ? "expired" : "settled", countedUsd: r.countedUsd, overrunUsd: r.overrunUsd, replay: true };
      const counted = actualUsd === null ? r.boundUsd : r6(Math.min(actualUsd, r.boundUsd));
      const overrun = actualUsd === null ? 0 : r6(Math.max(0, actualUsd - r.boundUsd));
      r.state = "settled"; r.actualUsd = actualUsd; r.countedUsd = counted; r.overrunUsd = overrun;
      g.reservedUsd = r6(g.reservedUsd - r.boundUsd); g.spentUsd = r6(g.spentUsd + counted); g.overrunUsd = r6(g.overrunUsd + overrun);
      if (r.missionId !== null) missionSpent.set(missionKey(g, r.missionId), r6((missionSpent.get(missionKey(g, r.missionId)) ?? 0) + counted + overrun));
      if (overrun > 0 && g.state === "open") g.state = "tripped";
      return { ok: true, state: "settled", countedUsd: counted, overrunUsd: overrun, replay: false };
    },
    async stop() {
      const g = openGrant();
      if (g) g.state = "tripped";
    },
  };

  /** OWNER ONLY (the SQL version is executable by the owner's database role and never by service_role). */
  const owner = {
    issueGrant(input: Omit<Grant, "reservedUsd" | "spentUsd" | "overrunUsd" | "state">): Grant {
      if (openGrant()) throw new Error("one open grant at a time: revoke the open one first");
      if (!(input.ceilingUsd > 0) || !(input.perOpMaxUsd > 0) || !(input.perMissionMaxUsd > 0) || !(input.closesAt > input.opensAt)) throw new Error("bad grant");
      const g: Grant = { ...input, reservedUsd: 0, spentUsd: 0, overrunUsd: 0, state: "open" };
      grants.set(g.id, g);
      return g;
    },
    revoke(id: string) { const g = grants.get(id); if (g) g.state = "revoked"; },
    grant: (id: string) => grants.get(id),
  };
  return { gate, owner };
}

export type GuardedOutcome<T> = { ran: true; value: T; reservationId: string | null; observedRefusal?: RefusalReason } | { ran: false; refused: RefusalReason; detail?: string };

/**
 * One paid operation through the gate. `off`: the call runs exactly as today (no reservation). `observe`: reserve and settle are recorded, a refusal is only
 * reported. `enforce`: no reservation, no call; ANY error or a reserve slower than 2 s is a refusal (`gate_unavailable`): a database outage stops spending.
 * The call reports its actual charge, or null when it is not known; a call that throws is settled as unknown (its whole bound stays spent) and rethrown.
 * A settle that fails leaves the reservation held: it then expires AS SPENT, the conservative side.
 */
export async function guardedPaidCall<T>(
  ctx: { gate: SpendGate | null; mode: SpendGateMode; timeoutMs?: number; onEvent?: (e: { type: string; detail?: string }) => void },
  req: ReserveRequest | { refuse: "no_safe_bound"; detail: string },
  call: () => Promise<{ value: T; actualUsd: number | null }>,
): Promise<GuardedOutcome<T>> {
  if (ctx.mode === "off") return { ran: true, value: (await call()).value, reservationId: null };
  const note = (type: string, detail?: string) => { try { ctx.onEvent?.({ type, detail }); } catch { /* telemetry never decides */ } };
  let reserved: ReserveResult;
  if ("refuse" in req) reserved = { ok: false, reason: "no_safe_bound", detail: req.detail };
  else if (!ctx.gate) reserved = { ok: false, reason: "gate_unavailable", detail: "no gate client" };
  else {
    const timeout = new Promise<ReserveResult>((resolve) => setTimeout(() => resolve({ ok: false, reason: "gate_unavailable", detail: "timeout" }), ctx.timeoutMs ?? RESERVE_TIMEOUT_MS).unref?.());
    try { reserved = await Promise.race([ctx.gate.reserve(req), timeout]); } catch (e) { reserved = { ok: false, reason: "gate_unavailable", detail: String((e as Error)?.message ?? e).slice(0, 120) }; }
  }
  if (!reserved.ok) {
    note("spend_gate.refused", `${reserved.reason}${reserved.detail ? `: ${reserved.detail}` : ""}`);
    if (ctx.mode === "enforce") return { ran: false, refused: reserved.reason, ...(reserved.detail ? { detail: reserved.detail } : {}) };
  }
  const reservationId = reserved.ok ? reserved.reservationId : null;
  let result: { value: T; actualUsd: number | null };
  try {
    result = await call();
  } catch (e) {
    if (reservationId && ctx.gate) await ctx.gate.settle(reservationId, null).catch(() => note("spend_gate.settle_failed", "left held: expires as spent"));
    throw e;
  }
  if (reservationId && ctx.gate) {
    const s = await ctx.gate.settle(reservationId, result.actualUsd).catch(() => null);
    if (!s || !s.ok) note("spend_gate.settle_failed", "left held: expires as spent");
    else if (s.overrunUsd > 0) note("spend_gate.bound_violated", `overrun ${s.overrunUsd}`);
  }
  return { ran: true, value: result.value, reservationId, ...(reserved.ok ? {} : { observedRefusal: reserved.reason }) };
}
