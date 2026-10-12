/**
 * Live Verification Script: Chunk Claiming Concurrency
 * Usage: tsx scripts/verify/verify-chunk-claim.ts
 * Uses service-role RPCs only; never writes protected table rows directly.
 */
import { createClient } from "@supabase/supabase-js";
import { newVrunPrefix, requireSetupRows } from "./vrun";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const RUN_PREFIX = newVrunPrefix();

if (!SERVICE_KEY) {
  console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  console.log("=== Verifying Chunk Claim Concurrency ===");
  console.log("Run prefix:", RUN_PREFIX);

  const jobId = `${RUN_PREFIX}claim_parallel`;
  const { data: fixture, error: fixtureErr } = await supabase
    .from("jobs")
    .select("id, user_id, status, step, attempt_count, lease_until, next_attempt_at")
    .eq("id", jobId)
    .maybeSingle();
  if (fixtureErr) throw fixtureErr;

  if (!fixture) {
    requireSetupRows([{
      table: "jobs",
      purpose: "two parallel claim_job_chunk calls",
      row: {
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
      },
    }]);
  }

  if (fixture.user_id !== TEST_USER_ID || fixture.status !== "queued" || fixture.step !== 0) {
    throw new Error(`Fixture must be the test user's queued step-0 job: ${JSON.stringify(fixture)}`);
  }
  if ((fixture.lease_until && new Date(fixture.lease_until).getTime() > Date.now()) ||
      (fixture.next_attempt_at && new Date(fixture.next_attempt_at).getTime() > Date.now())) {
    throw new Error(`Claim fixture must not have an active lease or future backoff: ${JSON.stringify(fixture)}`);
  }

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
  if (claim1.error) throw claim1.error;
  if (claim2.error) throw claim2.error;

  const wins = [claim1.data, claim2.data].filter((claim) => claim?.claimed === true);
  const losses = [claim1.data, claim2.data].filter(
    (claim) => claim?.claimed === false && claim?.error === "lease_active",
  );
  if (wins.length !== 1 || losses.length !== 1) {
    throw new Error(`Expected one claim winner and one lease_active rejection, got wins=${wins.length}, losses=${losses.length}`);
  }

  const { data: nullStepResult, error: nullStepErr } = await supabase.rpc("claim_job_chunk", {
    p_job_id: `${RUN_PREFIX}null_step_probe`,
    p_expected_step: null,
    p_lease_seconds: 60,
  });
  console.log("NULL expected-step error (expected):", nullStepErr?.message);
  if (!nullStepErr || !nullStepErr.message.includes("p_expected_step must not be NULL")) {
    throw new Error(`Expected claim_job_chunk to raise for NULL p_expected_step; result=${JSON.stringify(nullStepResult)}, error=${nullStepErr?.message}`);
  }

  const { data: jobRow, error: jobErr } = await supabase
    .from("jobs")
    .select("attempt_count, status")
    .eq("id", jobId)
    .single();
  if (jobErr) throw jobErr;
  if (jobRow?.attempt_count !== 0 || jobRow?.status !== "running") {
    throw new Error(`attempt_count should remain 0 and status should be running: ${JSON.stringify(jobRow)}`);
  }

  console.log("PASS: Chunk claim verification passed (one winner, lease respected, NULL step raises, attempt_count unchanged).");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
