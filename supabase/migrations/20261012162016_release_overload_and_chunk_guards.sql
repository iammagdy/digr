-- Migration: release_overload_and_chunk_guards
-- 1. claim_job_chunk NULL guard on p_expected_step
-- 2. Strict release_job_atomic(TEXT, TEXT, BOOLEAN) with no default on p_force
-- 3. Delegating 2-argument release_job_atomic(TEXT, TEXT) calling strict overload with p_force = false
-- 4. record_chunk_failure calling 3-argument release_job_atomic with p_force = true on 5th attempt
-- 5. Revoke from PUBLIC, anon, authenticated; Grant to service_role

-- 1. claim_job_chunk with NULL step guard
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
  -- Strict NULL guard on expected step
  IF p_expected_step IS NULL THEN
    RAISE EXCEPTION 'p_expected_step must not be NULL';
  END IF;

  -- 1. Row lock on the job
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'error', 'job_not_found', 'job_id', p_job_id);
  END IF;

  -- 2. Status check: must be queued or running
  IF v_job.status NOT IN ('queued', 'running') THEN
    RETURN jsonb_build_object('claimed', false, 'error', 'invalid_status', 'status', v_job.status, 'job_id', p_job_id);
  END IF;

  -- 3. Backoff check: next_attempt_at must have elapsed
  IF v_job.next_attempt_at > v_now THEN
    RETURN jsonb_build_object('claimed', false, 'error', 'backoff_active', 'next_attempt_at', v_job.next_attempt_at, 'job_id', p_job_id);
  END IF;

  -- 4. Step matching check
  IF v_job.step != p_expected_step THEN
    RETURN jsonb_build_object('claimed', false, 'error', 'step_mismatch', 'current_step', v_job.step, 'expected_step', p_expected_step, 'job_id', p_job_id);
  END IF;

  -- 5. Active lease check: cannot claim if unexpired lease is held
  IF v_job.lease_until IS NOT NULL AND v_job.lease_until > v_now THEN
    RETURN jsonb_build_object('claimed', false, 'error', 'lease_active', 'lease_until', v_job.lease_until, 'job_id', p_job_id);
  END IF;

  -- 6. Grant lease (attempt_count is NOT incremented on successful claim)
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

-- 2. Strict 3-argument release_job_atomic (NO default on p_force)
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

  -- 2. Status validation
  IF v_job.status = 'completed' THEN
    RAISE EXCEPTION 'Cannot release already completed job %', p_job_id;
  END IF;

  IF v_job.status NOT IN ('queued', 'running', 'failed') THEN
    RAISE EXCEPTION 'Cannot release job % with invalid status %', p_job_id, v_job.status;
  END IF;

  -- 3. Accounting integrity check: reserve must exist in ledger
  IF v_job.reserved_credits IS NULL OR v_job.reserved_credits <= 0 THEN
    RAISE EXCEPTION 'Job % has invalid reserved_credits', p_job_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = ('res_' || p_job_id)) THEN
    RAISE EXCEPTION 'Reserve record res_% does not exist for job %', p_job_id, p_job_id;
  END IF;

  -- 4. Active lease check: cannot release without force while active unexpired lease is held
  IF v_job.lease_until IS NOT NULL AND v_job.lease_until > timezone('utc'::text, now()) AND NOT p_force THEN
    RAISE EXCEPTION 'Cannot release job % while active chunk lease is held until %', p_job_id, v_job.lease_until;
  END IF;

  -- 5. Check if rel_ row already exists in ledger
  SELECT EXISTS(
    SELECT 1 FROM public.credit_ledger WHERE id = ('rel_' || p_job_id)
  ) INTO v_rel_exists;

  -- Idempotency check: if already failed AND rel_ row already exists, return early
  IF v_job.status = 'failed' AND v_rel_exists THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_released', true,
      'job_id', p_job_id,
      'released_credits', v_job.reserved_credits
    );
  END IF;

  -- 6. Insert rel_<jobId> if not already present (covers regular release and failed repair)
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

  -- 7. Mark job failed (zero charge debit) and clear lease
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

-- 3. Delegating 2-argument release_job_atomic
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

-- 4. record_chunk_failure updated to call 3-argument release_job_atomic with p_force = true on 5th attempt
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
  -- 1. Lock job row
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % not found', p_job_id;
  END IF;

  -- 2. Terminal guard: if job is already completed or failed, do nothing and return early
  IF v_job.status IN ('completed', 'failed') THEN
    RETURN jsonb_build_object(
      'success', true,
      'ignored', true,
      'status', v_job.status,
      'job_id', p_job_id
    );
  END IF;

  v_new_attempts := COALESCE(v_job.attempt_count, 0) + 1;

  -- 3. Terminal failure threshold: 5 attempts triggers release_job_atomic with force = true
  IF v_new_attempts >= 5 THEN
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

  -- 4. Exponential backoff: min(10 * 2^(n-1), 300) seconds
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

-- 5. Strict service_role privileges
REVOKE EXECUTE ON FUNCTION public.claim_job_chunk(TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_job_chunk(TEXT, INT, INT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT, BOOLEAN) TO service_role;

REVOKE EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.record_chunk_failure(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_chunk_failure(TEXT, TEXT) TO service_role;
