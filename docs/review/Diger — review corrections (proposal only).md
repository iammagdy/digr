# Diger — review corrections (proposal only)

Prepared from the read-only review on 2026-10-12. No repository files were edited, no SQL was applied, no verification script/test was run, and no secret or `.env.local` content was accessed. The checked-out branch is `migrate/supabase` at `7ba671add916c738bd1f21aff255ff4c09de699d`; the working tree is clean. PR #43 remains open and unmerged.

## Decisions and blockers

1. Keep the existing two-argument `release_job_atomic(TEXT,TEXT)` callable, but replace its body with a strict delegation to the required three-argument overload using `p_force=false`. The three-argument function has no default for `p_force`.
2. At the fifth failure attempt, `record_chunk_failure` calls the strict three-argument overload with `p_force=true`. This is the explicit terminal-failure path from the service-role worker, which may still hold the failed chunk's live lease. All other release calls default to non-force. The release function itself still validates status, reservation, ledger integrity, and idempotency.
3. The existing owner reset is unsafe for the FK graph: it deletes `auth.users` before multiple `RESTRICT` references. A live, read-only `pg_constraint` check confirmed the child-first order below.
4. `verify-spend-cap.ts` writes two provider-cost rows for the UTC day and consumes real cap headroom. It must require `--i-know-this-uses-budget`, and must not run while real jobs are active. The script's cap is current UTC-day spend plus $0.80, so it tests relative cap logic, not the production $0.80 limit itself.
5. `accept_quote_atomic` below is only a proposal. The current quote writer stores quote items as received, and `PlanItem` does not guarantee `unitPricePoints` within each item. The current acceptance helper expects that field. The proposed function therefore fails closed until the quote writer persists the per-item server-calculated unit price. Do not infer it from the total quote amount or the buffer.
6. A read-only catalog query shows the live database currently has only `release_job_atomic(text,text)`. The proposed three-argument overload has not been applied, so post-migration overload routing has not been verified live. PostgREST documentation says overloads with different required argument counts can be called separately.

## 1. Proposed SQL — `claim_job_chunk` NULL guard

The prior request's NULL-step correction remains active. This is the current checked-in function body with only the required NULL guard added before any job lookup; the rest of its logic is unchanged.

```sql
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

REVOKE EXECUTE ON FUNCTION public.claim_job_chunk(TEXT, INT, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_job_chunk(TEXT, INT, INT)
  TO service_role;
```

## 2. Proposed SQL — strict release overload, two-argument delegate, worker failure

This is a single new migration proposal. The strict three-argument signature has no default. The failed-job early return happens only after both `res_<jobId>` and `rel_<jobId>` are verified. If the job is failed but `rel_` is absent, release completes it. Release never needs `unit_price`.

