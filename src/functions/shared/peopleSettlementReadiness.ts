export const PEOPLE_SETTLEMENT_UNAVAILABLE_AR =
  "خدمة صناع القرار غير متاحة مؤقتاً؛ لم يتم إنشاء عرض سعر أو بدء التنفيذ.";

/**
 * Probes the settlement RPC with a deliberately nonexistent job id. The SQL
 * function locks and validates the job before any writes, so a "Job ... not
 * found" response proves the function is installed without changing data.
 */
export async function hasPeopleSettlementRpc(client: unknown): Promise<boolean> {
  const rpc = (client as { rpc?: (name: string, args: Record<string, unknown>) => Promise<any> } | null)?.rpc;
  if (typeof rpc !== "function") return false;

  const probeJobId = `__diger_people_settlement_probe_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
  try {
    const result = await rpc.call(client, "settle_people_job_atomic", {
      p_job_id: probeJobId,
      p_base_units: 0,
      p_email_units: 0,
      p_phone_units: 0,
    });
    const error = result?.error;
    if (!error) return false;
    const message = String(error.message || "");
    return message.includes(probeJobId) && /job .* not found/i.test(message);
  } catch {
    // Treat transport, permissions, and unexpected responses as unavailable.
    return false;
  }
}

export async function requirePeopleSettlementRpc(client: unknown): Promise<boolean> {
  const available = await hasPeopleSettlementRpc(client);
  if (!available) console.warn("[decision-maker:settlement_rpc_unavailable]");
  return available;
}
