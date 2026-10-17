-- Recovery migration proposal: allow settlement after persisted collection completion even if a stale lease remains.

CREATE OR REPLACE FUNCTION public.settle_job_atomic(
  p_job_id TEXT,
  p_points_cap NUMERIC DEFAULT 600,
  p_result_file_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- A live lease blocks settlement while collection is incomplete. Once the worker has
  -- persisted the terminal cursor or delivered the requested maximum, collection is final;
  -- claim_job_chunk rejects further claims in that state, so retire any stale lease and settle.
  IF v_job.lease_until IS NOT NULL AND v_job.lease_until > timezone('utc'::text, now()) THEN
    IF v_job.current_cursor = 'completed' OR
       (v_job.target_volume_max IS NOT NULL AND COALESCE(v_job.delivered_units, 0) >= v_job.target_volume_max) THEN
      UPDATE public.jobs SET lease_until = NULL, updated_at = timezone('utc'::text, now()) WHERE id = p_job_id;
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
$$;

CREATE OR REPLACE FUNCTION public.release_job_atomic(
  p_job_id TEXT,
  p_error_message TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job RECORD;
  v_rel_exists BOOLEAN;
BEGIN
  -- 1. Lock job row
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % not found', p_job_id;
  END IF;

  -- 2. Idempotency check: if already failed, return early
  IF v_job.status = 'failed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_released', true,
      'job_id', p_job_id,
      'released_credits', v_job.reserved_credits
    );
  END IF;

  IF v_job.status = 'completed' THEN
    RAISE EXCEPTION 'Cannot release already completed job %', p_job_id;
  END IF;

  -- 3. Accounting integrity check: reserve must exist in ledger
  IF v_job.reserved_credits IS NULL OR v_job.reserved_credits <= 0 THEN
    RAISE EXCEPTION 'Job % has invalid reserved_credits', p_job_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = ('res_' || p_job_id)) THEN
    RAISE EXCEPTION 'Reserve record res_% does not exist for job %', p_job_id, p_job_id;
  END IF;

  -- 4. Release hold: insert rel_<jobId> if not already present
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
      'إرجاع الحجز بالكامل عند تعثر المهمة',
      timezone('utc'::text, now())
    );
  END IF;

  -- 5. Mark job failed (zero charge debit)
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

REVOKE ALL ON FUNCTION public.settle_job_atomic(TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_job_atomic(TEXT, NUMERIC, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.release_job_atomic(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT) TO service_role;
