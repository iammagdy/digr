import { methodologyChargeId } from "../methodologyOffer";

/**
 * Whether this customer already bought the methodology file for a job. The deterministic ledger row `chg_meth_<jobId>` is the
 * only source: it survives a reload, a new device and a new conversation. Read-only (a SELECT); unknown on a failed read, which
 * callers treat as "not purchased" for display only, never for a charge (the charge path re-checks and is idempotent).
 */
export async function isMethodologyPurchased(admin: any, scope: { userId: string; jobId: string }): Promise<boolean> {
  if (!admin || typeof admin.from !== "function" || !scope.userId || !scope.jobId) return false;
  try {
    const { data } = await admin
      .from("credit_ledger")
      .select("id")
      .eq("id", methodologyChargeId(scope.jobId))
      .eq("user_id", scope.userId)
      .maybeSingle();
    return Boolean(data?.id);
  } catch {
    return false;
  }
}
