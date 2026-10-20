-- PROPOSAL (not applied, not in supabase/migrations). Apply order: 2 of 7. Requires 01.
-- 4a: wallet bundles. A bonus is a SEPARATE append-only ledger row written by a NEW function AFTER a top-up is approved.
-- approve_topup_atomic and the base row top_<topup id> are not changed. Id: bon_<topup id> (deterministic => idempotent).

CREATE TABLE IF NOT EXISTS public.wallet_bundles (
  amount_egp numeric PRIMARY KEY CHECK (amount_egp > 0),
  bonus_percent integer NOT NULL CHECK (bonus_percent BETWEEN 0 AND 100),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wallet_bundles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wallet_bundles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.wallet_bundles TO service_role;

INSERT INTO public.wallet_bundles (amount_egp, bonus_percent) VALUES (100, 0), (250, 5), (500, 15), (1000, 25), (2500, 40)
ON CONFLICT (amount_egp) DO NOTHING;

CREATE OR REPLACE FUNCTION public.grant_topup_bonus_atomic(p_topup_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_topup public.topups%ROWTYPE;
  v_base public.credit_ledger%ROWTYPE;
  v_pct integer;
  v_bonus numeric;
  v_id text;
  v_existing public.credit_ledger%ROWTYPE;
  v_balance numeric;
BEGIN
  IF p_topup_id IS NULL OR btrim(p_topup_id) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_topup');
  END IF;

  SELECT * INTO v_topup FROM public.topups WHERE id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'topup_not_found');
  END IF;
  IF v_topup.status <> 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error', 'topup_not_approved');
  END IF;

  -- The bonus is a percentage of what the top-up actually credited, read from its own ledger row (never recomputed).
  SELECT * INTO v_base FROM public.credit_ledger WHERE id = 'top_' || p_topup_id;
  IF NOT FOUND OR v_base.user_id IS DISTINCT FROM v_topup.user_id OR v_base.delta <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'base_credit_missing');
  END IF;

  SELECT bonus_percent INTO v_pct
  FROM public.wallet_bundles
  WHERE active AND amount_egp <= v_topup.amount_egp
  ORDER BY amount_egp DESC
  LIMIT 1;

  v_id := 'bon_' || p_topup_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_id, 0));

  SELECT * INTO v_existing FROM public.credit_ledger WHERE id = v_id;
  IF FOUND THEN
    SELECT COALESCE(SUM(delta), 0) INTO v_balance FROM public.credit_ledger WHERE user_id = v_topup.user_id;
    RETURN jsonb_build_object('success', true, 'already_granted', true, 'points', v_existing.delta, 'balance', v_balance, 'ledger_id', v_id);
  END IF;

  v_bonus := floor(v_base.delta * COALESCE(v_pct, 0) / 100);
  IF v_bonus <= 0 THEN
    RETURN jsonb_build_object('success', true, 'already_granted', false, 'points', 0);
  END IF;

  INSERT INTO public.credit_ledger (id, user_id, delta, type, topup_id, note)
  VALUES (v_id, v_topup.user_id, v_bonus, 'grant', p_topup_id, 'مكافأة الباقة (' || v_pct || '٪) على شحن الرصيد');
  INSERT INTO public.credit_ledger_kinds (ledger_id, kind) VALUES (v_id, 'bundle_bonus');

  SELECT COALESCE(SUM(delta), 0) INTO v_balance FROM public.credit_ledger WHERE user_id = v_topup.user_id;
  RETURN jsonb_build_object('success', true, 'already_granted', false, 'points', v_bonus, 'balance', v_balance, 'ledger_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.grant_topup_bonus_atomic(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_topup_bonus_atomic(text) TO service_role;
