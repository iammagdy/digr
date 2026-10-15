-- Migration: Prevent claiming new chunks once collection is complete
-- This eliminates race conditions where concurrent calls grab leases while files are being uploaded,
-- preventing settle_job_atomic from settling completed multi-chunk jobs.

CREATE OR REPLACE FUNCTION public.claim_job_chunk(p_job_id text, p_expected_step integer, p_lease_seconds integer DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- 2b. Finished check: cannot claim if job already completed collection or reached target volume
  IF v_job.current_cursor = 'completed' OR (v_job.target_volume_max IS NOT NULL AND v_job.delivered_units >= v_job.target_volume_max) THEN
    RETURN jsonb_build_object('claimed', false, 'error', 'already_completed', 'job_id', p_job_id);
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
$function$;
