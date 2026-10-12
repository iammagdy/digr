/**
 * Live Verification Script: settle_job_atomic
 * Usage: tsx scripts/verify/verify-settle-job.ts
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
  console.log("=== Verifying settle_job_atomic ===");

  const jobId = `job_test_settle_${Date.now()}`;
  const reservedCredits = 25;
  const unitPrice = 2;
  const deliveredUnits = 8; // Expected charge: ceil(8 * 2) = 16 credits

  // 1. Prepare test reservation in credit_ledger
  const { error: resErr } = await supabase.from("credit_ledger").insert({
    id: `res_${jobId}`,
    user_id: TEST_USER_ID,
    delta: -reservedCredits,
    type: "reserve",
    job_id: jobId,
    note: "Settlement test reservation hold",
  });
  if (resErr) throw resErr;

  // 2. Prepare running job record in public.jobs
  const { error: jobErr } = await supabase.from("jobs").insert({
    id: jobId,
    user_id: TEST_USER_ID,
    status: "running",
    endpoint_id: "tiktok-profile",
    unit_price: unitPrice,
    delivered_units: deliveredUnits,
    reserved_credits: reservedCredits,
    target_volume_min: 10,
    target_volume_max: 20,
    lease_until: null,
  });
  if (jobErr) throw jobErr;

  // 3. First settlement call
  const { data: firstRes, error: firstErr } = await supabase.rpc("settle_job_atomic", {
    p_job_id: jobId,
    p_points_cap: 600,
  });
  if (firstErr) throw firstErr;
  console.log("First settlement result:", firstRes);

  if (!firstRes.success || firstRes.charged_credits !== 16 || firstRes.already_settled) {
    throw new Error(`Unexpected first settlement result: ${JSON.stringify(firstRes)}`);
  }

  // 4. Second settlement call (idempotent retry)
  const { data: secondRes, error: secondErr } = await supabase.rpc("settle_job_atomic", {
    p_job_id: jobId,
    p_points_cap: 600,
  });
  if (secondErr) throw secondErr;
  console.log("Second settlement result (idempotent):", secondRes);

  if (!secondRes.success || !secondRes.already_settled) {
    throw new Error(`Expected already_settled: true on retry, got: ${JSON.stringify(secondRes)}`);
  }

  // 5. Verify ledger rows for this job
  const { data: ledgerRows } = await supabase
    .from("credit_ledger")
    .select("id, delta, type")
    .eq("job_id", jobId);

  console.log("Ledger rows for job:", ledgerRows);

  const relRows = ledgerRows?.filter((r) => r.id === `rel_${jobId}`);
  const chgRows = ledgerRows?.filter((r) => r.id === `chg_${jobId}`);

  if (relRows?.length !== 1 || chgRows?.length !== 1) {
    throw new Error(`Expected exactly 1 rel_ and 1 chg_ row, got rel=${relRows?.length}, chg=${chgRows?.length}`);
  }

  console.log("PASS: settle_job_atomic verification passed (settled correctly, idempotent on retry).");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
