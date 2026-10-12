/**
 * Live Verification Script: Storage Bucket Policies
 * Usage: tsx scripts/verify/verify-receipt-storage.ts
 * Any service-role test upload is removed in a finally block in the same run.
 */
import { createClient } from "@supabase/supabase-js";
import { newVrunPrefix } from "./vrun";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_USER_ID = "00000000-0000-0000-0000-000000000002";
const RUN_PREFIX = newVrunPrefix();

if (!ANON_KEY) {
  console.error("ERROR: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY must be provided via environment variable.");
  process.exit(1);
}
const anonClient = createClient(SUPABASE_URL, ANON_KEY);

async function main() {
  console.log("=== Verifying Live Storage Bucket Policies ===");
  console.log("Run prefix:", RUN_PREFIX);
  const sampleFileContent = Buffer.from("fake-receipt-png-content");

  const { data: resultsList, error: resultsErr } = await anonClient.storage.from("results").list();
  if (!resultsErr && resultsList && resultsList.length > 0) throw new Error("Client should not have access to read results bucket");

  const { data: partialsList, error: partialsErr } = await anonClient.storage.from("partials").list();
  if (!partialsErr && partialsList && partialsList.length > 0) throw new Error("Client should not have access to read partials bucket");

  const { error: forgedUploadErr } = await anonClient.storage.from("receipts").upload(
    `${OTHER_USER_ID}/${RUN_PREFIX}forged_receipt.png`, sampleFileContent, { contentType: "image/png" },
  );
  if (!forgedUploadErr) throw new Error("Client must be forbidden from uploading into another user's folder");

  if (SERVICE_KEY) {
    const adminClient = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const testFilePath = `${TEST_USER_ID}/${RUN_PREFIX}receipt.png`;
    try {
      const { error: uploadErr } = await adminClient.storage.from("receipts").upload(testFilePath, sampleFileContent, {
        contentType: "image/png",
      });
      if (uploadErr) throw uploadErr;

      const { data: listData, error: listErr } = await adminClient.storage.from("receipts").list(TEST_USER_ID);
      if (listErr) throw listErr;
      console.log(`Files in ${TEST_USER_ID} folder matching this run:`, listData?.filter((file) => file.name.startsWith(RUN_PREFIX)).map((file) => file.name));
    } finally {
      // Attempt removal even if upload/list returned an error after the object was created.
      const { error: removeErr } = await adminClient.storage.from("receipts").remove([testFilePath]);
      if (removeErr) throw removeErr;
    }
  }

  console.log("PASS: Storage policies verified; the service-role test object was removed in the same run.");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