```sql
-- Strict overload; p_force has NO DEFAULT.
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
  v_job public.jobs%ROWTYPE;
  v_reserve public.credit_ledger%ROWTYPE;
  v_release public.credit_ledger%ROWTYPE;
  v_has_release BOOLEAN;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
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

  IF v_job.status NOT IN ('queued', 'running', 'failed') THEN
    RAISE EXCEPTION 'Cannot release job % with status %', p_job_id, v_job.status;
  END IF;

  IF v_job.reserved_credits IS NULL OR v_job.reserved_credits <= 0 THEN
    RAISE EXCEPTION 'Job % has invalid reserved_credits', p_job_id;
  END IF;

  SELECT * INTO v_reserve
  FROM public.credit_ledger
  WHERE id = 'res_' || p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reserve record res_% does not exist for job %', p_job_id, p_job_id;
  END IF;

  IF v_reserve.user_id IS DISTINCT FROM v_job.user_id
     OR v_reserve.type IS DISTINCT FROM 'reserve'
     OR v_reserve.job_id IS DISTINCT FROM p_job_id
     OR v_reserve.delta IS DISTINCT FROM (-v_job.reserved_credits) THEN
    RAISE EXCEPTION 'Reserve record res_% does not match job %', p_job_id, p_job_id;
  END IF;

  SELECT * INTO v_release
  FROM public.credit_ledger
  WHERE id = 'rel_' || p_job_id;
  v_has_release := FOUND;

  IF v_has_release THEN
    IF v_release.user_id IS DISTINCT FROM v_job.user_id
       OR v_release.type IS DISTINCT FROM 'release'
       OR v_release.job_id IS DISTINCT FROM p_job_id
       OR v_release.delta IS DISTINCT FROM v_job.reserved_credits THEN
      RAISE EXCEPTION 'Release record rel_% does not match job %', p_job_id, p_job_id;
    END IF;

    -- Failed is idempotent only after both res_ and rel_ were verified above.
    IF v_job.status = 'failed' THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_released', true,
        'job_id', p_job_id,
        'released_credits', v_job.reserved_credits
      );
    END IF;
  END IF;

  -- Release does not use or require unit_price.
  IF v_job.lease_until IS NOT NULL
     AND v_job.lease_until > v_now
     AND p_force IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'Cannot release job % while active chunk lease is held until %',
      p_job_id, v_job.lease_until;
  END IF;

  IF NOT v_has_release THEN
    INSERT INTO public.credit_ledger
      (id, user_id, delta, type, job_id, note, created_at)
    VALUES
      ('rel_' || p_job_id, v_job.user_id, v_job.reserved_credits, 'release',
       p_job_id, 'إرجاع الحجز بالكامل عند تعثر المهمة', v_now);
  END IF;

  UPDATE public.jobs
  SET status = 'failed',
      charged_credits = 0,
      error_message = COALESCE(p_error_message, error_message, 'فشلت المهمة'),
      lease_until = NULL,
      updated_at = v_now
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

-- Preserve old PostgREST signature, but route through the strict overload.
CREATE OR REPLACE FUNCTION public.release_job_atomic(
  p_job_id TEXT,
  p_error_message TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN public.release_job_atomic(p_job_id, p_error_message, false);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT, BOOLEAN)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.record_chunk_failure(
  p_job_id TEXT,
  p_error_message TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job RECORD;
  v_new_attempts INT;
  v_delay_sec INT;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % not found', p_job_id;
  END IF;

  IF v_job.status IN ('completed', 'failed') THEN
    RETURN jsonb_build_object(
      'success', true,
      'ignored', true,
      'status', v_job.status,
      'job_id', p_job_id
    );
  END IF;

  v_new_attempts := COALESCE(v_job.attempt_count, 0) + 1;

  IF v_new_attempts >= 5 THEN
    -- Authorized terminal-failure path may still hold a live chunk lease.
    PERFORM public.release_job_atomic(
      p_job_id,
      'Exceeded maximum retry attempts (5): ' || COALESCE(p_error_message, 'unknown error'),
      true
    );

    UPDATE public.jobs
    SET attempt_count = v_new_attempts,
        lease_until = NULL,
        updated_at = v_now
    WHERE id = p_job_id;

    RETURN jsonb_build_object(
      'success', true,
      'failed_permanently', true,
      'attempt_count', v_new_attempts,
      'released', true,
      'job_id', p_job_id
    );
  END IF;

  v_delay_sec := LEAST(10 * (2 ^ (v_new_attempts - 1)), 300);

  UPDATE public.jobs
  SET attempt_count = v_new_attempts,
      next_attempt_at = (v_now + (v_delay_sec || ' seconds')::INTERVAL),
      lease_until = NULL,
      status = 'queued',
      error_message = p_error_message,
      updated_at = v_now
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'success', true,
    'failed_permanently', false,
    'attempt_count', v_new_attempts,
    'delay_seconds', v_delay_sec,
    'next_attempt_at', (v_now + (v_delay_sec || ' seconds')::INTERVAL),
    'job_id', p_job_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_chunk_failure(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_chunk_failure(TEXT, TEXT)
  TO service_role;
```

The exception from the strict release RPC aborts the containing call transaction, so the failure count does not advance unless release succeeds. `p_force=true` is used only by the worker's terminal retry path; ordinary two-argument release delegates with `false`.

