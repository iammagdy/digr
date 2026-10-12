/**
 * Live Verification Script: Top-up Approval Idempotency
 * Usage: tsx scripts/verify/verify-topup-approve.ts
 * Uses approved service-role RPCs only; never writes protected rows directly.
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
  console.log("=== Verifying Top-Up Approval Idempotency ===");
  console.log("Run prefix:", RUN_PREFIX);

  const topupId = `${RUN_PREFIX}topup`;
  const amountEgp = 50;
  const { data: topup, error: topupErr } = await supabase
    .from("topups")
    .select("id, user_id, amount_egp, status")
    .eq("id", topupId)
    .maybeSingle();
  if (topupErr) throw topupErr;

  if (!topup) {
    requireSetupRows([{
      table: "topups",
      purpose: "pending top-up approval idempotency; no approved RPC creates pending top-ups",
      row: {
        id: topupId,
        user_id: TEST_USER_ID,
        amount_egp: amountEgp,
        reference: `${RUN_PREFIX}reference`,
        sender_name: "Verification test user",
        sender_phone: "01000000000",
        receipt_file_id: `${RUN_PREFIX}receipt.png`,
        status: "pending",
      },
    }]);
  }
  if (topup.user_id !== TEST_USER_ID || topup.status !== "pending" || Number(topup.amount_egp) !== amountEgp) {
    throw new Error(`Top-up fixture must be the expected test user's pending row: ${JSON.stringify(topup)}`);
  }

  const { data: firstResult, error: firstErr } = await supabase.rpc("approve_topup_atomic", {
    p_topup_id: topupId,
    p_confirmed_amount_egp: amountEgp,
  });
  if (firstErr) throw firstErr;
  if (!firstResult?.success || firstResult.already_approved) {
    throw new Error(`First approval should succeed without already_approved: ${JSON.stringify(firstResult)}`);
  }

  const { data: retryResult, error: retryErr } = await supabase.rpc("approve_topup_atomic", {
    p_topup_id: topupId,
    p_confirmed_amount_egp: amountEgp,
  });
  if (retryErr) throw retryErr;
  if (!retryResult?.success || !retryResult.already_approved) {
    throw new Error(`Second approval should be idempotent: ${JSON.stringify(retryResult)}`);
  }

  const { data: ledgerEntries, error: ledgerErr } = await supabase
    .from("credit_ledger")
    .select("id, delta")
    .eq("id", `top_${topupId}`);
  if (ledgerErr) throw ledgerErr;
  if (!ledgerEntries || ledgerEntries.length !== 1) {
    throw new Error(`Expected one approved-RPC-created top-up ledger row, got ${ledgerEntries?.length}`);
  }

  console.log("PASS: Top-up approval idempotency verified (approved twice, credited once).");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
