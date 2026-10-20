-- PROPOSAL (not applied, not in supabase/migrations). Apply order: 5 of 7.
-- 4e: one place for the per-job cap and the large-reserve confirmation threshold, plus a start-of-job gate that checks the
-- customer's balance and the provider's daily allowance. It writes nothing and moves no money.
--
-- Settings row (settings_private, key 'job_limits'): { "maxPoints": 6000, "confirmAbovePoints": 600 }.
-- NOTE: the money functions that still hard-code 600 (settle_job_atomic default and clamp, settle_people_job_atomic, the
-- create_quote_atomic proposal) are FROZEN until the owner decides; docs/proposals/README.md lists the exact one-line edits.

INSERT INTO public.settings_private (key, value) VALUES ('job_limits', '{"maxPoints": 6000, "confirmAbovePoints": 600}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.job_points_cap()
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE((SELECT (value ->> 'maxPoints')::numeric FROM public.settings_private WHERE key = 'job_limits'), 600);
$$;

CREATE OR REPLACE FUNCTION public.provider_spend_today_usd()
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE(SUM(cost_usd), 0)
  FROM public.provider_costs
  WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc';
$$;

CREATE OR REPLACE FUNCTION public.job_start_gate(
  p_user_id uuid,
  p_reserve_points numeric,
  p_estimated_cost_usd numeric,
  p_confirmed boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_balance numeric;
  v_cap numeric := public.job_points_cap();
  v_confirm numeric := COALESCE((SELECT (value ->> 'confirmAbovePoints')::numeric FROM public.settings_private WHERE key = 'job_limits'), 600);
  v_daily numeric := (SELECT (value ->> 'dailyUsd')::numeric FROM public.settings_private WHERE key = 'provider_limits');
BEGIN
  IF p_user_id IS NULL OR p_reserve_points IS NULL OR p_reserve_points < 1 OR p_estimated_cost_usd IS NULL OR p_estimated_cost_usd < 0 THEN
    RETURN jsonb_build_object('decision', 'blocked', 'code', 'invalid_input');
  END IF;
  SELECT COALESCE(SUM(delta), 0) INTO v_balance FROM public.credit_ledger WHERE user_id = p_user_id;
  IF p_reserve_points > v_balance THEN
    RETURN jsonb_build_object('decision', 'blocked', 'code', 'insufficient_balance');
  END IF;
  IF p_reserve_points > v_cap THEN
    RETURN jsonb_build_object('decision', 'blocked', 'code', 'over_job_cap');
  END IF;
  IF v_daily IS NOT NULL AND public.provider_spend_today_usd() + p_estimated_cost_usd > v_daily THEN
    RETURN jsonb_build_object('decision', 'blocked', 'code', 'provider_daily_cap');
  END IF;
  IF p_reserve_points > v_confirm AND NOT COALESCE(p_confirmed, false) THEN
    RETURN jsonb_build_object('decision', 'needs_confirmation');
  END IF;
  RETURN jsonb_build_object('decision', 'allow');
END;
$$;

REVOKE ALL ON FUNCTION public.job_points_cap() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.provider_spend_today_usd() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_start_gate(uuid, numeric, numeric, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_points_cap() TO service_role;
GRANT EXECUTE ON FUNCTION public.provider_spend_today_usd() TO service_role;
GRANT EXECUTE ON FUNCTION public.job_start_gate(uuid, numeric, numeric, boolean) TO service_role;
