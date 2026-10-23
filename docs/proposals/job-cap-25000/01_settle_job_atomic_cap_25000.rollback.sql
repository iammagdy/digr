-- PROPOSAL, NOT APPLIED. Run by hand in the Supabase SQL editor after the owner's review.
-- ROLLBACK of Step 1 of 4: settle_job_atomic back to the cap 600
-- Restores the production definition byte for byte.
-- Only the per-job cap constant changes (600 -> 25000). Locks, idempotency, deterministic ids and the charge formula are exactly the PRODUCTION definition
-- (read with SELECT on 2026-10-21, saved in tests/replica/prod-definitions/). Run 00_verify_before_apply.sql first: if the live definition differs, stop.
-- SECURITY DEFINER with a pinned search_path is kept; execute is revoked from PUBLIC, anon and authenticated and granted to service_role only (last two statements).

CREATE OR REPLACE FUNCTION public.settle_job_atomic(p_job_id text, p_points_cap numeric DEFAULT 600, p_result_file_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_job RECORD;
  v_raw_charge NUMERIC;
  v_final_charge NUMERIC;
  v_rel_exists BOOLEAN;
  v_chg_exists BOOLEAN;
BEGIN
  -- 1. Lock job row
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % not found', p_job_id;
  END IF;

  -- 2. Idempotency check: if already completed, return current state
  IF v_job.status = 'completed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_settled', true,
      'job_id', p_job_id,
      'charged_credits', v_job.charged_credits,
      'delivered_units', v_job.delivered_units
    );
  END IF;

  -- 3. Strict status requirement: must be currently running
  IF v_job.status != 'running' THEN
    RAISE EXCEPTION 'Cannot settle job % with status % (must be running)', p_job_id, v_job.status;
  END IF;

  -- 4. Active lease check: cannot settle an incomplete collection.
  -- When collection is persisted as complete, retire the stale lease and continue.
  IF v_job.lease_until IS NOT NULL AND v_job.lease_until > timezone('utc'::text, now()) THEN
    IF v_job.current_cursor = 'completed' OR
       COALESCE(v_job.delivered_units, 0) >= v_job.target_volume_max THEN
      UPDATE public.jobs
      SET lease_until = NULL,
          updated_at = timezone('utc'::text, now())
      WHERE id = p_job_id;
    ELSE
      RAISE EXCEPTION 'Cannot settle job % while active chunk lease is held until %', p_job_id, v_job.lease_until;
    END IF;
  END IF;

  -- 5. Unit price integrity: must be present and positive (no default fallback)
  IF v_job.unit_price IS NULL OR v_job.unit_price <= 0 THEN
    RAISE EXCEPTION 'Job % has invalid unit_price: %', p_job_id, v_job.unit_price;
  END IF;

  -- 6. Accounting integrity check: reserve must exist in ledger
  IF v_job.reserved_credits IS NULL OR v_job.reserved_credits <= 0 THEN
    RAISE EXCEPTION 'Job % has invalid reserved_credits', p_job_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = ('res_' || p_job_id)) THEN
    RAISE EXCEPTION 'Reserve record res_% does not exist for job %', p_job_id, p_job_id;
  END IF;

  -- 7. Release hold first: insert rel_<jobId> if not already present
  SELECT EXISTS(
    SELECT 1 FROM public.credit_ledger WHERE id = ('rel_' || p_job_id)
  ) INTO v_rel_exists;

  IF NOT v_rel_exists THEN
    INSERT INTO public.credit_ledger (
      id,
      user_id,
      delta,
      type,
      job_id,
      note,
      created_at
    )
    VALUES (
      'rel_' || p_job_id,
      v_job.user_id,
      v_job.reserved_credits,
      'release',
      p_job_id,
      'إرجاع الحجز عند التسوية النهائية للمهمة',
      timezone('utc'::text, now())
    );
  END IF;

  -- 8. Calculate charge from stored DB values
  v_raw_charge := CEIL(COALESCE(v_job.delivered_units, 0) * v_job.unit_price);
  v_final_charge := LEAST(v_raw_charge, v_job.reserved_credits, p_points_cap);

  -- 9. Debit actual charge: insert chg_<jobId> if not already present
  SELECT EXISTS(
    SELECT 1 FROM public.credit_ledger WHERE id = ('chg_' || p_job_id)
  ) INTO v_chg_exists;

  IF NOT v_chg_exists AND v_final_charge > 0 THEN
    INSERT INTO public.credit_ledger (
      id,
      user_id,
      delta,
      type,
      job_id,
      note,
      created_at
    )
    VALUES (
      'chg_' || p_job_id,
      v_job.user_id,
      -v_final_charge,
      'charge',
      p_job_id,
      'خصم تكلفة النتائج المسلمة',
      timezone('utc'::text, now())
    );
  END IF;

  -- 10. Finalize job status
  UPDATE public.jobs
  SET status = 'completed',
      charged_credits = v_final_charge,
      result_file_id = COALESCE(p_result_file_id, result_file_id),
      lease_until = NULL,
      updated_at = timezone('utc'::text, now())
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'success', true,
    'already_settled', false,
    'job_id', p_job_id,
    'user_id', v_job.user_id,
    'reserved_credits', v_job.reserved_credits,
    'charged_credits', v_final_charge,
    'delivered_units', v_job.delivered_units
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.settle_job_atomic(text,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_job_atomic(text,numeric,text) TO service_role;
