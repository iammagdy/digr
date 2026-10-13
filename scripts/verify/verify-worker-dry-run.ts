/**
 * Dedicated Verification Script: Real /api/worker/chunk Route Handler Dry-Run (verify-worker-dry-run.ts)
 *
 * Exercises the actual Next.js route handler POST /api/worker/chunk against the live Supabase DB
 * using Test User 2 (00000000-0000-0000-0000-000000000002) with an injected fake provider
 * (enabled ONLY when NODE_ENV !== 'production' AND ENABLE_MOCK_PROVIDER === 'true').
 *
 * Verifies:
 * 0. Production & flag guard on POST /api/worker/chunk (403 when NODE_ENV=production or ENABLE_MOCK_PROVIDER!='true')
 * 1. 2-Chunk Success Path via POST /api/worker/chunk:
 *    - Create quote fixture via create_verify_fixture & accept via accept_quote_atomic (reserves 23 pts)
 *    - Call POST /api/worker/chunk (step 0, mockBatchSize=5): claims step 0, reserves/commits provider spend,
 *      writes partial step_0.json to storage, completes step 0 (delivered_units=5, done=false)
 *    - Call POST /api/worker/chunk (step 1, mockBatchSize=5): claims step 1, reserves/commits provider spend,
 *      completes step 1 (delivered_units=10, done=true), uploads final result to results bucket,
 *      removes partials from partials bucket, and settles via settle_job_atomic (charges 20 pts, refunds 3 pts)
 * 2. Provider-Error Path via POST /api/worker/chunk:
 *    - Create second quote fixture & accept via accept_quote_atomic (reserves 23 pts)
 *    - Call POST /api/worker/chunk (step 0, simulateProviderError=true, exhaustRetries=true):
 *      claims step 0, simulates provider error, records 5 failures via record_chunk_failure,
 *      and atomically releases full 23 reserved points with 0 charge
 *
 * Usage: npx tsx --env-file=.env.local scripts/verify/verify-worker-dry-run.ts
 */
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import crypto from "node:crypto";
import { newVrunPrefix, createVerifyFixtures } from "./vrun";
import { POST as workerChunkPost } from "../../src/app/api/worker/chunk/route";
import { setProviderAdapterForTesting } from "../../src/lib/server/tregAdapter";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_USER_ID = "00000000-0000-0000-0000-000000000002";
const RUN_PREFIX = newVrunPrefix();

if (!SERVICE_KEY) {
  console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
  process.exit(1);
}

