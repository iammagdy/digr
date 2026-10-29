import { isMissingAtomicRpc } from "../../../functions/shared/atomicRpc";
import type { CallRecord, CallRecorder, Reservation } from "./adapterTypes";
import { resolveProviderDailyCapUsd } from "./providerCaps";
import type { DataProviderId } from "../../multiProvider/types";
import { getTregKeyPool } from "../tregKeyPool";

/**
 * The cost-recording hook over the APPROVED SQL functions; nothing here writes provider_costs directly.
 *  reserve: reserve_provider_spend_atomic(job, provider, estimate, daily cap)   the cap is the PROVIDER's own daily limit
 *  commit : commit_provider_spend_v2(cost id, actual, units, capability, status, duration)   when the proposal is applied
 *           commit_provider_spend(cost id, actual, units)                                    the existing function otherwise
 * Both commits turn the reserved estimate row into the real cost; a failed or empty call commits with cost 0 (or the charge the
 * provider reported). The reserve is atomic across servers (an advisory lock inside the function), so two chunks cannot both pass a cap.
 */
let v2Available: boolean | null = null;
export function __resetCallRecorderForTests(): void { v2Available = null; }

export function createCallRecorder(client: any, options: { capFor?: (provider: DataProviderId) => Promise<number> } = {}): CallRecorder {
  const capFor = options.capFor ?? ((provider: DataProviderId) => resolveProviderDailyCapUsd(client, provider));
  return {
    async reserve({ provider, estimatedUsd, jobId }): Promise<Reservation> {
      let cap = 0;
      try { cap = await capFor(provider); } catch { cap = 0; }
      // A provider with no positive cap spends nothing.
      if (!(cap > 0)) return { allowed: false, costId: null, reason: "cap" };
      const { data, error } = await client.rpc("reserve_provider_spend_atomic", {
        p_job_id: jobId,
        p_provider: provider,
        p_estimated_cost_usd: Math.max(0, Number(estimatedUsd) || 0),
        p_daily_cap_usd: cap,
      });
      if (error) return { allowed: false, costId: null, reason: "error" };
      if (!data?.allowed) return { allowed: false, costId: null, reason: "cap" };
      return { allowed: true, costId: data.cost_id ?? null };
    },

    async commit(costId: number | null, record: CallRecord): Promise<void> {
      if (costId === null || costId === undefined) return;
      const cost = Math.max(0, Number(record.costUsd) || 0);
      // TREG key pool: which pool key made this call (number and label only), recorded beside the cost row. A cost row of a job with several calls carries the key of the
      // job's latest call. Never fails or delays the commit by more than 1.5 s; nothing is written while the pool's switch is OFF.
      const markKey = async () => {
        if (record.provider !== "treg") return;
        const pool = getTregKeyPool();
        if (!pool) return;
        try { await pool.recordCall(record.keyRef ?? pool.lastRefFor(record.jobId), costId); } catch { /* a mark never fails a commit */ }
      };
      if (v2Available !== false) {
        const { error } = await client.rpc("commit_provider_spend_v2", {
          p_cost_id: costId,
          p_actual_cost_usd: cost,
          p_units: Math.max(0, Math.floor(record.units)),
          p_capability: record.capabilityId,
          p_status: record.status,
          p_duration_ms: Math.max(0, Math.floor(record.durationMs)),
        });
        if (!error) { v2Available = true; await markKey(); return; }
        if (!isMissingAtomicRpc(error, "commit_provider_spend_v2")) throw error;
        v2Available = false;
      }
      const { error } = await client.rpc("commit_provider_spend", { p_cost_id: costId, p_actual_cost_usd: cost, p_units: Math.max(0, Math.floor(record.units)) });
      if (error) throw error;
      await markKey();
    },
  };
}
