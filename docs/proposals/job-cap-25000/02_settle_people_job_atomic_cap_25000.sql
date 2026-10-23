-- PROPOSAL, NOT APPLIED. Run by hand in the Supabase SQL editor after the owner's review.
-- Step 2 of 4: settle_people_job_atomic, default cap and the hard 600 -> 25000
-- The charge stays LEAST(raw, reserved, cap).
-- Only the per-job cap constant changes (600 -> 25000). Locks, idempotency, deterministic ids and the charge formula are exactly the PRODUCTION definition
-- (read with SELECT on 2026-10-21, saved in tests/replica/prod-definitions/). Run 00_verify_before_apply.sql first: if the live definition differs, stop.
-- SECURITY DEFINER with a pinned search_path is kept; execute is revoked from PUBLIC, anon and authenticated and granted to service_role only (last two statements).

CREATE OR REPLACE FUNCTION public.settle_people_job_atomic(p_job_id text, p_base_units integer, p_email_units integer, p_phone_units integer, p_points_cap numeric DEFAULT 25000, p_result_file_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_job public.jobs%ROWTYPE;
  v_quote public.plans_quotes%ROWTYPE;
  v_item jsonb;
  v_prices jsonb;
  v_base_price numeric;
  v_email_price numeric;
  v_phone_price numeric;
  v_raw_charge numeric;
  v_charge numeric;
  v_existing_charge numeric;
  v_requested_fields jsonb;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job % not found', p_job_id; END IF;
  IF v_job.status = 'completed' THEN
    RETURN jsonb_build_object('success',true,'already_settled',true,'job_id',p_job_id,
      'charged_credits',v_job.charged_credits,'delivered_units',v_job.delivered_units);
  END IF;
  IF v_job.status <> 'running' THEN RAISE EXCEPTION 'Job % is not running', p_job_id; END IF;
  IF v_job.lease_until IS NOT NULL AND v_job.lease_until > timezone('utc'::text, now()) THEN
    IF v_job.current_cursor = 'completed' OR
       (v_job.target_volume_max IS NOT NULL AND COALESCE(v_job.delivered_units,0) >= v_job.target_volume_max) THEN
      UPDATE public.jobs SET lease_until = NULL, updated_at = timezone('utc'::text,now()) WHERE id = p_job_id;
    ELSE
      RAISE EXCEPTION 'Cannot settle job % while collection is incomplete', p_job_id;
    END IF;
  END IF;
  IF p_base_units < 0 OR p_email_units < 0 OR p_phone_units < 0 OR
     p_base_units > COALESCE(v_job.delivered_units,0) OR p_email_units > p_base_units OR p_phone_units > p_base_units THEN
    RAISE EXCEPTION 'Invalid delivered contact units for job %', p_job_id;
  END IF;
  IF v_job.reserved_credits IS NULL OR v_job.reserved_credits <= 0 OR
     NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = 'res_' || p_job_id) THEN
    RAISE EXCEPTION 'Job % has no valid credit reserve', p_job_id;
  END IF;
  SELECT * INTO v_quote FROM public.plans_quotes
  WHERE 'job_quote_' || md5(id) = p_job_id AND user_id = v_job.user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Accepted quote for job % not found', p_job_id; END IF;
  IF v_quote.status <> 'accepted' THEN RAISE EXCEPTION 'Quote for job % is not accepted', p_job_id; END IF;
  v_item := v_quote.items -> 0;
  v_requested_fields := v_item -> 'params' -> 'requiredContactFields';
  IF (p_email_units > 0 AND NOT (COALESCE(v_requested_fields, '[]'::jsonb) @> '["work_email"]'::jsonb)) OR
     (p_phone_units > 0 AND NOT (COALESCE(v_requested_fields, '[]'::jsonb) @> '["phone"]'::jsonb)) OR
     p_base_units < GREATEST(p_email_units,p_phone_units) OR
     p_base_units > p_email_units + p_phone_units THEN
    RAISE EXCEPTION 'Delivered contact units do not match requested fields for job %', p_job_id;
  END IF;
  v_prices := v_item -> 'contactUnitPricesPoints';
  IF jsonb_typeof(v_prices) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Quote for job % has no contact field prices', p_job_id;
  END IF;
  v_base_price := (v_prices ->> 'basePerson')::numeric;
  v_email_price := (v_prices ->> 'workEmail')::numeric;
  v_phone_price := (v_prices ->> 'phone')::numeric;
  IF v_base_price IS NULL OR v_email_price IS NULL OR v_phone_price IS NULL OR
     v_base_price <= 0 OR v_email_price <= 0 OR v_phone_price <= 0 THEN
    RAISE EXCEPTION 'Quote for job % has invalid contact field prices', p_job_id;
  END IF;
  v_raw_charge := CEIL(p_base_units*v_base_price + p_email_units*v_email_price + p_phone_units*v_phone_price);
  v_charge := LEAST(v_raw_charge, v_job.reserved_credits, COALESCE(p_points_cap,25000), 25000);
  IF NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = 'rel_' || p_job_id) THEN
    INSERT INTO public.credit_ledger(id,user_id,delta,type,job_id,note,created_at)
    VALUES ('rel_' || p_job_id,v_job.user_id,v_job.reserved_credits,'release',p_job_id,
      'إرجاع الرصيد المحجوز بعد التسوية',timezone('utc'::text,now()));
  END IF;
  IF v_charge > 0 THEN
    SELECT delta INTO v_existing_charge FROM public.credit_ledger WHERE id = 'chg_' || p_job_id FOR UPDATE;
    IF FOUND THEN
      IF v_existing_charge IS DISTINCT FROM -v_charge THEN RAISE EXCEPTION 'Charge ledger conflict for job %', p_job_id; END IF;
    ELSE
      INSERT INTO public.credit_ledger(id,user_id,delta,type,job_id,note,created_at)
      VALUES ('chg_' || p_job_id,v_job.user_id,-v_charge,'charge',p_job_id,
        'خصم السجلات وحقول التواصل المعادة',timezone('utc'::text,now()));
    END IF;
  END IF;
  UPDATE public.jobs SET status='completed', charged_credits=v_charge,
    result_file_id=COALESCE(p_result_file_id,result_file_id), lease_until=NULL,
    updated_at=timezone('utc'::text,now()) WHERE id=p_job_id;
  RETURN jsonb_build_object('success',true,'already_settled',false,'job_id',p_job_id,
    'reserved_credits',v_job.reserved_credits,'charged_credits',v_charge,
    'base_units',p_base_units,'email_units',p_email_units,'phone_units',p_phone_units,
    'delivered_units',v_job.delivered_units);
END;
$function$;

REVOKE ALL ON FUNCTION public.settle_people_job_atomic(text,integer,integer,integer,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_people_job_atomic(text,integer,integer,integer,numeric,text) TO service_role;
