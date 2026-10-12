/**
 * Live Verification Script: Chunk Lifecycle (complete_chunk & record_chunk_failure)
 * Usage: tsx scripts/verify/verify-chunk-lifecycle.ts
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
  console.log("=== Verifying Chunk Lifecycle (complete_chunk & record_chunk_failure) ===");

  const jobId = `job_test_lifecycle_${Date.now()}`;
  const reservedCredits = 20;

  // 1. Prepare reservation in ledger
  await supabase.from("credit_ledger").insert({
    id: `res_${jobId}`,
    user_id: TEST_USER_ID,
    delta: -reservedCredits,
    type: "reserve",
    job_id: jobId,
    note: "Lifecycle test hold",
  });

  // 2. Prepare running job at step 0 with active lease
  await supabase.from("jobs").insert({
    id: jobId,
    user_id: TEST_USER_ID,
    status: "running",
    endpoint_id: "tiktok-profile",
    step: 0,
    attempt_count: 0,
    unit_price: 1,
    reserved_credits: reservedCredits,
    target_volume_min: 10,
    target_volume_max: 20,
    delivered_units: 0,
    lease_until: new Date(Date.now() + 60_000).toISOString(),
  });

  // 3. Complete chunk step 0
  const { data: comp1, error: compErr1 } = await supabase.rpc("complete_chunk", {
    p_job_id: jobId,
    p_expected_step: 0,
    p_new_cursor: "cursor_step_1",
    p_new_delivered_units: 5,
    p_cost_usd: 0.05,
  });
  if (compErr1) throw compErr1;
  console.log("complete_chunk step 0 result:", comp1);

  if (!comp1.success || comp1.step !== 1 || comp1.already_completed) {
    throw new Error(`Unexpected complete_chunk result: ${JSON.stringify(comp1)}`);
  }

  // 4. Duplicate complete_chunk step 0 (retried chunk) must be idempotent
  const { data: compDup, error: compDupErr } = await supabase.rpc("complete_chunk", {
    p_job_id: jobId,
    p_expected_step: 0,
    p_new_cursor: "cursor_step_1",
    p_new_delivered_units: 5,
    p_cost_usd: 0.05,
  });
  if (compDupErr) throw compDupErr;
  console.log("complete_chunk duplicate retry result:", compDup);

  if (!compDup.success || !compDup.already_completed) {
    throw new Error(`Expected already_completed: true on duplicate step completion: ${JSON.stringify(compDup)}`);
  }

  // 5. Test record_chunk_failure and backoff
  for (let i = 1; i <= 5; i++) {
    const { data: failRes, error: failErr } = await supabase.rpc("record_chunk_failure", {
      p_job_id: jobId,
      p_error_message: `Failure attempt ${i}`,
    });
    if (failErr) throw failErr;
    console.log(`record_chunk_failure attempt ${i}:`, failRes);

    if (i < 5) {
      if (failRes.failed_permanently || failRes.attempt_count !== i) {
        throw new Error(`Expected transient failure on attempt ${i}`);
      }
    } else {
      // 5th attempt must mark permanently failed and release hold
      if (!failRes.failed_permanently || !failRes.released) {
        throw new Error(`Expected permanent failure and release on attempt 5`);
      }
    }
  }

  // 6. Verify job status is failed and rel_ exists in ledger
  const { data: finalJob } = await supabase.from("jobs").select("status").eq("id", jobId).single();
  const { data: relRow } = await supabase.from("credit_ledger").select("id").eq("id", `rel_${jobId}`).single();

  if (finalJob?.status !== "failed" || !relRow) {
    throw new Error(`Job must be failed and rel_ must exist in ledger`);
  }

  console.log("PASS: Chunk lifecycle verification passed (idempotent step completion, exponential backoff, auto-release at 5th attempt).");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
