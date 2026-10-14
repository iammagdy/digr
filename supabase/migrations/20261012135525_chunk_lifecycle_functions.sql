-- Migration: Chunk Claiming, Progress Completion, and Failure Handling

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
  IF p_expected_step IS NOT NULL AND v_job.step != p_expected_step THEN
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

CREATE OR REPLACE FUNCTION public.complete_chunk(
  p_job_id TEXT,
  p_expected_step INT,
  p_new_cursor TEXT,
  p_new_delivered_units INT,
  p_cost_usd NUMERIC DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job RECORD;
BEGIN
  -- 1. Lock job row
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % not found', p_job_id;
  END IF;

  -- 2. Idempotency guard: if step has already advanced, do not re-apply
  IF v_job.step > p_expected_step THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_completed', true,
      'job_id', p_job_id,
      'current_step', v_job.step,
      'delivered_units', v_job.delivered_units
    );
  END IF;

  IF v_job.step < p_expected_step THEN
    RAISE EXCEPTION 'Step mismatch for job %: expected % but current is %', p_job_id, p_expected_step, v_job.step;
  END IF;

  -- 3. Bounds validation: delivered_units cannot decrease or exceed target_volume_max
  IF p_new_delivered_units < COALESCE(v_job.delivered_units, 0) THEN
    RAISE EXCEPTION 'Delivered units cannot decrease for job %: current % but got %',
      p_job_id, v_job.delivered_units, p_new_delivered_units;
  END IF;

  IF v_job.target_volume_max IS NOT NULL AND p_new_delivered_units > v_job.target_volume_max THEN
    RAISE EXCEPTION 'Delivered units % exceeds target_volume_max % for job %',
      p_new_delivered_units, v_job.target_volume_max, p_job_id;
  END IF;

  -- 4. Advance step, persist cursor and units, and clear lease
  UPDATE public.jobs
  SET step = v_job.step + 1,
      current_cursor = p_new_cursor,
      delivered_units = p_new_delivered_units,
      accumulated_cost_usd = COALESCE(accumulated_cost_usd, 0) + COALESCE(p_cost_usd, 0),
      lease_until = NULL,
      updated_at = timezone('utc'::text, now())
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'success', true,
    'already_completed', false,
    'job_id', p_job_id,
    'step', v_job.step + 1,
    'delivered_units', p_new_delivered_units,
    'cursor', p_new_cursor
  );
END;
$$;

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

  -- 3. Terminal failure threshold: 5 attempts triggers release_job_atomic
  IF v_new_attempts >= 5 THEN
    PERFORM public.release_job_atomic(
      p_job_id,
      'Exceeded maximum retry attempts (5): ' || COALESCE(p_error_message, 'unknown error')
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

REVOKE EXECUTE ON FUNCTION public.claim_job_chunk(TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_job_chunk(TEXT, INT, INT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.complete_chunk(TEXT, INT, TEXT, INT, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_chunk(TEXT, INT, TEXT, INT, NUMERIC) TO service_role;

REVOKE EXECUTE ON FUNCTION public.record_chunk_failure(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_chunk_failure(TEXT, TEXT) TO service_role;
