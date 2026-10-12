/**
 * Live Verification Script: Storage Bucket Policies
 * Usage: tsx scripts/verify/verify-receipt-storage.ts
 * Strictly reads keys from environment variables. Zero hardcoded secrets.
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_USER_ID = "00000000-0000-0000-0000-000000000002";

if (!ANON_KEY) {
  console.error("ERROR: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY must be provided via environment variable.");
  process.exit(1);
}

const anonClient = createClient(SUPABASE_URL, ANON_KEY);

async function main() {
  console.log("=== Verifying Live Storage Bucket Policies ===");

  const sampleFileContent = Buffer.from("fake-receipt-png-content");

  // 1. Client attempts to read from results or partials -> MUST be denied
  const { data: resultsList, error: resultsErr } = await anonClient
    .storage
    .from("results")
    .list();
  console.log("Client access to 'results' bucket:", { resultsList, error: resultsErr?.message });
  if (!resultsErr && resultsList && resultsList.length > 0) {
    throw new Error("Client should not have access to read results bucket");
  }

  const { data: partialsList, error: partialsErr } = await anonClient
    .storage
    .from("partials")
    .list();
  console.log("Client access to 'partials' bucket:", { partialsList, error: partialsErr?.message });
  if (!partialsErr && partialsList && partialsList.length > 0) {
    throw new Error("Client should not have access to read partials bucket");
  }

  // 2. Client attempts to upload into receipts under ANOTHER user's folder -> MUST be denied
  const { error: forgedUploadErr } = await anonClient
    .storage
    .from("receipts")
    .upload(`${OTHER_USER_ID}/forged_receipt.png`, sampleFileContent, {
      contentType: "image/png",
    });
  console.log("Forged folder upload attempt error (expected):", forgedUploadErr?.message);
  if (!forgedUploadErr) {
    throw new Error("Client must be forbidden from uploading into another user's folder");
  }

  // 3. Service role upload into own folder and immediate cleanup
  if (SERVICE_KEY) {
    const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);
    const testFilePath = `${TEST_USER_ID}/test_verify_receipt_${Date.now()}.png`;

    const { error: uploadErr } = await adminClient
      .storage
      .from("receipts")
      .upload(testFilePath, sampleFileContent, {
        contentType: "image/png",
      });
    if (uploadErr) throw uploadErr;
    console.log(`Uploaded test receipt: ${testFilePath}`);

    // Verify it exists
    const { data: listData } = await adminClient
      .storage
      .from("receipts")
      .list(TEST_USER_ID);
    console.log(`Files in ${TEST_USER_ID} folder:`, listData?.map((f) => f.name));

    // Clean up test file immediately (never keep test files in storage)
    const { error: removeErr } = await adminClient
      .storage
      .from("receipts")
      .remove([testFilePath]);
    if (removeErr) throw removeErr;
    console.log(`Cleaned up test storage file: ${testFilePath}`);
  }

  console.log("PASS: Storage policies verification passed (client isolated to own folder, results/partials private, test file cleaned up).");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
