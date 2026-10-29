import { createCallRecorder } from "./multiProvider/callRecorder";
import type { CallRecord, CallStatus } from "./multiProvider/adapterTypes";

/**
 * What a TREG cost row says about itself: the capability the call served, how it ended (success / failed / empty) and how long it took.
 * Recorded by committing the reserved estimate through commit_provider_spend_v2 (the approved function, already applied). The amount, the
 * units and the reserve are exactly what the worker passed before; only the three facts are added. When v2 is missing or refuses, the old
 * commit_provider_spend records the same amount, so a missing function can never leave a reserved estimate open.
 */
const MAX_CAPABILITY_CHARS = 80;

/** The capability id stored on the row: the job's capability slug, else its endpoint id. The admin screens turn it into Arabic. */
export function tregCapabilityIdOf(spec: { capabilitySlug?: string | null; endpointId?: string | null }): string {
  const id = String(spec.capabilitySlug || spec.endpointId || "").trim();
  return (id || "treg.unknown").slice(0, MAX_CAPABILITY_CHARS);
}

/** Failed when the provider's answer was an error; empty when it answered with no rows; success otherwise. */
export function tregCallStatusOf(result: { ok: boolean; rows?: unknown[] | null }): CallStatus {
  if (!result.ok) return "failed";
  return Array.isArray(result.rows) && result.rows.length > 0 ? "success" : "empty";
}

export async function commitTregSpend(
  client: any,
  args: { costId: number | null; costUsd: number; units: number; capabilityId: string; status: CallStatus; durationMs: number; jobId: string | null; keyRef?: CallRecord["keyRef"] },
): Promise<void> {
  if (args.costId === null || args.costId === undefined) return;
  const units = Math.max(0, Math.floor(Number(args.units) || 0));
  const costUsd = Math.max(0, Number(args.costUsd) || 0);
  try {
    await createCallRecorder(client).commit(args.costId, {
      provider: "treg",
      capabilityId: args.capabilityId,
      status: args.status,
      units,
      costUsd,
      durationMs: Math.max(0, Math.floor(Number(args.durationMs) || 0)),
      jobId: args.jobId,
      ...(args.keyRef ? { keyRef: args.keyRef } : {}),
    });
    return;
  } catch (e: any) {
    console.warn("[worker:provider_commit_v2_failed]", e?.code || "", String(e?.message || "").slice(0, 120));
  }
  // The same amount through the existing function; its own error is logged and never changes the job's outcome (as before).
  try {
    const { error } = await client.rpc("commit_provider_spend", { p_cost_id: args.costId, p_actual_cost_usd: costUsd, p_units: units });
    if (error) console.warn("[worker:provider_commit_failed]", error?.code || "", String(error?.message || "").slice(0, 120));
  } catch (e: any) {
    console.warn("[worker:provider_commit_failed]", String(e?.message || "").slice(0, 120));
  }
}
