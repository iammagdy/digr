/**
 * Live Verification Script: Chunk Lifecycle (complete_chunk & record_chunk_failure)
 * Usage: tsx scripts/verify/verify-chunk-lifecycle.ts
 * Uses service-role RPCs only; never writes protected table rows directly.
 */
import { createClient } from "@supabase/supabase-js";
import { newVrunPrefix, requireSetupRows } from "./vrun";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const RUN_PREFIX = newVrunPrefix();
const RESERVED_CREDITS = 20;

if (!SERVICE_KEY) {
  console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  console.log("=== Verifying Chunk Lifecycle (complete_chunk & record_chunk_failure) ===");
  console.log("Run prefix:", RUN_PREFIX);

  const jobId = `${RUN_PREFIX}lifecycle`;
  const completedJobId = `${RUN_PREFIX}completed_guard`;
  const [jobResult, completedResult] = await Promise.all([
    supabase.from("jobs").select("id, user_id, status, step, reserved_credits").eq("id", jobId).maybeSingle(),
    supabase.from("jobs").select("id, user_id, status, attempt_count").eq("id", completedJobId).maybeSingle(),
  ]);
  if (jobResult.error) throw jobResult.error;
  if (completedResult.error) throw completedResult.error;

  const missing = [];
  if (!jobResult.data) {
    missing.push({
      table: "jobs",
      purpose: "complete_chunk retry followed by five record_chunk_failure calls",
      row: {
        id: jobId,
        user_id: TEST_USER_ID,
        status: "running",
        endpoint_id: "tiktok-profile",
        step: 0,
        attempt_count: 0,
        unit_price: 1,
        reserved_credits: RESERVED_CREDITS,
        target_volume_min: 10,
        target_volume_max: 20,
        delivered_units: 0,
        lease_until: null,
      },
    });
  }
  if (!completedResult.data) {
    missing.push({
      table: "jobs",
      purpose: "record_chunk_failure completed-job no-change guard",
      row: {
        id: completedJobId,
        user_id: TEST_USER_ID,
        status: "completed",
        endpoint_id: "tiktok-profile",
        step: 2,
        attempt_count: 0,
        unit_price: 1,
        reserved_credits: 10,
        charged_credits: 5,
        delivered_units: 5,
        lease_until: null,
      },
    });
  }
  if (missing.length) requireSetupRows(missing);

  const job = jobResult.data!;
  const completedJob = completedResult.data!;
  if (job.user_id !== TEST_USER_ID || job.status !== "running" || job.step !== 0 || Number(job.reserved_credits) !== RESERVED_CREDITS) {
    throw new Error(`Lifecycle fixture does not match the required running step-0 job: ${JSON.stringify(job)}`);
  }
  if (completedJob.user_id !== TEST_USER_ID || completedJob.status !== "completed" || completedJob.attempt_count !== 0) {
    throw new Error(`Completed-job fixture does not match the required test row: ${JSON.stringify(completedJob)}`);
  }

  const { data: reserveResult, error: reserveErr } = await supabase.rpc("reserve_credits_atomic", {
    p_user_id: TEST_USER_ID,
    p_job_id: jobId,
    p_amount: RESERVED_CREDITS,
    p_note: "Approved RPC setup for chunk lifecycle verification",
  });
  if (reserveErr) throw reserveErr;
  if (!reserveResult?.success) throw new Error(`Could not reserve through approved RPC: ${JSON.stringify(reserveResult)}`);

  const completeArgs = {
    p_job_id: jobId,
    p_expected_step: 0,
    p_new_cursor: "cursor_step_1",
    p_new_delivered_units: 5,
    p_cost_usd: 0.05,
  };
  const { data: firstComplete, error: firstCompleteErr } = await supabase.rpc("complete_chunk", completeArgs);
  if (firstCompleteErr) throw firstCompleteErr;
  if (!firstComplete.success || firstComplete.step !== 1 || firstComplete.already_completed) {
    throw new Error(`Unexpected first complete_chunk result: ${JSON.stringify(firstComplete)}`);
  }

  const { data: completeRetry, error: completeRetryErr } = await supabase.rpc("complete_chunk", completeArgs);
  if (completeRetryErr) throw completeRetryErr;
  if (!completeRetry.success || !completeRetry.already_completed) {
    throw new Error(`Expected complete_chunk retry to return already_completed: ${JSON.stringify(completeRetry)}`);
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    const { data: failureResult, error: failureErr } = await supabase.rpc("record_chunk_failure", {
      p_job_id: jobId,
      p_error_message: `Verification failure attempt ${attempt}`,
    });
    if (failureErr) throw failureErr;
    if (attempt < 5 && (failureResult.failed_permanently || failureResult.attempt_count !== attempt)) {
      throw new Error(`Expected transient failure on attempt ${attempt}: ${JSON.stringify(failureResult)}`);
    }
    if (attempt === 5 && (!failureResult.failed_permanently || !failureResult.released)) {
      throw new Error(`Expected permanent failure and release on attempt 5: ${JSON.stringify(failureResult)}`);
    }
  }

  const [{ data: finalJob, error: finalJobErr }, { data: relRow, error: relErr }] = await Promise.all([
    supabase.from("jobs").select("status").eq("id", jobId).single(),
    supabase.from("credit_ledger").select("id").eq("id", `rel_${jobId}`).maybeSingle(),
  ]);
  if (finalJobErr) throw finalJobErr;
  if (relErr) throw relErr;
  if (finalJob?.status !== "failed" || !relRow) throw new Error("Expected failed job and rel_ ledger row after fifth failure");

  const { data: completedBefore, error: completedBeforeErr } = await supabase
    .from("jobs")
    .select("status, attempt_count, step, lease_until, error_message")
    .eq("id", completedJobId)
    .single();
  if (completedBeforeErr) throw completedBeforeErr;

  const { data: completedFailure, error: completedFailureErr } = await supabase.rpc("record_chunk_failure", {
    p_job_id: completedJobId,
    p_error_message: "Failure on already completed job",
  });
  if (completedFailureErr) throw completedFailureErr;
  if (!completedFailure.success || !completedFailure.ignored || completedFailure.status !== "completed") {
    throw new Error(`Expected completed job failure to be ignored: ${JSON.stringify(completedFailure)}`);
  }

  const { data: completedAfter, error: completedAfterErr } = await supabase
    .from("jobs")
    .select("status, attempt_count, step, lease_until, error_message")
    .eq("id", completedJobId)
    .single();
  if (completedAfterErr) throw completedAfterErr;
  if (JSON.stringify(completedBefore) !== JSON.stringify(completedAfter)) {
    throw new Error(`record_chunk_failure changed the completed job: before=${JSON.stringify(completedBefore)}, after=${JSON.stringify(completedAfter)}`);
  }

  console.log("PASS: Chunk lifecycle verification passed (complete retry idempotency, failure release, completed-job no-change guard).");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
