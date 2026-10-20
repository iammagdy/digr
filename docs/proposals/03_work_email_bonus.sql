-- PROPOSAL (not applied, not in supabase/migrations). Apply order: 3 of 7. Requires 01.
-- 4b: one-time bonus for a CONFIRMED work e-mail (a company domain, not a free mail provider). Id: bon_workemail_<user id>.
-- Abuse limits: one bonus per account, at most 3 accounts per domain, the address must be confirmed.

CREATE TABLE IF NOT EXISTS public.free_email_domains (domain text PRIMARY KEY);
ALTER TABLE public.free_email_domains ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.free_email_domains FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.free_email_domains TO service_role;
INSERT INTO public.free_email_domains (domain) VALUES
  ('gmail.com'), ('googlemail.com'), ('yahoo.com'), ('yahoo.com.eg'), ('ymail.com'), ('hotmail.com'), ('outlook.com'), ('live.com'),
  ('msn.com'), ('icloud.com'), ('me.com'), ('aol.com'), ('proton.me'), ('protonmail.com'), ('gmx.com'), ('mail.com'), ('zoho.com'), ('yandex.com')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.work_email_bonuses (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  domain text NOT NULL,
  ledger_id text NOT NULL REFERENCES public.credit_ledger(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_email_bonuses_domain_idx ON public.work_email_bonuses (domain);
ALTER TABLE public.work_email_bonuses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.work_email_bonuses FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.work_email_bonuses TO service_role;

CREATE OR REPLACE FUNCTION public.grant_work_email_bonus_atomic(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  c_points constant numeric := 100;
  c_max_per_domain constant integer := 3;
  v_email text;
  v_confirmed timestamptz;
  v_domain text;
  v_id text;
  v_used integer;
  v_balance numeric;
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'user_not_found', 'error_ar', 'تعذر العثور على الحساب.');
  END IF;

  SELECT lower(btrim(email)), email_confirmed_at INTO v_email, v_confirmed FROM auth.users WHERE id = p_user_id;
  IF v_email IS NULL OR v_confirmed IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'email_not_confirmed', 'error_ar', 'أكّد بريدك الإلكتروني أولًا.');
  END IF;
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_email', 'error_ar', 'البريد الإلكتروني غير صالح.');
  END IF;
  v_domain := split_part(v_email, '@', 2);
  IF EXISTS (SELECT 1 FROM public.free_email_domains WHERE domain = v_domain)
     OR v_domain ~ '^(example|test|localhost|invalid)[.]' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_work_email', 'error_ar', 'المكافأة لبريد العمل الخاص بشركتك فقط، وليس لبريد مجاني.');
  END IF;

  v_id := 'bon_workemail_' || p_user_id::text;
  PERFORM pg_advisory_xact_lock(hashtextextended('work_email_domain:' || v_domain, 0));

  IF EXISTS (SELECT 1 FROM public.work_email_bonuses WHERE user_id = p_user_id) THEN
    SELECT COALESCE(SUM(delta), 0) INTO v_balance FROM public.credit_ledger WHERE user_id = p_user_id;
    RETURN jsonb_build_object('success', true, 'already_granted', true, 'points', c_points, 'balance', v_balance, 'ledger_id', v_id);
  END IF;

  SELECT count(*) INTO v_used FROM public.work_email_bonuses WHERE domain = v_domain;
  IF v_used >= c_max_per_domain THEN
    RETURN jsonb_build_object('success', false, 'error', 'domain_limit', 'error_ar', 'استُخدمت مكافأة هذا النطاق الحد الأقصى من المرات.');
  END IF;

  INSERT INTO public.credit_ledger (id, user_id, delta, type, note)
  VALUES (v_id, p_user_id, c_points, 'grant', 'مكافأة تأكيد بريد العمل');
  INSERT INTO public.credit_ledger_kinds (ledger_id, kind) VALUES (v_id, 'work_email_bonus');
  INSERT INTO public.work_email_bonuses (user_id, domain, ledger_id) VALUES (p_user_id, v_domain, v_id);

  SELECT COALESCE(SUM(delta), 0) INTO v_balance FROM public.credit_ledger WHERE user_id = p_user_id;
  RETURN jsonb_build_object('success', true, 'already_granted', false, 'points', c_points, 'balance', v_balance, 'ledger_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.grant_work_email_bonus_atomic(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_work_email_bonus_atomic(uuid) TO service_role;
