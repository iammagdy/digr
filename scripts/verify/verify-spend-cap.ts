/**
 * Live Verification Script: Provider Daily Spend Cap & Commit
 * Usage: tsx scripts/verify/verify-spend-cap.ts
 * Strictly reads keys from environment variables. Zero hardcoded secrets.
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_KEY) {
  console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  console.log("=== Verifying Provider Daily Spend Cap & Commit ===");

  const jobId = `job_test_spend_${Date.now()}`;
  const dailyCapUsd = 0.80;

  // 1. First reserve spend: 0.50 USD (should succeed)
  const { data: res1, error: err1 } = await supabase.rpc("reserve_provider_spend_atomic", {
    p_job_id: jobId,
    p_provider: "treg",
    p_estimated_cost_usd: 0.50,
    p_daily_cap_usd: dailyCapUsd,
  });
  if (err1) throw err1;
  console.log("Reserve 1 ($0.50) result:", res1);

  if (!res1.allowed || !res1.cost_id) {
    throw new Error(`Expected reserve 1 to be allowed: ${JSON.stringify(res1)}`);
  }

  // 2. Second reserve spend: 0.40 USD (0.50 + 0.40 = 0.90 > 0.80 -> must be denied)
  const { data: res2, error: err2 } = await supabase.rpc("reserve_provider_spend_atomic", {
    p_job_id: jobId,
    p_provider: "treg",
    p_estimated_cost_usd: 0.40,
    p_daily_cap_usd: dailyCapUsd,
  });
  if (err2) throw err2;
  console.log("Reserve 2 ($0.40, exceeding cap) result:", res2);

  if (res2.allowed) {
    throw new Error(`Expected reserve 2 to be DENIED by spend cap: ${JSON.stringify(res2)}`);
  }

  // 3. Commit actual spend on reserve 1: actual cost = 0.45 USD, units = 45
  const { data: commitRes, error: commitErr } = await supabase.rpc("commit_provider_spend", {
    p_cost_id: res1.cost_id,
    p_actual_cost_usd: 0.45,
    p_units: 45,
  });
  if (commitErr) throw commitErr;
  console.log("Commit result:", commitRes);

  if (!commitRes.success || commitRes.actual_cost !== 0.45) {
    throw new Error(`Unexpected commit result: ${JSON.stringify(commitRes)}`);
  }

  // 4. Duplicate commit call must fail / raise exception (already committed)
  const { error: dupCommitErr } = await supabase.rpc("commit_provider_spend", {
    p_cost_id: res1.cost_id,
    p_actual_cost_usd: 0.45,
    p_units: 45,
  });
  console.log("Duplicate commit attempt error (expected):", dupCommitErr?.message);

  if (!dupCommitErr) {
    throw new Error("Duplicate commit must be rejected");
  }

  console.log("PASS: Provider daily spend cap verification passed (atomic cap enforcement and single commit).");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
