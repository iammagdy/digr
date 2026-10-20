-- PROPOSAL V2 (not applied, not in supabase/migrations). Apply order: 2 of 7. Requires 01.
-- 4a: wallet bundles (social and companies) with a bonus. A bonus is a SEPARATE append-only ledger row written by a NEW function AFTER a
-- top-up is approved. approve_topup_atomic and the base row top_<topup id> are NOT changed. Id: bon_<topup id> (deterministic => idempotent).
--
-- A free amount is a top-up with no bundle choice: 0.10 EGP per point, no bonus (the 100 EGP minimum is checked where the top-up is
-- submitted, see README). Which bundle a top-up is for is recorded when the customer submits it (topup_bundle_choices), never inferred
-- from the amount, so a free amount that happens to equal a bundle price earns nothing.

CREATE TABLE IF NOT EXISTS public.wallet_bundles (
  code text PRIMARY KEY CHECK (code ~ '^[a-z]+_[0-9]+$'),
  line text NOT NULL CHECK (line IN ('social', 'companies')),
  points integer NOT NULL CHECK (points > 0),
  bonus_percent integer NOT NULL CHECK (bonus_percent BETWEEN 0 AND 100),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wallet_bundles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wallet_bundles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.wallet_bundles TO service_role;

INSERT INTO public.wallet_bundles (code, line, points, bonus_percent) VALUES
  ('social_2000', 'social', 2000, 10), ('social_5000', 'social', 5000, 20), ('social_10000', 'social', 10000, 30), ('social_25000', 'social', 25000, 40),
  ('companies_3000', 'companies', 3000, 10), ('companies_8000', 'companies', 8000, 20), ('companies_20000', 'companies', 20000, 30)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.topup_bundle_choices (
  topup_id text PRIMARY KEY REFERENCES public.topups(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  bundle_code text NOT NULL REFERENCES public.wallet_bundles(code) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.topup_bundle_choices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.topup_bundle_choices FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.topup_bundle_choices TO service_role;

-- Called by the top-up submit route right after the pending top-up row exists. The submitted amount must equal the bundle's price.
CREATE OR REPLACE FUNCTION public.record_topup_bundle_choice_atomic(p_user_id uuid, p_topup_id text, p_bundle_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_topup public.topups%ROWTYPE;
  v_bundle public.wallet_bundles%ROWTYPE;
  v_existing public.topup_bundle_choices%ROWTYPE;
  v_credit_value numeric;
BEGIN
  SELECT * INTO v_topup FROM public.topups WHERE id = p_topup_id FOR UPDATE;
  IF NOT FOUND OR v_topup.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'topup_not_found');
  END IF;
  IF v_topup.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'topup_not_pending');
  END IF;
  SELECT * INTO v_bundle FROM public.wallet_bundles WHERE code = p_bundle_code AND active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'bundle_not_found', 'error_ar', 'الباقة غير متاحة.');
  END IF;
  SELECT * INTO v_existing FROM public.topup_bundle_choices WHERE topup_id = p_topup_id;
  IF FOUND THEN
    IF v_existing.bundle_code = p_bundle_code THEN
      RETURN jsonb_build_object('success', true, 'already_recorded', true);
    END IF;
    RETURN jsonb_build_object('success', false, 'error', 'choice_conflict');
  END IF;
  SELECT COALESCE((value ->> 'creditValueEgp')::numeric, 0.1) INTO v_credit_value FROM public.settings_public WHERE key = 'pricing';
  v_credit_value := COALESCE(NULLIF(v_credit_value, 0), 0.1);
  IF v_topup.amount_egp IS DISTINCT FROM v_bundle.points * v_credit_value THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount_mismatch', 'error_ar', 'مبلغ التحويل لا يطابق سعر الباقة.');
  END IF;
  INSERT INTO public.topup_bundle_choices (topup_id, user_id, bundle_code) VALUES (p_topup_id, p_user_id, p_bundle_code);
  RETURN jsonb_build_object('success', true, 'already_recorded', false);
END;
$$;

-- Called after approve_topup_atomic succeeds. No recorded bundle (a free amount) => no bonus. The bonus is a percentage of the BUNDLE'S
-- points, paid only if the approved amount reaches the bundle's price.
CREATE OR REPLACE FUNCTION public.grant_topup_bonus_atomic(p_topup_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_topup public.topups%ROWTYPE;
  v_base public.credit_ledger%ROWTYPE;
  v_choice public.topup_bundle_choices%ROWTYPE;
  v_bundle public.wallet_bundles%ROWTYPE;
  v_credit_value numeric;
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
  SELECT * INTO v_base FROM public.credit_ledger WHERE id = 'top_' || p_topup_id;
  IF NOT FOUND OR v_base.user_id IS DISTINCT FROM v_topup.user_id OR v_base.delta <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'base_credit_missing');
  END IF;

  SELECT * INTO v_choice FROM public.topup_bundle_choices WHERE topup_id = p_topup_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'already_granted', false, 'points', 0, 'reason', 'free_amount');
  END IF;
  SELECT * INTO v_bundle FROM public.wallet_bundles WHERE code = v_choice.bundle_code;
  SELECT COALESCE((value ->> 'creditValueEgp')::numeric, 0.1) INTO v_credit_value FROM public.settings_public WHERE key = 'pricing';
  v_credit_value := COALESCE(NULLIF(v_credit_value, 0), 0.1);

  v_id := 'bon_' || p_topup_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_id, 0));
  SELECT * INTO v_existing FROM public.credit_ledger WHERE id = v_id;
  IF FOUND THEN
    SELECT COALESCE(SUM(delta), 0) INTO v_balance FROM public.credit_ledger WHERE user_id = v_topup.user_id;
    RETURN jsonb_build_object('success', true, 'already_granted', true, 'points', v_existing.delta, 'balance', v_balance, 'ledger_id', v_id);
  END IF;

  IF v_topup.amount_egp < v_bundle.points * v_credit_value THEN
    RETURN jsonb_build_object('success', true, 'already_granted', false, 'points', 0, 'reason', 'amount_below_bundle_price');
  END IF;
  v_bonus := floor(v_bundle.points * v_bundle.bonus_percent / 100.0);
  IF v_bonus <= 0 THEN
    RETURN jsonb_build_object('success', true, 'already_granted', false, 'points', 0);
  END IF;

  INSERT INTO public.credit_ledger (id, user_id, delta, type, topup_id, note)
  VALUES (v_id, v_topup.user_id, v_bonus, 'grant', p_topup_id, 'مكافأة الباقة (' || v_bundle.bonus_percent || '٪) على شحن الرصيد');
  INSERT INTO public.credit_ledger_kinds (ledger_id, kind) VALUES (v_id, 'bundle_bonus');

  SELECT COALESCE(SUM(delta), 0) INTO v_balance FROM public.credit_ledger WHERE user_id = v_topup.user_id;
  RETURN jsonb_build_object('success', true, 'already_granted', false, 'points', v_bonus, 'balance', v_balance, 'ledger_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.record_topup_bundle_choice_atomic(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_topup_bundle_choice_atomic(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.grant_topup_bonus_atomic(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_topup_bonus_atomic(text) TO service_role;