## 3. Existing pre-launch reset and corrected order

### Current `docs/OWNER_SQL.md` reset block, reproduced exactly

```sql
-- 1. Temporarily disable ledger immutability triggers
ALTER TABLE public.credit_ledger DISABLE TRIGGER trg_block_ledger_mutation;
ALTER TABLE public.credit_ledger DISABLE TRIGGER trg_block_ledger_truncate;

-- 2. Truncate ledger and clean test user records
TRUNCATE TABLE public.credit_ledger;
DELETE FROM public.profiles WHERE id = '00000000-0000-0000-0000-000000000001'::uuid;
DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-000000000001'::uuid;

-- 3. IMMEDIATELY re-enable ledger immutability triggers
ALTER TABLE public.credit_ledger ENABLE TRIGGER trg_block_ledger_mutation;
ALTER TABLE public.credit_ledger ENABLE TRIGGER trg_block_ledger_truncate;

-- 4. Post-reset verification: Ensure ledger is completely empty
SELECT count(*) AS remaining_ledger_rows FROM public.credit_ledger;
```

As written, this is not FK-safe: `auth.users` can be restricted by rows in other public tables, and jobs are themselves referenced by events/costs/artifacts. A live read-only query of `pg_constraint` confirmed the relevant constraints. The pre-launch reset must be used only after the existing non-test-ledger pre-check passes. Corrected order follows.

### Corrected reset SQL — proposed only; do not run

```sql
BEGIN;

-- Prevent concurrent ledger writes; repeat the pre-check under the lock.
LOCK TABLE public.credit_ledger IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.credit_ledger
    WHERE user_id <> '00000000-0000-0000-0000-000000000001'::uuid
  ) THEN
    RAISE EXCEPTION 'Refusing pre-launch reset: non-test ledger rows exist';
  END IF;
END;
$$;

ALTER TABLE public.credit_ledger DISABLE TRIGGER trg_block_ledger_mutation;
ALTER TABLE public.credit_ledger DISABLE TRIGGER trg_block_ledger_truncate;
TRUNCATE TABLE public.credit_ledger;

-- Job-dependent RESTRICT rows must be removed before their jobs.
DELETE FROM public.provider_costs pc
USING public.jobs j
WHERE pc.job_id = j.id
  AND j.user_id = '00000000-0000-0000-0000-000000000001'::uuid;

DELETE FROM public.artifact_versions av
WHERE av.user_id = '00000000-0000-0000-0000-000000000001'::uuid
   OR av.job_id IN (
     SELECT j.id FROM public.jobs j
     WHERE j.user_id = '00000000-0000-0000-0000-000000000001'::uuid
   );

DELETE FROM public.job_events je
WHERE je.user_id = '00000000-0000-0000-0000-000000000001'::uuid
   OR je.job_id IN (
     SELECT j.id FROM public.jobs j
     WHERE j.user_id = '00000000-0000-0000-0000-000000000001'::uuid
   );

-- Then delete all direct RESTRICT references to the test auth user.
DELETE FROM public.jobs WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid;
DELETE FROM public.topups WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid;
DELETE FROM public.plans_quotes WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid;
DELETE FROM public.llm_usage WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid;
DELETE FROM public.admin_audit_log WHERE actor_id = '00000000-0000-0000-0000-000000000001'::uuid;
DELETE FROM public.profiles WHERE id = '00000000-0000-0000-0000-000000000001'::uuid;

-- auth.users is last, after the RESTRICT references above are gone.
DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-000000000001'::uuid;

ALTER TABLE public.credit_ledger ENABLE TRIGGER trg_block_ledger_mutation;
ALTER TABLE public.credit_ledger ENABLE TRIGGER trg_block_ledger_truncate;

SELECT count(*) AS remaining_ledger_rows FROM public.credit_ledger;
COMMIT;
```

