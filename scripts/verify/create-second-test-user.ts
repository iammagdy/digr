/**
 * Provision and fund the second test user (test_accept@digr.local).
 * Uses supabase.auth.admin.createUser with fixed UUID 00000000-0000-0000-0000-000000000002.
 * Funds strictly through approved path: create_verify_fixture (pending) -> approve_topup_atomic.
 * Usage: npx tsx --env-file=.env.local scripts/verify/create-second-test-user.ts
 */
import { createClient } from "@supabase/supabase-js";
import { newVrunPrefix, createVerifyFixtures } from "./vrun";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_KEY) {
  console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const SECOND_TEST_USER_ID = "00000000-0000-0000-0000-000000000002";
export const SECOND_TEST_EMAIL = "test_accept@digr.local";

async function getUserBalance(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("credit_ledger")
    .select("delta")
    .eq("user_id", userId);
  if (error) throw error;
  return (data || []).reduce((sum, row) => sum + Number(row.delta || 0), 0);
}

async function main() {
  console.log("=== Provisioning Second Test User ===");
  console.log("Target user ID:", SECOND_TEST_USER_ID);
  console.log("Target email:", SECOND_TEST_EMAIL);

  // 1. Check if user already exists in auth.users
  const { data: existingUser, error: checkErr } = await supabase.auth.admin.getUserById(SECOND_TEST_USER_ID);
  if (checkErr && !checkErr.message.toLowerCase().includes("not found")) {
    throw checkErr;
  }

  if (!existingUser?.user) {
    console.log("Creating user via supabase.auth.admin.createUser with fixed ID...");
    const { data: newUser, error: createErr } = await supabase.auth.admin.createUser({
      id: SECOND_TEST_USER_ID,
      email: SECOND_TEST_EMAIL,
      email_confirm: true,
      user_metadata: {
        sender_name: "حساب اختبار قبول العروض (TEST_ACCEPT_USER)",
      },
    });
    if (createErr) throw createErr;
    console.log("User created successfully:", newUser.user.id, newUser.user.email);
  } else {
    console.log("User already exists:", existingUser.user.id, existingUser.user.email);
  }

  // 2. Read balance before
  const balanceBefore = await getUserBalance(SECOND_TEST_USER_ID);
  console.log("Balance before funding:", balanceBefore);

  // 3. Fund if balance is 0
  if (balanceBefore === 0) {
    console.log("Funding account via approved path (create_verify_fixture + approve_topup_atomic)...");
    const runPrefix = newVrunPrefix();
    const topupId = `${runPrefix}topup_fund`;
    const amountEgp = 50; // 50 EGP = 500 points (1 EGP = 10 points)

    await createVerifyFixtures(supabase, [{
      table: "topups",
      purpose: "fund second test user via approved pending topup fixture",
      row: {
        id: topupId,
        user_id: SECOND_TEST_USER_ID,
        amount_egp: amountEgp,
        reference: `${runPrefix}reference`,
        sender_name: "حساب اختبار قبول العروض (TEST_ACCEPT_USER)",
        sender_phone: "01000000002",
        receipt_file_id: `${runPrefix}receipt.png`,
        status: "pending",
      },
    }]);

    const { data: approveResult, error: approveErr } = await supabase.rpc("approve_topup_atomic", {
      p_topup_id: topupId,
      p_confirmed_amount_egp: amountEgp,
    });
    if (approveErr) throw approveErr;
    console.log("Approve topup RPC result:", JSON.stringify(approveResult, null, 2));

    const balanceAfter = await getUserBalance(SECOND_TEST_USER_ID);
    console.log("Balance after funding:", balanceAfter);
    console.log("Net balance delta:", balanceAfter - balanceBefore);
    if (balanceAfter !== 500) {
      throw new Error(`Expected balance after 50 EGP top-up to be 500 points, got ${balanceAfter}`);
    }
  } else {
    console.log("Account already funded. Current balance:", balanceBefore);
  }

  console.log("PASS: Second test user verified and funded.");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
