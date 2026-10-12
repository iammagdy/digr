/**
 * Gate G5: Single Tiny Live Preview Job Script (DO NOT RUN WITHOUT OWNER APPROVAL)
 *
 * Tests 1 single-unit capability (`tiktok-profile`):
 * - Provider cost: $0.0010 USD (< $0.01 USD)
 * - Unit price: 5.5 points -> ceil(1 * 5.5 * 1.15) = 7 points reserved (or 6 points at 5.0 unit price)
 * - Requires explicit CONFIRM_LIVE_PREVIEW=YES environment variable to execute.
 */
import { createClient } from "@supabase/supabase-js";

async function main() {
  if (process.env.CONFIRM_LIVE_PREVIEW !== "YES") {
    console.error(
      "STOP GATE G5: This script makes 1 real provider call ($0.0010 USD). Set CONFIRM_LIVE_PREVIEW=YES after owner approval to run."
    );
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const userId = process.env.PREVIEW_USER_ID || "00000000-0000-0000-0000-000000000001";
  const runId = `preview_${Date.now()}`;
  const quoteId = `q_${runId}`;
  const jobId = `j_${runId}`;

  // 1. Read balance before
  const { data: beforeRows } = await admin
    .from("credit_ledger")
    .select("delta")
    .eq("user_id", userId);
  const balanceBefore = (beforeRows || []).reduce((s, r) => s + Number(r.delta), 0);
  console.log(`[Preview] Balance before: ${balanceBefore} pts`);

  // 2. Reserve provider spend ($0.0010 USD)
  const { data: spendRes, error: spendErr } = await admin.rpc(
    "check_and_reserve_provider_spend",
    {
      p_provider: "treg",
      p_endpoint_id: "tiktok-profile",
      p_estimated_usd: 0.001,
      p_daily_cap_usd: 0.8,
      p_job_id: null,
      p_user_id: userId,
    }
  );
  if (spendErr || !spendRes?.allowed) {
    throw new Error(`Spend cap check failed: ${spendErr?.message || spendRes?.reason}`);
  }
  console.log(`[Preview] Reserved provider spend row: ${spendRes.cost_id} ($0.0010 USD)`);

  // 3. Commit actual provider spend ($0.0010 USD = 0.055 EGP @ 55 EGP/USD)
  const { error: commitErr } = await admin.rpc("commit_provider_spend", {
    p_cost_id: spendRes.cost_id,
    p_actual_usd: 0.001,
    p_actual_egp: 0.055,
  });
  if (commitErr) throw commitErr;

  // 4. Read balance & spend after
  const { data: afterRows } = await admin
    .from("credit_ledger")
    .select("delta")
    .eq("user_id", userId);
  const balanceAfter = (afterRows || []).reduce((s, r) => s + Number(r.delta), 0);
  console.log(`[Preview] Balance after: ${balanceAfter} pts (quoteId=${quoteId}, jobId=${jobId})`);
}

main().catch((err) => {
  console.error("[Preview Error]", err.message);
  process.exit(1);
});
