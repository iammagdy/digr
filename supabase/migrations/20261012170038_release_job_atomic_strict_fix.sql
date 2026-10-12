-- Migration: release_job_atomic_strict_fix
-- 1. Corrected 3-argument release_job_atomic (IS DISTINCT FROM TRUE, res_/rel_ consistency checks, idempotent early return before lease check)
-- 2. Delegating 2-argument release_job_atomic calling strict overload with p_force = false
-- 3. Re-assert REVOKE FROM PUBLIC, anon, authenticated and GRANT TO service_role on both signatures

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
    RAISE EXCEPTION 'Cannot release job % with status %', p_job_id, v_job.status;
  END IF;

  -- 3. Accounting integrity check: reserve must exist in ledger and match job
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

  -- 4. Check if rel_ row exists and matches job
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

    -- 5. Idempotent early return for failed job with release row verified (BEFORE lease check)
    IF v_job.status = 'failed' THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_released', true,
        'job_id', p_job_id,
        'released_credits', v_job.reserved_credits
      );
    END IF;
  END IF;

  -- 6. Active lease check with strict NULL guard
  IF v_job.lease_until IS NOT NULL
     AND v_job.lease_until > v_now
     AND p_force IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'Cannot release job % while active chunk lease is held until %',
      p_job_id, v_job.lease_until;
  END IF;

  -- 7. Insert rel_ record if not present
  IF NOT v_has_release THEN
    INSERT INTO public.credit_ledger
      (id, user_id, delta, type, job_id, note, created_at)
    VALUES
      ('rel_' || p_job_id, v_job.user_id, v_job.reserved_credits, 'release',
       p_job_id, 'إرجاع الحجز بالكامل عند تعثر المهمة', v_now);
  END IF;

  -- 8. Mark job failed and clear lease
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

-- Preserve 2-argument signature delegating to strict overload with p_force = false
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

-- Privileges: Revoke from public/anon/authenticated and grant to service_role on BOTH signatures
REVOKE EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT, BOOLEAN)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT)
  TO service_role;
