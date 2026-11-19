-- DT-20261119-01 (Megz D-0103, D-0107): settle a mission whose people stage was priced by an ESTIMATE per stage, so that a mission that delivers no person charges the companies at the companies' own unit price and releases the rest.
-- A NEW function. settle_job_atomic is NOT touched and keeps settling every other job exactly as today (the code calls this one only for a job whose accepted quote carries `stageUnitsPoints`).
-- It is the body of the live settle_job_atomic (as recorded in 20261104222000_record_production_quote_and_settle.sql) with ONE change, marked below: the charge is ceil(base rows x base unit + estimated rows x estimated unit), the two units
-- read from the accepted quote (like settle_people_job_atomic reads contactUnitPricesPoints), never from the caller; the caller passes only the delivered counts. Locks, status checks, idempotency, release-first, the deterministic
-- ids (rel_ / chg_), `LEAST(charge, reserve, cap)` and nothing-delivered-no-charge are the same lines as the live function.
-- NOT APPLIED by the team: the owner applies it in the Supabase SQL editor after review (then the version is recorded, DT-20261119-02). Rollback: DROP FUNCTION public.settle_job_by_stage_atomic(text, jsonb, numeric, text); no ledger row is touched.
-- Execute is revoked from PUBLIC, anon and authenticated and granted to service_role only (the last two statements).

CREATE OR REPLACE FUNCTION public.settle_job_by_stage_atomic(p_job_id text, p_units jsonb, p_points_cap numeric DEFAULT 25000, p_result_file_id text DEFAULT NULL::text)
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
  v_quote public.plans_quotes%ROWTYPE;
  v_item jsonb;
  v_prices jsonb;
  v_rows jsonb;
  v_base_units numeric;
  v_est_units numeric;
  v_base_price numeric;
  v_est_price numeric;
  v_base_rows numeric;
  v_est_rows numeric;
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

  -- THE ONLY NEW PART (DT-20261119-01, D-0107), checked BEFORE any ledger row is written: the delivered counts per group come from the caller, the PRICE of each group comes from the accepted
  -- quote the job was created from (server-priced and hash-bound: the caller cannot set it), the counts must add up to the rows the job recorded, and no group may exceed what was sold.
  SELECT * INTO v_quote FROM public.plans_quotes
  WHERE 'job_quote_' || md5(id) = p_job_id AND user_id = v_job.user_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Accepted quote for job % not found', p_job_id; END IF;
  IF v_quote.status <> 'accepted' THEN RAISE EXCEPTION 'Quote for job % is not accepted', p_job_id; END IF;
  v_item := v_quote.items -> 0;
  v_prices := v_item -> 'stageUnitsPoints';
  v_rows := v_item -> 'stageRowsPlanned';
  -- every test is written so that a MISSING key (NULL) refuses: «IS NOT TRUE», never a bare condition that NULL would let through
  IF NOT COALESCE(jsonb_typeof(v_prices) = 'object' AND jsonb_typeof(v_rows) = 'object'
     AND (v_prices ->> 'base') ~ '^[0-9]+(\.[0-9]{1,6})?$' AND (v_prices ->> 'estimated') ~ '^[0-9]+(\.[0-9]{1,6})?$'
     AND (v_rows ->> 'base') ~ '^[0-9]+$' AND (v_rows ->> 'estimated') ~ '^[0-9]+$', false) THEN
    RAISE EXCEPTION 'Quote for job % has no per-stage unit prices', p_job_id;
  END IF;
  -- the companies' unit is above zero (a zero price would charge nothing for rows delivered); the people's unit may be zero only when the minimum charge alone sets the price of the whole plan
  IF NOT COALESCE((v_prices ->> 'base')::numeric > 0, false) THEN
    RAISE EXCEPTION 'Quote for job % has no per-stage unit prices', p_job_id;
  END IF;
  IF NOT COALESCE(jsonb_typeof(p_units) = 'object' AND (p_units ->> 'base') ~ '^[0-9]+$' AND (p_units ->> 'estimated') ~ '^[0-9]+$', false) THEN
    RAISE EXCEPTION 'Invalid delivered units per stage for job %', p_job_id;
  END IF;
  v_base_units := (p_units ->> 'base')::numeric;
  v_est_units := (p_units ->> 'estimated')::numeric;
  v_base_price := (v_prices ->> 'base')::numeric;
  v_est_price := (v_prices ->> 'estimated')::numeric;
  v_base_rows := (v_rows ->> 'base')::numeric;
  v_est_rows := (v_rows ->> 'estimated')::numeric;
  IF v_base_units > v_base_rows OR v_est_units > v_est_rows OR v_base_units + v_est_units <> COALESCE(v_job.delivered_units, 0) THEN
    RAISE EXCEPTION 'Delivered units per stage do not match job %', p_job_id;
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

  -- the charge: the LOWER of (a) each group's delivered rows at that group's own unit and (b) what the live function charges, the delivered rows at the job's ONE (blended) unit: this function never charges more than
  -- settle_job_atomic would for the same delivery (CTO rule, Gate 1 P1-4), and never above the hold or the cap (below)
  v_raw_charge := LEAST(CEIL(v_base_units * v_base_price + v_est_units * v_est_price), CEIL(COALESCE(v_job.delivered_units, 0) * v_job.unit_price));
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
    'delivered_units', v_job.delivered_units,
    'base_units', v_base_units,
    'estimated_units', v_est_units
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.settle_job_by_stage_atomic(text, jsonb, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_job_by_stage_atomic(text, jsonb, numeric, text) TO service_role;
