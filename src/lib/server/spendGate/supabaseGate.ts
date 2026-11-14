import type { EnrollResult, RefusalReason, ReserveResult, SettleResult, SpendGate } from "./gate";

/**
 * ROUND 62 (PR B): the spend gate through the database functions of docs/proposals/spend-gate/sql/001_spend_gate.sql,
 * called with the service role. The service role can reserve, settle and stop; it cannot issue, raise, reopen or extend a grant (the SQL grants prove it).
 * Every database error is returned as `gate_unavailable`: the caller (guardedPaidCall, gateBefore) treats it as a refusal in enforce mode.
 */
interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

const REASONS: ReadonlySet<string> = new Set(["no_grant", "grant_not_open", "grant_expired", "grant_revoked", "grant_tripped", "kind_not_covered", "over_ceiling", "over_mission_ceiling", "over_op_max", "bad_input", "key_conflict", "mission_not_enrolled", "wrong_account", "unknown_mission", "campaign_full", "not_a_campaign_grant"]);

export function createSupabaseSpendGate(client: RpcClient): SpendGate {
  return {
    async reserve(req): Promise<ReserveResult> {
      try {
        const { data, error } = await client.rpc("spend_reserve", { p_key: req.key, p_kind: req.kind, p_op: req.op.slice(0, 200), p_bound_usd: req.boundUsd, p_mission_id: req.missionId, p_ttl_seconds: req.ttlSeconds });
        if (error || !data || typeof data !== "object") return { ok: false, reason: "gate_unavailable", detail: String(error?.message ?? "no answer").slice(0, 120) };
        const d = data as { ok?: boolean; reason?: string; reservation_id?: string; grant_id?: string; replay?: boolean };
        if (d.ok === true && typeof d.reservation_id === "string" && typeof d.grant_id === "string") return { ok: true, reservationId: d.reservation_id, grantId: d.grant_id, replay: d.replay === true };
        const reason = typeof d.reason === "string" && REASONS.has(d.reason) ? (d.reason as RefusalReason) : "gate_unavailable";
        return { ok: false, reason };
      } catch (e) {
        return { ok: false, reason: "gate_unavailable", detail: String((e as Error)?.message ?? e).slice(0, 120) };
      }
    },
    async settle(reservationId, actualUsd): Promise<SettleResult> {
      try {
        const { data, error } = await client.rpc("spend_settle", { p_reservation: reservationId, p_actual_usd: actualUsd });
        if (error || !data || typeof data !== "object") return { ok: false, reason: "gate_unavailable" };
        const d = data as { ok?: boolean; reason?: string; state?: string; counted_usd?: number; overrun_usd?: number; replay?: boolean };
        if (d.ok !== true) return { ok: false, reason: d.reason === "unknown_reservation" ? "unknown_reservation" : d.reason === "bad_input" ? "bad_input" : "gate_unavailable" };
        return { ok: true, state: d.state === "expired" ? "expired" : "settled", countedUsd: Number(d.counted_usd) || 0, overrunUsd: Number(d.overrun_usd) || 0, replay: d.replay === true };
      } catch {
        return { ok: false, reason: "gate_unavailable" };
      }
    },
    /** CAMPAIGN SCOPE: public.spend_enroll_mission (003_campaign_scope.sql). The database checks the mission's owner against the grant's account; nothing the caller says decides it. */
    async enroll(missionId): Promise<EnrollResult> {
      try {
        const { data, error } = await client.rpc("spend_enroll_mission", { p_mission_id: missionId });
        if (error || !data || typeof data !== "object") return { ok: false, reason: "gate_unavailable", detail: String(error?.message ?? "no answer").slice(0, 120) };
        const d = data as { ok?: boolean; reason?: string; grant_id?: string; replay?: boolean };
        if (d.ok === true && typeof d.grant_id === "string") return { ok: true, grantId: d.grant_id, replay: d.replay === true };
        return { ok: false, reason: typeof d.reason === "string" && REASONS.has(d.reason) ? (d.reason as RefusalReason) : "gate_unavailable" };
      } catch (e) {
        return { ok: false, reason: "gate_unavailable", detail: String((e as Error)?.message ?? e).slice(0, 120) };
      }
    },
    async stop(reason) {
      await Promise.resolve(client.rpc("spend_stop", { p_reason: String(reason).slice(0, 300) })).catch(() => undefined);
    },
  };
}
