-- Proposal only (not applied by the author): promo codes and manual admin credit.
-- Requires 20261018140000_credit_ledger_kinds.sql first.
--
-- Credit rows are written only by the three functions at the end of this file. Each is SECURITY DEFINER,
-- has a pinned search_path, is revoked from PUBLIC / anon / authenticated and granted to service_role only.
-- The ledger stays append-only; ids are deterministic (promo_<code>_<user>, adm_<request id>).

CREATE TABLE IF NOT EXISTS public.promo_codes (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_-]{3,32}$'),
  points integer NOT NULL CHECK (points BETWEEN 1 AND 100000),
  max_redemptions integer NOT NULL CHECK (max_redemptions > 0),
  per_account_limit integer NOT NULL DEFAULT 1 CHECK (per_account_limit = 1),
  starts_at timestamptz,
  expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR starts_at IS NULL OR expires_at > starts_at)
);

CREATE TABLE IF NOT EXISTS public.promo_redemptions (
  id bigserial PRIMARY KEY,
  code text NOT NULL REFERENCES public.promo_codes(code) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  ledger_id text NOT NULL REFERENCES public.credit_ledger(id) ON DELETE RESTRICT,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, user_id)
);
CREATE INDEX IF NOT EXISTS promo_redemptions_user_idx ON public.promo_redemptions (user_id);

ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.promo_codes, public.promo_redemptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.promo_codes, public.promo_redemptions TO service_role;
REVOKE ALL ON SEQUENCE public.promo_redemptions_id_seq FROM PUBLIC, anon, authenticated;

-- 1. Redeem a code. Locks the code row, so concurrent redemptions are serialized and can never exceed
--    max_redemptions. One account can redeem one code once; a repeat is refused and credits nothing.
CREATE OR REPLACE FUNCTION public.redeem_promo_code_atomic(p_user_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_promo public.promo_codes%ROWTYPE;
  v_ledger_id text;
  v_count integer;
  v_balance numeric;
  v_now timestamptz := now();
BEGIN
  IF p_user_id IS NULL OR v_code !~ '^[A-Z0-9_-]{3,32}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_code', 'error_ar', 'الكود غير صحيح. تأكد من كتابته كما وصلك.');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'user_not_found', 'error_ar', 'تعذر العثور على الحساب.');
  END IF;

  SELECT * INTO v_promo FROM public.promo_codes WHERE code = v_code FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'code_not_found', 'error_ar', 'الكود غير صحيح. تأكد من كتابته كما وصلك.');
  END IF;

  SELECT COALESCE(SUM(delta), 0) INTO v_balance FROM public.credit_ledger WHERE user_id = p_user_id;

  IF EXISTS (SELECT 1 FROM public.promo_redemptions WHERE code = v_code AND user_id = p_user_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_redeemed', 'error_ar', 'استخدمت هذا الكود من قبل، ولا يمكن استخدامه مرة ثانية.', 'balance', v_balance);
  END IF;
  IF NOT v_promo.active THEN
    RETURN jsonb_build_object('success', false, 'error', 'code_inactive', 'error_ar', 'هذا الكود غير مفعّل حاليًا.', 'balance', v_balance);
  END IF;
  IF v_promo.starts_at IS NOT NULL AND v_now < v_promo.starts_at THEN
    RETURN jsonb_build_object('success', false, 'error', 'code_not_started', 'error_ar', 'هذا الكود لم يبدأ سريانه بعد.', 'balance', v_balance);
  END IF;
  IF v_promo.expires_at IS NOT NULL AND v_now >= v_promo.expires_at THEN
    RETURN jsonb_build_object('success', false, 'error', 'code_expired', 'error_ar', 'انتهت صلاحية هذا الكود.', 'balance', v_balance);
  END IF;

  SELECT count(*) INTO v_count FROM public.promo_redemptions WHERE code = v_code;
  IF v_count >= v_promo.max_redemptions THEN
    RETURN jsonb_build_object('success', false, 'error', 'code_exhausted', 'error_ar', 'استُنفد هذا الكود، فقد استخدمه العدد الأقصى من الأشخاص.', 'balance', v_balance);
  END IF;

  v_ledger_id := 'promo_' || v_code || '_' || p_user_id::text;
  INSERT INTO public.credit_ledger (id, user_id, delta, type, note)
  VALUES (v_ledger_id, p_user_id, v_promo.points, 'grant', 'رصيد ترويجي (كود: ' || v_code || ')');
  INSERT INTO public.credit_ledger_kinds (ledger_id, kind) VALUES (v_ledger_id, 'promo_code');
  INSERT INTO public.promo_redemptions (code, user_id, ledger_id) VALUES (v_code, p_user_id, v_ledger_id);

  RETURN jsonb_build_object('success', true, 'points', v_promo.points, 'balance', v_balance + v_promo.points, 'ledger_id', v_ledger_id);
END;
$$;

-- 2. Manual admin credit. The admin role is verified here, from the auth record of p_admin_id, not trusted
--    from the caller. Idempotent by request id; positive whole-point amounts only.
CREATE OR REPLACE FUNCTION public.admin_grant_credit_atomic(
  p_admin_id uuid,
  p_user_id uuid,
  p_points numeric,
  p_note text,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_role text;
  v_ledger_id text;
  v_existing public.credit_ledger%ROWTYPE;
  v_balance numeric;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  IF p_user_id IS NULL OR p_points IS NULL OR p_points <= 0 OR p_points <> trunc(p_points) OR p_points > 100000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount', 'error_ar', 'عدد النقاط يجب أن يكون رقمًا صحيحًا موجبًا.');
  END IF;
  IF p_note IS NULL OR char_length(btrim(p_note)) < 3 OR char_length(p_note) > 200 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_note', 'error_ar', 'اكتب سبب الإضافة (٣ أحرف على الأقل).');
  END IF;
  IF p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9_-]{8,64}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_request_id', 'error_ar', 'معرّف الطلب غير صالح.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'user_not_found', 'error_ar', 'تعذر العثور على الحساب.');
  END IF;

  v_ledger_id := 'adm_' || p_request_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_ledger_id, 0));

  SELECT * INTO v_existing FROM public.credit_ledger WHERE id = v_ledger_id;
  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id OR v_existing.delta IS DISTINCT FROM p_points THEN
      RETURN jsonb_build_object('success', false, 'error', 'request_id_conflict', 'error_ar', 'معرّف الطلب مستخدم من قبل لعملية مختلفة.');
    END IF;
    SELECT COALESCE(SUM(delta), 0) INTO v_balance FROM public.credit_ledger WHERE user_id = p_user_id;
    RETURN jsonb_build_object('success', true, 'already_granted', true, 'points', p_points, 'balance', v_balance, 'ledger_id', v_ledger_id);
  END IF;

  INSERT INTO public.credit_ledger (id, user_id, delta, type, note)
  VALUES (v_ledger_id, p_user_id, p_points, 'grant', 'هدية من الإدارة: ' || btrim(p_note));
  INSERT INTO public.credit_ledger_kinds (ledger_id, kind, actor_id) VALUES (v_ledger_id, 'admin_grant', p_admin_id);

  SELECT COALESCE(SUM(delta), 0) INTO v_balance FROM public.credit_ledger WHERE user_id = p_user_id;
  RETURN jsonb_build_object('success', true, 'already_granted', false, 'points', p_points, 'balance', v_balance, 'ledger_id', v_ledger_id);
