-- Migration: Atomic Provider Daily Spend Cap & Commit

CREATE OR REPLACE FUNCTION public.reserve_provider_spend_atomic(
  p_job_id TEXT,
  p_provider TEXT,
  p_estimated_cost_usd NUMERIC,
  p_daily_cap_usd NUMERIC DEFAULT 0.80
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current_spend NUMERIC;
  v_cost_id BIGINT;
BEGIN
  -- 1. Serialize spend check across parallel chunks
  PERFORM pg_advisory_xact_lock(hashtext('provider_daily_spend_lock'));

  -- 2. Sum UTC calendar day spend (matches Appwrite todayStart)
  SELECT COALESCE(SUM(cost_usd), 0)
  INTO v_current_spend
  FROM public.provider_costs
  WHERE created_at >= date_trunc('day', timezone('utc'::text, now()));

  -- 3. Check against cap
  IF (v_current_spend + p_estimated_cost_usd) > p_daily_cap_usd THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'current_spend', v_current_spend,
      'daily_cap', p_daily_cap_usd,
      'estimated_cost', p_estimated_cost_usd
    );
  END IF;

  -- 4. Record estimate immediately before external API call
  INSERT INTO public.provider_costs (
    job_id,
    provider,
    units,
    cost_usd,
    is_estimate,
    created_at
  )
  VALUES (
    p_job_id,
    p_provider,
    0,
    p_estimated_cost_usd,
    true,
    timezone('utc'::text, now())
  )
  RETURNING id INTO v_cost_id;

  RETURN jsonb_build_object(
    'allowed', true,
    'cost_id', v_cost_id,
    'current_spend', (v_current_spend + p_estimated_cost_usd),
    'daily_cap', p_daily_cap_usd
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_provider_spend(
  p_cost_id BIGINT,
  p_actual_cost_usd NUMERIC,
  p_units INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated INT;
BEGIN
  -- Update ONLY if the row is currently marked as an estimate
  UPDATE public.provider_costs
  SET cost_usd = p_actual_cost_usd,
      units = p_units,
      is_estimate = false
  WHERE id = p_cost_id AND is_estimate = true;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RAISE EXCEPTION 'Provider cost % not found or already committed', p_cost_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'cost_id', p_cost_id,
    'actual_cost', p_actual_cost_usd,
    'units', p_units
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reserve_provider_spend_atomic(TEXT, TEXT, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_provider_spend_atomic(TEXT, TEXT, NUMERIC, NUMERIC) TO service_role;

REVOKE EXECUTE ON FUNCTION public.commit_provider_spend(BIGINT, NUMERIC, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_provider_spend(BIGINT, NUMERIC, INT) TO service_role;