The live FK results include: `credit_ledger.user_id → auth.users` RESTRICT (handled by the guarded truncate); `jobs.user_id`, `job_events.user_id/job_id`, `topups.user_id`, `plans_quotes.user_id`, `llm_usage.user_id`, `admin_audit_log.actor_id`, and `profiles.id` RESTRICT; `provider_costs.job_id → jobs` and `artifact_versions.job_id → jobs` RESTRICT. The auth-system child references observed were CASCADE or SET NULL. The proposed order removes job children first, then jobs and other direct references, then auth.users. It was not run.

## 4. `create_verify_fixture` removal and documentation diffs

The current repository has no `docs/CUTOVER.md` and no installed migration defining `create_verify_fixture`. If that temporary helper is approved and installed for tests, it must be removed before launch.

### Proposed `docs/OWNER_SQL.md` diff

```diff
diff --git a/docs/OWNER_SQL.md b/docs/OWNER_SQL.md
--- a/docs/OWNER_SQL.md
+++ b/docs/OWNER_SQL.md
@@
 > The known test-only residue is limited to the dedicated test user: **24 compensating ledger rows** and **71 orphan ledger references**. Do not edit or delete these ledger records manually. They are to be removed only by the documented pre-launch reset above, after its pre-check passes. This note is not authorization to run the reset, and it must never be run after launch.
 
+### Step 1b: Remove temporary verification fixture helper
+
+If the temporary test fixture RPC was installed, remove it before launch:
+
+```sql
+DROP FUNCTION public.create_verify_fixture(TEXT, TEXT, TEXT, JSONB);
+```
+
 ### Step 2: Clean Reset Execution
```

### Proposed new `docs/CUTOVER.md` diff

```diff
diff --git a/docs/CUTOVER.md b/docs/CUTOVER.md
new file mode 100644
--- /dev/null
+++ b/docs/CUTOVER.md
@@
+# Diger Pre-Launch Cutover
+
+## Before launch
+
+1. Complete review of the migration ledger, verification outcomes, and owner-only checks.
+2. If the temporary fixture RPC was installed, remove it:
+
+   ```sql
+   DROP FUNCTION public.create_verify_fixture(TEXT, TEXT, TEXT, JSONB);
+   ```
+
+3. Use the pre-check and child-first reset in `docs/OWNER_SQL.md` before the first real user.
+   Never run that reset after launch.
+4. Do not run `verify-spend-cap.ts` while real jobs are active. It consumes UTC-day
+   provider-cost headroom; details and the required confirmation flag are below.
+
+## Expected verifier leftovers
+
+Counts below include the existing fixture rows supplied before the run. The scripts do
+not create those fixture rows directly. Each run uses its own `vrun_<millis>_<uuid>_`
+prefix. A partial failure can leave fewer or partially written approved-RPC rows.
+
+| Script | jobs remaining | plans_quotes remaining | topups remaining | provider_costs remaining | credit_ledger additions |
+|---|---|---|---|---|---|
+| `verify-accept-quote.ts` | 1 queued fixture, unchanged | 1 quoted fixture, unchanged | 0 | 0 | 0; current script blocks before mutations because there is no atomic accept RPC wired in |
+| `verify-chunk-claim.ts` | 1 fixture; ends running with an active lease | 0 | 0 | 0 | 0 |
+| `verify-chunk-lifecycle.ts` | 2 fixtures; lifecycle job ends failed, completed guard unchanged | 0 | 0 | 0 | 2 rows for lifecycle job: `res_` and `rel_` |
+| `verify-concurrency.ts` | 11 fixtures; end failed after successful release cleanup | 0 | 0 | 0 | 22 rows: 11 `res_` + 11 `rel_` |
+| `verify-receipt-storage.ts` | 0 | 0 | 0 | 0 | 0; receipt test object removed in same run |
+| `verify-release-job.ts` | 7 fixtures remain; first three end failed; guards remain in their tested states | 0 | 0 | 0 | 6 rows: 3 `res_` + 3 `rel_` |
+| `verify-settle-job.ts` | 3 fixtures remain; main ends completed, two guards remain running | 0 | 0 | 0 | 5 rows: 3 `res_` + 1 `rel_` + 1 `chg_` |
+| `verify-spend-cap.ts` | 3 queued fixtures remain | 0 | 0 | 2 rows remain; actual costs `$0.45` and `$0.15` | 0 |
+| `verify-topup-approve.ts` | 0 | 0 | 1 fixture remains, status becomes approved | 1 `top_` row created by `approve_topup_atomic` |
+
+The job, quote, and top-up rows above are pre-existing fixtures and remain after the
+verification scripts. Reservations are created only through `reserve_credits_atomic`;
+release/settlement/top-up ledger entries are created only through their approved RPCs.
+No verifier manually deletes ledger rows. Provider-cost rows from the spend-cap test remain.
+
+## Spend-cap test warning
+
+Run only with `--i-know-this-uses-budget`, and never while real jobs are active. The
+script reserves estimates `$0.50` and `$0.20` on the UTC day, one of which is denied
+under the test cap; the successful estimates are committed at actuals `$0.45` and
+`$0.15`. It sets its cap to `current UTC-day spend + $0.80`, so it tests relative
+cap enforcement, **not** the production `$0.80` limit by itself. These writes consume
+real UTC-day cap headroom and remain as two `provider_costs` rows.
+```

