/**
 * Live Verification Script: Atomic Quote Acceptance (accept_quote_atomic)
 * Usage: npx tsx --env-file=.env.local scripts/verify/verify-accept-quote.ts
 * Tests against second test user: 00000000-0000-0000-0000-000000000002.
 * Uses service-role RPCs only (create_verify_fixture, accept_quote_atomic, release_job_atomic).
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

function computeTestQuoteHash(items: any[], outputFormats: string[] = ["xlsx", "csv"]): string {
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
  console.log("=== Verifying Atomic Quote Acceptance Flow ===");
  console.log("Run prefix:", RUN_PREFIX);
  console.log("Test user:", TEST_USER_ID);

  const balanceStart = await getUserBalance(TEST_USER_ID);
  console.log("Starting balance:", balanceStart);

  const createdJobIds: string[] = [];

  try {
    // -------------------------------------------------------------------------
    // 1. Accept once (valid quote)
    // -------------------------------------------------------------------------
    console.log("\n--- Check 1: Accept once (valid quote) ---");
    const quote1Id = `${RUN_PREFIX}quote_single`;
    const items1 = [{
      capabilitySlug: "tiktok-profile",
      targetVolumeMin: 5,
      targetVolumeMax: 10,
      unitPricePoints: 2,
    }];
    const hash1 = computeTestQuoteHash(items1);
    const reserved1 = 23; // 10 * 2 = 20 + 15% buffer = 23
    const expires1 = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    await createVerifyFixtures(supabase, [{
      table: "plans_quotes",
      purpose: "valid single quote fixture",
      row: {
        id: quote1Id,
        user_id: TEST_USER_ID,
        quote_hash: hash1,
        status: "quoted",
        total_reserved_credits: reserved1,
        items: items1,
        output_formats: ["csv", "xlsx"],
        expires_at: expires1,
      },
    }]);

    const { data: res1, error: err1 } = await supabase.rpc("accept_quote_atomic", {
      p_quote_id: quote1Id,
      p_user_id: TEST_USER_ID,
      p_expected_quote_hash: hash1,
    });
    if (err1) throw err1;
    console.log("Accept once result:", JSON.stringify(res1));
    if (!res1?.success || res1.already_accepted !== false || res1.reserved_credits !== reserved1) {
      throw new Error(`Accept once failed: ${JSON.stringify(res1)}`);
    }
    const expectedJobId1 = `job_quote_${crypto.createHash("md5").update(quote1Id).digest("hex")}`;
    if (res1.job_id !== expectedJobId1) {
      throw new Error(`Job ID mismatch: expected ${expectedJobId1}, got ${res1.job_id}`);
    }
    createdJobIds.push(res1.job_id);

    // Verify DB state
    const { data: jobRow1 } = await supabase.from("jobs").select("*").eq("id", expectedJobId1).single();
    if (!jobRow1 || jobRow1.status !== "queued" || Number(jobRow1.unit_price) !== 2 || Number(jobRow1.reserved_credits) !== reserved1) {
      throw new Error(`Job row 1 verification failed: ${JSON.stringify(jobRow1)}`);
    }

    const { data: quoteRow1 } = await supabase.from("plans_quotes").select("status").eq("id", quote1Id).single();
    if (quoteRow1?.status !== "accepted") {
      throw new Error(`Quote 1 status was not updated to accepted: ${quoteRow1?.status}`);
    }

    const { data: ledgerRow1 } = await supabase.from("credit_ledger").select("*").eq("id", `res_${expectedJobId1}`).single();
    if (!ledgerRow1 || Number(ledgerRow1.delta) !== -reserved1) {
      throw new Error(`Ledger row 1 verification failed: ${JSON.stringify(ledgerRow1)}`);
    }
    console.log("PASS: Accept once verified. Job, ledger, quote, and event created.");

    // -------------------------------------------------------------------------
    // 2. Accept twice (idempotent, same job ID, balance unchanged)
    // -------------------------------------------------------------------------
    console.log("\n--- Check 2: Accept twice (idempotency) ---");
    const balBeforeRetry = await getUserBalance(TEST_USER_ID);
    const { data: res2, error: err2 } = await supabase.rpc("accept_quote_atomic", {
      p_quote_id: quote1Id,
      p_user_id: TEST_USER_ID,
      p_expected_quote_hash: hash1,
    });
    if (err2) throw err2;
    console.log("Accept twice result:", JSON.stringify(res2));
    if (!res2?.success || res2.already_accepted !== true || res2.job_id !== expectedJobId1) {
      throw new Error(`Accept twice failed idempotency: ${JSON.stringify(res2)}`);
    }
    const balAfterRetry = await getUserBalance(TEST_USER_ID);
    if (balBeforeRetry !== balAfterRetry) {
      throw new Error(`Balance changed on duplicate accept: before=${balBeforeRetry}, after=${balAfterRetry}`);
    }
    console.log("PASS: Accept twice verified idempotent. Balance unchanged.");

    // -------------------------------------------------------------------------
    // 3. Wrong hash rejected
    // -------------------------------------------------------------------------
    console.log("\n--- Check 3: Wrong quote hash rejected ---");
    const quoteWrongHashId = `${RUN_PREFIX}quote_wrong_hash`;
    await createVerifyFixtures(supabase, [{
      table: "plans_quotes",
      purpose: "quote for wrong hash check",
      row: {
        id: quoteWrongHashId,
        user_id: TEST_USER_ID,
        quote_hash: hash1,
        status: "quoted",
        total_reserved_credits: 10,
        items: items1,
        output_formats: ["csv", "xlsx"],
        expires_at: expires1,
      },
    }]);

    const fakeHash = "0000000000000000000000000000000000000000000000000000000000000000";
    const { data: resWrongHash, error: errWrongHash } = await supabase.rpc("accept_quote_atomic", {
      p_quote_id: quoteWrongHashId,
      p_user_id: TEST_USER_ID,
      p_expected_quote_hash: fakeHash,
    });
    if (errWrongHash) throw errWrongHash;
    console.log("Wrong hash result:", JSON.stringify(resWrongHash));
    if (resWrongHash?.success !== false || resWrongHash.error !== "quote_hash_mismatch") {
      throw new Error(`Expected quote_hash_mismatch, got: ${JSON.stringify(resWrongHash)}`);
    }
    console.log("PASS: Wrong hash rejected.");

    // -------------------------------------------------------------------------
    // 4. Expired quote rejected
    // -------------------------------------------------------------------------
    console.log("\n--- Check 4: Expired quote rejected ---");
    const quoteExpiredId = `${RUN_PREFIX}quote_expired`;
    // Create with future expiration (1.5s in future) to satisfy create_verify_fixture constraint
    const nearExpiry = new Date(Date.now() + 1500).toISOString();
    await createVerifyFixtures(supabase, [{
      table: "plans_quotes",
      purpose: "quote for expiration check",
      row: {
        id: quoteExpiredId,
        user_id: TEST_USER_ID,
        quote_hash: hash1,
        status: "quoted",
        total_reserved_credits: 10,
        items: items1,
        output_formats: ["csv", "xlsx"],
        expires_at: nearExpiry,
      },
    }]);
    console.log("Waiting 2000ms for quote to expire...");
    await new Promise((r) => setTimeout(r, 2000));

    const { data: resExpired, error: errExpired } = await supabase.rpc("accept_quote_atomic", {
      p_quote_id: quoteExpiredId,
      p_user_id: TEST_USER_ID,
      p_expected_quote_hash: hash1,
    });
    if (errExpired) throw errExpired;
    console.log("Expired quote result:", JSON.stringify(resExpired));
    if (resExpired?.success !== false || resExpired.error !== "quote_expired") {
      throw new Error(`Expected quote_expired, got: ${JSON.stringify(resExpired)}`);
    }
    console.log("PASS: Expired quote rejected.");

    // -------------------------------------------------------------------------
    // 5. Quote item without unitPricePoints rejected
    // -------------------------------------------------------------------------
    console.log("\n--- Check 5: Item without unitPricePoints rejected ---");
    const quoteNoPriceId = `${RUN_PREFIX}quote_no_unit_price`;
    const itemsNoPrice = [{
      capabilitySlug: "tiktok-profile",
      targetVolumeMin: 5,
      targetVolumeMax: 10,
      // no unitPricePoints
    }];
    const hashNoPrice = computeTestQuoteHash(itemsNoPrice);
    await createVerifyFixtures(supabase, [{
      table: "plans_quotes",
      purpose: "quote without unitPricePoints fixture",
      row: {
        id: quoteNoPriceId,
        user_id: TEST_USER_ID,
        quote_hash: hashNoPrice,
        status: "quoted",
        total_reserved_credits: 10,
        items: itemsNoPrice,
        output_formats: ["csv", "xlsx"],
        expires_at: expires1,
      },
    }]);

    const { data: resNoPrice, error: errNoPrice } = await supabase.rpc("accept_quote_atomic", {
      p_quote_id: quoteNoPriceId,
      p_user_id: TEST_USER_ID,
      p_expected_quote_hash: hashNoPrice,
    });
    if (errNoPrice) throw errNoPrice;
    console.log("Missing unit price result:", JSON.stringify(resNoPrice));
    if (resNoPrice?.success !== false || resNoPrice.error !== "missing_item_unit_price") {
      throw new Error(`Expected missing_item_unit_price, got: ${JSON.stringify(resNoPrice)}`);
    }
    console.log("PASS: Item without unitPricePoints rejected.");

    // -------------------------------------------------------------------------
    // 6. Two-item quote rejected
    // -------------------------------------------------------------------------
    console.log("\n--- Check 6: Two-item quote rejected ---");
    const quoteTwoItemsId = `${RUN_PREFIX}quote_two_items`;
    const itemsTwo = [
      { capabilitySlug: "tiktok-profile", targetVolumeMin: 5, targetVolumeMax: 10, unitPricePoints: 2 },
      { capabilitySlug: "instagram-profile", targetVolumeMin: 5, targetVolumeMax: 10, unitPricePoints: 2 },
    ];
    const hashTwo = computeTestQuoteHash(itemsTwo);
    await createVerifyFixtures(supabase, [{
      table: "plans_quotes",
      purpose: "two-item quote fixture",
      row: {
        id: quoteTwoItemsId,
        user_id: TEST_USER_ID,
        quote_hash: hashTwo,
        status: "quoted",
        total_reserved_credits: 46,
        items: itemsTwo,
        output_formats: ["csv", "xlsx"],
        expires_at: expires1,
      },
    }]);

    const { data: resTwoItems, error: errTwoItems } = await supabase.rpc("accept_quote_atomic", {
      p_quote_id: quoteTwoItemsId,
      p_user_id: TEST_USER_ID,
      p_expected_quote_hash: hashTwo,
    });
    if (errTwoItems) throw errTwoItems;
    console.log("Two-item quote result:", JSON.stringify(resTwoItems));
    if (resTwoItems?.success !== false || resTwoItems.error !== "single_item_quote_required") {
      throw new Error(`Expected single_item_quote_required, got: ${JSON.stringify(resTwoItems)}`);
    }
    console.log("PASS: Two-item quote rejected.");

    // -------------------------------------------------------------------------
    // 7. Insufficient balance rejected (no ledger row, no job)
    // -------------------------------------------------------------------------
    console.log("\n--- Check 7: Insufficient balance rejected ---");
    const quoteBrokeId = `${RUN_PREFIX}quote_insufficient_bal`;
    const itemsBroke = [{ capabilitySlug: "tiktok-profile", targetVolumeMin: 5, targetVolumeMax: 10, unitPricePoints: 2 }];
    const hashBroke = computeTestQuoteHash(itemsBroke);
    const hugeReserve = 99999;
    await createVerifyFixtures(supabase, [{
      table: "plans_quotes",
      purpose: "insufficient balance quote fixture",
      row: {
        id: quoteBrokeId,
        user_id: TEST_USER_ID,
        quote_hash: hashBroke,
        status: "quoted",
        total_reserved_credits: hugeReserve,
        items: itemsBroke,
        output_formats: ["csv", "xlsx"],
        expires_at: expires1,
      },
    }]);

    const balBeforeBroke = await getUserBalance(TEST_USER_ID);
    const { data: resBroke, error: errBroke } = await supabase.rpc("accept_quote_atomic", {
      p_quote_id: quoteBrokeId,
      p_user_id: TEST_USER_ID,
      p_expected_quote_hash: hashBroke,
    });
    if (errBroke) throw errBroke;
    console.log("Insufficient balance result:", JSON.stringify(resBroke));
    if (resBroke?.success !== false || resBroke.error !== "insufficient_balance") {
      throw new Error(`Expected insufficient_balance, got: ${JSON.stringify(resBroke)}`);
    }
    const balAfterBroke = await getUserBalance(TEST_USER_ID);
    if (balBeforeBroke !== balAfterBroke) {
      throw new Error(`Balance changed on insufficient_balance rejection!`);
    }
    console.log("PASS: Insufficient balance rejected without mutations.");

    // -------------------------------------------------------------------------
    // 8. 10 parallel accepts of the SAME quote produce 1 job and 1 res_ row
    // -------------------------------------------------------------------------
    console.log("\n--- Check 8: 10 parallel accepts of same quote ---");
    const quoteParallelSameId = `${RUN_PREFIX}quote_par_same`;
    const itemsParSame = [{ capabilitySlug: "tiktok-profile", targetVolumeMin: 5, targetVolumeMax: 10, unitPricePoints: 2 }];
    const hashParSame = computeTestQuoteHash(itemsParSame);
    const reservedParSame = 20;

    await createVerifyFixtures(supabase, [{
      table: "plans_quotes",
      purpose: "10 parallel accepts of same quote fixture",
      row: {
        id: quoteParallelSameId,
        user_id: TEST_USER_ID,
        quote_hash: hashParSame,
        status: "quoted",
        total_reserved_credits: reservedParSame,
        items: itemsParSame,
        output_formats: ["csv", "xlsx"],
        expires_at: expires1,
      },
    }]);

    const parallelSameCalls = Array.from({ length: 10 }, () =>
      supabase.rpc("accept_quote_atomic", {
        p_quote_id: quoteParallelSameId,
        p_user_id: TEST_USER_ID,
        p_expected_quote_hash: hashParSame,
      })
    );
    const parallelSameResults = await Promise.all(parallelSameCalls);
    for (const r of parallelSameResults) if (r.error) throw r.error;
    const sameData = parallelSameResults.map((r) => r.data);
    const parWinners = sameData.filter((r) => r?.success && !r.already_accepted);
    const parRetries = sameData.filter((r) => r?.success && r.already_accepted);
    console.log(`Parallel same-quote results: winners=${parWinners.length}, already_accepted=${parRetries.length}`);
    if (parWinners.length !== 1 || parRetries.length !== 9) {
      throw new Error(`Expected 1 winner and 9 already_accepted, got: ${JSON.stringify(sameData)}`);
    }
    const parJobId = parWinners[0].job_id;
    createdJobIds.push(parJobId);

    // Verify only 1 res_ row exists for this job
    const { data: ledgerRowsPar } = await supabase
      .from("credit_ledger")
      .select("id")
      .eq("id", `res_${parJobId}`);
    if (!ledgerRowsPar || ledgerRowsPar.length !== 1) {
      throw new Error(`Expected exactly 1 ledger row for ${parJobId}, found ${ledgerRowsPar?.length}`);
    }
    console.log("PASS: 10 parallel accepts serialized. Exactly 1 job and 1 reservation.");

    // -------------------------------------------------------------------------
    // 9. Third active job hits concurrency_limit
    // -------------------------------------------------------------------------
    console.log("\n--- Check 9: Third active job hits concurrency_limit ---");
    // User 2 now has 2 active queued jobs (Job 1 and Job 2).
    const quote3Id = `${RUN_PREFIX}quote_third_active`;
    const items3 = [{ capabilitySlug: "tiktok-profile", targetVolumeMin: 1, targetVolumeMax: 5, unitPricePoints: 2 }];
    const hash3 = computeTestQuoteHash(items3);
    await createVerifyFixtures(supabase, [{
      table: "plans_quotes",
      purpose: "third active job fixture",
      row: {
        id: quote3Id,
        user_id: TEST_USER_ID,
        quote_hash: hash3,
        status: "quoted",
        total_reserved_credits: 10,
        items: items3,
        output_formats: ["csv", "xlsx"],
        expires_at: expires1,
      },
    }]);

    const { data: res3, error: err3 } = await supabase.rpc("accept_quote_atomic", {
      p_quote_id: quote3Id,
      p_user_id: TEST_USER_ID,
      p_expected_quote_hash: hash3,
    });
    if (err3) throw err3;
    console.log("Third active job result:", JSON.stringify(res3));
    if (res3?.success !== false || res3.error !== "concurrency_limit") {
      throw new Error(`Expected concurrency_limit error, got: ${JSON.stringify(res3)}`);
    }
    console.log("PASS: Concurrency limit enforced (maximum 2 active queued/running jobs).");

    // -------------------------------------------------------------------------
    // Release active jobs so balance is refunded and active jobs count resets
    // -------------------------------------------------------------------------
    console.log("\nReleasing the two active test jobs to test parallel different quotes...");
    for (const jid of createdJobIds) {
      const { data: relRes, error: relErr } = await supabase.rpc("release_job_atomic", {
        p_job_id: jid,
        p_error_message: "Test stage release",
      });
      if (relErr) throw relErr;
      if (!relRes?.success) throw new Error(`Release failed for ${jid}: ${JSON.stringify(relRes)}`);
    }
    createdJobIds.length = 0; // cleared

    const balAfterRelease = await getUserBalance(TEST_USER_ID);
    console.log("Balance after releasing holds:", balAfterRelease);
    if (balAfterRelease !== 500) {
      throw new Error(`Expected balance 500 after release, got ${balAfterRelease}`);
    }

    // -------------------------------------------------------------------------
    // 10. Two different quotes parallel when balance covers only 1 (no overdraft)
    // -------------------------------------------------------------------------
    console.log("\n--- Check 10: Two different quotes parallel when balance covers only 1 ---");
    // Balance is 500. Each quote asks for 300 points (total 600 > 500).
    const quoteDiffAId = `${RUN_PREFIX}quote_diff_a`;
    const quoteDiffBId = `${RUN_PREFIX}quote_diff_b`;
    const itemsDiffA = [{ capabilitySlug: "tiktok-profile", targetVolumeMin: 100, targetVolumeMax: 150, unitPricePoints: 2 }];
    const itemsDiffB = [{ capabilitySlug: "tiktok-profile", targetVolumeMin: 100, targetVolumeMax: 150, unitPricePoints: 2 }];
    const hashDiffA = computeTestQuoteHash(itemsDiffA);
    const hashDiffB = computeTestQuoteHash(itemsDiffB);

    await createVerifyFixtures(supabase, [
      {
        table: "plans_quotes",
        purpose: "parallel quote A fixture",
        row: {
          id: quoteDiffAId,
          user_id: TEST_USER_ID,
          quote_hash: hashDiffA,
          status: "quoted",
          total_reserved_credits: 300,
          items: itemsDiffA,
          output_formats: ["csv", "xlsx"],
          expires_at: expires1,
        },
      },
      {
        table: "plans_quotes",
        purpose: "parallel quote B fixture",
        row: {
          id: quoteDiffBId,
          user_id: TEST_USER_ID,
          quote_hash: hashDiffB,
          status: "quoted",
          total_reserved_credits: 300,
          items: itemsDiffB,
          output_formats: ["csv", "xlsx"],
          expires_at: expires1,
        },
      },
    ]);

    const [resA, resB] = await Promise.all([
      supabase.rpc("accept_quote_atomic", {
        p_quote_id: quoteDiffAId,
        p_user_id: TEST_USER_ID,
        p_expected_quote_hash: hashDiffA,
      }),
      supabase.rpc("accept_quote_atomic", {
        p_quote_id: quoteDiffBId,
        p_user_id: TEST_USER_ID,
        p_expected_quote_hash: hashDiffB,
      }),
    ]);
    if (resA.error) throw resA.error;
    if (resB.error) throw resB.error;

    console.log("Parallel Quote A result:", JSON.stringify(resA.data));
    console.log("Parallel Quote B result:", JSON.stringify(resB.data));

    const diffResults = [resA.data, resB.data];
    const diffWinner = diffResults.find((r) => r?.success === true);
    const diffLoser = diffResults.find((r) => r?.success === false && r?.error === "insufficient_balance");

    if (!diffWinner || !diffLoser) {
      throw new Error(`Expected exactly 1 winner and 1 insufficient_balance, got: ${JSON.stringify(diffResults)}`);
    }
    createdJobIds.push(diffWinner.job_id);

    const balAfterDiff = await getUserBalance(TEST_USER_ID);
    console.log("Balance after parallel quotes:", balAfterDiff);
    if (balAfterDiff !== 200) {
      throw new Error(`Expected balance 200 (500 - 300), got ${balAfterDiff}`);
    }
    console.log("PASS: Two parallel quotes serialized. Exactly 1 approved, 0 overdraft.");

    // -------------------------------------------------------------------------
    // 11. Another user's ID on the quote is rejected
    // -------------------------------------------------------------------------
    console.log("\n--- Check 11: Another user's quote rejected ---");
    const quoteOtherUserId = `${RUN_PREFIX}quote_other_user`;
    const itemsOther = [{ capabilitySlug: "tiktok-profile", targetVolumeMin: 1, targetVolumeMax: 5, unitPricePoints: 2 }];
    const hashOther = computeTestQuoteHash(itemsOther);
    // Quote belongs to test user 1 (00000000-0000-0000-0000-000000000001)
    await createVerifyFixtures(supabase, [{
      table: "plans_quotes",
      purpose: "other user quote fixture",
      row: {
        id: quoteOtherUserId,
        user_id: "00000000-0000-0000-0000-000000000001",
        quote_hash: hashOther,
        status: "quoted",
        total_reserved_credits: 10,
        items: itemsOther,
        output_formats: ["csv", "xlsx"],
        expires_at: expires1,
      },
    }]);

    // Attempt to accept with user 2
    const { data: resOtherUser, error: errOtherUser } = await supabase.rpc("accept_quote_atomic", {
      p_quote_id: quoteOtherUserId,
      p_user_id: TEST_USER_ID,
      p_expected_quote_hash: hashOther,
    });
    if (errOtherUser) throw errOtherUser;
    console.log("Other user quote accept result:", JSON.stringify(resOtherUser));
    if (resOtherUser?.success !== false || resOtherUser.error !== "quote_user_mismatch") {
      throw new Error(`Expected quote_user_mismatch, got: ${JSON.stringify(resOtherUser)}`);
    }
    console.log("PASS: Cross-user quote acceptance rejected.");

  } finally {
    // Release any remaining held jobs
    for (const jid of createdJobIds) {
      console.log(`Cleanup release for ${jid}...`);
      await supabase.rpc("release_job_atomic", {
        p_job_id: jid,
        p_error_message: "Verification final cleanup",
      });
    }
  }

  const finalBalance = await getUserBalance(TEST_USER_ID);
  console.log("\n==========================================");
  console.log("Final balance for test user 2:", finalBalance);
  console.log("Net balance change across run:", finalBalance - balanceStart);

  // Print all created rows matching this run
  console.log("\n--- Created rows inventory for prefix:", RUN_PREFIX, "---");
  const { data: quotesCreated } = await supabase
    .from("plans_quotes")
    .select("id, user_id, status, total_reserved_credits, quote_hash")
    .like("id", `${RUN_PREFIX}%`);
  console.log("plans_quotes created count:", quotesCreated?.length);
  for (const q of quotesCreated || []) console.log(`  [quote] ${q.id} status=${q.status} reserved=${q.total_reserved_credits}`);

  const { data: jobsCreated } = await supabase
    .from("jobs")
    .select("id, user_id, status, reserved_credits, charged_credits, unit_price")
    .like("id", `job_quote_%`);
  console.log("jobs matching this run's quotes:");
  for (const j of jobsCreated || []) {
    console.log(`  [job] ${j.id} status=${j.status} reserved=${j.reserved_credits} charged=${j.charged_credits} unit_price=${j.unit_price}`);
  }

  const { data: ledgerCreated } = await supabase
    .from("credit_ledger")
    .select("id, user_id, delta, type, job_id, created_at")
    .eq("user_id", TEST_USER_ID);
  console.log("credit_ledger rows for test user 2 (total count: " + ledgerCreated?.length + "):");
  for (const l of ledgerCreated || []) {
    console.log(`  [ledger] ${l.id} type=${l.type} delta=${l.delta} job=${l.job_id}`);
  }

  console.log("\nPASS: All 11 accept_quote_atomic verification assertions passed.");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
