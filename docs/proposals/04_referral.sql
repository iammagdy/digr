-- PROPOSAL (not applied, not in supabase/migrations). Apply order: 4 of 7. Requires 01.
-- 4c: referral. A reward is paid ONLY after the referred account's first approved top-up of at least 100 EGP, so it is never
-- paid for a sign-up alone. Both sides get a ledger row: ref_<referral id>_referrer and ref_<referral id>_referee.
-- Abuse limits: no self-referral, one referrer per account, the referrer must have an approved top-up of their own,
-- at most 20 rewarded referrals per referrer.

CREATE TABLE IF NOT EXISTS public.referral_codes (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{6,12}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  referee_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rewarded', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  rewarded_at timestamptz,
  CHECK (referrer_id <> referee_id)
);
CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON public.referrals (referrer_id, status);
ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.referral_codes, public.referrals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.referral_codes, public.referrals TO service_role;

-- At sign-up: link the new account to the code's owner. Refused for self-referral, for an account that already has a top-up,
-- and for a second referrer.
CREATE OR REPLACE FUNCTION public.register_referral_atomic(p_referee_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_referrer uuid;
BEGIN
  IF p_referee_id IS NULL OR v_code !~ '^[A-Z0-9]{6,12}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_code', 'error_ar', 'كود الدعوة غير صحيح.');
  END IF;
  SELECT user_id INTO v_referrer FROM public.referral_codes WHERE code = v_code;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_code', 'error_ar', 'كود الدعوة غير صحيح.');
  END IF;
  IF v_referrer = p_referee_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'self_referral', 'error_ar', 'لا يمكنك استخدام كود دعوتك أنت.');
  END IF;
  IF EXISTS (SELECT 1 FROM public.topups WHERE user_id = p_referee_id AND status = 'approved') THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_new', 'error_ar', 'كود الدعوة للحسابات الجديدة فقط.');
  END IF;
  INSERT INTO public.referrals (referrer_id, referee_id) VALUES (v_referrer, p_referee_id) ON CONFLICT (referee_id) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- After an approved top-up: pay both sides once.
CREATE OR REPLACE FUNCTION public.grant_referral_reward_atomic(p_referee_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  c_referrer_points constant numeric := 200;
  c_referee_points constant numeric := 100;
  c_min_topup_egp constant numeric := 100;
  c_max_rewarded constant integer := 20;
  v_ref public.referrals%ROWTYPE;
  v_first_topup numeric;
BEGIN
  SELECT * INTO v_ref FROM public.referrals WHERE referee_id = p_referee_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'rewarded', false, 'reason', 'no_referral');
  END IF;
  IF v_ref.status = 'rewarded' THEN
    RETURN jsonb_build_object('success', true, 'rewarded', true, 'already_rewarded', true);
  END IF;
  IF v_ref.status <> 'pending' THEN
    RETURN jsonb_build_object('success', true, 'rewarded', false, 'reason', 'rejected');
  END IF;

  SELECT amount_egp INTO v_first_topup FROM public.topups WHERE user_id = p_referee_id AND status = 'approved' ORDER BY created_at ASC LIMIT 1;
  IF v_first_topup IS NULL OR v_first_topup < c_min_topup_egp THEN
    RETURN jsonb_build_object('success', true, 'rewarded', false, 'reason', 'no_qualifying_topup');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.topups WHERE user_id = v_ref.referrer_id AND status = 'approved') THEN
    RETURN jsonb_build_object('success', true, 'rewarded', false, 'reason', 'referrer_has_no_topup');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('referrer:' || v_ref.referrer_id::text, 0));
  IF (SELECT count(*) FROM public.referrals WHERE referrer_id = v_ref.referrer_id AND status = 'rewarded') >= c_max_rewarded THEN
    RETURN jsonb_build_object('success', true, 'rewarded', false, 'reason', 'referrer_limit');
  END IF;

  INSERT INTO public.credit_ledger (id, user_id, delta, type, note)
  VALUES ('ref_' || v_ref.id::text || '_referrer', v_ref.referrer_id, c_referrer_points, 'grant', 'مكافأة دعوة صديق');
  INSERT INTO public.credit_ledger_kinds (ledger_id, kind) VALUES ('ref_' || v_ref.id::text || '_referrer', 'referral_reward');
  INSERT INTO public.credit_ledger (id, user_id, delta, type, note)
  VALUES ('ref_' || v_ref.id::text || '_referee', v_ref.referee_id, c_referee_points, 'grant', 'مكافأة الانضمام بدعوة صديق');
  INSERT INTO public.credit_ledger_kinds (ledger_id, kind) VALUES ('ref_' || v_ref.id::text || '_referee', 'referral_reward');

  UPDATE public.referrals SET status = 'rewarded', rewarded_at = now() WHERE id = v_ref.id;
  RETURN jsonb_build_object('success', true, 'rewarded', true, 'referrer_points', c_referrer_points, 'referee_points', c_referee_points);
END;
$$;

REVOKE ALL ON FUNCTION public.register_referral_atomic(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_referral_atomic(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.grant_referral_reward_atomic(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_referral_reward_atomic(uuid) TO service_role;
