-- The TREG daily budget must exclude LLM and other provider costs.
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
  PERFORM pg_advisory_xact_lock(hashtext('provider_daily_spend_lock'));

  SELECT COALESCE(SUM(cost_usd), 0)
  INTO v_current_spend
  FROM public.provider_costs
  WHERE provider = p_provider
    AND created_at >= date_trunc('day', timezone('utc'::text, now()));

  IF (v_current_spend + p_estimated_cost_usd) > p_daily_cap_usd THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'current_spend', v_current_spend,
      'daily_cap', p_daily_cap_usd,
      'estimated_cost', p_estimated_cost_usd
    );
  END IF;

  INSERT INTO public.provider_costs (
    job_id, provider, units, cost_usd, is_estimate, created_at
  ) VALUES (
    p_job_id, p_provider, 0, p_estimated_cost_usd, true,
    timezone('utc'::text, now())
  ) RETURNING id INTO v_cost_id;

  RETURN jsonb_build_object(
    'allowed', true,
    'cost_id', v_cost_id,
    'current_spend', v_current_spend + p_estimated_cost_usd,
    'daily_cap', p_daily_cap_usd
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reserve_provider_spend_atomic(TEXT, TEXT, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_provider_spend_atomic(TEXT, TEXT, NUMERIC, NUMERIC) TO service_role;
