/**
 * Dedicated Verification Script: Worker Dry-Run Flow (verify-worker-dry-run.ts)
 * 
 * Exercises the end-to-end worker execution lifecycle against Test User 2:
 * (00000000-0000-0000-0000-000000000002)
 *
 * Success Path:
 * 1. Create quote fixture via create_verify_fixture
 * 2. Accept quote via accept_quote_atomic
 * 3. Step 0 chunk claim via claim_job_chunk
 * 4. Provider spend reservation via reserve_provider_spend_atomic
 * 5. Mock provider call (zero real external network requests)
 * 6. Provider spend commit via commit_provider_spend
 * 7. Save partial artifact to Supabase Storage (partials bucket)
 * 8. Complete step 0 chunk via complete_chunk
 * 9. Step 1 chunk claim via claim_job_chunk
 * 10. Provider spend reservation & commit
 * 11. Complete step 1 chunk via complete_chunk
 * 12. Settle job via settle_job_atomic (delivers 10 units, charges 20 points, releases 3 points)
 * 13. Upload final result artifact to Storage (results bucket)
 * 14. Clean up partial files from Storage
 *
 * Failure Path:
 * 1. Create second quote fixture
 * 2. Accept quote via accept_quote_atomic
 * 3. Step 0 chunk claim
 * 4. Record chunk failure 5 times via record_chunk_failure
 * 5. Verify terminal failure (status=failed, attempt_count=5) and 100% refund release via rel_ row
 *
 * Prints:
 * - Starting/ending balances for Test User 2
 * - provider_costs entries created
 * - Storage operations and verifications
 * - Detailed row inventory before and after
 *
 * Usage: npx tsx --env-file=.env.local scripts/verify/verify-worker-dry-run.ts
 */
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { newVrunPrefix, createVerifyFixtures } from "./vrun";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_USER_ID = "00000000-0000-0000-0000-000000000002";
const RUN_PREFIX = newVrunPrefix();

