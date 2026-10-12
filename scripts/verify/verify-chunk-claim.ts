/**
 * Live Verification Script: Chunk Claiming Concurrency
 * Usage: tsx scripts/verify/verify-chunk-claim.ts
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
  console.log("=== Verifying Chunk Claim Concurrency ===");

  const jobId = `job_test_claim_${Date.now()}`;

  // 1. Prepare queued job ready for step 0
  const { error: jobErr } = await supabase.from("jobs").insert({
    id: jobId,
    user_id: TEST_USER_ID,
    status: "queued",
    endpoint_id: "tiktok-profile",
    step: 0,
    attempt_count: 0,
    unit_price: 1,
    reserved_credits: 10,
    target_volume_min: 5,
    target_volume_max: 10,
    next_attempt_at: new Date().toISOString(),
    lease_until: null,
  });
  if (jobErr) throw jobErr;

  // 2. Launch 2 parallel claim calls for step 0
  const [claim1, claim2] = await Promise.all([
    supabase.rpc("claim_job_chunk", {
      p_job_id: jobId,
      p_expected_step: 0,
      p_lease_seconds: 60,
    }),
    supabase.rpc("claim_job_chunk", {
      p_job_id: jobId,
      p_expected_step: 0,
      p_lease_seconds: 60,
    }),
  ]);

  console.log("Claim 1 result:", claim1.data);
  console.log("Claim 2 result:", claim2.data);

  const wins = [claim1.data, claim2.data].filter((c) => c?.claimed === true);
  const losses = [claim1.data, claim2.data].filter((c) => c?.claimed === false && c?.error === "lease_active");

  if (wins.length !== 1 || losses.length !== 1) {
    throw new Error(`Expected exactly 1 claim winner and 1 lease_active rejection, got wins=${wins.length}, losses=${losses.length}`);
  }

  // 3. Verify attempt_count was NOT incremented on claim
  const { data: jobRow } = await supabase.from("jobs").select("attempt_count, status").eq("id", jobId).single();
  console.log("Job status after claim:", jobRow);

  if (jobRow?.attempt_count !== 0 || jobRow?.status !== "running") {
    throw new Error(`attempt_count should remain 0 on claim, status should be running: ${JSON.stringify(jobRow)}`);
  }

  console.log("PASS: Chunk claim verification passed (exactly one winner, lease respected, attempt_count unincremented).");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
