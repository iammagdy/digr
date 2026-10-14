# Diger read-only review packet

Prepared at the owner's request. All SQL below is a proposal only: it has not been applied or executed. The Git patch in the last section is the complete committed diff from `7ba671add916c738bd1f21aff255ff4c09de699d`; it is included verbatim from the saved diff.

## Part 1 — Proposed `claim_job_chunk` NULL guard and `release_job_atomic` overload

```sql
-- PROPOSED ONLY — not applied, executed, or committed as a migration.
-- Existing public.release_job_atomic(TEXT, TEXT) remains unchanged.

CREATE OR REPLACE FUNCTION public.claim_job_chunk(
  p_job_id TEXT,
  p_expected_step INT,
  p_lease_seconds INT DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job RECORD;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
  IF p_expected_step IS NULL THEN
    RAISE EXCEPTION 'p_expected_step must not be NULL';
  END IF;

  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'error', 'job_not_found', 'job_id', p_job_id);
  END IF;

  IF v_job.status NOT IN ('queued', 'running') THEN
    RETURN jsonb_build_object('claimed', false, 'error', 'invalid_status', 'status', v_job.status, 'job_id', p_job_id);
  END IF;

  IF v_job.next_attempt_at > v_now THEN
    RETURN jsonb_build_object('claimed', false, 'error', 'backoff_active', 'next_attempt_at', v_job.next_attempt_at, 'job_id', p_job_id);
  END IF;

  IF v_job.step != p_expected_step THEN
    RETURN jsonb_build_object('claimed', false, 'error', 'step_mismatch', 'current_step', v_job.step, 'expected_step', p_expected_step, 'job_id', p_job_id);
  END IF;

  IF v_job.lease_until IS NOT NULL AND v_job.lease_until > v_now THEN
    RETURN jsonb_build_object('claimed', false, 'error', 'lease_active', 'lease_until', v_job.lease_until, 'job_id', p_job_id);
  END IF;

  UPDATE public.jobs
  SET status = 'running',
      lease_until = (v_now + (p_lease_seconds || ' seconds')::INTERVAL),
      updated_at = v_now
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'claimed', true,
    'job_id', p_job_id,
    'user_id', v_job.user_id,
    'step', v_job.step,
    'current_cursor', v_job.current_cursor,
    'delivered_units', v_job.delivered_units,
    'endpoint_id', v_job.endpoint_id,
    'unit_price', v_job.unit_price,
    'target_volume_min', v_job.target_volume_min,
    'target_volume_max', v_job.target_volume_max,
    'reserved_credits', v_job.reserved_credits,
    'attempt_count', COALESCE(v_job.attempt_count, 0),
    'lease_until', (v_now + (p_lease_seconds || ' seconds')::INTERVAL)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_job_atomic(
  p_job_id TEXT,
  p_error_message TEXT,
  p_force BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job RECORD;
  v_res_exists BOOLEAN;
  v_rel_exists BOOLEAN;
BEGIN
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % not found', p_job_id;
  END IF;

  IF v_job.status = 'completed' THEN
    RAISE EXCEPTION 'Cannot release already completed job %', p_job_id;
  END IF;

  -- A failed row is idempotent only after both required ledger records exist.
  -- If rel_ is absent, the function continues and completes the release.
  IF v_job.status NOT IN ('queued', 'running', 'failed') THEN
    RAISE EXCEPTION 'Cannot release job % with status % (must be queued/running, or failed recovery)',
      p_job_id, v_job.status;
  END IF;

  IF v_job.reserved_credits IS NULL OR v_job.reserved_credits <= 0 THEN
    RAISE EXCEPTION 'Job % has invalid reserved_credits', p_job_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.credit_ledger WHERE id = ('res_' || p_job_id)
  ) INTO v_res_exists;

  IF NOT v_res_exists THEN
    RAISE EXCEPTION 'Reserve record res_% does not exist for job %', p_job_id, p_job_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.credit_ledger WHERE id = ('rel_' || p_job_id)
  ) INTO v_rel_exists;

  IF v_job.status = 'failed' AND v_rel_exists THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_released', true,
      'job_id', p_job_id,
      'released_credits', v_job.reserved_credits
    );
  END IF;

  IF v_job.lease_until IS NOT NULL
     AND v_job.lease_until > timezone('utc'::text, now())
     AND NOT COALESCE(p_force, false) THEN
    RAISE EXCEPTION 'Cannot release job % while active chunk lease is held until %',
      p_job_id, v_job.lease_until;
  END IF;

  IF NOT v_rel_exists THEN
    INSERT INTO public.credit_ledger (
      id, user_id, delta, type, job_id, note, created_at
    )
    VALUES (
      'rel_' || p_job_id,
      v_job.user_id,
      v_job.reserved_credits,
      'release',
      p_job_id,
      'إرجاع الحجز بالكامل عند تعثر المهمة',
      timezone('utc'::text, now())
    );
  END IF;

  UPDATE public.jobs
  SET status = 'failed',
      charged_credits = 0,
      error_message = COALESCE(p_error_message, error_message, 'فشلت المهمة'),
      lease_until = NULL,
      updated_at = timezone('utc'::text, now())
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'success', true,
    'already_released', false,
    'job_id', p_job_id,
    'user_id', v_job.user_id,
    'released_credits', v_job.reserved_credits
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT, BOOLEAN)
  TO service_role;

-- record_chunk_failure remains unchanged and calls the two-argument function:
-- PERFORM public.release_job_atomic(p_job_id, p_error_message);
```

## Part 2 — Proposed test fixture function; PostgREST overload answer

This helper is a proposal only. It creates only rows in `jobs`, `plans_quotes`, or `topups`, only for the dedicated test user, and only when IDs and top-up references use a generated `vrun_<13-digit-millis>_<UUIDv4>_` prefix. It never writes `credit_ledger`. The caller must still create a job's reserve only through `reserve_credits_atomic`.

```sql
-- PROPOSED ONLY — do not apply or execute. This helper never writes credit_ledger.
CREATE OR REPLACE FUNCTION public.create_verify_fixture(
  p_prefix TEXT,
  p_suffix TEXT,
  p_fixture_type TEXT,
  p_data JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_test_user UUID := '00000000-0000-0000-0000-000000000001';
  v_id TEXT;
  v_status TEXT;
  v_amount NUMERIC;
  v_unit_price NUMERIC;
BEGIN
  IF p_prefix IS NULL OR p_prefix !~ '^vrun_[0-9]{13}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_$' THEN
    RAISE EXCEPTION 'p_prefix must be a generated vrun_<millis>_<uuid>_ prefix';
  END IF;
  IF p_suffix IS NULL OR p_suffix !~ '^[a-z0-9_]{1,40}$' THEN
    RAISE EXCEPTION 'p_suffix must contain only lowercase letters, digits, and underscores';
  END IF;
  IF p_fixture_type IS NULL OR p_fixture_type NOT IN ('job', 'quote', 'topup') THEN
    RAISE EXCEPTION 'p_fixture_type must be job, quote, or topup';
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'p_data must be a JSON object';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_test_user) THEN
    RAISE EXCEPTION 'Dedicated verification profile does not exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_data) AS supplied(key)
    WHERE NOT (
      (p_fixture_type = 'job' AND key IN (
        'status', 'endpoint_id', 'step', 'attempt_count', 'unit_price',
        'reserved_credits', 'delivered_units', 'current_cursor',
        'target_volume_min', 'target_volume_max', 'lease_until',
        'next_attempt_at', 'charged_credits', 'error_message'
      ))
      OR (p_fixture_type = 'quote' AND key IN (
        'quote_hash', 'status', 'items', 'total_reserved_credits',
        'output_formats', 'expires_at'
      ))
      OR (p_fixture_type = 'topup' AND key IN (
        'amount_egp', 'reference', 'sender_name', 'sender_phone', 'receipt_file_id'
      ))
    )
  ) THEN
    RAISE EXCEPTION 'p_data contains a field not allowed for this fixture type';
  END IF;

  v_id := p_prefix || p_suffix;

  IF p_fixture_type = 'job' THEN
    v_status := p_data ->> 'status';
    IF v_status IS NULL OR v_status NOT IN ('queued', 'running', 'completed', 'failed', 'refused') THEN
      RAISE EXCEPTION 'job status is missing or invalid';
    END IF;
    IF NOT (p_data ? 'reserved_credits') OR p_data -> 'reserved_credits' = 'null'::jsonb THEN
      RAISE EXCEPTION 'job reserved_credits is required';
    END IF;
    v_amount := (p_data ->> 'reserved_credits')::NUMERIC;
    IF v_amount < 0 THEN
      RAISE EXCEPTION 'job reserved_credits cannot be negative';
    END IF;
    IF p_data ? 'unit_price' AND p_data -> 'unit_price' <> 'null'::jsonb THEN
      v_unit_price := (p_data ->> 'unit_price')::NUMERIC;
      IF v_unit_price <= 0 THEN
        RAISE EXCEPTION 'job unit_price must be positive or NULL';
      END IF;
    ELSE
      v_unit_price := NULL;
    END IF;

    INSERT INTO public.jobs (
      id, user_id, status, endpoint_id, step, attempt_count, unit_price,
      reserved_credits, delivered_units, current_cursor, target_volume_min,
      target_volume_max, lease_until, next_attempt_at, charged_credits, error_message
    ) VALUES (
      v_id, v_test_user, v_status,
      COALESCE(p_data ->> 'endpoint_id', 'tiktok-profile'),
      COALESCE((p_data ->> 'step')::INT, 0),
      COALESCE((p_data ->> 'attempt_count')::INT, 0),
      v_unit_price, v_amount,
      COALESCE((p_data ->> 'delivered_units')::INT, 0),
      p_data ->> 'current_cursor',
      (p_data ->> 'target_volume_min')::INT,
      (p_data ->> 'target_volume_max')::INT,
      (p_data ->> 'lease_until')::TIMESTAMPTZ,
      COALESCE((p_data ->> 'next_attempt_at')::TIMESTAMPTZ, timezone('utc'::text, now())),
      COALESCE((p_data ->> 'charged_credits')::NUMERIC, 0),
      p_data ->> 'error_message'
    );

  ELSIF p_fixture_type = 'quote' THEN
    IF COALESCE(p_data ->> 'status', 'quoted') <> 'quoted'
       OR COALESCE(p_data ->> 'quote_hash', '') !~ '^[0-9a-f]{64}$'
       OR COALESCE(jsonb_typeof(p_data -> 'items'), '') <> 'array'
       OR COALESCE((p_data ->> 'total_reserved_credits')::NUMERIC, 0) <= 0
       OR p_data ->> 'expires_at' IS NULL
       OR (p_data ->> 'expires_at')::TIMESTAMPTZ <= timezone('utc'::text, now()) THEN
      RAISE EXCEPTION 'quote fixture must be a valid, unexpired quoted row';
    END IF;
    IF p_data ? 'output_formats' AND jsonb_typeof(p_data -> 'output_formats') NOT IN ('array', 'null') THEN
      RAISE EXCEPTION 'quote output_formats must be an array or NULL';
    END IF;

    INSERT INTO public.plans_quotes (
      id, user_id, quote_hash, status, items, total_reserved_credits,
      output_formats, expires_at
    ) VALUES (
      v_id, v_test_user, p_data ->> 'quote_hash', 'quoted', p_data -> 'items',
      (p_data ->> 'total_reserved_credits')::NUMERIC,
      p_data -> 'output_formats', (p_data ->> 'expires_at')::TIMESTAMPTZ
    );

  ELSE
    IF COALESCE((p_data ->> 'amount_egp')::NUMERIC, 0) <= 0
       OR p_data ->> 'reference' IS NULL
       OR left(p_data ->> 'reference', length(p_prefix)) <> p_prefix
       OR p_data ->> 'sender_name' IS NULL
       OR p_data ->> 'sender_phone' IS NULL
       OR p_data ->> 'receipt_file_id' IS NULL
       OR left(p_data ->> 'receipt_file_id', length(p_prefix)) <> p_prefix THEN
      RAISE EXCEPTION 'topup fixture requires a positive amount and vrun-prefixed reference/receipt id';
    END IF;

    INSERT INTO public.topups (
      id, user_id, amount_egp, reference, sender_name, sender_phone,
      receipt_file_id, status
    ) VALUES (
      v_id, v_test_user, (p_data ->> 'amount_egp')::NUMERIC,
      p_data ->> 'reference', p_data ->> 'sender_name',
      p_data ->> 'sender_phone', p_data ->> 'receipt_file_id', 'pending'
    );
  END IF;

  RETURN jsonb_build_object('fixture_type', p_fixture_type, 'id', v_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_verify_fixture(TEXT, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_verify_fixture(TEXT, TEXT, TEXT, JSONB)
  TO service_role;

-- Example only; not executed. First create a job fixture, then reserve exclusively with the approved RPC.
-- SELECT public.create_verify_fixture(
--   p_prefix := '<one generated vrun_<millis>_<uuid>_ prefix>',
--   p_suffix := 'settle',
--   p_fixture_type := 'job',
--   p_data := '{"status":"running","unit_price":2,"delivered_units":8,"reserved_credits":25,"target_volume_min":10,"target_volume_max":20}'::jsonb
-- );
-- SELECT public.reserve_credits_atomic(
--   p_user_id := '00000000-0000-0000-0000-000000000001'::uuid,
--   p_job_id := '<same prefix>settle',
--   p_amount := 25,
--   p_note := 'Approved test verification reservation'
-- );
-- Quote/topup fixtures use p_fixture_type := 'quote'/'topup'; neither creates ledger rows.
```