if (!SERVICE_KEY) {
  console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function getUserBalance(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("credit_ledger")
    .select("delta")
    .eq("user_id", userId);
  if (error) throw error;
  return (data || []).reduce((sum, row) => sum + Number(row.delta || 0), 0);
}

async function getTableRowCounts() {
  const [ledgerRes, jobsRes, eventsRes, quotesRes, costsRes] = await Promise.all([
    supabase.from("credit_ledger").select("*", { count: "exact", head: true }),
    supabase.from("jobs").select("*", { count: "exact", head: true }),
    supabase.from("job_events").select("*", { count: "exact", head: true }),
    supabase.from("plans_quotes").select("*", { count: "exact", head: true }),
    supabase.from("provider_costs").select("*", { count: "exact", head: true }),
  ]);
  return {
    credit_ledger: ledgerRes.count ?? 0,
    jobs: jobsRes.count ?? 0,
    job_events: eventsRes.count ?? 0,
    plans_quotes: quotesRes.count ?? 0,
    provider_costs: costsRes.count ?? 0,
  };
}

function computeQuoteHash(items: any[], outputFormats: string[] = ["xlsx", "csv"]): string {
  const sorted = items.map((it) => {
    const sortedParams: Record<string, any> = {};
    Object.keys(it.params || {})
      .sort()
      .forEach((k) => {
        sortedParams[k] = it.params[k];
      });
    return {
      slug: it.capabilitySlug,
      params: sortedParams,
      targetVolumeMax: it.targetVolumeMax,
    };
  });
  const canonical = JSON.stringify({
    items: sorted,
    formats: [...outputFormats].sort(),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

async function main() {
  console.log("================================================================================");
  console.log("         DIGER WORKER DRY-RUN VERIFICATION (verify-worker-dry-run.ts)          ");
  console.log("================================================================================");
  console.log("Run Prefix:", RUN_PREFIX);
  console.log("Target User ID:", TEST_USER_ID);

  // 1. Initial State Inventory
  const balanceBefore = await getUserBalance(TEST_USER_ID);
  const countsBefore = await getTableRowCounts();
  console.log("\n[1] Initial State:");
  console.log(`- Test User 2 Starting Balance: ${balanceBefore} points`);
  console.log("- Table Row Counts Before:", JSON.stringify(countsBefore, null, 2));

  // Check today's UTC provider spend
  const utcDayStart = new Date();
  utcDayStart.setUTCHours(0, 0, 0, 0);
  const { data: todayCosts } = await supabase
    .from("provider_costs")
    .select("cost_usd")
    .gte("created_at", utcDayStart.toISOString());
  const currentDailySpend = (todayCosts || []).reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  console.log(`- Current UTC Day Provider Spend: $${currentDailySpend.toFixed(4)} / $0.80`);

  const createdCostIds: number[] = [];
  const createdStorageFiles: { bucket: string; path: string }[] = [];

  // ===========================================================================
  // SECTION A: SUCCESS PATH (Two-step multi-chunk execution + settlement)
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION A: SUCCESS PATH (Multi-Chunk Worker Lifecycle -> Settle)");
  console.log("--------------------------------------------------------------------------------");

  const successQuoteId = `${RUN_PREFIX}quote_success`;
  const successItems = [{
    capabilitySlug: "tiktok-profile",
    targetVolumeMin: 5,
    targetVolumeMax: 10,
    unitPricePoints: 2,
    params: { username: "diger_test_user" },
  }];
  const successHash = computeQuoteHash(successItems);
  const successReserved = 23; // 10 * 2 = 20 + 15% buffer = 23
  const successExpires = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  // A.1: Create Quote Fixture
  console.log("\n[A.1] Creating Fixture Quote:", successQuoteId);
  await createVerifyFixtures(supabase, [{
    table: "plans_quotes",
    purpose: "success path worker dry-run",
    row: {
      id: successQuoteId,
      user_id: TEST_USER_ID,
      quote_hash: successHash,
      status: "quoted",
      total_reserved_credits: successReserved,
      items: successItems,
      output_formats: ["csv", "xlsx"],
      expires_at: successExpires,
    },
  }]);

  // A.2: Accept Quote via accept_quote_atomic
  console.log("[A.2] Calling accept_quote_atomic...");
  const { data: acceptRes, error: acceptErr } = await supabase.rpc("accept_quote_atomic", {
    p_quote_id: successQuoteId,
    p_user_id: TEST_USER_ID,
    p_expected_quote_hash: successHash,
  });
  if (acceptErr) throw acceptErr;
  if (!acceptRes?.success || !acceptRes.job_id) {
    throw new Error(`accept_quote_atomic failed: ${JSON.stringify(acceptRes)}`);
  }
  const successJobId = acceptRes.job_id;
  console.log(`- Quote Accepted: Job ID = ${successJobId}, Reserved = ${acceptRes.reserved_credits} points`);

  const balanceAfterAccept = await getUserBalance(TEST_USER_ID);
  console.log(`- Balance after reservation: ${balanceAfterAccept} points (deducted ${balanceBefore - balanceAfterAccept})`);
  if (balanceBefore - balanceAfterAccept !== successReserved) {
    throw new Error(`Balance reservation mismatch: expected -${successReserved}, got -${balanceBefore - balanceAfterAccept}`);
  }

  // A.3: Claim Step 0 Chunk
  console.log("\n[A.3] Claiming Step 0 Chunk via claim_job_chunk...");
  const { data: claim0, error: claim0Err } = await supabase.rpc("claim_job_chunk", {
    p_job_id: successJobId,
    p_expected_step: 0,
    p_lease_seconds: 60,
  });
  if (claim0Err) throw claim0Err;
  if (!claim0?.claimed) {
    throw new Error(`claim_job_chunk step 0 failed: ${JSON.stringify(claim0)}`);
  }
  console.log("- Step 0 Claimed successfully. Status is now 'running'.");

  // A.4: Reserve Provider Spend (Chunk 0)
  console.log("[A.4] Reserving Provider Spend ($0.005) for Step 0...");
  const { data: spendRes0, error: spendErr0 } = await supabase.rpc("reserve_provider_spend_atomic", {
    p_job_id: successJobId,
    p_provider: "treg",
    p_estimated_cost_usd: 0.005,
    p_daily_cap_usd: 0.80,
  });
  if (spendErr0) throw spendErr0;
  if (!spendRes0?.allowed || !spendRes0.cost_id) {
    throw new Error(`reserve_provider_spend_atomic step 0 failed: ${JSON.stringify(spendRes0)}`);
  }
  const costId0 = spendRes0.cost_id;
  createdCostIds.push(costId0);
  console.log(`- Provider spend reserved. Cost ID = ${costId0}`);

  // A.5: Mock Provider API Execution (Chunk 0)
  console.log("[A.5] Simulating Mock Provider API Execution: fetched 5 items.");
  const mockChunk0Data = [
    { id: 1, handle: "diger_test_user", text: "sample post 1" },
    { id: 2, handle: "diger_test_user", text: "sample post 2" },
    { id: 3, handle: "diger_test_user", text: "sample post 3" },
    { id: 4, handle: "diger_test_user", text: "sample post 4" },
    { id: 5, handle: "diger_test_user", text: "sample post 5" },
  ];

  // A.6: Commit Provider Spend (Chunk 0)
  console.log("[A.6] Committing Provider Spend for Step 0...");
  const { data: commitRes0, error: commitErr0 } = await supabase.rpc("commit_provider_spend", {
    p_cost_id: costId0,
    p_actual_cost_usd: 0.004,
    p_units: 5,
  });
  if (commitErr0) throw commitErr0;
  if (!commitRes0?.success) {
    throw new Error(`commit_provider_spend step 0 failed: ${JSON.stringify(commitRes0)}`);
  }
  console.log("- Provider spend committed: $0.004 for 5 units.");

  // A.7: Save Partial Artifact to Storage (partials bucket)
  console.log("[A.7] Uploading Partial Artifact to Storage (bucket: partials)...");
  const partial0Path = `${successJobId}/partial_step_0.json`;
  const { error: uploadPart0Err } = await supabase.storage
    .from("partials")
    .upload(partial0Path, JSON.stringify(mockChunk0Data), {
      contentType: "application/json",
      upsert: true,
    });
  if (uploadPart0Err) throw uploadPart0Err;
  createdStorageFiles.push({ bucket: "partials", path: partial0Path });
  console.log(`- Partial uploaded: ${partial0Path}`);

  // A.8: Complete Step 0 Chunk via complete_chunk
  console.log("[A.8] Completing Step 0 via complete_chunk...");
  const { data: comp0, error: comp0Err } = await supabase.rpc("complete_chunk", {
    p_job_id: successJobId,
    p_expected_step: 0,
    p_new_cursor: "cursor_after_step_0",
    p_new_delivered_units: 5,
    p_cost_usd: 0.004,
  });
  if (comp0Err) throw comp0Err;
  if (!comp0?.success || comp0.step !== 1 || comp0.delivered_units !== 5) {
    throw new Error(`complete_chunk step 0 failed: ${JSON.stringify(comp0)}`);
  }
  console.log("- Step 0 completed. Advanced to step 1, delivered_units = 5.");

  // A.9: Claim Step 1 Chunk
  console.log("\n[A.9] Claiming Step 1 Chunk via claim_job_chunk...");
  const { data: claim1, error: claim1Err } = await supabase.rpc("claim_job_chunk", {
    p_job_id: successJobId,
    p_expected_step: 1,
    p_lease_seconds: 60,
  });
  if (claim1Err) throw claim1Err;
  if (!claim1?.claimed) {
    throw new Error(`claim_job_chunk step 1 failed: ${JSON.stringify(claim1)}`);
  }
  console.log("- Step 1 Claimed successfully.");

  // A.10: Reserve & Commit Provider Spend (Chunk 1)
  console.log("[A.10] Reserving and Committing Provider Spend for Step 1...");
  const { data: spendRes1, error: spendErr1 } = await supabase.rpc("reserve_provider_spend_atomic", {
    p_job_id: successJobId,
    p_provider: "treg",
    p_estimated_cost_usd: 0.005,
    p_daily_cap_usd: 0.80,
  });
  if (spendErr1) throw spendErr1;
  const costId1 = spendRes1.cost_id;
  createdCostIds.push(costId1);

  const mockChunk1Data = [
    { id: 6, handle: "diger_test_user", text: "sample post 6" },
    { id: 7, handle: "diger_test_user", text: "sample post 7" },
    { id: 8, handle: "diger_test_user", text: "sample post 8" },
    { id: 9, handle: "diger_test_user", text: "sample post 9" },
    { id: 10, handle: "diger_test_user", text: "sample post 10" },
  ];

  const { error: commitErr1 } = await supabase.rpc("commit_provider_spend", {
    p_cost_id: costId1,
    p_actual_cost_usd: 0.004,
    p_units: 5,
  });
  if (commitErr1) throw commitErr1;

  // Upload partial 1
  const partial1Path = `${successJobId}/partial_step_1.json`;
  const { error: uploadPart1Err } = await supabase.storage
    .from("partials")
    .upload(partial1Path, JSON.stringify(mockChunk1Data), {
      contentType: "application/json",
      upsert: true,
    });
  if (uploadPart1Err) throw uploadPart1Err;
  createdStorageFiles.push({ bucket: "partials", path: partial1Path });

  // Complete Step 1
  console.log("[A.11] Completing Step 1 (delivered_units = 10)...");
  const { data: comp1, error: comp1Err } = await supabase.rpc("complete_chunk", {
    p_job_id: successJobId,
    p_expected_step: 1,
    p_new_cursor: "cursor_final",
    p_new_delivered_units: 10,
    p_cost_usd: 0.004,
  });
  if (comp1Err) throw comp1Err;
  if (!comp1?.success || comp1.delivered_units !== 10) {
    throw new Error(`complete_chunk step 1 failed: ${JSON.stringify(comp1)}`);
  }
  console.log("- Step 1 completed. Total delivered units = 10.");

  // A.12: Settle Job via settle_job_atomic
  console.log("\n[A.12] Settling Job via settle_job_atomic...");
  const resultFilePath = `${TEST_USER_ID}/${successJobId}/result.csv`;
  const { data: settleRes, error: settleErr } = await supabase.rpc("settle_job_atomic", {
    p_job_id: successJobId,
    p_points_cap: 600,
    p_result_file_id: resultFilePath,
  });
  if (settleErr) throw settleErr;
  console.log("- Settle Result:", JSON.stringify(settleRes));
  if (!settleRes?.success || settleRes.charged_credits !== 20 || settleRes.reserved_credits !== 23) {
    throw new Error(`settle_job_atomic math mismatch: expected charge 20, reserved 23; got ${JSON.stringify(settleRes)}`);
  }

  // Verify settlement ledger rows: rel_ (refund excess buffer) and chg_ (debit actual delivered)
  const { data: settleLedgerRows, error: settleLedgerErr } = await supabase
    .from("credit_ledger")
    .select("id, delta, type")
    .eq("job_id", successJobId);
  if (settleLedgerErr) throw settleLedgerErr;
  console.log("- Settlement Ledger Rows (Release-First semantics):", JSON.stringify(settleLedgerRows));
  const relSuccess = (settleLedgerRows || []).find(r => r.id === `rel_${successJobId}`);
  const chgSuccess = (settleLedgerRows || []).find(r => r.id === `chg_${successJobId}`);
  if (!relSuccess || Number(relSuccess.delta) !== successReserved) {
    throw new Error(`Missing or invalid rel_${successJobId} row: expected +${successReserved}, got ${JSON.stringify(relSuccess)}`);
  }
  if (!chgSuccess || Number(chgSuccess.delta) !== -20) {
    throw new Error(`Missing or invalid chg_${successJobId} row: expected -20, got ${JSON.stringify(chgSuccess)}`);
  }


  // A.13: Upload Final Results File to Storage (results bucket)
  console.log("[A.13] Uploading Final Results File (bucket: results)...");
  const csvContent = "id,handle,text\n" + [...mockChunk0Data, ...mockChunk1Data].map(r => `${r.id},${r.handle},${r.text}`).join("\n");
  const { error: resultUploadErr } = await supabase.storage
    .from("results")
    .upload(resultFilePath, csvContent, {
      contentType: "text/csv",
      upsert: true,
    });
  if (resultUploadErr) throw resultUploadErr;
  createdStorageFiles.push({ bucket: "results", path: resultFilePath });
  console.log(`- Final result uploaded: ${resultFilePath}`);

  // A.14: Clean up partials from storage
  console.log("[A.14] Cleaning up partial files from Storage...");
  const { error: removePartErr } = await supabase.storage
    .from("partials")
    .remove([partial0Path, partial1Path]);
  if (removePartErr) throw removePartErr;
  console.log("- Partials removed from Storage.");

  // Verify Success DB State
  const balanceAfterSuccess = await getUserBalance(TEST_USER_ID);
  console.log(`- User 2 balance after settlement: ${balanceAfterSuccess} points (net job cost = ${balanceBefore - balanceAfterSuccess} points)`);
  if (balanceBefore - balanceAfterSuccess !== 20) {
    throw new Error(`Net balance deduction mismatch: expected 20, got ${balanceBefore - balanceAfterSuccess}`);
  }

  const { data: jobSuccessRow } = await supabase.from("jobs").select("*").eq("id", successJobId).single();
  if (jobSuccessRow?.status !== "completed" || jobSuccessRow?.charged_credits !== 20 || jobSuccessRow?.delivered_units !== 10) {
    throw new Error(`Job final row verification failed: ${JSON.stringify(jobSuccessRow)}`);
  }
  console.log("PASS: Success path executed cleanly with exact math (23 reserved, 20 charged, 3 refunded, 10 units delivered).");

  // ===========================================================================
  // SECTION B: FAILURE PATH (5 retries -> auto-release -> 100% refund)
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION B: FAILURE PATH (5 Retries via record_chunk_failure -> Full Refund)");
  console.log("--------------------------------------------------------------------------------");

  const failQuoteId = `${RUN_PREFIX}quote_fail`;
  const failItems = [{
    capabilitySlug: "tiktok-profile",
    targetVolumeMin: 5,
    targetVolumeMax: 10,
    unitPricePoints: 2,
    params: { username: "failing_user" },
  }];
  const failHash = computeQuoteHash(failItems);
  const failReserved = 23;
  const failExpires = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  // B.1: Create & Accept Failing Quote
  console.log("\n[B.1] Creating and Accepting Second Quote Fixture:", failQuoteId);
  await createVerifyFixtures(supabase, [{
    table: "plans_quotes",
    purpose: "failure path worker dry-run",
    row: {
      id: failQuoteId,
      user_id: TEST_USER_ID,
      quote_hash: failHash,
      status: "quoted",
      total_reserved_credits: failReserved,
      items: failItems,
      output_formats: ["csv"],
      expires_at: failExpires,
    },
  }]);

  const { data: failAcceptRes, error: failAcceptErr } = await supabase.rpc("accept_quote_atomic", {
    p_quote_id: failQuoteId,
    p_user_id: TEST_USER_ID,
    p_expected_quote_hash: failHash,
  });
  if (failAcceptErr) throw failAcceptErr;
  const failJobId = failAcceptRes.job_id;
  console.log(`- Failing Job Created: ID = ${failJobId}, Reserved = ${failAcceptRes.reserved_credits} points`);

  // B.2: Claim step 0 to start running
  await supabase.rpc("claim_job_chunk", {
    p_job_id: failJobId,
    p_expected_step: 0,
    p_lease_seconds: 60,
  });

  // B.3: Trigger 5 consecutive chunk failures
  console.log("[B.3] Triggering 5 consecutive record_chunk_failure calls...");
  for (let attempt = 1; attempt <= 5; attempt++) {
    const { data: failRes, error: failErr } = await supabase.rpc("record_chunk_failure", {
      p_job_id: failJobId,
      p_error_message: `Simulated upstream provider timeout on attempt ${attempt}`,
    });
    if (failErr) throw failErr;
    console.log(`  Attempt ${attempt}/5:`, JSON.stringify(failRes));
  }

  // B.4: Verify Terminal State & Balance Restoration
  console.log("\n[B.4] Verifying Terminal Failure State & Full Refund...");
  const { data: failedJobRow } = await supabase.from("jobs").select("*").eq("id", failJobId).single();
  console.log("- Failed Job Row:", JSON.stringify({
    status: failedJobRow.status,
    attempt_count: failedJobRow.attempt_count,
    charged_credits: failedJobRow.charged_credits,
    reserved_credits: failedJobRow.reserved_credits,
    error_message: failedJobRow.error_message,
  }, null, 2));

  if (failedJobRow.status !== "failed" || failedJobRow.attempt_count !== 5 || failedJobRow.charged_credits !== 0) {
    throw new Error(`Failed job row invariant violated: ${JSON.stringify(failedJobRow)}`);
  }

  const { data: relRow } = await supabase
    .from("credit_ledger")
    .select("*")
    .eq("id", `rel_${failJobId}`)
    .single();
  if (!relRow || Number(relRow.delta) !== failReserved) {
    throw new Error(`Refund ledger row rel_${failJobId} missing or mismatch: ${JSON.stringify(relRow)}`);
  }
  console.log(`- Refund Ledger Row verified: rel_${failJobId} (+${relRow.delta} points)`);

  const balanceAfterFail = await getUserBalance(TEST_USER_ID);
  console.log(`- User 2 Balance after full refund: ${balanceAfterFail} points (net deduction from both runs = ${balanceBefore - balanceAfterFail} points)`);
  if (balanceAfterFail !== balanceAfterSuccess) {
    throw new Error(`Balance was not fully refunded for failed job: expected ${balanceAfterSuccess}, got ${balanceAfterFail}`);
  }
  console.log("PASS: Failure path cleanly refunded 100% of reserved points with 0 charge.");

  // ===========================================================================
  // SECTION C: INVENTORY & RECONCILIATION SUMMARY
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION C: FINAL RECONCILIATION & ROW INVENTORY");
  console.log("--------------------------------------------------------------------------------");
  const countsAfter = await getTableRowCounts();

  console.log("Table Row Counts Comparison:");
  for (const table of Object.keys(countsBefore) as (keyof typeof countsBefore)[]) {
    const diff = countsAfter[table] - countsBefore[table];
    console.log(`  - ${table.padEnd(16)}: Before = ${String(countsBefore[table]).padStart(4)}, After = ${String(countsAfter[table]).padStart(4)}, Delta = +${diff}`);
  }

  console.log(`\nProvider Costs Created in This Run: IDs [${createdCostIds.join(", ")}]`);
  const { data: runCosts } = await supabase
    .from("provider_costs")
    .select("id, job_id, cost_usd, units, is_estimate")
    .in("id", createdCostIds);
  console.log(JSON.stringify(runCosts, null, 2));

  console.log("\nStorage Verification:");
  const { data: finalResultsList } = await supabase.storage.from("results").list(`${TEST_USER_ID}/${successJobId}`);
  console.log(`- Results folder contents (${TEST_USER_ID}/${successJobId}):`, (finalResultsList || []).map(f => f.name));
  const { data: finalPartialsList } = await supabase.storage.from("partials").list(successJobId);
  console.log(`- Partials folder contents (${successJobId}) after cleanup:`, (finalPartialsList || []).map(f => f.name));

  console.log("\n================================================================================");
  console.log(`PASS: WORKER DRY-RUN VERIFIED (Net points spent: ${balanceBefore - balanceAfterFail} for 1 completed job)`);
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
