-- PROPOSAL V2 (not applied, not in supabase/migrations). Apply order: 3 of 7. Requires 01 and 02.
-- 4b: «بريد عمل أو جامعي»: +5 percentage points of the bundle's points, on top of the bundle bonus, as its OWN ledger row
-- bon_email_<topup id>. Only after the account's e-mail is confirmed, only for a bundle purchase (never a free amount), and only for the
-- first 5 accounts of a domain ("bonus accounts"). An account that already is a bonus account keeps the +5 on its later bundle purchases.
-- Any confirmed domain that is not a free mail provider counts (a company or a university); free providers never do.

CREATE TABLE IF NOT EXISTS public.free_email_domains (domain text PRIMARY KEY);
ALTER TABLE public.free_email_domains ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.free_email_domains FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.free_email_domains TO service_role;
INSERT INTO public.free_email_domains (domain) VALUES
  ('gmail.com'), ('googlemail.com'), ('yahoo.com'), ('yahoo.com.eg'), ('ymail.com'), ('hotmail.com'), ('outlook.com'), ('live.com'),
  ('msn.com'), ('icloud.com'), ('me.com'), ('aol.com'), ('proton.me'), ('protonmail.com'), ('gmx.com'), ('mail.com'), ('zoho.com'), ('yandex.com')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.email_bonus_accounts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  domain text NOT NULL,
  first_topup_id text NOT NULL REFERENCES public.topups(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_bonus_accounts_domain_idx ON public.email_bonus_accounts (domain);
ALTER TABLE public.email_bonus_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.email_bonus_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.email_bonus_accounts TO service_role;

-- Called after grant_topup_bonus_atomic for the same top-up.
CREATE OR REPLACE FUNCTION public.grant_email_bonus_atomic(p_topup_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  c_percent_points constant integer := 5;
  c_max_per_domain constant integer := 5;
  v_topup public.topups%ROWTYPE;
  v_choice public.topup_bundle_choices%ROWTYPE;
  v_bundle public.wallet_bundles%ROWTYPE;
  v_credit_value numeric;
  v_email text;
  v_confirmed timestamptz;
  v_domain text;
  v_id text;
  v_points numeric;
  v_used integer;
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
  IF NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = 'top_' || p_topup_id AND user_id = v_topup.user_id AND delta > 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'base_credit_missing');
  END IF;

  SELECT * INTO v_choice FROM public.topup_bundle_choices WHERE topup_id = p_topup_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'points', 0, 'reason', 'free_amount');
  END IF;
  SELECT * INTO v_bundle FROM public.wallet_bundles WHERE code = v_choice.bundle_code;
  SELECT COALESCE((value ->> 'creditValueEgp')::numeric, 0.1) INTO v_credit_value FROM public.settings_public WHERE key = 'pricing';
  v_credit_value := COALESCE(NULLIF(v_credit_value, 0), 0.1);
  IF v_topup.amount_egp < v_bundle.points * v_credit_value THEN
    RETURN jsonb_build_object('success', true, 'points', 0, 'reason', 'amount_below_bundle_price');
  END IF;

  SELECT lower(btrim(email)), email_confirmed_at INTO v_email, v_confirmed FROM auth.users WHERE id = v_topup.user_id;
  IF v_email IS NULL OR v_confirmed IS NULL THEN
    RETURN jsonb_build_object('success', true, 'points', 0, 'reason', 'email_not_confirmed');
  END IF;
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN
    RETURN jsonb_build_object('success', true, 'points', 0, 'reason', 'invalid_email');
  END IF;
  v_domain := split_part(v_email, '@', 2);
  IF EXISTS (SELECT 1 FROM public.free_email_domains WHERE domain = v_domain) OR v_domain ~ '^(example|test|localhost|invalid)[.]' THEN
    RETURN jsonb_build_object('success', true, 'points', 0, 'reason', 'not_work_or_university_email');
  END IF;

  v_id := 'bon_email_' || p_topup_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('email_bonus_domain:' || v_domain, 0));

  IF EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = v_id) THEN
    SELECT COALESCE(SUM(delta), 0) INTO v_balance FROM public.credit_ledger WHERE user_id = v_topup.user_id;
    RETURN jsonb_build_object('success', true, 'already_granted', true, 'balance', v_balance, 'ledger_id', v_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.email_bonus_accounts WHERE user_id = v_topup.user_id) THEN
    SELECT count(*) INTO v_used FROM public.email_bonus_accounts WHERE domain = v_domain;
    IF v_used >= c_max_per_domain THEN
      RETURN jsonb_build_object('success', true, 'points', 0, 'reason', 'domain_limit');
    END IF;
    INSERT INTO public.email_bonus_accounts (user_id, domain, first_topup_id) VALUES (v_topup.user_id, v_domain, p_topup_id);
  END IF;

  v_points := floor(v_bundle.points * c_percent_points / 100.0);
  INSERT INTO public.credit_ledger (id, user_id, delta, type, topup_id, note)
  VALUES (v_id, v_topup.user_id, v_points, 'grant', p_topup_id, 'مكافأة إضافية (٥٪) لبريد عمل أو جامعي مؤكَّد');
  INSERT INTO public.credit_ledger_kinds (ledger_id, kind) VALUES (v_id, 'email_bonus');

  SELECT COALESCE(SUM(delta), 0) INTO v_balance FROM public.credit_ledger WHERE user_id = v_topup.user_id;
  RETURN jsonb_build_object('success', true, 'already_granted', false, 'points', v_points, 'balance', v_balance, 'ledger_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.grant_email_bonus_atomic(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_email_bonus_atomic(text) TO service_role;
