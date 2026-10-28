-- PROPOSAL, NOT APPLIED. Run by hand in the Supabase SQL editor ONLY after the owner's review, and only after 02_replica_test.sql passed on a scratch PostgreSQL.
-- A NEW function, settle_job_min_atomic: the live settle_job_atomic (read with SELECT on 2026-10-28, md5 a7bb7aed118732d1664442cd13b978ac) is NOT touched and keeps working for every other caller.
-- It is that function's body with ONE change (the charge, marked below): max(minimum, ceil(delivered x unit_price)) when at least one row is delivered, 0 when nothing is. Locks, status checks, idempotency,
-- the deterministic ids (res_ / rel_ / chg_), release-first, the cap and the "never above the reserve" rule are the same lines as the live function.
-- Nothing in the code of the website or the worker calls it until the owner decides (see README.md): the code does not depend on this file.
-- SECURITY DEFINER with the pinned search_path is kept; execute is revoked from PUBLIC, anon and authenticated and granted to service_role only (the last two statements).

CREATE OR REPLACE FUNCTION public.settle_job_min_atomic(p_job_id text, p_min_charge numeric, p_points_cap numeric DEFAULT 25000, p_result_file_id text DEFAULT NULL::text)
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
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % not found', p_job_id;
  END IF;

  IF v_job.status = 'completed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_settled', true,
      'job_id', p_job_id,
      'charged_credits', v_job.charged_credits,
      'delivered_units', v_job.delivered_units
    );
  END IF;

  IF v_job.status != 'running' THEN
    RAISE EXCEPTION 'Cannot settle job % with status % (must be running)', p_job_id, v_job.status;
  END IF;

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

  IF v_job.unit_price IS NULL OR v_job.unit_price <= 0 THEN
    RAISE EXCEPTION 'Job % has invalid unit_price: %', p_job_id, v_job.unit_price;
  END IF;

  IF v_job.reserved_credits IS NULL OR v_job.reserved_credits <= 0 THEN
    RAISE EXCEPTION 'Job % has invalid reserved_credits', p_job_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = ('res_' || p_job_id)) THEN
    RAISE EXCEPTION 'Reserve record res_% does not exist for job %', p_job_id, p_job_id;
  END IF;

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

  -- THE ONLY CHANGE against settle_job_atomic: a job that delivered at least one row is charged at least p_min_charge (the pricing rule's minimum mission charge); a job that delivered nothing is charged nothing.
  -- Still never above the reserve and never above the cap.
  IF COALESCE(v_job.delivered_units, 0) > 0 THEN
    v_raw_charge := GREATEST(CEIL(COALESCE(v_job.delivered_units, 0) * v_job.unit_price), COALESCE(p_min_charge, 0));
  ELSE
    v_raw_charge := 0;
  END IF;
  v_final_charge := LEAST(v_raw_charge, v_job.reserved_credits, p_points_cap);

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

REVOKE ALL ON FUNCTION public.settle_job_min_atomic(text, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_job_min_atomic(text, numeric, numeric, text) TO service_role;