## 5. Proposed `verify-spend-cap.ts` diff

```diff
diff --git a/scripts/verify/verify-spend-cap.ts b/scripts/verify/verify-spend-cap.ts
--- a/scripts/verify/verify-spend-cap.ts
+++ b/scripts/verify/verify-spend-cap.ts
@@
 /**
  * Live Verification Script: Provider Daily Spend Cap & Commit
- * Usage: tsx scripts/verify/verify-spend-cap.ts
+ * WARNING: Do not run while real jobs are active. This writes two provider_costs
+ * rows for the current UTC day and consumes real daily-cap headroom; no provider
+ * API is called. It estimates $0.50 + $0.20 and commits $0.45 + $0.15.
+ * Its cap is current UTC-day spend + $0.80, so this tests relative cap logic,
+ * NOT the production $0.80 cap value itself.
+ * Usage: tsx scripts/verify/verify-spend-cap.ts --i-know-this-uses-budget
  * Mutations use approved service-role RPCs only; no direct provider_costs writes.
  */
@@
 const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
 const RUN_PREFIX = newVrunPrefix();
+const BUDGET_CONFIRMATION_FLAG = "--i-know-this-uses-budget";
+
+if (!process.argv.slice(2).includes(BUDGET_CONFIRMATION_FLAG)) {
+  console.error(`Refusing to run without ${BUDGET_CONFIRMATION_FLAG}.`);
+  console.error(`Usage: tsx scripts/verify/verify-spend-cap.ts ${BUDGET_CONFIRMATION_FLAG}`);
+  process.exit(1);
+}
```

## 6. Proposed atomic quote acceptance SQL

This moves reservation, job creation, event creation, and the quote status transition into one PostgreSQL transaction. It uses the stored `total_reserved_credits` as-is (including the existing quote buffer), uses the per-item `unitPricePoints` for `jobs.unit_price`, and does not recompute or change any price. It locks the quote and profile, checks ownership/status/expiry/hash, enforces the existing maximum of two active jobs, and uses a deterministic job ID derived from quote ID for idempotency.

