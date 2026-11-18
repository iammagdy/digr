-- Records the definitions production runs since the hand-applied 25,000-point cap (D-0064). Applying it changes no behaviour.

CREATE OR REPLACE FUNCTION public.create_quote_atomic(p_user_id uuid, p_quote_id text, p_quote_hash text, p_items jsonb, p_total_points numeric, p_output_formats text[], p_expires_at timestamp with time zone, p_previous_quote_ids text[] DEFAULT '{}'::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cap numeric := 25000;
  v_existing public.plans_quotes%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR NULLIF(btrim(p_quote_id), '') IS NULL OR NULLIF(btrim(p_quote_hash), '') IS NULL THEN
    RAISE EXCEPTION 'user, quote id, and quote hash are required';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'quote items must be a non-empty JSON array';
  END IF;
  IF p_total_points IS NULL OR p_total_points <= 0 OR p_total_points > v_cap THEN
    RAISE EXCEPTION 'quote reserve must be between 0 and % points', v_cap;
  END IF;
  IF p_output_formats IS NULL OR cardinality(p_output_formats) = 0 OR
     EXISTS (SELECT 1 FROM unnest(p_output_formats) f WHERE f NOT IN ('xlsx','csv','pdf')) THEN
    RAISE EXCEPTION 'unsupported output formats';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'quote expiry must be in the future';
  END IF;

  -- Lock the user's profile, then supersede only the prior quotes for this conversation
  -- whose IDs the server resolved from its authenticated messages table.
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote owner profile does not exist';
  END IF;
  SELECT * INTO v_existing FROM public.plans_quotes WHERE id = p_quote_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id
       OR v_existing.quote_hash IS DISTINCT FROM p_quote_hash
       OR v_existing.items IS DISTINCT FROM p_items
       OR v_existing.total_reserved_credits IS DISTINCT FROM p_total_points THEN
      RAISE EXCEPTION 'quote idempotency conflict for %', p_quote_id;
    END IF;
    RETURN jsonb_build_object('success',true,'quote_id',p_quote_id,
      'status',v_existing.status,'total_reserved_credits',v_existing.total_reserved_credits,
      'expires_at',v_existing.expires_at,'already_created',true);
  END IF;
  PERFORM 1 FROM public.plans_quotes
  WHERE user_id = p_user_id AND status = 'quoted'
    AND id = ANY(COALESCE(p_previous_quote_ids, '{}'::text[]))
  FOR UPDATE;
  UPDATE public.plans_quotes
  SET status = 'expired'
  WHERE user_id = p_user_id
    AND status = 'quoted'
    AND id = ANY(COALESCE(p_previous_quote_ids, '{}'::text[]));

  INSERT INTO public.plans_quotes
    (id,user_id,quote_hash,status,items,total_reserved_credits,output_formats,expires_at,created_at)
  VALUES
    (p_quote_id,p_user_id,p_quote_hash,'quoted',p_items,p_total_points,to_jsonb(p_output_formats),p_expires_at,now());

  RETURN jsonb_build_object('success',true,'quote_id',p_quote_id,'status','quoted','total_reserved_credits',p_total_points,'expires_at',p_expires_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public.settle_job_atomic(p_job_id text, p_points_cap numeric DEFAULT 25000, p_result_file_id text DEFAULT NULL::text)
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

  v_raw_charge := CEIL(COALESCE(v_job.delivered_units, 0) * v_job.unit_price);
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
