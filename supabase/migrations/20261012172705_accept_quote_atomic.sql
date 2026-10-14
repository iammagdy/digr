-- Migration: accept_quote_atomic
-- Atomic quote acceptance RPC:
-- 1. Validates quote existence, ownership, status ('quoted'), expiry, and expected quote_hash.
-- 2. Strictly requires a single-item quote with positive numeric unitPricePoints.
-- 3. Enforces 2-active-job user concurrency limit under profile lock.
-- 4. Calls reserve_credits_atomic for deterministic reservation (res_<job_id>).
-- 5. Inserts deterministic job row (job_quote_<md5(quote_id)>) and job_events progress row.
-- 6. Transitions quote status to 'accepted'.
-- 7. Fully idempotent on already-accepted quotes.

CREATE OR REPLACE FUNCTION public.accept_quote_atomic(
  p_quote_id TEXT,
  p_user_id UUID,
  p_expected_quote_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_quote public.plans_quotes%ROWTYPE;
  v_existing_job public.jobs%ROWTYPE;
  v_reservation public.credit_ledger%ROWTYPE;
  v_items JSONB;
  v_item JSONB;
  v_job_id TEXT;
  v_reserved NUMERIC;
  v_unit_price NUMERIC;
  v_target_min INT;
  v_target_max INT;
  v_endpoint_id TEXT;
  v_active_jobs BIGINT;
  v_reserve_result JSONB;
  v_updated_rows INT;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
  IF p_quote_id IS NULL OR p_user_id IS NULL
     OR p_expected_quote_hash IS NULL
     OR p_expected_quote_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_required_argument');
  END IF;

  SELECT * INTO v_quote
  FROM public.plans_quotes
  WHERE id = p_quote_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_not_found');
  END IF;
  IF v_quote.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_user_mismatch');
  END IF;
  IF v_quote.quote_hash IS DISTINCT FROM p_expected_quote_hash THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_hash_mismatch');
  END IF;

  -- Stable per-quote job ID makes duplicate acceptance calls idempotent.
  v_job_id := 'job_quote_' || md5(p_quote_id);

  IF v_quote.status = 'accepted' THEN
    SELECT * INTO v_existing_job FROM public.jobs WHERE id = v_job_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Accepted quote % has no deterministic job %', p_quote_id, v_job_id;
    END IF;

    SELECT * INTO v_reservation
    FROM public.credit_ledger
    WHERE id = 'res_' || v_job_id;
    IF NOT FOUND
       OR v_existing_job.user_id IS DISTINCT FROM v_quote.user_id
       OR v_existing_job.reserved_credits IS DISTINCT FROM v_quote.total_reserved_credits
       OR v_reservation.user_id IS DISTINCT FROM v_quote.user_id
       OR v_reservation.type IS DISTINCT FROM 'reserve'
       OR v_reservation.job_id IS DISTINCT FROM v_job_id
       OR v_reservation.delta IS DISTINCT FROM (-v_quote.total_reserved_credits) THEN
      RAISE EXCEPTION 'Accepted quote % has inconsistent job or reservation', p_quote_id;
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'already_accepted', true,
      'quote_id', p_quote_id,
      'job_id', v_job_id,
      'reserved_credits', v_quote.total_reserved_credits
    );
  END IF;

  IF v_quote.status <> 'quoted' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_quote_status', 'status', v_quote.status);
  END IF;
  IF v_quote.expires_at <= v_now THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_expired');
  END IF;

  v_reserved := v_quote.total_reserved_credits;
  IF v_reserved IS NULL OR v_reserved <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_reserved_credits');
  END IF;

  IF jsonb_typeof(v_quote.items) = 'array' THEN
    v_items := v_quote.items;
  ELSIF jsonb_typeof(v_quote.items) = 'object' THEN
    v_items := v_quote.items -> 'items';
  ELSE
    v_items := NULL;
  END IF;

  IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_quote_items');
  END IF;
  IF jsonb_array_length(v_items) <> 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'single_item_quote_required');
  END IF;

  v_item := v_items -> 0;
  IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_item -> 'unitPricePoints') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing_item_unit_price');
  END IF;
  v_unit_price := (v_item ->> 'unitPricePoints')::NUMERIC;
  IF v_unit_price <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_item_unit_price');
  END IF;

  v_target_min := COALESCE(NULLIF(v_item ->> 'targetVolumeMin', '')::INT, 1);
  v_target_max := COALESCE(NULLIF(v_item ->> 'targetVolumeMax', '')::INT, 1);
  IF v_target_min < 1 OR v_target_max < v_target_min OR v_target_max > 5000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_target_volume');
  END IF;

  v_endpoint_id := COALESCE(
    NULLIF(v_item ->> 'endpointId', ''),
    NULLIF(v_item ->> 'capabilitySlug', ''),
    'default'
  );

  -- Serialize the current two-active-job limit for this user.
  PERFORM 1 FROM public.profiles WHERE id = v_quote.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'profile_not_found');
  END IF;
  SELECT count(*) INTO v_active_jobs
  FROM public.jobs
  WHERE user_id = v_quote.user_id AND status IN ('queued', 'running');
  IF v_active_jobs >= 2 THEN
    RETURN jsonb_build_object('success', false, 'error', 'concurrency_limit');
  END IF;

  -- This approved RPC alone writes the reservation. The stored quote total is authoritative.
  v_reserve_result := public.reserve_credits_atomic(
    v_quote.user_id, v_job_id, v_reserved, 'حجز رصيد للطلب'
  );
  IF NOT COALESCE((v_reserve_result ->> 'success')::BOOLEAN, false) THEN
    RETURN v_reserve_result;
  END IF;

  SELECT * INTO v_reservation FROM public.credit_ledger WHERE id = 'res_' || v_job_id;
  IF NOT FOUND
     OR v_reservation.user_id IS DISTINCT FROM v_quote.user_id
     OR v_reservation.type IS DISTINCT FROM 'reserve'
     OR v_reservation.job_id IS DISTINCT FROM v_job_id
     OR v_reservation.delta IS DISTINCT FROM (-v_reserved) THEN
    RAISE EXCEPTION 'Reservation res_% does not match quote %', v_job_id, p_quote_id;
  END IF;

  INSERT INTO public.jobs (
    id, user_id, status, endpoint_id,
    target_volume_min, target_volume_max,
    reserved_credits, charged_credits, delivered_units,
    unit_price, attempt_count, step, next_attempt_at,
    created_at, updated_at
  ) VALUES (
    v_job_id, v_quote.user_id, 'queued', v_endpoint_id,
    v_target_min, v_target_max,
    v_reserved, 0, 0,
    v_unit_price, 0, 0, v_now,
    v_now, v_now
  );

  INSERT INTO public.job_events (job_id, user_id, message, units, event_type, created_at)
  VALUES (
    v_job_id, v_quote.user_id,
    'تم اعتماد الخطة وحجز النقاط بنجاح. جاري بدء معالجة الطلب...',
    0, 'progress', v_now
  );

  UPDATE public.plans_quotes
  SET status = 'accepted'
  WHERE id = p_quote_id AND status = 'quoted' AND expires_at > v_now;
  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION 'Quote % was not eligible for acceptance', p_quote_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_accepted', false,
    'quote_id', p_quote_id,
    'job_id', v_job_id,
    'reserved_credits', v_reserved
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.accept_quote_atomic(TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_quote_atomic(TEXT, UUID, TEXT)
  TO service_role;
