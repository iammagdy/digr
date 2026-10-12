/**
 * Live Verification Script: Provider Daily Spend Cap & Commit
 * Usage: tsx scripts/verify/verify-spend-cap.ts
 * Mutations use approved service-role RPCs only; no direct provider_costs writes.
 */
import { createClient } from "@supabase/supabase-js";
import { newVrunPrefix, createVerifyFixtures } from "./vrun";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUN_PREFIX = newVrunPrefix();

if (!SERVICE_KEY) {
  console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
  process.exit(1);
}

if (!process.argv.includes("--i-know-this-uses-budget")) {
  console.error("BLOCKED: verify-spend-cap reserves and commits real provider budget ($0.60 total).");
  console.error("To run this check, pass the explicit flag: --i-know-this-uses-budget");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  console.log("=== Verifying Provider Daily Spend Cap & Commit ===");
  console.log("Run prefix:", RUN_PREFIX);

  const firstJobId = `${RUN_PREFIX}spend_first`;
  const parallelJobIds = [`${RUN_PREFIX}spend_parallel_a`, `${RUN_PREFIX}spend_parallel_b`];
  const jobFixtures = [firstJobId, ...parallelJobIds].map((id) => ({
    id,
    row: { id, user_id: "00000000-0000-0000-0000-000000000001", status: "queued", endpoint_id: "tiktok-profile" },
  }));

  await createVerifyFixtures(supabase, jobFixtures.map((f) => ({
    table: "jobs",
    purpose: "provider_costs.job_id foreign-key fixture for spend-cap RPC",
    row: f.row,
  })));

  const jobResults = await Promise.all(jobFixtures.map((fixture) =>
    supabase.from("jobs").select("id, user_id, status").eq("id", fixture.id).single(),
  ));
  jobResults.forEach((result) => { if (result.error) throw result.error; });
  jobResults.forEach((result, index) => {
    const row = result.data!;
    if (row.user_id !== jobFixtures[index].row.user_id || row.status !== "queued") {
      throw new Error(`Spend-cap job fixture mismatch for ${jobFixtures[index].id}: ${JSON.stringify(row)}`);
    }
  });

  const utcDayStart = new Date();
  utcDayStart.setUTCHours(0, 0, 0, 0);
  const { data: costRows, error: costReadErr } = await supabase
    .from("provider_costs")
    .select("cost_usd")
    .gte("created_at", utcDayStart.toISOString());
  if (costReadErr) throw costReadErr;
  const currentSpend = (costRows || []).reduce((sum, row) => sum + Number(row.cost_usd || 0), 0);
  const dailyCapUsd = currentSpend + 0.80;

  const { data: firstReserve, error: firstReserveErr } = await supabase.rpc("reserve_provider_spend_atomic", {
    p_job_id: firstJobId,
    p_provider: "treg",
    p_estimated_cost_usd: 0.50,
    p_daily_cap_usd: dailyCapUsd,
  });
  if (firstReserveErr) throw firstReserveErr;
  if (!firstReserve?.allowed || !firstReserve.cost_id) {
    throw new Error(`Expected initial $0.50 estimate to be allowed: ${JSON.stringify(firstReserve)}`);
  }

  // Only one of these concurrent $0.20 reservations fits in the remaining $0.30.
  const parallelResults = await Promise.all([
    supabase.rpc("reserve_provider_spend_atomic", {
      p_job_id: parallelJobIds[0],
      p_provider: "treg",
      p_estimated_cost_usd: 0.20,
      p_daily_cap_usd: dailyCapUsd,
    }),
    supabase.rpc("reserve_provider_spend_atomic", {
      p_job_id: parallelJobIds[1],
      p_provider: "treg",
      p_estimated_cost_usd: 0.20,
      p_daily_cap_usd: dailyCapUsd,
    }),
  ]);
  for (const result of parallelResults) if (result.error) throw result.error;
  const allowed = parallelResults.map((result) => result.data).filter((result) => result?.allowed && result.cost_id);
  const denied = parallelResults.map((result) => result.data).filter((result) => result?.allowed === false);
  if (allowed.length !== 1 || denied.length !== 1) {
    throw new Error(`Expected exactly one allowed and one cap-denied parallel reservation: ${JSON.stringify(parallelResults.map((result) => result.data))}`);
  }

  const winningCostId = allowed[0].cost_id;
  const { data: firstCommit, error: firstCommitErr } = await supabase.rpc("commit_provider_spend", {
    p_cost_id: firstReserve.cost_id,
    p_actual_cost_usd: 0.45,
    p_units: 45,
  });
  if (firstCommitErr) throw firstCommitErr;
  if (!firstCommit?.success || firstCommit.actual_cost !== 0.45) {
    throw new Error(`Unexpected first commit result: ${JSON.stringify(firstCommit)}`);
  }

  const { data: parallelCommit, error: parallelCommitErr } = await supabase.rpc("commit_provider_spend", {
    p_cost_id: winningCostId,
    p_actual_cost_usd: 0.15,
    p_units: 15,
  });
  if (parallelCommitErr) throw parallelCommitErr;
  if (!parallelCommit?.success || parallelCommit.actual_cost !== 0.15) {
    throw new Error(`Unexpected parallel-winner commit result: ${JSON.stringify(parallelCommit)}`);
  }

  const { error: duplicateCommitErr } = await supabase.rpc("commit_provider_spend", {
    p_cost_id: firstReserve.cost_id,
    p_actual_cost_usd: 0.45,
    p_units: 45,
  });
  if (!duplicateCommitErr) throw new Error("Duplicate commit must be rejected");

  console.log("PASS: Provider spend cap verification passed (parallel cap serialization, one winner, single commit).");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
