/**
 * Live Verification Script: settle_job_atomic
 * Usage: tsx scripts/verify/verify-settle-job.ts
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
  console.log("=== Verifying settle_job_atomic ===");
  console.log("Run prefix:", RUN_PREFIX);
  const futureLeaseUntil = new Date(Date.now() + 60_000).toISOString();

  const fixtures = [
    { id: `${RUN_PREFIX}settle`, purpose: "settle twice", row: {
      id: `${RUN_PREFIX}settle`, user_id: TEST_USER_ID, status: "running", endpoint_id: "tiktok-profile",
      unit_price: 2, delivered_units: 8, reserved_credits: 25, target_volume_min: 10, target_volume_max: 20, lease_until: null,
    } },
    { id: `${RUN_PREFIX}settle_live_lease`, purpose: "settling with a live lease must raise", row: {
      id: `${RUN_PREFIX}settle_live_lease`, user_id: TEST_USER_ID, status: "running", endpoint_id: "tiktok-profile",
      unit_price: 1, delivered_units: 5, reserved_credits: 10, lease_until: futureLeaseUntil,
    } },
    { id: `${RUN_PREFIX}settle_bad_price`, purpose: "settling with invalid unit_price must raise", row: {
      id: `${RUN_PREFIX}settle_bad_price`, user_id: TEST_USER_ID, status: "running", endpoint_id: "tiktok-profile",
      unit_price: null, delivered_units: 5, reserved_credits: 10, lease_until: null,
    } },
  ];

  const results = await Promise.all(fixtures.map((fixture) =>
    supabase.from("jobs").select("id, user_id, status, unit_price, delivered_units, reserved_credits, lease_until").eq("id", fixture.id).maybeSingle(),
  ));
  results.forEach((result) => { if (result.error) throw result.error; });
  const missing = fixtures.flatMap((fixture, index) => results[index].data ? [] : [{
    table: "jobs",
    purpose: fixture.purpose,
    row: fixture.row,
  }]);
  if (missing.length) requireSetupRows(missing);

  for (let index = 0; index < fixtures.length; index++) {
    const row = results[index].data!;
    const fixture = fixtures[index];
    if (row.user_id !== TEST_USER_ID || row.status !== "running" || Number(row.reserved_credits) !== Number(fixture.row.reserved_credits)) {
      throw new Error(`Settlement fixture mismatch for ${fixture.id}: ${JSON.stringify(row)}`);
    }
  }
  const mainFixture = results[0].data!;
  const leaseFixture = results[1].data!;
  const badPriceFixture = results[2].data!;
  if (Number(mainFixture.unit_price) !== 2 || Number(mainFixture.delivered_units) !== 8 || mainFixture.lease_until !== null) {
    throw new Error(`Settle-twice fixture must have unit_price=2, delivered_units=8 and no lease: ${JSON.stringify(mainFixture)}`);
  }
  if (!leaseFixture.lease_until || new Date(String(leaseFixture.lease_until)).getTime() <= Date.now()) {
    throw new Error(`Lease fixture must hold an unexpired lease: ${JSON.stringify(leaseFixture)}`);
  }
  if (badPriceFixture.unit_price !== null) {
    throw new Error(`Bad-price fixture must have NULL unit_price: ${JSON.stringify(badPriceFixture)}`);
  }

  for (const fixture of fixtures) {
    const { data, error } = await supabase.rpc("reserve_credits_atomic", {
      p_user_id: TEST_USER_ID,
      p_job_id: fixture.id,
      p_amount: Number(fixture.row.reserved_credits),
      p_note: "Approved RPC setup for settlement verification",
    });
    if (error) throw error;
    if (!data?.success) throw new Error(`Approved reservation RPC failed for ${fixture.id}: ${JSON.stringify(data)}`);
  }

  const mainJobId = fixtures[0].id;
  const { data: first, error: firstErr } = await supabase.rpc("settle_job_atomic", {
    p_job_id: mainJobId,
    p_points_cap: 600,
  });
  if (firstErr) throw firstErr;
  if (!first?.success || first.charged_credits !== 16 || first.already_settled) {
    throw new Error(`Unexpected first settlement result: ${JSON.stringify(first)}`);
  }

  const { data: second, error: secondErr } = await supabase.rpc("settle_job_atomic", {
    p_job_id: mainJobId,
    p_points_cap: 600,
  });
  if (secondErr) throw secondErr;
  if (!second?.success || !second.already_settled) {
    throw new Error(`Expected settlement retry to be idempotent: ${JSON.stringify(second)}`);
  }

  const { data: ledgerRows, error: ledgerErr } = await supabase
    .from("credit_ledger").select("id, delta, type").eq("job_id", mainJobId);
  if (ledgerErr) throw ledgerErr;
  const releaseRows = ledgerRows?.filter((row) => row.id === `rel_${mainJobId}`);
  const chargeRows = ledgerRows?.filter((row) => row.id === `chg_${mainJobId}`);
  if (releaseRows?.length !== 1 || chargeRows?.length !== 1) {
    throw new Error(`Expected one rel_ and one chg_ ledger row: rel=${releaseRows?.length}, chg=${chargeRows?.length}`);
  }

  const { error: leaseErr } = await supabase.rpc("settle_job_atomic", {
    p_job_id: fixtures[1].id,
    p_points_cap: 600,
  });
  if (!leaseErr || !leaseErr.message.includes("active chunk lease")) {
    throw new Error(`Expected settling with a live lease to raise, got ${leaseErr?.message}`);
  }

  const { error: badPriceErr } = await supabase.rpc("settle_job_atomic", {
    p_job_id: fixtures[2].id,
    p_points_cap: 600,
  });
  if (!badPriceErr || !badPriceErr.message.includes("invalid unit_price")) {
    throw new Error(`Expected invalid unit_price to raise, got ${badPriceErr?.message}`);
  }

  console.log("PASS: settle_job_atomic verification passed (settle twice, active lease raises, bad unit_price raises).");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
