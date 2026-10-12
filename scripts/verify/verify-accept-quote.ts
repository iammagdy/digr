/**
 * Live Verification Script: Accept-Quote Path against Supabase Project
 * Usage: tsx scripts/verify/verify-accept-quote.ts
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
  console.log("=== Verifying Live Accept-Quote Flow on Supabase ===");

  // 1. Check initial test user balance
  const { data: initialLedger, error: ledgerErr } = await supabase
    .from("credit_ledger")
    .select("delta")
    .eq("user_id", TEST_USER_ID);

  if (ledgerErr) throw ledgerErr;
  const initialBal = (initialLedger || []).reduce((sum, r) => sum + Number(r.delta), 0);
  console.log(`Initial balance: ${initialBal} points (ledger rows: ${initialLedger?.length})`);

  const quoteId = `quote_live_${Date.now()}`;
  const jobId = `job_live_${Date.now()}`;
  const testCredits = 3;

  // 2. Insert test quote
  const { error: quoteErr } = await supabase.from("plans_quotes").insert({
    id: quoteId,
    user_id: TEST_USER_ID,
    status: "quoted",
    total_reserved_credits: testCredits,
    items: [{ capabilitySlug: "tiktok-profile", targetVolumeMin: 1, targetVolumeMax: 1 }],
    output_formats: ["xlsx", "csv"],
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  });
  if (quoteErr) throw quoteErr;
  console.log(`Created test quote: ${quoteId}`);

  // 3. Call atomic reserve RPC
  const { data: rpcRes, error: rpcErr } = await supabase.rpc("reserve_credits_atomic", {
    p_user_id: TEST_USER_ID,
    p_job_id: jobId,
    p_amount: testCredits,
    p_note: "Live verification of accept-quote",
  });
  if (rpcErr) throw rpcErr;
  console.log("reserve_credits_atomic result:", rpcRes);

  if (!rpcRes.success || rpcRes.already_reserved) {
    throw new Error("Failed to reserve credits");
  }

  // 4. Update quote and create job
  await supabase.from("plans_quotes").update({ status: "accepted" }).eq("id", quoteId);
  await supabase.from("jobs").insert({
    id: jobId,
    user_id: TEST_USER_ID,
    status: "queued",
    endpoint_id: "tiktok-profile",
    target_volume_min: 1,
    target_volume_max: 1,
    reserved_credits: testCredits,
    charged_credits: 0,
    delivered_units: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  // 5. Test idempotent reserve retry -> must return already_reserved
  const { data: retryRes } = await supabase.rpc("reserve_credits_atomic", {
    p_user_id: TEST_USER_ID,
    p_job_id: jobId,
    p_amount: testCredits,
    p_note: "Idempotent retry test",
  });
  console.log("Idempotent retry result:", retryRes);
  if (!retryRes.already_reserved) {
    throw new Error("Expected already_reserved to be true");
  }

  // 6. Release reservation to restore balance
  const { error: relErr } = await supabase.from("credit_ledger").insert({
    id: `rel_${jobId}`,
    user_id: TEST_USER_ID,
    delta: testCredits,
    type: "release",
    job_id: jobId,
    note: "Release verification test cleanup",
  });
  if (relErr) throw relErr;
  console.log(`Released ${testCredits} credits via rel_${jobId}`);

  // 7. Verify balance restored
  const { data: finalLedger } = await supabase
    .from("credit_ledger")
    .select("delta")
    .eq("user_id", TEST_USER_ID);
  const finalBal = (finalLedger || []).reduce((sum, r) => sum + Number(r.delta), 0);
  console.log(`Final restored balance: ${finalBal} points`);

  if (finalBal !== initialBal) {
    throw new Error(`Balance mismatch: expected ${initialBal}, got ${finalBal}`);
  }

  console.log("PASS: Live accept-quote verification passed.");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
