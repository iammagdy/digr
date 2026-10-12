/**
 * Live Verification Script: release_job_atomic overloads
 * Usage: tsx scripts/verify/verify-release-job.ts
 * Uses service-role RPCs only; protected table rows are never written directly.
 */
import { createClient } from "@supabase/supabase-js";
import { newVrunPrefix, createVerifyFixtures, getTestUserBalance } from "./vrun";

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

type Fixture = { id: string; purpose: string; row: Record<string, unknown> };

async function main() {
  console.log("=== Verifying release_job_atomic overloads ===");
  console.log("Run prefix:", RUN_PREFIX);
  const balanceBefore = await getTestUserBalance(supabase, TEST_USER_ID);
  console.log("Balance before verification:", balanceBefore);
  const forceLeaseUntil = new Date(Date.now() + 60_000).toISOString();

  const fixtures: Fixture[] = [
    { id: `${RUN_PREFIX}legacy_two_arg`, purpose: "old two-argument overload; queued/running release and retry", row: {
      id: `${RUN_PREFIX}legacy_two_arg`, user_id: TEST_USER_ID, status: "running", endpoint_id: "tiktok-profile",
      unit_price: 1, delivered_units: 0, reserved_credits: 30, target_volume_min: 10, target_volume_max: 30, lease_until: null,
    } },
    { id: `${RUN_PREFIX}forced_lease`, purpose: "three-argument overload; active lease and unit_price is intentionally NULL", row: {
      id: `${RUN_PREFIX}forced_lease`, user_id: TEST_USER_ID, status: "running", endpoint_id: "tiktok-profile",
      unit_price: null, delivered_units: 0, reserved_credits: 20, lease_until: forceLeaseUntil,
    } },
    { id: `${RUN_PREFIX}failed_repair`, purpose: "failed job with reservation but no rel_ row", row: {
      id: `${RUN_PREFIX}failed_repair`, user_id: TEST_USER_ID, status: "failed", endpoint_id: "tiktok-profile",
      unit_price: null, reserved_credits: 12, lease_until: null,
    } },
    { id: `${RUN_PREFIX}completed`, purpose: "completed job must raise", row: {
      id: `${RUN_PREFIX}completed`, user_id: TEST_USER_ID, status: "completed", endpoint_id: "tiktok-profile",
      reserved_credits: 5, lease_until: null,
    } },
    { id: `${RUN_PREFIX}missing_reserve`, purpose: "positive reserve amount but res_ row intentionally absent", row: {
      id: `${RUN_PREFIX}missing_reserve`, user_id: TEST_USER_ID, status: "queued", endpoint_id: "tiktok-profile",
      reserved_credits: 8, lease_until: null,
    } },
    { id: `${RUN_PREFIX}zero_reserve`, purpose: "non-positive reserved_credits must raise", row: {
      id: `${RUN_PREFIX}zero_reserve`, user_id: TEST_USER_ID, status: "queued", endpoint_id: "tiktok-profile",
      reserved_credits: 0, lease_until: null,
    } },
    { id: `${RUN_PREFIX}refused`, purpose: "statuses other than queued/running/failed must raise", row: {
      id: `${RUN_PREFIX}refused`, user_id: TEST_USER_ID, status: "refused", endpoint_id: "tiktok-profile",
      reserved_credits: 5, lease_until: null,
    } },
  ];

  await createVerifyFixtures(supabase, fixtures.map((f) => ({
    table: "jobs",
    purpose: f.purpose,
    row: f.row,
  })));

  const jobResults = await Promise.all(fixtures.map((fixture) =>
    supabase.from("jobs").select("id, user_id, status, reserved_credits, lease_until, unit_price").eq("id", fixture.id).single(),
  ));
  jobResults.forEach((result) => { if (result.error) throw result.error; });

  const jobRows = jobResults.map((result) => result.data!);
  const legacyId = fixtures[0].id;
  const forceId = fixtures[1].id;
  const repairId = fixtures[2].id;

  for (let index = 0; index < fixtures.length; index++) {
    const fixture = fixtures[index];
    const row = jobRows[index];
    if (row.user_id !== TEST_USER_ID || row.status !== fixture.row.status || Number(row.reserved_credits) !== Number(fixture.row.reserved_credits)) {
      throw new Error(`Fixture mismatch for ${fixture.id}: ${JSON.stringify(row)}`);
    }
  }

  if (!jobRows[1].lease_until || new Date(String(jobRows[1].lease_until)).getTime() <= Date.now() || jobRows[1].unit_price !== null) {
    throw new Error(`Forced-release fixture must have a future lease and NULL unit_price: ${JSON.stringify(jobRows[1])}`);
  }
  const { data: preexistingRepairRelease, error: repairReleaseReadErr } = await supabase
    .from("credit_ledger").select("id").eq("id", `rel_${repairId}`).maybeSingle();
  if (repairReleaseReadErr) throw repairReleaseReadErr;
  if (preexistingRepairRelease) throw new Error(`Repair fixture must start without rel_${repairId}`);

  for (const fixture of fixtures.slice(0, 3)) {
    const { data, error } = await supabase.rpc("reserve_credits_atomic", {
      p_user_id: TEST_USER_ID,
      p_job_id: fixture.id,
      p_amount: Number(fixture.row.reserved_credits),
      p_note: "Approved RPC setup for release verification",
    });
    if (error) throw error;
    if (!data?.success) throw new Error(`Approved reservation RPC failed for ${fixture.id}: ${JSON.stringify(data)}`);
  }

  // Exactly two named arguments: this must keep resolving to the original overload.
  const { data: legacyFirst, error: legacyFirstErr } = await supabase.rpc("release_job_atomic", {
    p_job_id: legacyId,
    p_error_message: "Two-argument overload verification",
  });
  if (legacyFirstErr) throw legacyFirstErr;
  console.log("Legacy two-argument release result:", JSON.stringify(legacyFirst, null, 2));
  if (!legacyFirst?.success || legacyFirst.released_credits !== 30 || legacyFirst.already_released) {
    throw new Error(`Unexpected two-argument release result: ${JSON.stringify(legacyFirst)}`);
  }
  const { data: legacyRetry, error: legacyRetryErr } = await supabase.rpc("release_job_atomic", {
    p_job_id: legacyId,
    p_error_message: "Two-argument retry verification",
  });
  if (legacyRetryErr) throw legacyRetryErr;
  console.log("Legacy retry release result:", JSON.stringify(legacyRetry, null, 2));
  if (!legacyRetry?.success || !legacyRetry.already_released) {
    throw new Error(`Expected legacy two-argument retry to be idempotent: ${JSON.stringify(legacyRetry)}`);
  }

  // Three required keys select the new overload; a live lease must block unless forced.
  const { error: leaseErr } = await supabase.rpc("release_job_atomic", {
    p_job_id: forceId,
    p_error_message: "Live lease should block",
    p_force: false,
  });
  if (!leaseErr || !leaseErr.message.includes("active chunk lease")) {
    throw new Error(`Expected active lease to raise unless p_force=true; got ${leaseErr?.message}`);
  }
  console.log("Active lease guard verified (raised as expected):", leaseErr.message);

  const { data: forced, error: forcedErr } = await supabase.rpc("release_job_atomic", {
    p_job_id: forceId,
    p_error_message: "Owner-authorized force-path verification",
    p_force: true,
  });
  if (forcedErr) throw forcedErr;
  console.log("Forced release result:", JSON.stringify(forced, null, 2));
  if (!forced?.success || forced.released_credits !== 20 || forced.already_released) {
    throw new Error(`Forced release failed (also verifies no unit_price requirement): ${JSON.stringify(forced)}`);
  }
  const { data: forcedRetry, error: forcedRetryErr } = await supabase.rpc("release_job_atomic", {
    p_job_id: forceId,
    p_error_message: "Forced release retry",
    p_force: true,
  });
  if (forcedRetryErr) throw forcedRetryErr;
  console.log("Forced retry release result:", JSON.stringify(forcedRetry, null, 2));
  if (!forcedRetry?.success || !forcedRetry.already_released) {
    throw new Error(`Expected failed-job idempotency when both res_ and rel_ exist: ${JSON.stringify(forcedRetry)}`);
  }

  const { data: repaired, error: repairedErr } = await supabase.rpc("release_job_atomic", {
    p_job_id: repairId,
    p_error_message: "Repair missing rel_ for failed job",
    p_force: false,
  });
  if (repairedErr) throw repairedErr;
  console.log("Repaired release result:", JSON.stringify(repaired, null, 2));
  if (!repaired?.success || repaired.already_released) {
    throw new Error(`Expected failed job with missing rel_ to complete release: ${JSON.stringify(repaired)}`);
  }
  const { data: repairedRel, error: repairedRelErr } = await supabase
    .from("credit_ledger").select("id").eq("id", `rel_${repairId}`).maybeSingle();
  if (repairedRelErr) throw repairedRelErr;
  if (!repairedRel) throw new Error(`Expected approved release RPC to create rel_${repairId}`);

  const expectedErrors: Array<{ id: string; force: boolean; includes: string }> = [
    { id: fixtures[3].id, force: false, includes: "already completed" },
    { id: fixtures[4].id, force: false, includes: "Reserve record" },
    { id: fixtures[5].id, force: false, includes: "reserved_credits" },
    { id: fixtures[6].id, force: false, includes: "status" },
  ];
  for (const test of expectedErrors) {
    const { error } = await supabase.rpc("release_job_atomic", {
      p_job_id: test.id,
      p_error_message: "Expected guard rejection",
      p_force: test.force,
    });
    if (!error || !error.message.toLowerCase().includes(test.includes.toLowerCase())) {
      throw new Error(`Expected release guard for ${test.id} to include '${test.includes}', got '${error?.message}'`);
    }
    console.log(`Guard verified for ${test.id} (raised as expected):`, error.message);
  }

  const balanceAfter = await getTestUserBalance(supabase, TEST_USER_ID);
  console.log("Balance after verification:", balanceAfter);
  console.log("Net balance delta:", balanceAfter - balanceBefore);

  console.log("PASS: both release overloads verified (two-arg route, retry, lease force, failed-row recovery, integrity/status guards).");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
