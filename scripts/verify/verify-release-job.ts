/**
 * Live Verification Script: release_job_atomic
 * Usage: tsx scripts/verify/verify-release-job.ts
 * Strictly reads keys from environment variables. Zero hardcoded secrets.
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

if (!SERVICE_KEY) {
  console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  console.log("=== Verifying release_job_atomic ===");

  const jobId = `job_test_release_${Date.now()}`;
  const reservedCredits = 30;

  // 1. Prepare test reservation hold in credit_ledger
  const { error: resErr } = await supabase.from("credit_ledger").insert({
    id: `res_${jobId}`,
    user_id: TEST_USER_ID,
    delta: -reservedCredits,
    type: "reserve",
    job_id: jobId,
    note: "Release test reservation hold",
  });
  if (resErr) throw resErr;

  // 2. Prepare running job record in public.jobs
  const { error: jobErr } = await supabase.from("jobs").insert({
    id: jobId,
    user_id: TEST_USER_ID,
    status: "running",
    endpoint_id: "tiktok-profile",
    unit_price: 1,
    delivered_units: 0,
    reserved_credits: reservedCredits,
    target_volume_min: 10,
    target_volume_max: 30,
    lease_until: null,
  });
  if (jobErr) throw jobErr;

  // 3. First release call
  const { data: firstRes, error: firstErr } = await supabase.rpc("release_job_atomic", {
    p_job_id: jobId,
    p_error_message: "Test failure triggering atomic release",
  });
  if (firstErr) throw firstErr;
  console.log("First release result:", firstRes);

  if (!firstRes.success || firstRes.released_credits !== reservedCredits || firstRes.already_released) {
    throw new Error(`Unexpected first release result: ${JSON.stringify(firstRes)}`);
  }

  // 4. Second release call (idempotent retry)
  const { data: secondRes, error: secondErr } = await supabase.rpc("release_job_atomic", {
    p_job_id: jobId,
    p_error_message: "Duplicate retry call",
  });
  if (secondErr) throw secondErr;
  console.log("Second release result (idempotent):", secondRes);

  if (!secondRes.success || !secondRes.already_released) {
    throw new Error(`Expected already_released: true on retry, got: ${JSON.stringify(secondRes)}`);
  }

  // 5. Verify ledger rows for this job: exactly 1 rel_ row, 0 chg_ rows
  const { data: ledgerRows } = await supabase
    .from("credit_ledger")
    .select("id, delta, type")
    .eq("job_id", jobId);

  console.log("Ledger rows for job:", ledgerRows);

  const relRows = ledgerRows?.filter((r) => r.id === `rel_${jobId}`);
  const chgRows = ledgerRows?.filter((r) => r.id === `chg_${jobId}`);

  if (relRows?.length !== 1 || (chgRows && chgRows.length > 0)) {
    throw new Error(`Expected exactly 1 rel_ row and 0 chg_ rows, got rel=${relRows?.length}, chg=${chgRows?.length}`);
  }

  // 6. Verify job status is failed
  const { data: jobRow } = await supabase.from("jobs").select("status, charged_credits").eq("id", jobId).single();
  if (jobRow?.status !== "failed" || jobRow?.charged_credits !== 0) {
    throw new Error(`Job status not failed or charged_credits not 0: ${JSON.stringify(jobRow)}`);
  }

  console.log("PASS: release_job_atomic verification passed (released full reserve, zero charge, idempotent).");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