```sql
CREATE OR REPLACE FUNCTION public.accept_quote_atomic(
  p_quote_id TEXT,
  p_user_id UUID,
  p_expected_quote_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_quote public.plans_quotes%ROWTYPE;
  v_existing_job public.jobs%ROWTYPE;
  v_reservation public.credit_ledger%ROWTYPE;
  v_items JSONB;
  v_item JSONB;
  v_job_id TEXT;
  v_reserved NUMERIC;
  v_unit_price NUMERIC;
  v_target_min INT;
  v_target_max INT;
  v_endpoint_id TEXT;
  v_active_jobs BIGINT;
  v_reserve_result JSONB;
  v_updated_rows INT;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
  IF p_quote_id IS NULL OR p_user_id IS NULL
     OR p_expected_quote_hash IS NULL
     OR p_expected_quote_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_required_argument');
  END IF;

  SELECT * INTO v_quote
  FROM public.plans_quotes
  WHERE id = p_quote_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_not_found');
  END IF;
  IF v_quote.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_user_mismatch');
  END IF;
  IF v_quote.quote_hash IS DISTINCT FROM p_expected_quote_hash THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_hash_mismatch');
  END IF;

  -- Stable per-quote job ID makes duplicate acceptance calls idempotent.
  v_job_id := 'job_quote_' || md5(p_quote_id);

  IF v_quote.status = 'accepted' THEN
    SELECT * INTO v_existing_job FROM public.jobs WHERE id = v_job_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Accepted quote % has no deterministic job %', p_quote_id, v_job_id;
    END IF;

    SELECT * INTO v_reservation
    FROM public.credit_ledger
    WHERE id = 'res_' || v_job_id;
    IF NOT FOUND
       OR v_existing_job.user_id IS DISTINCT FROM v_quote.user_id
       OR v_existing_job.reserved_credits IS DISTINCT FROM v_quote.total_reserved_credits
       OR v_reservation.user_id IS DISTINCT FROM v_quote.user_id
       OR v_reservation.type IS DISTINCT FROM 'reserve'
       OR v_reservation.job_id IS DISTINCT FROM v_job_id
       OR v_reservation.delta IS DISTINCT FROM (-v_quote.total_reserved_credits) THEN
      RAISE EXCEPTION 'Accepted quote % has inconsistent job or reservation', p_quote_id;
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'already_accepted', true,
      'quote_id', p_quote_id,
      'job_id', v_job_id,
      'reserved_credits', v_quote.total_reserved_credits
    );
  END IF;

  IF v_quote.status <> 'quoted' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_quote_status', 'status', v_quote.status);
  END IF;
  IF v_quote.expires_at <= v_now THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_expired');
  END IF;

  v_reserved := v_quote.total_reserved_credits;
  IF v_reserved IS NULL OR v_reserved <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_reserved_credits');
  END IF;

  IF jsonb_typeof(v_quote.items) = 'array' THEN
    v_items := v_quote.items;
  ELSIF jsonb_typeof(v_quote.items) = 'object' THEN
    v_items := v_quote.items -> 'items';
  ELSE
    v_items := NULL;
  END IF;

  IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_quote_items');
  END IF;
  IF jsonb_array_length(v_items) <> 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'single_item_quote_required');
  END IF;

  v_item := v_items -> 0;
  IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_item -> 'unitPricePoints') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing_item_unit_price');
  END IF;
  v_unit_price := (v_item ->> 'unitPricePoints')::NUMERIC;
  IF v_unit_price <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_item_unit_price');
  END IF;

  v_target_min := COALESCE(NULLIF(v_item ->> 'targetVolumeMin', '')::INT, 1);
  v_target_max := COALESCE(NULLIF(v_item ->> 'targetVolumeMax', '')::INT, 1);
  IF v_target_min < 1 OR v_target_max < v_target_min OR v_target_max > 5000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_target_volume');
  END IF;

  v_endpoint_id := COALESCE(
    NULLIF(v_item ->> 'endpointId', ''),
    NULLIF(v_item ->> 'capabilitySlug', ''),
    'default'
  );

  -- Serialize the current two-active-job limit for this user.
  PERFORM 1 FROM public.profiles WHERE id = v_quote.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'profile_not_found');
  END IF;
  SELECT count(*) INTO v_active_jobs
  FROM public.jobs
  WHERE user_id = v_quote.user_id AND status IN ('queued', 'running');
  IF v_active_jobs >= 2 THEN
    RETURN jsonb_build_object('success', false, 'error', 'concurrency_limit');
  END IF;

  -- This approved RPC alone writes the reservation. The stored quote total is authoritative.
  v_reserve_result := public.reserve_credits_atomic(
    v_quote.user_id, v_job_id, v_reserved, 'حجز رصيد للطلب'
  );
  IF NOT COALESCE((v_reserve_result ->> 'success')::BOOLEAN, false) THEN
    RETURN v_reserve_result;
  END IF;

  SELECT * INTO v_reservation FROM public.credit_ledger WHERE id = 'res_' || v_job_id;
  IF NOT FOUND
     OR v_reservation.user_id IS DISTINCT FROM v_quote.user_id
     OR v_reservation.type IS DISTINCT FROM 'reserve'
     OR v_reservation.job_id IS DISTINCT FROM v_job_id
     OR v_reservation.delta IS DISTINCT FROM (-v_reserved) THEN
    RAISE EXCEPTION 'Reservation res_% does not match quote %', v_job_id, p_quote_id;
  END IF;

  INSERT INTO public.jobs (
    id, user_id, status, endpoint_id,
    target_volume_min, target_volume_max,
    reserved_credits, charged_credits, delivered_units,
    unit_price, attempt_count, step, next_attempt_at,
    created_at, updated_at
  ) VALUES (
    v_job_id, v_quote.user_id, 'queued', v_endpoint_id,
    v_target_min, v_target_max,
    v_reserved, 0, 0,
    v_unit_price, 0, 0, v_now,
    v_now, v_now
  );

  INSERT INTO public.job_events (job_id, user_id, message, units, event_type, created_at)
  VALUES (
    v_job_id, v_quote.user_id,
    'تم اعتماد الخطة وحجز النقاط بنجاح. جاري بدء معالجة الطلب...',
    0, 'progress', v_now
  );

  UPDATE public.plans_quotes
  SET status = 'accepted'
  WHERE id = p_quote_id AND status = 'quoted' AND expires_at > v_now;
  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION 'Quote % was not eligible for acceptance', p_quote_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_accepted', false,
    'quote_id', p_quote_id,
    'job_id', v_job_id,
    'reserved_credits', v_reserved
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.accept_quote_atomic(TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_quote_atomic(TEXT, UUID, TEXT)
  TO service_role;
```

