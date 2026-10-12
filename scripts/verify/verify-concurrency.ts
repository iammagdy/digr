/**
 * Live Verification Script: 20 Parallel Reservation Requests
 * Usage: tsx scripts/verify/verify-concurrency.ts
 * Uses approved service-role RPCs only; fixture rows are never written directly.
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

async function main() {
  console.log("=== Verifying 20 Parallel Reservation RPC Requests ===");
  console.log("Run prefix:", RUN_PREFIX);
  const balanceBefore = await getTestUserBalance(supabase, TEST_USER_ID);
  console.log("Balance before verification:", balanceBefore);

  const sameJobId = `${RUN_PREFIX}parallel_same`;
  const differentJobIds = Array.from({ length: 10 }, (_, index) => `${RUN_PREFIX}parallel_diff_${index + 1}`);
  const fixtures = [
    { id: sameJobId, amount: 25 },
    ...differentJobIds.map((id) => ({ id, amount: 15 })),
  ];

  await createVerifyFixtures(supabase, fixtures.map((f) => ({
    table: "jobs",
    purpose: `reservation concurrency fixture (reserved_credits=${f.amount})`,
    row: {
      id: f.id,
      user_id: TEST_USER_ID,
      status: "queued",
      endpoint_id: "tiktok-profile",
      reserved_credits: f.amount,
      lease_until: null,
    },
  })));

  const fixtureResults = await Promise.all(fixtures.map((fixture) =>
    supabase.from("jobs").select("id, user_id, status, reserved_credits").eq("id", fixture.id).single(),
  ));
  fixtureResults.forEach((result) => { if (result.error) throw result.error; });

  for (let index = 0; index < fixtures.length; index++) {
    const row = fixtureResults[index].data!;
    if (row.user_id !== TEST_USER_ID || row.status !== "queued" || Number(row.reserved_credits) !== fixtures[index].amount) {
      throw new Error(`Concurrency fixture mismatch for ${fixtures[index].id}: ${JSON.stringify(row)}`);
    }
  }

  try {
    const calls = [
      ...Array.from({ length: 10 }, () => supabase.rpc("reserve_credits_atomic", {
        p_user_id: TEST_USER_ID,
        p_job_id: sameJobId,
        p_amount: 25,
        p_note: "Parallel concurrency verification",
      })),
      ...differentJobIds.map((jobId) => supabase.rpc("reserve_credits_atomic", {
        p_user_id: TEST_USER_ID,
        p_job_id: jobId,
        p_amount: 15,
        p_note: "Parallel concurrency verification",
      })),
    ];

    const startedAt = Date.now();
    const results = await Promise.all(calls);
    console.log(`Executed ${results.length} parallel RPC calls in ${Date.now() - startedAt}ms`);
    results.forEach((result) => { if (result.error) throw result.error; });

    const sameJobResults = results.slice(0, 10).map((result) => result.data);
    const winners = sameJobResults.filter((result) => result?.success && !result.already_reserved);
    const retries = sameJobResults.filter((result) => result?.success && result.already_reserved);
    const allResults = results.map((result) => result.data);
    const sameJobAlreadyReservedCount = retries.length;
    const totalReservationsSucceeded = allResults.filter((r) => r?.success && !r?.already_reserved).length;
    const totalInsufficientBalance = allResults.filter((r) => r?.error === "insufficient_balance").length;

    console.log("Computed counts:");
    console.log(`- Same-job already_reserved: ${sameJobAlreadyReservedCount}`);
    console.log(`- Reservations succeeded: ${totalReservationsSucceeded}`);
    console.log(`- Insufficient balance: ${totalInsufficientBalance}`);

    if (winners.length !== 1 || retries.length !== 9) {
      throw new Error(`Expected one same-job reservation and nine idempotent retries: ${JSON.stringify(sameJobResults)}`);
    }
  } finally {
    // Release any reservation that was created, including after an ambiguous RPC response.
    let releasedCount = 0;
    const cleanupErrors: string[] = [];
    for (const fixture of fixtures) {
      try {
        const { data: reserveRow, error: reserveReadErr } = await supabase
          .from("credit_ledger").select("id").eq("id", `res_${fixture.id}`).maybeSingle();
        if (reserveReadErr) throw reserveReadErr;
        if (reserveRow) {
          const { data: releaseResult, error: releaseErr } = await supabase.rpc("release_job_atomic", {
            p_job_id: fixture.id,
            p_error_message: "Verification cleanup through the existing two-argument release RPC",
          });
          if (releaseErr) throw releaseErr;
          if (!releaseResult?.success) throw new Error(`Could not release verification reservation for ${fixture.id}: ${JSON.stringify(releaseResult)}`);
          releasedCount++;
        }
      } catch (error) {
        cleanupErrors.push(`${fixture.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(`- Released count: ${releasedCount}`);
    if (cleanupErrors.length) throw new Error(`Reservation cleanup failures: ${cleanupErrors.join("; ")}`);
  }

  const balanceAfter = await getTestUserBalance(supabase, TEST_USER_ID);
  console.log("Balance after verification:", balanceAfter);
  console.log("Net balance delta:", balanceAfter - balanceBefore);

  console.log("PASS: Reservation concurrency verified and created holds were released through the approved RPC.");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
