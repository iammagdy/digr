import { methodologyChargeId } from "../methodologyOffer";

/**
 * Whether this customer already bought the methodology file for a job. The deterministic ledger row `chg_meth_<jobId>` is the
 * only source: it survives a reload, a new device and a new conversation. Read-only (a SELECT); unknown on a failed read, which
 * callers treat as "not purchased" for display only, never for a charge (the charge path re-checks and is idempotent).
 */
/**
 * Whether the job has the SAVED DATA the methodology purchase is written from (the same file and the same rule as the purchase route: a `data.json` of the job with at least one row; a mission-era job keeps its results in the workbook and has none, so the
 * purchase would answer «لم يتم خصم أي نقاط» after the customer confirmed). Read-only. `null` when it could not be read (callers then say what they said before).
 */
export async function jobHasSavedData(admin: any, scope: { userId: string; jobId: string }): Promise<boolean | null> {
  if (!admin?.storage || typeof admin.storage.from !== "function" || !scope.userId || !scope.jobId) return null;
  try {
    const paths = [`${scope.userId}/${scope.jobId}/data.json`, `${scope.jobId}/data.json`, `json_${scope.jobId}`];
    for (const bucketName of ["results", "partials"]) {
      const bucket = admin.storage.from(bucketName);
      if (!bucket || typeof bucket.download !== "function") continue;
      for (const path of paths) {
        const { data: blob, error } = await bucket.download(path);
        if (error || !blob) continue;
        const parsed = JSON.parse(await blob.text());
        return Array.isArray(parsed?.rows) && parsed.rows.length > 0;
      }
    }
    return false;
  } catch {
    return null;
  }
}

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