PostgREST ambiguity check: no ambiguity is expected for this overload. The official documentation section “Overloaded functions” says overloaded RPC functions with different numbers of arguments can be called separately: https://docs.postgrest.org/en/v14/references/api/functions.html. Because the new `p_force` parameter is required and has no default, a JSON RPC call with only `p_job_id` and `p_error_message` has two matching arguments and resolves to the existing two-argument function. A call with all three named arguments matches the new overload. `record_chunk_failure` remains unchanged and uses the two-argument call. I checked the official docs; I did not run a live catalog query or any SQL.

Reserve sequence: call `create_verify_fixture(..., 'job', ...)` only to create the matching test job row. Then call `reserve_credits_atomic(p_user_id, p_job_id, p_amount, p_note)` through the service role to create its `res_<jobId>` ledger entry. No script or helper inserts ledger rows directly.

## Part 3 — Complete committed diff

The following is the complete unified diff for `docs/OWNER_SQL.md` and every changed file in `scripts/verify/` from commit `7ba671add916c738bd1f21aff255ff4c09de699d`.

diff --git a/docs/OWNER_SQL.md b/docs/OWNER_SQL.md
index 4cc8694..9c519ce 100644
--- a/docs/OWNER_SQL.md
+++ b/docs/OWNER_SQL.md
@@ -19,7 +19,7 @@ SELECT id, user_id, delta, type, created_at
 FROM public.credit_ledger
 WHERE user_id != '00000000-0000-0000-0000-000000000001'::uuid;
 
--- Summary check: Count test rows (should be exactly 14 test rows)
+-- Summary check: Reconcile the test-only total, including the known 24 compensating rows noted below
 SELECT 
   count(*) AS total_rows,
   count(*) FILTER (WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid) AS test_user_rows
@@ -28,6 +28,9 @@ FROM public.credit_ledger;
 
 If `total_rows` equals `test_user_rows` and the first query returns 0 rows, it is safe to proceed with the pre-cutover reset.
 
+> [!NOTE]
+> The known test-only residue is limited to the dedicated test user: **24 compensating ledger rows** and **71 orphan ledger references**. Do not edit or delete these ledger records manually. They are to be removed only by the documented pre-launch reset above, after its pre-check passes. This note is not authorization to run the reset, and it must never be run after launch.
+
 ### Step 2: Clean Reset Execution
 ```sql
 -- 1. Temporarily disable ledger immutability triggers
@@ -95,4 +98,3 @@ Verification query:
 ```sql
 SELECT key, value FROM public.settings_public WHERE key = 'pricing';
 ```
-
diff --git a/scripts/verify/verify-accept-quote.ts b/scripts/verify/verify-accept-quote.ts
index 7700f5b..4309bcb 100644
--- a/scripts/verify/verify-accept-quote.ts
+++ b/scripts/verify/verify-accept-quote.ts
@@ -1,14 +1,16 @@
 /**
  * Live Verification Script: Accept-Quote Path against Supabase Project
  * Usage: tsx scripts/verify/verify-accept-quote.ts
- * Strictly reads keys from environment variables. Zero hardcoded secrets.
+ * Fail-closed: no approved RPC creates/accepts a quote and creates its job.
  */
 import { createClient } from "@supabase/supabase-js";
-import crypto from "crypto";
+import crypto from "node:crypto";
+import { newVrunPrefix, requireSetupRows } from "./vrun";
 
 const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
 const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
 const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
+const RUN_PREFIX = newVrunPrefix();
 
 if (!SERVICE_KEY) {
   console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
@@ -20,108 +22,62 @@ const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
 });
 
 async function main() {
-  console.log("=== Verifying Live Accept-Quote Flow on Supabase ===");
-
-  // 1. Check initial test user balance
-  const { data: initialLedger, error: ledgerErr } = await supabase
-    .from("credit_ledger")
-    .select("delta")
-    .eq("user_id", TEST_USER_ID);
-
-  if (ledgerErr) throw ledgerErr;
-  const initialBal = (initialLedger || []).reduce((sum, r) => sum + Number(r.delta), 0);
-  console.log(`Initial balance: ${initialBal} points (ledger rows: ${initialLedger?.length})`);
-
-  const quoteId = `quote_live_${Date.now()}`;
-  const jobId = `job_live_${Date.now()}`;
-  const testCredits = 3;
+  console.log("=== Verifying Accept-Quote Flow ===");
+  console.log("Run prefix:", RUN_PREFIX);
 
+  const quoteId = `${RUN_PREFIX}quote`;
+  const jobId = `${RUN_PREFIX}job`;
+  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
   const items = [{ capabilitySlug: "tiktok-profile", targetVolumeMin: 1, targetVolumeMax: 1 }];
   const outputFormats = ["xlsx", "csv"];
   const quoteHash = crypto.createHash("sha256").update(JSON.stringify({ items, outputFormats })).digest("hex");
-
-  // 2. Insert test quote
-  const { error: quoteErr } = await supabase.from("plans_quotes").insert({
-    id: quoteId,
-    user_id: TEST_USER_ID,
-    quote_hash: quoteHash,
-    status: "quoted",
-    total_reserved_credits: testCredits,
-    items,
-    output_formats: outputFormats,
-    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
-    created_at: new Date().toISOString(),
-  });
-  if (quoteErr) throw quoteErr;
-  console.log(`Created test quote: ${quoteId}`);
-
-  // 3. Call atomic reserve RPC
-  const { data: rpcRes, error: rpcErr } = await supabase.rpc("reserve_credits_atomic", {
-    p_user_id: TEST_USER_ID,
-    p_job_id: jobId,
-    p_amount: testCredits,
-    p_note: "Live verification of accept-quote",
-  });
-  if (rpcErr) throw rpcErr;
-  console.log("reserve_credits_atomic result:", rpcRes);
-
-  if (!rpcRes.success || rpcRes.already_reserved) {
-    throw new Error("Failed to reserve credits");
+  const [quoteResult, jobResult] = await Promise.all([
+    supabase.from("plans_quotes").select("id, user_id, status, quote_hash").eq("id", quoteId).maybeSingle(),
+    supabase.from("jobs").select("id, user_id, status").eq("id", jobId).maybeSingle(),
+  ]);
+  if (quoteResult.error) throw quoteResult.error;
+  if (jobResult.error) throw jobResult.error;
+
+  const missing = [];
+  if (!quoteResult.data) {
+    missing.push({
+      table: "plans_quotes",
+      purpose: "accept-quote fixture; no approved RPC creates the quote row",
+      row: {
+        id: quoteId,
+        user_id: TEST_USER_ID,
+        quote_hash: quoteHash,
+        status: "quoted",
+        total_reserved_credits: 3,
+        items,
+        output_formats: outputFormats,
+        expires_at: expiresAt,
+      },
+    });
   }
-
-  // 4. Update quote and create job
-  await supabase.from("plans_quotes").update({ status: "accepted" }).eq("id", quoteId);
-  await supabase.from("jobs").insert({
-    id: jobId,
-    user_id: TEST_USER_ID,
-    status: "queued",
-    endpoint_id: "tiktok-profile",
-    target_volume_min: 1,
-    target_volume_max: 1,
-    reserved_credits: testCredits,
-    charged_credits: 0,
-    delivered_units: 0,
-    created_at: new Date().toISOString(),
-    updated_at: new Date().toISOString(),
-  });
-
-  // 5. Test idempotent reserve retry -> must return already_reserved
-  const { data: retryRes } = await supabase.rpc("reserve_credits_atomic", {
-    p_user_id: TEST_USER_ID,
-    p_job_id: jobId,
-    p_amount: testCredits,
-    p_note: "Idempotent retry test",
-  });
-  console.log("Idempotent retry result:", retryRes);
-  if (!retryRes.already_reserved) {
-    throw new Error("Expected already_reserved to be true");
-  }
-
-  // 6. Release reservation to restore balance
-  const { error: relErr } = await supabase.from("credit_ledger").insert({
-    id: `rel_${jobId}`,
-    user_id: TEST_USER_ID,
-    delta: testCredits,
-    type: "release",
-    job_id: jobId,
-    note: "Release verification test cleanup",
-  });
-  if (relErr) throw relErr;
-  console.log(`Released ${testCredits} credits via rel_${jobId}`);
-
-  // 7. Verify balance restored
-  const { data: finalLedger } = await supabase
-    .from("credit_ledger")
-    .select("delta")
-    .eq("user_id", TEST_USER_ID);
-  const finalBal = (finalLedger || []).reduce((sum, r) => sum + Number(r.delta), 0);
-  console.log(`Final restored balance: ${finalBal} points`);
-
-  if (finalBal !== initialBal) {
-    throw new Error(`Balance mismatch: expected ${initialBal}, got ${finalBal}`);
+  if (!jobResult.data) {
+    missing.push({
+      table: "jobs",
+      purpose: "accepted quote's job fixture; no approved RPC creates this job row",
+      row: {
+        id: jobId,
+        user_id: TEST_USER_ID,
+        status: "queued",
+        endpoint_id: "tiktok-profile",
+        target_volume_min: 1,
+        target_volume_max: 1,
+        reserved_credits: 3,
+        charged_credits: 0,
+        delivered_units: 0,
+      },
+    });
   }
+  if (missing.length) requireSetupRows(missing);
 
-  console.log("PASS: Live accept-quote verification passed.");
+  throw new Error(
+    "BLOCKED: fixture rows exist, but there is no approved RPC for atomic quote acceptance/job creation. " +
+    "No reserve RPC or table mutation was attempted; wait for owner direction.",
+  );
 }
 
 main().catch((err) => {
diff --git a/scripts/verify/verify-chunk-claim.ts b/scripts/verify/verify-chunk-claim.ts
index 4cda454..37d6f1c 100644
--- a/scripts/verify/verify-chunk-claim.ts
+++ b/scripts/verify/verify-chunk-claim.ts
@@ -1,13 +1,15 @@
 /**
  * Live Verification Script: Chunk Claiming Concurrency
  * Usage: tsx scripts/verify/verify-chunk-claim.ts
- * Strictly reads keys from environment variables. Zero hardcoded secrets.
+ * Uses service-role RPCs only; never writes protected table rows directly.
  */
 import { createClient } from "@supabase/supabase-js";
+import { newVrunPrefix, requireSetupRows } from "./vrun";
 
 const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
 const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
 const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
+const RUN_PREFIX = newVrunPrefix();
 
 if (!SERVICE_KEY) {
   console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
@@ -20,27 +22,45 @@ const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
 
 async function main() {
   console.log("=== Verifying Chunk Claim Concurrency ===");
+  console.log("Run prefix:", RUN_PREFIX);
 
-  const jobId = `job_test_claim_${Date.now()}`;
+  const jobId = `${RUN_PREFIX}claim_parallel`;
+  const { data: fixture, error: fixtureErr } = await supabase
+    .from("jobs")
+    .select("id, user_id, status, step, attempt_count, lease_until, next_attempt_at")
+    .eq("id", jobId)
+    .maybeSingle();
+  if (fixtureErr) throw fixtureErr;
 
-  // 1. Prepare queued job ready for step 0
-  const { error: jobErr } = await supabase.from("jobs").insert({
-    id: jobId,
-    user_id: TEST_USER_ID,
-    status: "queued",
-    endpoint_id: "tiktok-profile",
-    step: 0,
-    attempt_count: 0,
-    unit_price: 1,
-    reserved_credits: 10,
-    target_volume_min: 5,
-    target_volume_max: 10,
-    next_attempt_at: new Date().toISOString(),
-    lease_until: null,
-  });
-  if (jobErr) throw jobErr;
+  if (!fixture) {
+    requireSetupRows([{
+      table: "jobs",
+      purpose: "two parallel claim_job_chunk calls",
+      row: {
+        id: jobId,
+        user_id: TEST_USER_ID,
+        status: "queued",
+        endpoint_id: "tiktok-profile",
+        step: 0,
+        attempt_count: 0,
+        unit_price: 1,
+        reserved_credits: 10,
+        target_volume_min: 5,
+        target_volume_max: 10,
+        next_attempt_at: new Date().toISOString(),
+        lease_until: null,
+      },
+    }]);
+  }
+
+  if (fixture.user_id !== TEST_USER_ID || fixture.status !== "queued" || fixture.step !== 0) {
+    throw new Error(`Fixture must be the test user's queued step-0 job: ${JSON.stringify(fixture)}`);
+  }
+  if ((fixture.lease_until && new Date(fixture.lease_until).getTime() > Date.now()) ||
+      (fixture.next_attempt_at && new Date(fixture.next_attempt_at).getTime() > Date.now())) {
+    throw new Error(`Claim fixture must not have an active lease or future backoff: ${JSON.stringify(fixture)}`);
+  }
 
