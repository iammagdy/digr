import type { CallRecord, CallRecorder, Reservation } from "../../src/lib/server/multiProvider/adapterTypes";
import type { DataProviderId } from "../../src/lib/multiProvider/types";

/** An in-memory stand-in for the reserve and commit functions: a per-provider daily cap, estimate rows turned into real rows. */
export interface MemoryCostRow { id: number; provider: DataProviderId; capabilityId: string; estimate: boolean; costUsd: number; units: number; status: string | null; durationMs: number | null; jobId: string | null }

export function createMemoryRecorder(caps: Partial<Record<DataProviderId, number>> = { treg: 1, firecrawl: 5, contextdev: 5 }) {
  const rows: MemoryCostRow[] = [];
  let nextId = 1;
  const recorder: CallRecorder = {
    async reserve({ provider, capabilityId, estimatedUsd, jobId }): Promise<Reservation> {
      const cap = caps[provider] ?? 0;
      if (!(cap > 0)) return { allowed: false, costId: null, reason: "cap" };
      const spent = rows.filter((r) => r.provider === provider).reduce((a, r) => a + r.costUsd, 0);
      if (spent + estimatedUsd > cap) return { allowed: false, costId: null, reason: "cap" };
      const row: MemoryCostRow = { id: nextId++, provider, capabilityId, estimate: true, costUsd: estimatedUsd, units: 0, status: null, durationMs: null, jobId };
      rows.push(row);
      return { allowed: true, costId: row.id };
    },
    async commit(costId: number | null, record: CallRecord): Promise<void> {
      const row = rows.find((r) => r.id === costId);
      if (!row) return;
      row.estimate = false; row.costUsd = record.costUsd; row.units = record.units; row.status = record.status; row.durationMs = record.durationMs;
    },
  };
  return { recorder, rows, spent: (provider?: DataProviderId) => rows.filter((r) => !provider || r.provider === provider).reduce((a, r) => a + r.costUsd, 0) };
}