END;
$$;

-- 3. Create or edit a promo code (admin only, verified here). A code that already has redemptions cannot
--    be given a cap below its redemption count.
CREATE OR REPLACE FUNCTION public.admin_save_promo_code_atomic(
  p_admin_id uuid,
  p_code text,
  p_points integer,
  p_max_redemptions integer,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_active boolean,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_role text;
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_used integer;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  IF v_code !~ '^[A-Z0-9_-]{3,32}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_code', 'error_ar', 'الكود يتكوّن من ٣ إلى ٣٢ حرفًا لاتينيًا كبيرًا أو أرقامًا أو - أو _.');
  END IF;
  IF p_points IS NULL OR p_points < 1 OR p_points > 100000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_points', 'error_ar', 'قيمة الكود يجب أن تكون بين ١ و١٠٠٠٠٠ نقطة.');
  END IF;
  IF p_max_redemptions IS NULL OR p_max_redemptions < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_max', 'error_ar', 'الحد الأقصى للاستخدام يجب أن يكون ١ أو أكثر.');
  END IF;
  IF p_starts_at IS NOT NULL AND p_expires_at IS NOT NULL AND p_expires_at <= p_starts_at THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_dates', 'error_ar', 'تاريخ الانتهاء يجب أن يأتي بعد تاريخ البدء.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('promo_code:' || v_code, 0));
  SELECT count(*) INTO v_used FROM public.promo_redemptions WHERE code = v_code;
  IF p_max_redemptions < v_used THEN
    RETURN jsonb_build_object('success', false, 'error', 'max_below_used', 'error_ar', 'الحد الأقصى أقل من عدد من استخدموا الكود فعلًا.');
  END IF;

  INSERT INTO public.promo_codes (code, points, max_redemptions, starts_at, expires_at, active, created_by, note)
  VALUES (v_code, p_points, p_max_redemptions, p_starts_at, p_expires_at, COALESCE(p_active, true), p_admin_id, p_note)
  ON CONFLICT (code) DO UPDATE SET
    points = EXCLUDED.points,
    max_redemptions = EXCLUDED.max_redemptions,
    starts_at = EXCLUDED.starts_at,
    expires_at = EXCLUDED.expires_at,
    active = EXCLUDED.active,
    note = EXCLUDED.note,
    updated_at = now();

  RETURN jsonb_build_object('success', true, 'code', v_code, 'redemptions', v_used);
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_promo_code_atomic(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_promo_code_atomic(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_grant_credit_atomic(uuid, uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_grant_credit_atomic(uuid, uuid, numeric, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_save_promo_code_atomic(uuid, text, integer, integer, timestamptz, timestamptz, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_promo_code_atomic(uuid, text, integer, integer, timestamptz, timestamptz, boolean, text) TO service_role;