// Ensure an ephemeral in-process CRON_SECRET is set if not already present in env (never printed)
if (!process.env.CRON_SECRET) {
  process.env.CRON_SECRET = "ephemeral_verify_cron_secret_do_not_print";
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

function buildWorkerRequest(payload: Record<string, any>): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.CRON_SECRET}`,
      "x-mock-provider": "true",
    },
    body: JSON.stringify(payload),
  });
}

async function main() {
  console.log("================================================================================");
  console.log("   DIGER REAL /api/worker/chunk ROUTE DRY-RUN (verify-worker-dry-run.ts)        ");
  console.log("================================================================================");
  console.log("Run Prefix:", RUN_PREFIX);
  console.log("Target User ID:", TEST_USER_ID);

  // 0. Verify Production & Flag Guard on the Real Route Handler
  console.log("\n[0] Verifying Production & Explicit Flag Guards on POST /api/worker/chunk...");
  const prevNodeEnv = process.env.NODE_ENV;
  const prevEnableMock = process.env.ENABLE_MOCK_PROVIDER;

  process.env.NODE_ENV = "production";
  process.env.ENABLE_MOCK_PROVIDER = "true";
  const prodGuardRes = await workerChunkPost(buildWorkerRequest({ jobId: "guard_check", mockProvider: true }));
  console.log(`- Guard when NODE_ENV=production: HTTP ${prodGuardRes.status}`);
  if (prodGuardRes.status !== 403) {
    throw new Error(`Expected 403 when NODE_ENV=production, got ${prodGuardRes.status}`);
  }

  process.env.NODE_ENV = "test";
  delete process.env.ENABLE_MOCK_PROVIDER;
  const flagGuardRes = await workerChunkPost(buildWorkerRequest({ jobId: "guard_check", mockProvider: true }));
  console.log(`- Guard when ENABLE_MOCK_PROVIDER is unset: HTTP ${flagGuardRes.status}`);
  if (flagGuardRes.status !== 403) {
    throw new Error(`Expected 403 when ENABLE_MOCK_PROVIDER is unset, got ${flagGuardRes.status}`);
  }

  // Enable test mode + explicit mock provider flag for the dry run
  process.env.NODE_ENV = "test";
  process.env.ENABLE_MOCK_PROVIDER = "true";

  // 1. Initial State Inventory
  const balanceBefore = await getUserBalance(TEST_USER_ID);
  const countsBefore = await getTableRowCounts();
  console.log("\n[1] Initial State:");
  console.log(`- Test User 2 Starting Balance: ${balanceBefore} points`);
  console.log("- Table Row Counts Before:", JSON.stringify(countsBefore, null, 2));

  const utcDayStart = new Date();
  utcDayStart.setUTCHours(0, 0, 0, 0);
  const { data: todayCosts } = await supabase
    .from("provider_costs")
    .select("cost_usd")
    .gte("created_at", utcDayStart.toISOString());
  const currentDailySpend = (todayCosts || []).reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  console.log(`- Current UTC Day Provider Spend: $${currentDailySpend.toFixed(4)} / $0.80`);

  const createdCostIds: number[] = [];

  // ===========================================================================
  // SECTION A: 2-CHUNK SUCCESS PATH THROUGH POST /api/worker/chunk
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION A: 2-CHUNK SUCCESS PATH VIA POST /api/worker/chunk");
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

  console.log("\n[A.1] Creating Fixture Quote:", successQuoteId);
  await createVerifyFixtures(supabase, [{
    table: "plans_quotes",
    purpose: "success path worker route dry-run",
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

  // Inject fake provider adapter for 2-chunk pagination (5 rows on step 0, 5 rows on step 1)
  setProviderAdapterForTesting(async (input) => {
    const startIdx = input.step * 5;
    const rows = Array.from({ length: 5 }, (_, idx) => {
      const n = startIdx + idx + 1;
      return {
        id: `tt_id_${n}`,
        uniqueId: `diger_creator_${n}`,
        nickname: `صانع محتوى ${n}`,
        signature: `حساب عام للاختبار رقم ${n}`,
        verified: n % 2 === 0,
        followerCount: 10000 + n * 100,
        followingCount: 150 + n,
        heartCount: 250000 + n * 1000,
        videoCount: 40 + n,
        bioLink: `https://diger.tech/u/${n}`,
      };
    });
    return {
      ok: true,
      httpStatus: 200,
      rows,
      rawProfile: rows[0],
      nextCursor: input.step === 0 ? "cursor_step_1" : null,
      costUsd: 0.005,
      costMicro: 5000,
      tregCallId: `fake_treg_${input.jobId}_step_${input.step}`,
    };
  });

  // A.3: Invoke POST /api/worker/chunk for Chunk 0 (processes 5 of 10 units)
  console.log("\n[A.3] Invoking POST /api/worker/chunk (Step 0, injected adapter -> 5 rows)...");
  const chunk0HttpRes = await workerChunkPost(
    buildWorkerRequest({
      jobId: successJobId,
      expectedStep: 0,
      mockProvider: true,
      mockBatchSize: 5,
      mockEstimatedCostUsd: 0.005,
      disableSelfChain: true,
    })
  );
  const chunk0Json = await chunk0HttpRes.json();
  console.log(`- Chunk 0 HTTP ${chunk0HttpRes.status}:`, JSON.stringify(chunk0Json));
  if (chunk0HttpRes.status !== 200 || !chunk0Json.success || chunk0Json.done !== false || chunk0Json.deliveredUnits !== 5) {
    throw new Error(`Chunk 0 route execution failed: ${JSON.stringify(chunk0Json)}`);
  }
  if (chunk0Json.spendCostId) createdCostIds.push(chunk0Json.spendCostId);

  // Verify partial object exists in 'partials' bucket after Step 0
  const { data: partialsAfterStep0 } = await supabase.storage.from("partials").list(successJobId);
  console.log(`- Storage 'partials/${successJobId}' after Step 0:`, (partialsAfterStep0 || []).map((f) => f.name));
  if (!(partialsAfterStep0 || []).some((f) => f.name === "step_0.json")) {
    throw new Error(`Expected step_0.json in partials/${successJobId}`);
  }

  // A.4: Invoke POST /api/worker/chunk for Chunk 1 (processes remaining 5 units -> total 10 -> settles)
  console.log("\n[A.4] Invoking POST /api/worker/chunk (Step 1, injected adapter -> 5 rows -> Settlement)...");
  const chunk1HttpRes = await workerChunkPost(
    buildWorkerRequest({
      jobId: successJobId,
      expectedStep: 1,
      mockProvider: true,
      mockBatchSize: 5,
      mockEstimatedCostUsd: 0.005,
      disableSelfChain: true,
    })
  );
  const chunk1Json = await chunk1HttpRes.json();
  console.log(`- Chunk 1 HTTP ${chunk1HttpRes.status}:`, JSON.stringify(chunk1Json));
  if (chunk1HttpRes.status !== 200 || !chunk1Json.success || chunk1Json.done !== true || chunk1Json.deliveredUnits !== 10) {
    throw new Error(`Chunk 1 route execution failed: ${JSON.stringify(chunk1Json)}`);
  }
  if (chunk1Json.spendCostId) createdCostIds.push(chunk1Json.spendCostId);

  // Verify settlement ledger rows (rel_ +23, chg_ -20)
  const { data: settleLedgerRows, error: settleLedgerErr } = await supabase
    .from("credit_ledger")
    .select("id, delta, type")
    .eq("job_id", successJobId);
  if (settleLedgerErr) throw settleLedgerErr;
  console.log("- Settlement Ledger Rows:", JSON.stringify(settleLedgerRows));
  const relSuccess = (settleLedgerRows || []).find((r) => r.id === `rel_${successJobId}`);
  const chgSuccess = (settleLedgerRows || []).find((r) => r.id === `chg_${successJobId}`);
  if (!relSuccess || Number(relSuccess.delta) !== successReserved) {
    throw new Error(`Missing or invalid rel_${successJobId}: ${JSON.stringify(relSuccess)}`);
  }
  if (!chgSuccess || Number(chgSuccess.delta) !== -20) {
    throw new Error(`Missing or invalid chg_${successJobId}: ${JSON.stringify(chgSuccess)}`);
  }

  const balanceAfterSuccess = await getUserBalance(TEST_USER_ID);
  console.log(`- User 2 balance after 2-chunk settlement: ${balanceAfterSuccess} points (net cost = ${balanceBefore - balanceAfterSuccess} points)`);
  if (balanceBefore - balanceAfterSuccess !== 20) {
    throw new Error(`Net balance deduction mismatch: expected 20, got ${balanceBefore - balanceAfterSuccess}`);
  }

  // ===========================================================================
  // SECTION B: PROVIDER-ERROR PATH THROUGH POST /api/worker/chunk
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION B: PROVIDER-ERROR PATH VIA POST /api/worker/chunk (-> Full Refund)");
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

  console.log("\n[B.1] Creating and Accepting Second Quote Fixture:", failQuoteId);
  await createVerifyFixtures(supabase, [{
    table: "plans_quotes",
    purpose: "provider-error path worker route dry-run",
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
  const balanceDuringFailReserve = await getUserBalance(TEST_USER_ID);
  console.log(`- Failing Job Created: ID = ${failJobId}, Reserved = ${failAcceptRes.reserved_credits} points, Balance = ${balanceDuringFailReserve}`);

  // Inject failing provider adapter for Section B
  setProviderAdapterForTesting(async (input) => ({
    ok: false,
    httpStatus: 502,
    rows: [],
    nextCursor: null,
    costUsd: 0,
    costMicro: 0,
    tregCallId: `fake_treg_fail_${input.jobId}`,
    errorCode: "simulated_provider_error",
    errorMessageAr: "خطأ محاكى من مزود البيانات لاختبار الاسترداد الكامل.",
  }));

  // B.2: Call POST /api/worker/chunk with simulateProviderError=true & exhaustRetries=true
  console.log("[B.2] Invoking POST /api/worker/chunk with injected failing adapter & exhaustRetries=true...");
  const failHttpRes = await workerChunkPost(
    buildWorkerRequest({
      jobId: failJobId,
      expectedStep: 0,
      mockProvider: true,
      simulateProviderError: true,
      mockEstimatedCostUsd: 0.001,
      exhaustRetries: true,
      disableSelfChain: true,
    })
  );
  const failJson = await failHttpRes.json();
  console.log(`- Error Route Response HTTP ${failHttpRes.status}:`, JSON.stringify(failJson));
  if (failHttpRes.status !== 500 || failJson.success !== false || !failJson.failure?.released) {
    throw new Error(`Expected 500 with terminal release on provider error, got: ${JSON.stringify(failJson)}`);
  }

  // B.3: Verify Terminal State & Full Reserve Release
  const { data: failedJobRow } = await supabase.from("jobs").select("*").eq("id", failJobId).single();
  console.log("- Failed Job Row:", JSON.stringify({
    status: failedJobRow.status,
    attempt_count: failedJobRow.attempt_count,
    charged_credits: failedJobRow.charged_credits,
    reserved_credits: failedJobRow.reserved_credits,
    error_message: failedJobRow.error_message,
  }));
  if (failedJobRow.status !== "failed" || failedJobRow.attempt_count !== 5 || failedJobRow.charged_credits !== 0) {
    throw new Error(`Failed job row invariant violated: ${JSON.stringify(failedJobRow)}`);
  }

  const { data: relRow } = await supabase
    .from("credit_ledger")
    .select("id, delta, type")
    .eq("id", `rel_${failJobId}`)
    .single();
  if (!relRow || Number(relRow.delta) !== failReserved) {
    throw new Error(`Refund ledger row rel_${failJobId} missing or mismatch: ${JSON.stringify(relRow)}`);
  }
  console.log(`- Refund Ledger Row verified: ${relRow.id} (+${relRow.delta} points)`);

  const balanceAfterFail = await getUserBalance(TEST_USER_ID);
  console.log(`- User 2 Balance after full refund: ${balanceAfterFail} points (net deduction from both runs = ${balanceBefore - balanceAfterFail} points)`);
  if (balanceAfterFail !== balanceAfterSuccess) {
    throw new Error(`Balance was not fully refunded for failed job: expected ${balanceAfterSuccess}, got ${balanceAfterFail}`);
  }

  // ===========================================================================
  // SECTION C: INVENTORY & RECONCILIATION SUMMARY
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION C: FINAL RECONCILIATION, PROVIDER_COSTS & STORAGE OBJECTS");
  console.log("--------------------------------------------------------------------------------");
  const countsAfter = await getTableRowCounts();

  console.log("Table Row Counts Comparison:");
  for (const table of Object.keys(countsBefore) as (keyof typeof countsBefore)[]) {
    const diff = countsAfter[table] - countsBefore[table];
    console.log(`  - ${table.padEnd(16)}: Before = ${String(countsBefore[table]).padStart(4)}, After = ${String(countsAfter[table]).padStart(4)}, Delta = +${diff}`);
  }

  console.log(`\nProvider Costs Created by Route Handler: IDs [${createdCostIds.join(", ")}]`);
  const { data: runCosts } = await supabase
    .from("provider_costs")
    .select("id, job_id, provider, cost_usd, units, is_estimate")
    .in("id", createdCostIds);
  console.log(JSON.stringify(runCosts, null, 2));

  console.log("\nStorage & Artifact Verification:");
  const { data: finalUserResultsList } = await supabase.storage.from("results").list(`${TEST_USER_ID}/${successJobId}`);
  const userResultFiles = (finalUserResultsList || []).map((f) => f.name);
  console.log(`- Results folder (${TEST_USER_ID}/${successJobId}):`, userResultFiles);
  if (!userResultFiles.includes("result.csv") || !userResultFiles.includes("result.xlsx") || !userResultFiles.includes("result.pdf")) {
    throw new Error(`Expected result.csv, result.xlsx, result.pdf in results/${TEST_USER_ID}/${successJobId}, got ${JSON.stringify(userResultFiles)}`);
  }

  const { data: csvBlob, error: csvDlErr } = await supabase.storage
    .from("results")
    .download(`${TEST_USER_ID}/${successJobId}/result.csv`);
  if (csvDlErr || !csvBlob) {
    throw new Error(`Failed to download result.csv: ${csvDlErr?.message || "missing_blob"}`);
  }
  const csvText = (await csvBlob.text()).replace(/^\uFEFF/, "").trimEnd();
  const csvLines = csvText.split(/\r?\n/);
  const dataRowCount = csvLines.length - 1;
  console.log(`- Downloaded result.csv line count: ${csvLines.length} total lines (1 header + ${dataRowCount} data rows)`);
  console.log("- Downloaded result.csv first rows:");
  csvLines.slice(0, 4).forEach((line, idx) => {
    console.log(`    [${idx === 0 ? "HEADER" : `ROW ${idx}`}] ${line}`);
  });
  if (dataRowCount !== 10) {
    throw new Error(`Expected result.csv data row count to equal delivered_units (10), got ${dataRowCount}`);
  }

  const { data: avRow, error: avErr } = await supabase
    .from("artifact_versions")
    .select("*")
    .eq("job_id", successJobId)
    .single();
  if (avErr || !avRow) {
    throw new Error(`Missing artifact_versions row for ${successJobId}: ${avErr?.message}`);
  }
  console.log("- Artifact Version Row:", JSON.stringify(avRow));

  const { data: finalPartialsList } = await supabase.storage.from("partials").list(successJobId);
  const remainingPartials = (finalPartialsList || []).map((f) => f.name).filter((n) => n.startsWith("step_"));
  console.log(`- Partials step files (${successJobId}) after cleanup:`, remainingPartials);
  if (remainingPartials.length !== 0) {
    throw new Error(`Expected step_*.json in partials/${successJobId} to be empty after settlement cleanup, found ${JSON.stringify(remainingPartials)}`);
  }

  setProviderAdapterForTesting(null);
  process.env.NODE_ENV = prevNodeEnv;
  if (prevEnableMock === undefined) delete process.env.ENABLE_MOCK_PROVIDER;
  else process.env.ENABLE_MOCK_PROVIDER = prevEnableMock;

  console.log("\n================================================================================");
  console.log(`PASS: REAL /api/worker/chunk ROUTE VERIFIED (Start=${balanceBefore}, End=${balanceAfterFail}, Net=-${balanceBefore - balanceAfterFail})`);
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
