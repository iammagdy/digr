/**
 * Live Verification Script: Top-up Approval Idempotency
 * Usage: tsx scripts/verify/verify-topup-approve.ts
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
  console.log("=== Verifying Live Top-Up Approval Idempotency ===");

  const topupId = `tp_live_test_${Date.now()}`;
  const amountEgp = 50; // 50 EGP -> 500 credits at 0.1 EGP/credit

  // 1. Create pending topup record
  const { error: insErr } = await supabase.from("topups").insert({
    id: topupId,
    user_id: TEST_USER_ID,
    amount_egp: amountEgp,
    reference: `REF_${Date.now()}`,
    sender_name: "مستخدم تجريبي للاختبار",
    sender_phone: "01000000000",
    receipt_file_id: "test_receipt_file",
    status: "pending",
    created_at: new Date().toISOString(),
  });
  if (insErr) throw insErr;
  console.log(`Created pending topup record: ${topupId}`);

  // 2. First approval call via approve_topup_atomic RPC
  const { data: firstRes, error: firstErr } = await supabase.rpc("approve_topup_atomic", {
    p_topup_id: topupId,
    p_confirmed_amount_egp: amountEgp,
  });
  if (firstErr) throw firstErr;
  console.log("First approval result:", firstRes);

  if (!firstRes.success || firstRes.already_approved) {
    throw new Error("First approval should succeed and not be marked already_approved");
  }

  // 3. Second approval call on the SAME topup -> MUST be idempotent
  const { data: secondRes, error: secondErr } = await supabase.rpc("approve_topup_atomic", {
    p_topup_id: topupId,
    p_confirmed_amount_egp: amountEgp,
  });
  if (secondErr) throw secondErr;
  console.log("Second approval result (retry):", secondRes);

  if (!secondRes.success || !secondRes.already_approved) {
    throw new Error("Second approval retry must succeed and report already_approved: true");
  }

  // 4. Verify strictly 1 ledger entry exists for this topup: top_<topupId>
  const { data: ledgerEntries, error: ledgErr } = await supabase
    .from("credit_ledger")
    .select("id, delta")
    .eq("id", `top_${topupId}`);
  if (ledgErr) throw ledgErr;

  console.log(`Ledger entries for top_${topupId}:`, ledgerEntries);
  if (!ledgerEntries || ledgerEntries.length !== 1) {
    throw new Error(`Expected exactly 1 ledger entry, found: ${ledgerEntries?.length}`);
  }

  console.log("PASS: Top-up approval idempotency verified (approved twice, credited once).");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