-  // 2. Launch 2 parallel claim calls for step 0
   const [claim1, claim2] = await Promise.all([
     supabase.rpc("claim_job_chunk", {
       p_job_id: jobId,
@@ -53,26 +73,38 @@ async function main() {
       p_lease_seconds: 60,
     }),
   ]);
+  if (claim1.error) throw claim1.error;
+  if (claim2.error) throw claim2.error;
 
-  console.log("Claim 1 result:", claim1.data);
-  console.log("Claim 2 result:", claim2.data);
-
-  const wins = [claim1.data, claim2.data].filter((c) => c?.claimed === true);
-  const losses = [claim1.data, claim2.data].filter((c) => c?.claimed === false && c?.error === "lease_active");
-
+  const wins = [claim1.data, claim2.data].filter((claim) => claim?.claimed === true);
+  const losses = [claim1.data, claim2.data].filter(
+    (claim) => claim?.claimed === false && claim?.error === "lease_active",
+  );
   if (wins.length !== 1 || losses.length !== 1) {
-    throw new Error(`Expected exactly 1 claim winner and 1 lease_active rejection, got wins=${wins.length}, losses=${losses.length}`);
+    throw new Error(`Expected one claim winner and one lease_active rejection, got wins=${wins.length}, losses=${losses.length}`);
   }
 
-  // 3. Verify attempt_count was NOT incremented on claim
-  const { data: jobRow } = await supabase.from("jobs").select("attempt_count, status").eq("id", jobId).single();
-  console.log("Job status after claim:", jobRow);
+  const { data: nullStepResult, error: nullStepErr } = await supabase.rpc("claim_job_chunk", {
+    p_job_id: `${RUN_PREFIX}null_step_probe`,
+    p_expected_step: null,
+    p_lease_seconds: 60,
+  });
+  console.log("NULL expected-step error (expected):", nullStepErr?.message);
+  if (!nullStepErr || !nullStepErr.message.includes("p_expected_step must not be NULL")) {
+    throw new Error(`Expected claim_job_chunk to raise for NULL p_expected_step; result=${JSON.stringify(nullStepResult)}, error=${nullStepErr?.message}`);
+  }
 
+  const { data: jobRow, error: jobErr } = await supabase
+    .from("jobs")
+    .select("attempt_count, status")
+    .eq("id", jobId)
+    .single();
+  if (jobErr) throw jobErr;
   if (jobRow?.attempt_count !== 0 || jobRow?.status !== "running") {
-    throw new Error(`attempt_count should remain 0 on claim, status should be running: ${JSON.stringify(jobRow)}`);
+    throw new Error(`attempt_count should remain 0 and status should be running: ${JSON.stringify(jobRow)}`);
   }
 
-  console.log("PASS: Chunk claim verification passed (exactly one winner, lease respected, attempt_count unincremented).");
+  console.log("PASS: Chunk claim verification passed (one winner, lease respected, NULL step raises, attempt_count unchanged).");
 }
 
 main().catch((err) => {
diff --git a/scripts/verify/verify-chunk-lifecycle.ts b/scripts/verify/verify-chunk-lifecycle.ts
index b2fee32..aa0f309 100644
--- a/scripts/verify/verify-chunk-lifecycle.ts
+++ b/scripts/verify/verify-chunk-lifecycle.ts
@@ -1,13 +1,16 @@
 /**
  * Live Verification Script: Chunk Lifecycle (complete_chunk & record_chunk_failure)
  * Usage: tsx scripts/verify/verify-chunk-lifecycle.ts
- * Strictly reads keys from environment variables. Zero hardcoded secrets.
+ * Uses service-role RPCs only; never writes protected table rows directly.
  */
 import { createClient } from "@supabase/supabase-js";
+import { newVrunPrefix, requireSetupRows } from "./vrun";
 
 const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
 const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
 const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
+const RUN_PREFIX = newVrunPrefix();
+const RESERVED_CREDITS = 20;
 
 if (!SERVICE_KEY) {
   console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
@@ -20,129 +23,145 @@ const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
 
 async function main() {
   console.log("=== Verifying Chunk Lifecycle (complete_chunk & record_chunk_failure) ===");
+  console.log("Run prefix:", RUN_PREFIX);
+
+  const jobId = `${RUN_PREFIX}lifecycle`;
+  const completedJobId = `${RUN_PREFIX}completed_guard`;
+  const [jobResult, completedResult] = await Promise.all([
+    supabase.from("jobs").select("id, user_id, status, step, reserved_credits").eq("id", jobId).maybeSingle(),
+    supabase.from("jobs").select("id, user_id, status, attempt_count").eq("id", completedJobId).maybeSingle(),
+  ]);
+  if (jobResult.error) throw jobResult.error;
+  if (completedResult.error) throw completedResult.error;
+
+  const missing = [];
+  if (!jobResult.data) {
+    missing.push({
+      table: "jobs",
+      purpose: "complete_chunk retry followed by five record_chunk_failure calls",
+      row: {
+        id: jobId,
+        user_id: TEST_USER_ID,
+        status: "running",
+        endpoint_id: "tiktok-profile",
+        step: 0,
+        attempt_count: 0,
+        unit_price: 1,
+        reserved_credits: RESERVED_CREDITS,
+        target_volume_min: 10,
+        target_volume_max: 20,
+        delivered_units: 0,
+        lease_until: null,
+      },
+    });
+  }
+  if (!completedResult.data) {
+    missing.push({
+      table: "jobs",
+      purpose: "record_chunk_failure completed-job no-change guard",
+      row: {
+        id: completedJobId,
+        user_id: TEST_USER_ID,
+        status: "completed",
+        endpoint_id: "tiktok-profile",
+        step: 2,
+        attempt_count: 0,
+        unit_price: 1,
+        reserved_credits: 10,
+        charged_credits: 5,
+        delivered_units: 5,
+        lease_until: null,
+      },
+    });
+  }
+  if (missing.length) requireSetupRows(missing);
 
-  const jobId = `job_test_lifecycle_${Date.now()}`;
-  const reservedCredits = 20;
-
-  // 1. Prepare reservation in ledger
-  await supabase.from("credit_ledger").insert({
-    id: `res_${jobId}`,
-    user_id: TEST_USER_ID,
-    delta: -reservedCredits,
-    type: "reserve",
-    job_id: jobId,
-    note: "Lifecycle test hold",
-  });
-
-  // 2. Prepare running job at step 0 with active lease
-  await supabase.from("jobs").insert({
-    id: jobId,
-    user_id: TEST_USER_ID,
-    status: "running",
-    endpoint_id: "tiktok-profile",
-    step: 0,
-    attempt_count: 0,
-    unit_price: 1,
-    reserved_credits: reservedCredits,
-    target_volume_min: 10,
-    target_volume_max: 20,
-    delivered_units: 0,
-    lease_until: new Date(Date.now() + 60_000).toISOString(),
-  });
+  const job = jobResult.data!;
+  const completedJob = completedResult.data!;
+  if (job.user_id !== TEST_USER_ID || job.status !== "running" || job.step !== 0 || Number(job.reserved_credits) !== RESERVED_CREDITS) {
+    throw new Error(`Lifecycle fixture does not match the required running step-0 job: ${JSON.stringify(job)}`);
+  }
+  if (completedJob.user_id !== TEST_USER_ID || completedJob.status !== "completed" || completedJob.attempt_count !== 0) {
+    throw new Error(`Completed-job fixture does not match the required test row: ${JSON.stringify(completedJob)}`);
+  }
 
-  // 3. Complete chunk step 0
-  const { data: comp1, error: compErr1 } = await supabase.rpc("complete_chunk", {
+  const { data: reserveResult, error: reserveErr } = await supabase.rpc("reserve_credits_atomic", {
+    p_user_id: TEST_USER_ID,
     p_job_id: jobId,
-    p_expected_step: 0,
-    p_new_cursor: "cursor_step_1",
-    p_new_delivered_units: 5,
-    p_cost_usd: 0.05,
+    p_amount: RESERVED_CREDITS,
+    p_note: "Approved RPC setup for chunk lifecycle verification",
   });
-  if (compErr1) throw compErr1;
-  console.log("complete_chunk step 0 result:", comp1);
-
-  if (!comp1.success || comp1.step !== 1 || comp1.already_completed) {
-    throw new Error(`Unexpected complete_chunk result: ${JSON.stringify(comp1)}`);
-  }
+  if (reserveErr) throw reserveErr;
+  if (!reserveResult?.success) throw new Error(`Could not reserve through approved RPC: ${JSON.stringify(reserveResult)}`);
 
-  // 4. Duplicate complete_chunk step 0 (retried chunk) must be idempotent
-  const { data: compDup, error: compDupErr } = await supabase.rpc("complete_chunk", {
+  const completeArgs = {
     p_job_id: jobId,
     p_expected_step: 0,
     p_new_cursor: "cursor_step_1",
     p_new_delivered_units: 5,
     p_cost_usd: 0.05,
-  });
-  if (compDupErr) throw compDupErr;
-  console.log("complete_chunk duplicate retry result:", compDup);
+  };
+  const { data: firstComplete, error: firstCompleteErr } = await supabase.rpc("complete_chunk", completeArgs);
+  if (firstCompleteErr) throw firstCompleteErr;
+  if (!firstComplete.success || firstComplete.step !== 1 || firstComplete.already_completed) {
+    throw new Error(`Unexpected first complete_chunk result: ${JSON.stringify(firstComplete)}`);
+  }
 
-  if (!compDup.success || !compDup.already_completed) {
-    throw new Error(`Expected already_completed: true on duplicate step completion: ${JSON.stringify(compDup)}`);
+  const { data: completeRetry, error: completeRetryErr } = await supabase.rpc("complete_chunk", completeArgs);
+  if (completeRetryErr) throw completeRetryErr;
+  if (!completeRetry.success || !completeRetry.already_completed) {
+    throw new Error(`Expected complete_chunk retry to return already_completed: ${JSON.stringify(completeRetry)}`);
   }
 
-  // 5. Test record_chunk_failure and backoff
-  for (let i = 1; i <= 5; i++) {
-    const { data: failRes, error: failErr } = await supabase.rpc("record_chunk_failure", {
+  for (let attempt = 1; attempt <= 5; attempt++) {
+    const { data: failureResult, error: failureErr } = await supabase.rpc("record_chunk_failure", {
       p_job_id: jobId,
-      p_error_message: `Failure attempt ${i}`,
+      p_error_message: `Verification failure attempt ${attempt}`,
     });
-    if (failErr) throw failErr;
-    console.log(`record_chunk_failure attempt ${i}:`, failRes);
-
-    if (i < 5) {
-      if (failRes.failed_permanently || failRes.attempt_count !== i) {
-        throw new Error(`Expected transient failure on attempt ${i}`);
-      }
-    } else {
-      // 5th attempt must mark permanently failed and release hold
-      if (!failRes.failed_permanently || !failRes.released) {
-        throw new Error(`Expected permanent failure and release on attempt 5`);
-      }
+    if (failureErr) throw failureErr;
+    if (attempt < 5 && (failureResult.failed_permanently || failureResult.attempt_count !== attempt)) {
+      throw new Error(`Expected transient failure on attempt ${attempt}: ${JSON.stringify(failureResult)}`);
+    }
+    if (attempt === 5 && (!failureResult.failed_permanently || !failureResult.released)) {
+      throw new Error(`Expected permanent failure and release on attempt 5: ${JSON.stringify(failureResult)}`);
     }
   }
 
-  // 6. Verify job status is failed and rel_ exists in ledger
-  const { data: finalJob } = await supabase.from("jobs").select("status").eq("id", jobId).single();
-  const { data: relRow } = await supabase.from("credit_ledger").select("id").eq("id", `rel_${jobId}`).single();
-
-  if (finalJob?.status !== "failed" || !relRow) {
-    throw new Error(`Job must be failed and rel_ must exist in ledger`);
-  }
-
-  // 7. Explicit Check: record_chunk_failure on a COMPLETED job changes nothing
-  const completedJobId = `job_test_completed_${Date.now()}`;
-  await supabase.from("jobs").insert({
-    id: completedJobId,
-    user_id: TEST_USER_ID,
-    status: "completed",
-    endpoint_id: "tiktok-profile",
-    step: 2,
-    attempt_count: 0,
-    unit_price: 1,
-    reserved_credits: 10,
-    charged_credits: 5,
-    delivered_units: 5,
-    lease_until: null,
-  });
-
-  const { data: compFailRes, error: compFailErr } = await supabase.rpc("record_chunk_failure", {
+  const [{ data: finalJob, error: finalJobErr }, { data: relRow, error: relErr }] = await Promise.all([
+    supabase.from("jobs").select("status").eq("id", jobId).single(),
+    supabase.from("credit_ledger").select("id").eq("id", `rel_${jobId}`).maybeSingle(),
+  ]);
+  if (finalJobErr) throw finalJobErr;
+  if (relErr) throw relErr;
+  if (finalJob?.status !== "failed" || !relRow) throw new Error("Expected failed job and rel_ ledger row after fifth failure");
+
+  const { data: completedBefore, error: completedBeforeErr } = await supabase
+    .from("jobs")
+    .select("status, attempt_count, step, lease_until, error_message")
+    .eq("id", completedJobId)
+    .single();
+  if (completedBeforeErr) throw completedBeforeErr;
+
+  const { data: completedFailure, error: completedFailureErr } = await supabase.rpc("record_chunk_failure", {
     p_job_id: completedJobId,
     p_error_message: "Failure on already completed job",
   });
-  if (compFailErr) throw compFailErr;
-  console.log("record_chunk_failure on completed job result:", compFailRes);
-
-  if (!compFailRes.success || !compFailRes.ignored || compFailRes.status !== "completed") {
-    throw new Error("Expected record_chunk_failure on completed job to be ignored without change");
+  if (completedFailureErr) throw completedFailureErr;
+  if (!completedFailure.success || !completedFailure.ignored || completedFailure.status !== "completed") {
+    throw new Error(`Expected completed job failure to be ignored: ${JSON.stringify(completedFailure)}`);
   }
 
-  // Verify job remains completed and attempt_count is still 0
-  const { data: stillCompletedJob } = await supabase.from("jobs").select("status, attempt_count").eq("id", completedJobId).single();
-  if (stillCompletedJob?.status !== "completed" || stillCompletedJob?.attempt_count !== 0) {
-    throw new Error(`Completed job was modified: ${JSON.stringify(stillCompletedJob)}`);
+  const { data: completedAfter, error: completedAfterErr } = await supabase
+    .from("jobs")
+    .select("status, attempt_count, step, lease_until, error_message")
+    .eq("id", completedJobId)
+    .single();
+  if (completedAfterErr) throw completedAfterErr;
+  if (JSON.stringify(completedBefore) !== JSON.stringify(completedAfter)) {
+    throw new Error(`record_chunk_failure changed the completed job: before=${JSON.stringify(completedBefore)}, after=${JSON.stringify(completedAfter)}`);
   }
 
-  console.log("PASS: Chunk lifecycle verification passed (idempotent step completion, exponential backoff, auto-release at 5th attempt).");
+  console.log("PASS: Chunk lifecycle verification passed (complete retry idempotency, failure release, completed-job no-change guard).");
 }
 
 main().catch((err) => {
diff --git a/scripts/verify/verify-concurrency.ts b/scripts/verify/verify-concurrency.ts
index 5197482..2644608 100644
--- a/scripts/verify/verify-concurrency.ts
+++ b/scripts/verify/verify-concurrency.ts
@@ -1,99 +1,112 @@
 /**
- * Live Verification Script: 20 Parallel Concurrency Requests
+ * Live Verification Script: 20 Parallel Reservation Requests
  * Usage: tsx scripts/verify/verify-concurrency.ts
- * Strictly reads keys from environment variables. Zero hardcoded secrets.
+ * Uses approved service-role RPCs only; fixture rows are never written directly.
  */
-import https from "https";
+import { createClient } from "@supabase/supabase-js";
+import { newVrunPrefix, requireSetupRows } from "./vrun";
 
 const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
 const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
 const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
+const RUN_PREFIX = newVrunPrefix();
 
 if (!SERVICE_KEY) {
   console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
   process.exit(1);
 }
 
-function callReserveRpc(jobId: string, amount: number): Promise<any> {
-  return new Promise((resolve, reject) => {
-    const payload = JSON.stringify({
-      p_user_id: TEST_USER_ID,
-      p_job_id: jobId,
-      p_amount: amount,
-      p_note: "Parallel concurrency verification",
-    });
-
-    const url = new URL("/rest/v1/rpc/reserve_credits_atomic", SUPABASE_URL);
-
-    const req = https.request(
-      url,
-      {
-        method: "POST",
-        headers: {
-          "Content-Type": "application/json",
-          apikey: SERVICE_KEY,
-          Authorization: `Bearer ${SERVICE_KEY}`,
-          "Content-Length": Buffer.byteLength(payload),
-        },
-      },
-      (res) => {
-        let data = "";
-        res.on("data", (chunk) => {
-          data += chunk;
-        });
-        res.on("end", () => {
-          try {
-            resolve({ status: res.statusCode, body: JSON.parse(data) });
-          } catch {
-            resolve({ status: res.statusCode, raw: data });
-          }
-        });
-      }
-    );
-
-    req.on("error", reject);
-    req.write(payload);
-    req.end();
-  });
-}
+const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
+  auth: { persistSession: false, autoRefreshToken: false },
+});
 
 async function main() {
-  console.log("=== Launching 20 Real Parallel HTTP Requests to PostgREST RPC ===");
-
-  const runId = Date.now();
-  const sameJobId = `verify_parallel_same_${runId}`;
-
-  const sameJobCalls = Array.from({ length: 10 }).map(() =>
-    callReserveRpc(sameJobId, 25)
-  );
-
-  const diffJobCalls = Array.from({ length: 10 }).map((_, idx) =>
-    callReserveRpc(`verify_parallel_diff_${runId}_${idx + 1}`, 15)
-  );
-
-  const startTime = Date.now();
-  const results = await Promise.all([...sameJobCalls, ...diffJobCalls]);
-  const durationMs = Date.now() - startTime;
-
-  console.log(`Executed 20 parallel calls in ${durationMs}ms`);
-
-  const sameJobResults = results.slice(0, 10);
-  const diffJobResults = results.slice(10, 20);
-
-  const sameJobSuccess = sameJobResults.filter(
-    (r) => r.body && r.body.success && !r.body.already_reserved
-  );
-  const sameJobAlreadyReserved = sameJobResults.filter(
-    (r) => r.body && r.body.already_reserved
-  );
+  console.log("=== Verifying 20 Parallel Reservation RPC Requests ===");
+  console.log("Run prefix:", RUN_PREFIX);
+
+  const sameJobId = `${RUN_PREFIX}parallel_same`;
+  const differentJobIds = Array.from({ length: 10 }, (_, index) => `${RUN_PREFIX}parallel_diff_${index + 1}`);
+  const fixtures = [
+    { id: sameJobId, amount: 25 },
+    ...differentJobIds.map((id) => ({ id, amount: 15 })),
+  ];
+
+  const fixtureResults = await Promise.all(fixtures.map((fixture) =>
+    supabase.from("jobs").select("id, user_id, status, reserved_credits").eq("id", fixture.id).maybeSingle(),
+  ));
+  fixtureResults.forEach((result) => { if (result.error) throw result.error; });
+  const missing = fixtures.flatMap((fixture, index) => fixtureResults[index].data ? [] : [{
+    table: "jobs",
+    purpose: `reservation concurrency fixture (reserved_credits=${fixture.amount})`,
+    row: {
+      id: fixture.id,
+      user_id: TEST_USER_ID,
+      status: "queued",
+      endpoint_id: "tiktok-profile",
+      reserved_credits: fixture.amount,
+      lease_until: null,
+    },
+  }]);
+  if (missing.length) requireSetupRows(missing);
+
+  for (let index = 0; index < fixtures.length; index++) {
+    const row = fixtureResults[index].data!;
+    if (row.user_id !== TEST_USER_ID || row.status !== "queued" || Number(row.reserved_credits) !== fixtures[index].amount) {
+      throw new Error(`Concurrency fixture mismatch for ${fixtures[index].id}: ${JSON.stringify(row)}`);
+    }
+  }
+
+  try {
+    const calls = [
+      ...Array.from({ length: 10 }, () => supabase.rpc("reserve_credits_atomic", {
+        p_user_id: TEST_USER_ID,
+        p_job_id: sameJobId,
+        p_amount: 25,
+        p_note: "Parallel concurrency verification",
+      })),
+      ...differentJobIds.map((jobId) => supabase.rpc("reserve_credits_atomic", {
+        p_user_id: TEST_USER_ID,
+        p_job_id: jobId,
+        p_amount: 15,
+        p_note: "Parallel concurrency verification",
+      })),
+    ];
+
+    const startedAt = Date.now();
+    const results = await Promise.all(calls);
+    console.log(`Executed ${results.length} parallel RPC calls in ${Date.now() - startedAt}ms`);
+    results.forEach((result) => { if (result.error) throw result.error; });
+
+    const sameJobResults = results.slice(0, 10).map((result) => result.data);
+    const winners = sameJobResults.filter((result) => result?.success && !result.already_reserved);
+    const retries = sameJobResults.filter((result) => result?.success && result.already_reserved);
+    if (winners.length !== 1 || retries.length !== 9) {
+      throw new Error(`Expected one same-job reservation and nine idempotent retries: ${JSON.stringify(sameJobResults)}`);
+    }
+  } finally {
+    // Release any reservation that was created, including after an ambiguous RPC response.
+    const cleanupErrors: string[] = [];
+    for (const fixture of fixtures) {
+      try {
+        const { data: reserveRow, error: reserveReadErr } = await supabase
+          .from("credit_ledger").select("id").eq("id", `res_${fixture.id}`).maybeSingle();
+        if (reserveReadErr) throw reserveReadErr;
+        if (reserveRow) {
+          const { data: releaseResult, error: releaseErr } = await supabase.rpc("release_job_atomic", {
+            p_job_id: fixture.id,
+            p_error_message: "Verification cleanup through the existing two-argument release RPC",
+          });
+          if (releaseErr) throw releaseErr;
+          if (!releaseResult?.success) throw new Error(`Could not release verification reservation for ${fixture.id}: ${JSON.stringify(releaseResult)}`);
+        }
+      } catch (error) {
+        cleanupErrors.push(`${fixture.id}: ${error instanceof Error ? error.message : String(error)}`);
+      }
+    }
+    if (cleanupErrors.length) throw new Error(`Reservation cleanup failures: ${cleanupErrors.join("; ")}`);
+  }
 
-  console.log({
-    totalCalls: 20,
-    durationMs,
-    sameJobSuccessCount: sameJobSuccess.length,
-    sameJobAlreadyReservedCount: sameJobAlreadyReserved.length,
-    diffJobResultsCount: diffJobResults.length,
-  });
+  console.log("PASS: Reservation concurrency verified and created holds were released through the approved RPC.");
 }
 
 main().catch((err) => {
diff --git a/scripts/verify/verify-receipt-storage.ts b/scripts/verify/verify-receipt-storage.ts
index eaa6485..b5b3a09 100644
--- a/scripts/verify/verify-receipt-storage.ts
+++ b/scripts/verify/verify-receipt-storage.ts
@@ -1,92 +1,62 @@
 /**
  * Live Verification Script: Storage Bucket Policies
  * Usage: tsx scripts/verify/verify-receipt-storage.ts
- * Strictly reads keys from environment variables. Zero hardcoded secrets.
+ * Any service-role test upload is removed in a finally block in the same run.
  */
 import { createClient } from "@supabase/supabase-js";
+import { newVrunPrefix } from "./vrun";
 
 const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
-const ANON_KEY =
-  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
-  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
+const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
 const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
 const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
 const OTHER_USER_ID = "00000000-0000-0000-0000-000000000002";
+const RUN_PREFIX = newVrunPrefix();
 
 if (!ANON_KEY) {
   console.error("ERROR: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY must be provided via environment variable.");
   process.exit(1);
 }
-
 const anonClient = createClient(SUPABASE_URL, ANON_KEY);
 
 async function main() {
   console.log("=== Verifying Live Storage Bucket Policies ===");
-
+  console.log("Run prefix:", RUN_PREFIX);
   const sampleFileContent = Buffer.from("fake-receipt-png-content");
 
-  // 1. Client attempts to read from results or partials -> MUST be denied
-  const { data: resultsList, error: resultsErr } = await anonClient
-    .storage
-    .from("results")
-    .list();
-  console.log("Client access to 'results' bucket:", { resultsList, error: resultsErr?.message });
-  if (!resultsErr && resultsList && resultsList.length > 0) {
-    throw new Error("Client should not have access to read results bucket");
-  }
+  const { data: resultsList, error: resultsErr } = await anonClient.storage.from("results").list();
+  if (!resultsErr && resultsList && resultsList.length > 0) throw new Error("Client should not have access to read results bucket");
 
-  const { data: partialsList, error: partialsErr } = await anonClient
-    .storage
-    .from("partials")
-    .list();
-  console.log("Client access to 'partials' bucket:", { partialsList, error: partialsErr?.message });
-  if (!partialsErr && partialsList && partialsList.length > 0) {
-    throw new Error("Client should not have access to read partials bucket");
-  }
+  const { data: partialsList, error: partialsErr } = await anonClient.storage.from("partials").list();
+  if (!partialsErr && partialsList && partialsList.length > 0) throw new Error("Client should not have access to read partials bucket");
 
-  // 2. Client attempts to upload into receipts under ANOTHER user's folder -> MUST be denied
-  const { error: forgedUploadErr } = await anonClient
-    .storage
-    .from("receipts")
-    .upload(`${OTHER_USER_ID}/forged_receipt.png`, sampleFileContent, {
-      contentType: "image/png",
-    });
-  console.log("Forged folder upload attempt error (expected):", forgedUploadErr?.message);
-  if (!forgedUploadErr) {
-    throw new Error("Client must be forbidden from uploading into another user's folder");
-  }
+  const { error: forgedUploadErr } = await anonClient.storage.from("receipts").upload(
+    `${OTHER_USER_ID}/${RUN_PREFIX}forged_receipt.png`, sampleFileContent, { contentType: "image/png" },
+  );
+  if (!forgedUploadErr) throw new Error("Client must be forbidden from uploading into another user's folder");
 
-  // 3. Service role upload into own folder and immediate cleanup
   if (SERVICE_KEY) {
-    const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);
-    const testFilePath = `${TEST_USER_ID}/test_verify_receipt_${Date.now()}.png`;
-
-    const { error: uploadErr } = await adminClient
-      .storage
-      .from("receipts")
-      .upload(testFilePath, sampleFileContent, {
+    const adminClient = createClient(SUPABASE_URL, SERVICE_KEY, {
+      auth: { persistSession: false, autoRefreshToken: false },
+    });
+    const testFilePath = `${TEST_USER_ID}/${RUN_PREFIX}receipt.png`;
+    try {
+      const { error: uploadErr } = await adminClient.storage.from("receipts").upload(testFilePath, sampleFileContent, {
         contentType: "image/png",
       });
-    if (uploadErr) throw uploadErr;
-    console.log(`Uploaded test receipt: ${testFilePath}`);
-
-    // Verify it exists
-    const { data: listData } = await adminClient
-      .storage
-      .from("receipts")
-      .list(TEST_USER_ID);
-    console.log(`Files in ${TEST_USER_ID} folder:`, listData?.map((f) => f.name));
+      if (uploadErr) throw uploadErr;
 
-    // Clean up test file immediately (never keep test files in storage)
-    const { error: removeErr } = await adminClient
-      .storage
-      .from("receipts")
-      .remove([testFilePath]);
-    if (removeErr) throw removeErr;
-    console.log(`Cleaned up test storage file: ${testFilePath}`);
+      const { data: listData, error: listErr } = await adminClient.storage.from("receipts").list(TEST_USER_ID);
+      if (listErr) throw listErr;
+      console.log(`Files in ${TEST_USER_ID} folder matching this run:`, listData?.filter((file) => file.name.startsWith(RUN_PREFIX)).map((file) => file.name));
+    } finally {
+      // Attempt removal even if upload/list returned an error after the object was created.
+      const { error: removeErr } = await adminClient.storage.from("receipts").remove([testFilePath]);
+      if (removeErr) throw removeErr;
+    }
   }
 
-  console.log("PASS: Storage policies verification passed (client isolated to own folder, results/partials private, test file cleaned up).");
+  console.log("PASS: Storage policies verified; the service-role test object was removed in the same run.");
 }
 
 main().catch((err) => {
diff --git a/scripts/verify/verify-release-job.ts b/scripts/verify/verify-release-job.ts
index 83f3a54..45063e8 100644
--- a/scripts/verify/verify-release-job.ts
+++ b/scripts/verify/verify-release-job.ts
@@ -1,13 +1,15 @@
 /**
- * Live Verification Script: release_job_atomic
+ * Live Verification Script: release_job_atomic overloads
  * Usage: tsx scripts/verify/verify-release-job.ts
- * Strictly reads keys from environment variables. Zero hardcoded secrets.
+ * Uses service-role RPCs only; protected table rows are never written directly.
  */
 import { createClient } from "@supabase/supabase-js";
+import { newVrunPrefix, requireSetupRows } from "./vrun";
 
 const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
 const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
 const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
+const RUN_PREFIX = newVrunPrefix();
 
 if (!SERVICE_KEY) {
   console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
@@ -18,84 +20,165 @@ const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
   auth: { persistSession: false, autoRefreshToken: false },
 });
 
+type Fixture = { id: string; purpose: string; row: Record<string, unknown> };
+
 async function main() {
-  console.log("=== Verifying release_job_atomic ===");
-
-  const jobId = `job_test_release_${Date.now()}`;
-  const reservedCredits = 30;
-
-  // 1. Prepare test reservation hold in credit_ledger
-  const { error: resErr } = await supabase.from("credit_ledger").insert({
-    id: `res_${jobId}`,
-    user_id: TEST_USER_ID,
-    delta: -reservedCredits,
-    type: "reserve",
-    job_id: jobId,
-    note: "Release test reservation hold",
+  console.log("=== Verifying release_job_atomic overloads ===");
+  console.log("Run prefix:", RUN_PREFIX);
+  const forceLeaseUntil = new Date(Date.now() + 60_000).toISOString();
+
+  const fixtures: Fixture[] = [
+    { id: `${RUN_PREFIX}legacy_two_arg`, purpose: "old two-argument overload; queued/running release and retry", row: {
+      id: `${RUN_PREFIX}legacy_two_arg`, user_id: TEST_USER_ID, status: "running", endpoint_id: "tiktok-profile",
+      unit_price: 1, delivered_units: 0, reserved_credits: 30, target_volume_min: 10, target_volume_max: 30, lease_until: null,
+    } },
+    { id: `${RUN_PREFIX}forced_lease`, purpose: "three-argument overload; active lease and unit_price is intentionally NULL", row: {
+      id: `${RUN_PREFIX}forced_lease`, user_id: TEST_USER_ID, status: "running", endpoint_id: "tiktok-profile",
+      unit_price: null, delivered_units: 0, reserved_credits: 20, lease_until: forceLeaseUntil,
+    } },
+    { id: `${RUN_PREFIX}failed_repair`, purpose: "failed job with reservation but no rel_ row", row: {
+      id: `${RUN_PREFIX}failed_repair`, user_id: TEST_USER_ID, status: "failed", endpoint_id: "tiktok-profile",
+      unit_price: null, reserved_credits: 12, lease_until: null,
+    } },
+    { id: `${RUN_PREFIX}completed`, purpose: "completed job must raise", row: {
+      id: `${RUN_PREFIX}completed`, user_id: TEST_USER_ID, status: "completed", endpoint_id: "tiktok-profile",
+      reserved_credits: 5, lease_until: null,
+    } },
+    { id: `${RUN_PREFIX}missing_reserve`, purpose: "positive reserve amount but res_ row intentionally absent", row: {
+      id: `${RUN_PREFIX}missing_reserve`, user_id: TEST_USER_ID, status: "queued", endpoint_id: "tiktok-profile",
+      reserved_credits: 8, lease_until: null,
+    } },
+    { id: `${RUN_PREFIX}zero_reserve`, purpose: "non-positive reserved_credits must raise", row: {
+      id: `${RUN_PREFIX}zero_reserve`, user_id: TEST_USER_ID, status: "queued", endpoint_id: "tiktok-profile",
+      reserved_credits: 0, lease_until: null,
+    } },
+    { id: `${RUN_PREFIX}refused`, purpose: "statuses other than queued/running/failed must raise", row: {
+      id: `${RUN_PREFIX}refused`, user_id: TEST_USER_ID, status: "refused", endpoint_id: "tiktok-profile",
+      reserved_credits: 5, lease_until: null,
+    } },
+  ];
+
+  const jobResults = await Promise.all(fixtures.map((fixture) =>
+    supabase.from("jobs").select("id, user_id, status, reserved_credits, lease_until, unit_price").eq("id", fixture.id).maybeSingle(),
+  ));
+  jobResults.forEach((result) => { if (result.error) throw result.error; });
+  const missingFixtures = fixtures.flatMap((fixture, index) => jobResults[index].data ? [] : [{
+    table: "jobs",
+    purpose: fixture.purpose,
+    row: fixture.row,
+  }]);
+  if (missingFixtures.length) requireSetupRows(missingFixtures);
+
+  const jobRows = jobResults.map((result) => result.data!);
+  const legacyId = fixtures[0].id;
+  const forceId = fixtures[1].id;
+  const repairId = fixtures[2].id;
+
+  for (let index = 0; index < fixtures.length; index++) {
+    const fixture = fixtures[index];
+    const row = jobRows[index];
+    if (row.user_id !== TEST_USER_ID || row.status !== fixture.row.status || Number(row.reserved_credits) !== Number(fixture.row.reserved_credits)) {
+      throw new Error(`Fixture mismatch for ${fixture.id}: ${JSON.stringify(row)}`);
+    }
+  }
+
+  if (!jobRows[1].lease_until || new Date(String(jobRows[1].lease_until)).getTime() <= Date.now() || jobRows[1].unit_price !== null) {
+    throw new Error(`Forced-release fixture must have a future lease and NULL unit_price: ${JSON.stringify(jobRows[1])}`);
+  }
+  const { data: preexistingRepairRelease, error: repairReleaseReadErr } = await supabase
+    .from("credit_ledger").select("id").eq("id", `rel_${repairId}`).maybeSingle();
+  if (repairReleaseReadErr) throw repairReleaseReadErr;
+  if (preexistingRepairRelease) throw new Error(`Repair fixture must start without rel_${repairId}`);
+
+  for (const fixture of fixtures.slice(0, 3)) {
+    const { data, error } = await supabase.rpc("reserve_credits_atomic", {
+      p_user_id: TEST_USER_ID,
+      p_job_id: fixture.id,
+      p_amount: Number(fixture.row.reserved_credits),
+      p_note: "Approved RPC setup for release verification",
+    });
+    if (error) throw error;
+    if (!data?.success) throw new Error(`Approved reservation RPC failed for ${fixture.id}: ${JSON.stringify(data)}`);
+  }
+
+  // Exactly two named arguments: this must keep resolving to the original overload.
+  const { data: legacyFirst, error: legacyFirstErr } = await supabase.rpc("release_job_atomic", {
+    p_job_id: legacyId,
+    p_error_message: "Two-argument overload verification",
   });
-  if (resErr) throw resErr;
-
-  // 2. Prepare running job record in public.jobs
-  const { error: jobErr } = await supabase.from("jobs").insert({
-    id: jobId,
-    user_id: TEST_USER_ID,
-    status: "running",
-    endpoint_id: "tiktok-profile",
-    unit_price: 1,
-    delivered_units: 0,
-    reserved_credits: reservedCredits,
-    target_volume_min: 10,
-    target_volume_max: 30,
-    lease_until: null,
+  if (legacyFirstErr) throw legacyFirstErr;
+  if (!legacyFirst?.success || legacyFirst.released_credits !== 30 || legacyFirst.already_released) {
+    throw new Error(`Unexpected two-argument release result: ${JSON.stringify(legacyFirst)}`);
+  }
+  const { data: legacyRetry, error: legacyRetryErr } = await supabase.rpc("release_job_atomic", {
+    p_job_id: legacyId,
+    p_error_message: "Two-argument retry verification",
   });
-  if (jobErr) throw jobErr;
+  if (legacyRetryErr) throw legacyRetryErr;
+  if (!legacyRetry?.success || !legacyRetry.already_released) {
+    throw new Error(`Expected legacy two-argument retry to be idempotent: ${JSON.stringify(legacyRetry)}`);
+  }
 
-  // 3. First release call
-  const { data: firstRes, error: firstErr } = await supabase.rpc("release_job_atomic", {
-    p_job_id: jobId,
-    p_error_message: "Test failure triggering atomic release",
+  // Three required keys select the new overload; a live lease must block unless forced.
+  const { error: leaseErr } = await supabase.rpc("release_job_atomic", {
+    p_job_id: forceId,
+    p_error_message: "Live lease should block",
+    p_force: false,
   });
-  if (firstErr) throw firstErr;
-  console.log("First release result:", firstRes);
-
-  if (!firstRes.success || firstRes.released_credits !== reservedCredits || firstRes.already_released) {
-    throw new Error(`Unexpected first release result: ${JSON.stringify(firstRes)}`);
+  if (!leaseErr || !leaseErr.message.includes("active chunk lease")) {
+    throw new Error(`Expected active lease to raise unless p_force=true; got ${leaseErr?.message}`);
   }
-
-  // 4. Second release call (idempotent retry)
-  const { data: secondRes, error: secondErr } = await supabase.rpc("release_job_atomic", {
-    p_job_id: jobId,
-    p_error_message: "Duplicate retry call",
+  const { data: forced, error: forcedErr } = await supabase.rpc("release_job_atomic", {
+    p_job_id: forceId,
+    p_error_message: "Owner-authorized force-path verification",
+    p_force: true,
   });
-  if (secondErr) throw secondErr;
-  console.log("Second release result (idempotent):", secondRes);
-
-  if (!secondRes.success || !secondRes.already_released) {
-    throw new Error(`Expected already_released: true on retry, got: ${JSON.stringify(secondRes)}`);
+  if (forcedErr) throw forcedErr;
+  if (!forced?.success || forced.released_credits !== 20 || forced.already_released) {
+    throw new Error(`Forced release failed (also verifies no unit_price requirement): ${JSON.stringify(forced)}`);
   }
-
-  // 5. Verify ledger rows for this job: exactly 1 rel_ row, 0 chg_ rows
-  const { data: ledgerRows } = await supabase
-    .from("credit_ledger")
-    .select("id, delta, type")
-    .eq("job_id", jobId);
-
-  console.log("Ledger rows for job:", ledgerRows);
-
-  const relRows = ledgerRows?.filter((r) => r.id === `rel_${jobId}`);
-  const chgRows = ledgerRows?.filter((r) => r.id === `chg_${jobId}`);
-
-  if (relRows?.length !== 1 || (chgRows && chgRows.length > 0)) {
-    throw new Error(`Expected exactly 1 rel_ row and 0 chg_ rows, got rel=${relRows?.length}, chg=${chgRows?.length}`);
+  const { data: forcedRetry, error: forcedRetryErr } = await supabase.rpc("release_job_atomic", {
+    p_job_id: forceId,
+    p_error_message: "Forced release retry",
+    p_force: true,
+  });
+  if (forcedRetryErr) throw forcedRetryErr;
+  if (!forcedRetry?.success || !forcedRetry.already_released) {
+    throw new Error(`Expected failed-job idempotency when both res_ and rel_ exist: ${JSON.stringify(forcedRetry)}`);
   }
 
-  // 6. Verify job status is failed
-  const { data: jobRow } = await supabase.from("jobs").select("status, charged_credits").eq("id", jobId).single();
-  if (jobRow?.status !== "failed" || jobRow?.charged_credits !== 0) {
-    throw new Error(`Job status not failed or charged_credits not 0: ${JSON.stringify(jobRow)}`);
+  const { data: repaired, error: repairedErr } = await supabase.rpc("release_job_atomic", {
+    p_job_id: repairId,
+    p_error_message: "Repair missing rel_ for failed job",
+    p_force: false,
+  });
+  if (repairedErr) throw repairedErr;
+  if (!repaired?.success || repaired.already_released) {
+    throw new Error(`Expected failed job with missing rel_ to complete release: ${JSON.stringify(repaired)}`);
+  }
+  const { data: repairedRel, error: repairedRelErr } = await supabase
+    .from("credit_ledger").select("id").eq("id", `rel_${repairId}`).maybeSingle();
+  if (repairedRelErr) throw repairedRelErr;
+  if (!repairedRel) throw new Error(`Expected approved release RPC to create rel_${repairId}`);
+
+  const expectedErrors: Array<{ id: string; force: boolean; includes: string }> = [
+    { id: fixtures[3].id, force: false, includes: "already completed" },
+    { id: fixtures[4].id, force: false, includes: "Reserve record" },
+    { id: fixtures[5].id, force: false, includes: "reserved_credits" },
+    { id: fixtures[6].id, force: false, includes: "status" },
+  ];
+  for (const test of expectedErrors) {
+    const { error } = await supabase.rpc("release_job_atomic", {
+      p_job_id: test.id,
+      p_error_message: "Expected guard rejection",
+      p_force: test.force,
+    });
+    if (!error || !error.message.toLowerCase().includes(test.includes.toLowerCase())) {
+      throw new Error(`Expected release guard for ${test.id} to include '${test.includes}', got '${error?.message}'`);
+    }
   }
 
-  console.log("PASS: release_job_atomic verification passed (released full reserve, zero charge, idempotent).");
+  console.log("PASS: both release overloads verified (two-arg route, retry, lease force, failed-row recovery, integrity/status guards).");
 }
 
 main().catch((err) => {
diff --git a/scripts/verify/verify-settle-job.ts b/scripts/verify/verify-settle-job.ts
index 6cd3edf..2c417bd 100644
--- a/scripts/verify/verify-settle-job.ts
+++ b/scripts/verify/verify-settle-job.ts
@@ -1,13 +1,15 @@
 /**
  * Live Verification Script: settle_job_atomic
  * Usage: tsx scripts/verify/verify-settle-job.ts
- * Strictly reads keys from environment variables. Zero hardcoded secrets.
+ * Uses service-role RPCs only; never writes protected table rows directly.
  */
 import { createClient } from "@supabase/supabase-js";
+import { newVrunPrefix, requireSetupRows } from "./vrun";
 
 const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
 const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
 const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
+const RUN_PREFIX = newVrunPrefix();
 
 if (!SERVICE_KEY) {
   console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
@@ -20,138 +22,111 @@ const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
 
 async function main() {
   console.log("=== Verifying settle_job_atomic ===");
+  console.log("Run prefix:", RUN_PREFIX);
+  const futureLeaseUntil = new Date(Date.now() + 60_000).toISOString();
+
+  const fixtures = [
+    { id: `${RUN_PREFIX}settle`, purpose: "settle twice", row: {
+      id: `${RUN_PREFIX}settle`, user_id: TEST_USER_ID, status: "running", endpoint_id: "tiktok-profile",
+      unit_price: 2, delivered_units: 8, reserved_credits: 25, target_volume_min: 10, target_volume_max: 20, lease_until: null,
+    } },
+    { id: `${RUN_PREFIX}settle_live_lease`, purpose: "settling with a live lease must raise", row: {
+      id: `${RUN_PREFIX}settle_live_lease`, user_id: TEST_USER_ID, status: "running", endpoint_id: "tiktok-profile",
+      unit_price: 1, delivered_units: 5, reserved_credits: 10, lease_until: futureLeaseUntil,
+    } },
+    { id: `${RUN_PREFIX}settle_bad_price`, purpose: "settling with invalid unit_price must raise", row: {
+      id: `${RUN_PREFIX}settle_bad_price`, user_id: TEST_USER_ID, status: "running", endpoint_id: "tiktok-profile",
+      unit_price: null, delivered_units: 5, reserved_credits: 10, lease_until: null,
+    } },
+  ];
+
+  const results = await Promise.all(fixtures.map((fixture) =>
+    supabase.from("jobs").select("id, user_id, status, unit_price, delivered_units, reserved_credits, lease_until").eq("id", fixture.id).maybeSingle(),
+  ));
+  results.forEach((result) => { if (result.error) throw result.error; });
+  const missing = fixtures.flatMap((fixture, index) => results[index].data ? [] : [{
+    table: "jobs",
+    purpose: fixture.purpose,
+    row: fixture.row,
+  }]);
+  if (missing.length) requireSetupRows(missing);
+
+  for (let index = 0; index < fixtures.length; index++) {
+    const row = results[index].data!;
+    const fixture = fixtures[index];
+    if (row.user_id !== TEST_USER_ID || row.status !== "running" || Number(row.reserved_credits) !== Number(fixture.row.reserved_credits)) {
+      throw new Error(`Settlement fixture mismatch for ${fixture.id}: ${JSON.stringify(row)}`);
+    }
+  }
+  const mainFixture = results[0].data!;
+  const leaseFixture = results[1].data!;
+  const badPriceFixture = results[2].data!;
+  if (Number(mainFixture.unit_price) !== 2 || Number(mainFixture.delivered_units) !== 8 || mainFixture.lease_until !== null) {
+    throw new Error(`Settle-twice fixture must have unit_price=2, delivered_units=8 and no lease: ${JSON.stringify(mainFixture)}`);
+  }
+  if (!leaseFixture.lease_until || new Date(String(leaseFixture.lease_until)).getTime() <= Date.now()) {
+    throw new Error(`Lease fixture must hold an unexpired lease: ${JSON.stringify(leaseFixture)}`);
+  }
+  if (badPriceFixture.unit_price !== null) {
+    throw new Error(`Bad-price fixture must have NULL unit_price: ${JSON.stringify(badPriceFixture)}`);
+  }
 
-  const jobId = `job_test_settle_${Date.now()}`;
-  const reservedCredits = 25;
-  const unitPrice = 2;
-  const deliveredUnits = 8; // Expected charge: ceil(8 * 2) = 16 credits
-
-  // 1. Prepare test reservation in credit_ledger
-  const { error: resErr } = await supabase.from("credit_ledger").insert({
-    id: `res_${jobId}`,
-    user_id: TEST_USER_ID,
-    delta: -reservedCredits,
-    type: "reserve",
-    job_id: jobId,
-    note: "Settlement test reservation hold",
-  });
-  if (resErr) throw resErr;
-
-  // 2. Prepare running job record in public.jobs
-  const { error: jobErr } = await supabase.from("jobs").insert({
-    id: jobId,
-    user_id: TEST_USER_ID,
-    status: "running",
-    endpoint_id: "tiktok-profile",
-    unit_price: unitPrice,
-    delivered_units: deliveredUnits,
-    reserved_credits: reservedCredits,
-    target_volume_min: 10,
-    target_volume_max: 20,
-    lease_until: null,
-  });
-  if (jobErr) throw jobErr;
+  for (const fixture of fixtures) {
+    const { data, error } = await supabase.rpc("reserve_credits_atomic", {
+      p_user_id: TEST_USER_ID,
+      p_job_id: fixture.id,
+      p_amount: Number(fixture.row.reserved_credits),
+      p_note: "Approved RPC setup for settlement verification",
+    });
+    if (error) throw error;
+    if (!data?.success) throw new Error(`Approved reservation RPC failed for ${fixture.id}: ${JSON.stringify(data)}`);
+  }
 
-  // 3. First settlement call
-  const { data: firstRes, error: firstErr } = await supabase.rpc("settle_job_atomic", {
-    p_job_id: jobId,
+  const mainJobId = fixtures[0].id;
+  const { data: first, error: firstErr } = await supabase.rpc("settle_job_atomic", {
+    p_job_id: mainJobId,
     p_points_cap: 600,
   });
   if (firstErr) throw firstErr;
-  console.log("First settlement result:", firstRes);
-
-  if (!firstRes.success || firstRes.charged_credits !== 16 || firstRes.already_settled) {
-    throw new Error(`Unexpected first settlement result: ${JSON.stringify(firstRes)}`);
+  if (!first?.success || first.charged_credits !== 16 || first.already_settled) {
+    throw new Error(`Unexpected first settlement result: ${JSON.stringify(first)}`);
   }
 
-  // 4. Second settlement call (idempotent retry)
-  const { data: secondRes, error: secondErr } = await supabase.rpc("settle_job_atomic", {
-    p_job_id: jobId,
+  const { data: second, error: secondErr } = await supabase.rpc("settle_job_atomic", {
+    p_job_id: mainJobId,
     p_points_cap: 600,
   });
   if (secondErr) throw secondErr;
-  console.log("Second settlement result (idempotent):", secondRes);
-
-  if (!secondRes.success || !secondRes.already_settled) {
-    throw new Error(`Expected already_settled: true on retry, got: ${JSON.stringify(secondRes)}`);
+  if (!second?.success || !second.already_settled) {
+    throw new Error(`Expected settlement retry to be idempotent: ${JSON.stringify(second)}`);
   }
 
-  // 5. Verify ledger rows for this job
-  const { data: ledgerRows } = await supabase
-    .from("credit_ledger")
-    .select("id, delta, type")
-    .eq("job_id", jobId);
-
-  console.log("Ledger rows for job:", ledgerRows);
-
-  const relRows = ledgerRows?.filter((r) => r.id === `rel_${jobId}`);
-  const chgRows = ledgerRows?.filter((r) => r.id === `chg_${jobId}`);
-
-  if (relRows?.length !== 1 || chgRows?.length !== 1) {
-    throw new Error(`Expected exactly 1 rel_ and 1 chg_ row, got rel=${relRows?.length}, chg=${chgRows?.length}`);
+  const { data: ledgerRows, error: ledgerErr } = await supabase
+    .from("credit_ledger").select("id, delta, type").eq("job_id", mainJobId);
+  if (ledgerErr) throw ledgerErr;
+  const releaseRows = ledgerRows?.filter((row) => row.id === `rel_${mainJobId}`);
+  const chargeRows = ledgerRows?.filter((row) => row.id === `chg_${mainJobId}`);
+  if (releaseRows?.length !== 1 || chargeRows?.length !== 1) {
+    throw new Error(`Expected one rel_ and one chg_ ledger row: rel=${releaseRows?.length}, chg=${chargeRows?.length}`);
   }
 
-  // 6. Explicit Check: Settle with active lease MUST raise
-  const leaseJobId = `job_test_lease_${Date.now()}`;
-  await supabase.from("credit_ledger").insert({
-    id: `res_${leaseJobId}`,
-    user_id: TEST_USER_ID,
-    delta: -10,
-    type: "reserve",
-    job_id: leaseJobId,
-    note: "Lease test hold",
-  });
-  await supabase.from("jobs").insert({
-    id: leaseJobId,
-    user_id: TEST_USER_ID,
-    status: "running",
-    endpoint_id: "tiktok-profile",
-    unit_price: 1,
-    delivered_units: 5,
-    reserved_credits: 10,
-    lease_until: new Date(Date.now() + 60_000).toISOString(), // Active lease in future
-  });
-
-  const { error: leaseSettleErr } = await supabase.rpc("settle_job_atomic", {
-    p_job_id: leaseJobId,
+  const { error: leaseErr } = await supabase.rpc("settle_job_atomic", {
+    p_job_id: fixtures[1].id,
     p_points_cap: 600,
   });
-  console.log("Settle with active lease error (expected):", leaseSettleErr?.message);
-  if (!leaseSettleErr || !leaseSettleErr.message.includes("active chunk lease")) {
-    throw new Error("Expected settle_job_atomic to raise when active lease is held");
+  if (!leaseErr || !leaseErr.message.includes("active chunk lease")) {
+    throw new Error(`Expected settling with a live lease to raise, got ${leaseErr?.message}`);
   }
 
-  // 7. Explicit Check: Settle with unit_price NULL or <= 0 MUST raise
-  const invalidPriceJobId = `job_test_bad_price_${Date.now()}`;
-  await supabase.from("credit_ledger").insert({
-    id: `res_${invalidPriceJobId}`,
-    user_id: TEST_USER_ID,
-    delta: -10,
-    type: "reserve",
-    job_id: invalidPriceJobId,
-    note: "Invalid price test hold",
-  });
-  await supabase.from("jobs").insert({
-    id: invalidPriceJobId,
-    user_id: TEST_USER_ID,
-    status: "running",
-    endpoint_id: "tiktok-profile",
-    unit_price: null,
-    delivered_units: 5,
-    reserved_credits: 10,
-    lease_until: null,
-  });
-
   const { error: badPriceErr } = await supabase.rpc("settle_job_atomic", {
-    p_job_id: invalidPriceJobId,
+    p_job_id: fixtures[2].id,
     p_points_cap: 600,
   });
-  console.log("Settle with null unit_price error (expected):", badPriceErr?.message);
   if (!badPriceErr || !badPriceErr.message.includes("invalid unit_price")) {
-    throw new Error("Expected settle_job_atomic to raise when unit_price is NULL or <= 0");
+    throw new Error(`Expected invalid unit_price to raise, got ${badPriceErr?.message}`);
   }
 
-  console.log("PASS: settle_job_atomic verification passed (settled correctly, idempotent, active lease raises, bad price raises).");
+  console.log("PASS: settle_job_atomic verification passed (settle twice, active lease raises, bad unit_price raises).");
 }
 
 main().catch((err) => {
diff --git a/scripts/verify/verify-spend-cap.ts b/scripts/verify/verify-spend-cap.ts
index 8cf19f3..3c05a99 100644
--- a/scripts/verify/verify-spend-cap.ts
+++ b/scripts/verify/verify-spend-cap.ts
@@ -1,12 +1,14 @@
 /**
  * Live Verification Script: Provider Daily Spend Cap & Commit
  * Usage: tsx scripts/verify/verify-spend-cap.ts
- * Strictly reads keys from environment variables. Zero hardcoded secrets.
+ * Mutations use approved service-role RPCs only; no direct provider_costs writes.
  */
 import { createClient } from "@supabase/supabase-js";
+import { newVrunPrefix, requireSetupRows } from "./vrun";
 
 const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
 const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
+const RUN_PREFIX = newVrunPrefix();
 
 if (!SERVICE_KEY) {
   console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
@@ -19,64 +21,103 @@ const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
 
 async function main() {
   console.log("=== Verifying Provider Daily Spend Cap & Commit ===");
+  console.log("Run prefix:", RUN_PREFIX);
 
-  const jobId = `job_test_spend_${Date.now()}`;
-  const dailyCapUsd = 0.80;
-
-  // 1. First reserve spend: 0.50 USD (should succeed)
-  const { data: res1, error: err1 } = await supabase.rpc("reserve_provider_spend_atomic", {
-    p_job_id: jobId,
-    p_provider: "treg",
-    p_estimated_cost_usd: 0.50,
-    p_daily_cap_usd: dailyCapUsd,
+  const firstJobId = `${RUN_PREFIX}spend_first`;
+  const parallelJobIds = [`${RUN_PREFIX}spend_parallel_a`, `${RUN_PREFIX}spend_parallel_b`];
+  const jobFixtures = [firstJobId, ...parallelJobIds].map((id) => ({
+    id,
+    row: { id, user_id: "00000000-0000-0000-0000-000000000001", status: "queued", endpoint_id: "tiktok-profile" },
+  }));
+  const jobResults = await Promise.all(jobFixtures.map((fixture) =>
+    supabase.from("jobs").select("id, user_id, status").eq("id", fixture.id).maybeSingle(),
+  ));
+  jobResults.forEach((result) => { if (result.error) throw result.error; });
+  const missingJobs = jobFixtures.flatMap((fixture, index) => jobResults[index].data ? [] : [{
+    table: "jobs",
+    purpose: "provider_costs.job_id foreign-key fixture for spend-cap RPC",
+    row: fixture.row,
+  }]);
+  if (missingJobs.length) requireSetupRows(missingJobs);
+  jobResults.forEach((result, index) => {
+    const row = result.data!;
+    if (row.user_id !== jobFixtures[index].row.user_id || row.status !== "queued") {
+      throw new Error(`Spend-cap job fixture mismatch for ${jobFixtures[index].id}: ${JSON.stringify(row)}`);
+    }
   });
-  if (err1) throw err1;
-  console.log("Reserve 1 ($0.50) result:", res1);
 
-  if (!res1.allowed || !res1.cost_id) {
-    throw new Error(`Expected reserve 1 to be allowed: ${JSON.stringify(res1)}`);
-  }
+  const utcDayStart = new Date();
+  utcDayStart.setUTCHours(0, 0, 0, 0);
+  const { data: costRows, error: costReadErr } = await supabase
+    .from("provider_costs")
+    .select("cost_usd")
+    .gte("created_at", utcDayStart.toISOString());
+  if (costReadErr) throw costReadErr;
+  const currentSpend = (costRows || []).reduce((sum, row) => sum + Number(row.cost_usd || 0), 0);
+  const dailyCapUsd = currentSpend + 0.80;
 
-  // 2. Second reserve spend: 0.40 USD (0.50 + 0.40 = 0.90 > 0.80 -> must be denied)
-  const { data: res2, error: err2 } = await supabase.rpc("reserve_provider_spend_atomic", {
-    p_job_id: jobId,
+  const { data: firstReserve, error: firstReserveErr } = await supabase.rpc("reserve_provider_spend_atomic", {
+    p_job_id: firstJobId,
     p_provider: "treg",
-    p_estimated_cost_usd: 0.40,
+    p_estimated_cost_usd: 0.50,
     p_daily_cap_usd: dailyCapUsd,
   });
-  if (err2) throw err2;
-  console.log("Reserve 2 ($0.40, exceeding cap) result:", res2);
+  if (firstReserveErr) throw firstReserveErr;
+  if (!firstReserve?.allowed || !firstReserve.cost_id) {
+    throw new Error(`Expected initial $0.50 estimate to be allowed: ${JSON.stringify(firstReserve)}`);
+  }
 
-  if (res2.allowed) {
-    throw new Error(`Expected reserve 2 to be DENIED by spend cap: ${JSON.stringify(res2)}`);
+  // Only one of these concurrent $0.20 reservations fits in the remaining $0.30.
+  const parallelResults = await Promise.all([
+    supabase.rpc("reserve_provider_spend_atomic", {
+      p_job_id: parallelJobIds[0],
+      p_provider: "treg",
+      p_estimated_cost_usd: 0.20,
+      p_daily_cap_usd: dailyCapUsd,
+    }),
+    supabase.rpc("reserve_provider_spend_atomic", {
+      p_job_id: parallelJobIds[1],
+      p_provider: "treg",
+      p_estimated_cost_usd: 0.20,
+      p_daily_cap_usd: dailyCapUsd,
+    }),
+  ]);
+  for (const result of parallelResults) if (result.error) throw result.error;
+  const allowed = parallelResults.map((result) => result.data).filter((result) => result?.allowed && result.cost_id);
+  const denied = parallelResults.map((result) => result.data).filter((result) => result?.allowed === false);
+  if (allowed.length !== 1 || denied.length !== 1) {
+    throw new Error(`Expected exactly one allowed and one cap-denied parallel reservation: ${JSON.stringify(parallelResults.map((result) => result.data))}`);
   }
 
-  // 3. Commit actual spend on reserve 1: actual cost = 0.45 USD, units = 45
-  const { data: commitRes, error: commitErr } = await supabase.rpc("commit_provider_spend", {
-    p_cost_id: res1.cost_id,
+  const winningCostId = allowed[0].cost_id;
+  const { data: firstCommit, error: firstCommitErr } = await supabase.rpc("commit_provider_spend", {
+    p_cost_id: firstReserve.cost_id,
     p_actual_cost_usd: 0.45,
     p_units: 45,
   });
-  if (commitErr) throw commitErr;
-  console.log("Commit result:", commitRes);
+  if (firstCommitErr) throw firstCommitErr;
+  if (!firstCommit?.success || firstCommit.actual_cost !== 0.45) {
+    throw new Error(`Unexpected first commit result: ${JSON.stringify(firstCommit)}`);
+  }
 
-  if (!commitRes.success || commitRes.actual_cost !== 0.45) {
-    throw new Error(`Unexpected commit result: ${JSON.stringify(commitRes)}`);
+  const { data: parallelCommit, error: parallelCommitErr } = await supabase.rpc("commit_provider_spend", {
+    p_cost_id: winningCostId,
+    p_actual_cost_usd: 0.15,
+    p_units: 15,
+  });
+  if (parallelCommitErr) throw parallelCommitErr;
+  if (!parallelCommit?.success || parallelCommit.actual_cost !== 0.15) {
+    throw new Error(`Unexpected parallel-winner commit result: ${JSON.stringify(parallelCommit)}`);
   }
 
-  // 4. Duplicate commit call must fail / raise exception (already committed)
-  const { error: dupCommitErr } = await supabase.rpc("commit_provider_spend", {
-    p_cost_id: res1.cost_id,
+  const { error: duplicateCommitErr } = await supabase.rpc("commit_provider_spend", {
+    p_cost_id: firstReserve.cost_id,
     p_actual_cost_usd: 0.45,
     p_units: 45,
   });
-  console.log("Duplicate commit attempt error (expected):", dupCommitErr?.message);
-
-  if (!dupCommitErr) {
-    throw new Error("Duplicate commit must be rejected");
-  }
+  if (!duplicateCommitErr) throw new Error("Duplicate commit must be rejected");
 
-  console.log("PASS: Provider daily spend cap verification passed (atomic cap enforcement and single commit).");
+  console.log("PASS: Provider spend cap verification passed (parallel cap serialization, one winner, single commit).");
 }
 
 main().catch((err) => {
diff --git a/scripts/verify/verify-topup-approve.ts b/scripts/verify/verify-topup-approve.ts
index b3e6f8f..ff6f6f2 100644
--- a/scripts/verify/verify-topup-approve.ts
+++ b/scripts/verify/verify-topup-approve.ts
@@ -1,13 +1,15 @@
 /**
  * Live Verification Script: Top-up Approval Idempotency
  * Usage: tsx scripts/verify/verify-topup-approve.ts
- * Strictly reads keys from environment variables. Zero hardcoded secrets.
+ * Uses approved service-role RPCs only; never writes protected rows directly.
  */
 import { createClient } from "@supabase/supabase-js";
+import { newVrunPrefix, requireSetupRows } from "./vrun";
 
 const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
 const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
 const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
+const RUN_PREFIX = newVrunPrefix();
 
 if (!SERVICE_KEY) {
   console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY must be provided via environment variable.");
@@ -19,60 +21,63 @@ const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
 });
 
 async function main() {
-  console.log("=== Verifying Live Top-Up Approval Idempotency ===");
+  console.log("=== Verifying Top-Up Approval Idempotency ===");
+  console.log("Run prefix:", RUN_PREFIX);
 
-  const topupId = `tp_live_test_${Date.now()}`;
-  const amountEgp = 50; // 50 EGP -> 500 credits at 0.1 EGP/credit
+  const topupId = `${RUN_PREFIX}topup`;
+  const amountEgp = 50;
+  const { data: topup, error: topupErr } = await supabase
+    .from("topups")
+    .select("id, user_id, amount_egp, status")
+    .eq("id", topupId)
+    .maybeSingle();
+  if (topupErr) throw topupErr;
 
-  // 1. Create pending topup record
-  const { error: insErr } = await supabase.from("topups").insert({
-    id: topupId,
-    user_id: TEST_USER_ID,
-    amount_egp: amountEgp,
-    reference: `REF_${Date.now()}`,
-    sender_name: "مستخدم تجريبي للاختبار",
-    sender_phone: "01000000000",
-    receipt_file_id: "test_receipt_file",
-    status: "pending",
-    created_at: new Date().toISOString(),
-  });
-  if (insErr) throw insErr;
-  console.log(`Created pending topup record: ${topupId}`);
+  if (!topup) {
+    requireSetupRows([{
+      table: "topups",
+      purpose: "pending top-up approval idempotency; no approved RPC creates pending top-ups",
+      row: {
+        id: topupId,
+        user_id: TEST_USER_ID,
+        amount_egp: amountEgp,
+        reference: `${RUN_PREFIX}reference`,
+        sender_name: "Verification test user",
+        sender_phone: "01000000000",
+        receipt_file_id: `${RUN_PREFIX}receipt.png`,
+        status: "pending",
+      },
+    }]);
+  }
+  if (topup.user_id !== TEST_USER_ID || topup.status !== "pending" || Number(topup.amount_egp) !== amountEgp) {
+    throw new Error(`Top-up fixture must be the expected test user's pending row: ${JSON.stringify(topup)}`);
+  }
 
-  // 2. First approval call via approve_topup_atomic RPC
-  const { data: firstRes, error: firstErr } = await supabase.rpc("approve_topup_atomic", {
+  const { data: firstResult, error: firstErr } = await supabase.rpc("approve_topup_atomic", {
     p_topup_id: topupId,
     p_confirmed_amount_egp: amountEgp,
   });
   if (firstErr) throw firstErr;
-  console.log("First approval result:", firstRes);
-
-  if (!firstRes.success || firstRes.already_approved) {
-    throw new Error("First approval should succeed and not be marked already_approved");
+  if (!firstResult?.success || firstResult.already_approved) {
+    throw new Error(`First approval should succeed without already_approved: ${JSON.stringify(firstResult)}`);
   }
 
-  // 3. Second approval call on the SAME topup -> MUST be idempotent
-  const { data: secondRes, error: secondErr } = await supabase.rpc("approve_topup_atomic", {
+  const { data: retryResult, error: retryErr } = await supabase.rpc("approve_topup_atomic", {
     p_topup_id: topupId,
     p_confirmed_amount_egp: amountEgp,
   });
-  if (secondErr) throw secondErr;
-  console.log("Second approval result (retry):", secondRes);
-
-  if (!secondRes.success || !secondRes.already_approved) {
-    throw new Error("Second approval retry must succeed and report already_approved: true");
+  if (retryErr) throw retryErr;
+  if (!retryResult?.success || !retryResult.already_approved) {
+    throw new Error(`Second approval should be idempotent: ${JSON.stringify(retryResult)}`);
   }
 
-  // 4. Verify strictly 1 ledger entry exists for this topup: top_<topupId>
-  const { data: ledgerEntries, error: ledgErr } = await supabase
+  const { data: ledgerEntries, error: ledgerErr } = await supabase
     .from("credit_ledger")
     .select("id, delta")
     .eq("id", `top_${topupId}`);
-  if (ledgErr) throw ledgErr;
-
-  console.log(`Ledger entries for top_${topupId}:`, ledgerEntries);
+  if (ledgerErr) throw ledgerErr;
   if (!ledgerEntries || ledgerEntries.length !== 1) {
-    throw new Error(`Expected exactly 1 ledger entry, found: ${ledgerEntries?.length}`);
+    throw new Error(`Expected one approved-RPC-created top-up ledger row, got ${ledgerEntries?.length}`);
   }
 
   console.log("PASS: Top-up approval idempotency verified (approved twice, credited once).");
diff --git a/scripts/verify/vrun.ts b/scripts/verify/vrun.ts
new file mode 100644
index 0000000..f64ad06
--- /dev/null
+++ b/scripts/verify/vrun.ts
@@ -0,0 +1,23 @@
+import { randomUUID } from "node:crypto";
+
+export function newVrunPrefix(): string {
+  return `vrun_${Date.now()}_${randomUUID()}_`;
+}
+
+export type SetupRequirement = {
+  table: string;
+  purpose: string;
+  row: Record<string, unknown>;
+};
+
+export function requireSetupRows(requirements: SetupRequirement[]): never {
+  throw new Error(
+    [
+      "SETUP_REQUIRED: verification stopped before any mutation.",
+      "No approved RPC creates the required fixture row(s); do not insert them manually.",
+      "Exact required row(s):",
+      JSON.stringify(requirements, null, 2),
+      "Wait for owner direction or an approved fixture-creation RPC before running this check.",
+    ].join("\n"),
+  );
+}

## Fixture inventory and deferred side effects

The scripts use a fresh generated prefix independently per run. The exact suffixes and required fixture values follow; no fixture has been created here. The proposed helper accepts only `job`, `quote`, or `topup` and each ID is `<prefix><suffix>`.

- `verify-accept-quote`: quote `<prefix>quote`, test user `00000000-0000-0000-0000-000000000001`, status `quoted`, hash `8f5fd93beff1b51db9b38272c1c1677803c3614f01ea2024f92f01988bde1584`, `items=[{"capabilitySlug":"tiktok-profile","targetVolumeMin":1,"targetVolumeMax":1}]`, formats `["xlsx","csv"]`, 3 reserved points, expiry 30 minutes in the future; and job `<prefix>job`, status `queued`, endpoint `tiktok-profile`, target 1–1, reserved 3, charged 0, delivered 0. Its verifier remains blocked even if these rows exist because there is no approved atomic quote-acceptance/job-creation RPC.
- `verify-chunk-claim`: job `<prefix>claim_parallel`, status `queued`, step 0, attempt_count 0, unit_price 1, reserved 10, target 5–10, lease NULL, next_attempt_at elapsed.
- `verify-chunk-lifecycle`: job `<prefix>lifecycle`, `running`, step 0, attempt_count 0, unit_price 1, reserve 20, target 10–20, delivered 0, lease NULL; and job `<prefix>completed_guard`, `completed`, step 2, attempt_count 0, unit_price 1, reserve 10, charged 5, delivered 5, lease NULL.
- `verify-concurrency`: 11 queued jobs: `<prefix>parallel_same` with reserve 25 and `<prefix>parallel_diff_1` through `<prefix>parallel_diff_10`, each with reserve 15; all test user, endpoint `tiktok-profile`, lease NULL.
- `verify-release-job`: seven jobs: `<prefix>legacy_two_arg` running/reserve 30/unit_price 1/no lease; `<prefix>forced_lease` running/reserve 20/unit_price NULL/future lease; `<prefix>failed_repair` failed/reserve 12/unit_price NULL/no lease, with valid res_ and no rel_; `<prefix>completed` completed/reserve 5; `<prefix>missing_reserve` queued/reserve 8 with no res_; `<prefix>zero_reserve` queued/reserve 0; and `<prefix>refused` refused/reserve 5. All are test-user rows.
- `verify-settle-job`: `<prefix>settle` running, unit_price 2, delivered 8, reserve 25, target 10–20, no lease; `<prefix>settle_live_lease` running, unit_price 1, delivered 5, reserve 10, future lease; `<prefix>settle_bad_price` running, unit_price NULL, delivered 5, reserve 10, no lease. Each requires a reserve created only by `reserve_credits_atomic` before the calls.
- `verify-spend-cap`: three queued test-user jobs `<prefix>spend_first`, `<prefix>spend_parallel_a`, `<prefix>spend_parallel_b`, endpoint `tiktok-profile`; these satisfy the provider_costs.job_id FK.
- `verify-topup-approve`: pending test-user top-up `<prefix>topup`, 50 EGP, reference `<prefix>reference`, sender name `Verification test user`, sender phone `01000000000`, receipt file `<prefix>receipt.png`.
- `verify-receipt-storage`: service-role receipt object `<test-user-id>/<prefix>receipt.png`; its script attempts removal in a `finally` block during the same run.

The only way the rewritten scripts create `res_` rows is `reserve_credits_atomic`; settlement/release/top-up RPCs may create their normal immutable ledger rows. `verify-spend-cap` creates/commits provider-cost rows through the approved RPCs and does not delete them. The owner should review those expected test leftovers before authorizing any execution. None of the scripts/tests was run for this packet.