The transaction ensures that if the job/event insert or quote status update fails, the reservation created by the nested `reserve_credits_atomic` call rolls back too. The current quote writer must first persist `unitPricePoints` in the item. Existing already-accepted quotes from the old random-job-ID path also need a compatibility decision before deployment; this deterministic proposal cannot identify an old random job ID from quote ID alone.

### Suggested application diff to use the RPC

This is a proposal only. The API route must continue authenticating the user and pass that verified `user.id`; the client must not supply an authoritative user ID. The route/UI already passes `quote.planHash`, so make it required and let the atomic RPC do the state-changing work.

```diff
diff --git a/src/lib/supabase/quoteAccept.ts b/src/lib/supabase/quoteAccept.ts
--- a/src/lib/supabase/quoteAccept.ts
+++ b/src/lib/supabase/quoteAccept.ts
@@
-import { computePlanHash, parseStoredPlan, PlanItem } from "../../functions/shared/planManager";
-import { isQuoteExpired } from "../../functions/shared/quotes";
-import { reserveCreditsAtomic } from "./ledger";
-import crypto from "crypto";
@@
-  expectedPlanHash?: string;
+  expectedPlanHash: string;
@@
 export async function acceptQuoteSupabase(
   adminClient: SupabaseClient,
   options: AcceptQuoteOptions
 ): Promise<AcceptQuoteResult> {
   const { userId, quoteId, expectedPlanHash } = options;
-
-  // Replace the current read → reserve → quote update → job insert sequence.
-  // The remaining old logic is removed; no direct table mutation stays here.
-  const { data, error } = await adminClient.rpc("accept_quote_atomic", {
+  if (!/^[0-9a-f]{64}$/.test(expectedPlanHash)) {
+    return { success: false, statusCode: 400, errorAr: "بيانات عرض السعر غير صالحة." };
+  }
+
+  const { data, error } = await adminClient.rpc("accept_quote_atomic", {
     p_quote_id: quoteId,
     p_user_id: userId,
     p_expected_quote_hash: expectedPlanHash,
   });
-
-  // Translate RPC result/error codes to safe Arabic responses; never expose raw SQL errors.
+  if (error) {
+    return { success: false, statusCode: 500, errorAr: "تعذر اعتماد العرض الآن." };
+  }
+  if (!data?.success) {
+    const errorAr = data?.error === "insufficient_balance"
+      ? `رصيدك الحالي (${data.balance ?? 0} نقطة) غير كافٍ لتغطية تكلفة العرض. يرجى شحن الرصيد أولاً.`
+      : data?.error === "quote_expired"
+        ? "انتهت صلاحية هذا العرض. يرجى طلب عرض جديد."
+        : data?.error === "concurrency_limit"
+          ? "لديك طلبات قيد المعالجة بالحد الأقصى. يرجى انتظار اكتمالها."
+          : "تعذر اعتماد العرض. يرجى طلب عرض سعر جديد.";
+    return { success: false, statusCode: data?.error === "insufficient_balance" ? 402 : 409, errorAr };
+  }
+  return {
+    success: true,
+    jobId: data.job_id,
+    quoteId: data.quote_id,
+    reservedCredits: Number(data.reserved_credits),
+  };
 }
```

