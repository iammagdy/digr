/**
 * Live Verification Script: Accept-Quote Path against Supabase Project
 * Usage: tsx scripts/verify/verify-accept-quote.ts
 * Fail-closed: no approved RPC creates/accepts a quote and creates its job.
 */
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
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
  console.log("=== Verifying Accept-Quote Flow ===");
  console.log("Run prefix:", RUN_PREFIX);

  const quoteId = `${RUN_PREFIX}quote`;
  const jobId = `${RUN_PREFIX}job`;
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const items = [{ capabilitySlug: "tiktok-profile", targetVolumeMin: 1, targetVolumeMax: 1 }];
  const outputFormats = ["xlsx", "csv"];
  const quoteHash = crypto.createHash("sha256").update(JSON.stringify({ items, outputFormats })).digest("hex");
  const [quoteResult, jobResult] = await Promise.all([
    supabase.from("plans_quotes").select("id, user_id, status, quote_hash").eq("id", quoteId).maybeSingle(),
    supabase.from("jobs").select("id, user_id, status").eq("id", jobId).maybeSingle(),
  ]);
  if (quoteResult.error) throw quoteResult.error;
  if (jobResult.error) throw jobResult.error;

  const missing = [];
  if (!quoteResult.data) {
    missing.push({
      table: "plans_quotes",
      purpose: "accept-quote fixture; no approved RPC creates the quote row",
      row: {
        id: quoteId,
        user_id: TEST_USER_ID,
        quote_hash: quoteHash,
        status: "quoted",
        total_reserved_credits: 3,
        items,
        output_formats: outputFormats,
        expires_at: expiresAt,
      },
    });
  }
  if (!jobResult.data) {
    missing.push({
      table: "jobs",
      purpose: "accepted quote's job fixture; no approved RPC creates this job row",
      row: {
        id: jobId,
        user_id: TEST_USER_ID,
        status: "queued",
        endpoint_id: "tiktok-profile",
        target_volume_min: 1,
        target_volume_max: 1,
        reserved_credits: 3,
        charged_credits: 0,
        delivered_units: 0,
      },
    });
  }
  if (missing.length) requireSetupRows(missing);

  throw new Error(
    "BLOCKED: fixture rows exist, but there is no approved RPC for atomic quote acceptance/job creation. " +
    "No reserve RPC or table mutation was attempted; wait for owner direction.",
  );
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
