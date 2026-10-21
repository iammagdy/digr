-- PRODUCTION definitions read 2026-10-21 (pg_get_functiondef, project pfinlfaqwnytesedchik). Definitions only, no data.
CREATE OR REPLACE FUNCTION public.block_ledger_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only. UPDATE and DELETE operations are forbidden.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.block_ledger_truncate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'credit_ledger cannot be truncated.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.block_credit_kind_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'credit_ledger_kinds is append-only. UPDATE and DELETE operations are forbidden.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.reserve_provider_spend_atomic(p_job_id text, p_provider text, p_estimated_cost_usd numeric, p_daily_cap_usd numeric DEFAULT 0.80)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.commit_provider_spend(p_cost_id bigint, p_actual_cost_usd numeric, p_units integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