This is an outline diff, not directly applicable as written if the source file's comments/import formatting have changed. It shows the crucial contract: one service-role RPC replaces separate reservation, quote update, and job insert calls.

## 7. Live read-only evidence

### Current overloads

Read-only query run against project `pfinlfaqwnytesedchik`:

```sql
SELECT p.oid::regprocedure AS signature, p.pronargs, p.pronargdefaults, p.proargnames
FROM pg_proc AS p
JOIN pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'release_job_atomic'
ORDER BY p.pronargs
LIMIT 10;
```

Observed result: `release_job_atomic(text,text)`, `pronargs=2`, `pronargdefaults=1`, argument names `p_job_id,p_error_message`. No three-argument overload currently exists; it was not applied. This checks present catalog state, not future RPC routing.

PostgREST docs consulted: https://docs.postgrest.org/en/v14/references/api/functions.html — the overloaded-functions section demonstrates separate calls by different argument counts. With the proposed three-argument overload having no default, the two-key request stays matched to the old two-argument signature. This is documentation-based, not a post-migration live test.

### Live foreign-key catalog check

A second read-only `pg_constraint` query inspected FKs referencing `auth.users` and `public.jobs`. It confirmed the requested RESTRICT ordering:

- `credit_ledger.user_id → auth.users` RESTRICT; the guarded truncate handles it.
- `jobs.user_id → auth.users` RESTRICT.
- `job_events.job_id → jobs` and `job_events.user_id → auth.users` RESTRICT.
- `topups.user_id`, `plans_quotes.user_id`, `llm_usage.user_id`, `admin_audit_log.actor_id`, and `profiles.id` → `auth.users` RESTRICT.
- `provider_costs.job_id → jobs` and `artifact_versions.job_id → jobs` RESTRICT.
- `artifact_versions.user_id → auth.users` is CASCADE; auth-system child references observed were CASCADE or SET NULL.

The query was read-only and limited to catalog metadata; no table rows were changed.

## Final report — five short Arabic lines

١. لم أطبّق SQL أو أشغّل سكربتات؛ الفرع نظيف، وPR #43 مفتوح وغير مدموج.
٢. `release_job_atomic` ذو معاملين يمرّر `false`؛ والمحاولة الخامسة تستخدم `true` من `record_chunk_failure` مع lease العامل.
٣. reset الحالي غير آمن للـFK؛ الترتيب المصحح يحذف children ثم jobs وباقي مراجع المستخدم قبل `auth.users`.
٤. spend-cap يحتاج `--i-know-this-uses-budget`، ولا يعمل أثناء jobs حقيقية؛ cap الاختبار نسبي ويترك صفّي تكلفة.
٥. `accept_quote_atomic` مقترح ذري، لكنه ينتظر تخزين `unitPricePoints` داخل كل quote item؛ الـoverload الحي الحالي اثنان فقط.