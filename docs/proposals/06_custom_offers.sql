-- PROPOSAL (not applied, not in supabase/migrations). Apply order: 6 of 7.
-- 4f: a custom offer for ONE customer: a fixed unit price, a most volume, a most reserve, an expiry. It never writes the ledger:
-- the customer still approves an ordinary plan (reserve / settle / release unchanged). The quote writer reads an OPEN offer of
-- that customer and uses its unit price; accepting the plan marks the offer used.

CREATE TABLE IF NOT EXISTS public.custom_offers (
  id text PRIMARY KEY CHECK (id ~ '^off_[A-Za-z0-9_-]{8,64}$'),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  unit_price_points numeric(12, 4) NOT NULL CHECK (unit_price_points > 0),
  max_volume integer NOT NULL CHECK (max_volume > 0),
  max_reserve_points integer NOT NULL CHECK (max_reserve_points > 0),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'used', 'cancelled')),
  quote_id text,
  note text,
  created_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS custom_offers_user_idx ON public.custom_offers (user_id, status);
ALTER TABLE public.custom_offers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.custom_offers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.custom_offers TO service_role;

CREATE OR REPLACE FUNCTION public.admin_create_custom_offer_atomic(
  p_admin_id uuid,
  p_user_id uuid,
  p_unit_price_points numeric,
  p_max_volume integer,
  p_max_reserve_points integer,
  p_expires_at timestamptz,
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
  v_id text;
  v_existing public.custom_offers%ROWTYPE;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  IF p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9_-]{8,64}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_request_id');
  END IF;
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'user_not_found', 'error_ar', 'تعذر العثور على الحساب.');
  END IF;
  IF p_unit_price_points IS NULL OR p_unit_price_points <= 0 OR p_max_volume IS NULL OR p_max_volume < 1
     OR p_max_reserve_points IS NULL OR p_max_reserve_points < 1 OR p_expires_at IS NULL OR p_expires_at <= now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_offer', 'error_ar', 'بيانات العرض غير صالحة.');
  END IF;

  v_id := 'off_' || p_request_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_id, 0));
  SELECT * INTO v_existing FROM public.custom_offers WHERE id = v_id;
  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id OR v_existing.unit_price_points IS DISTINCT FROM p_unit_price_points
       OR v_existing.max_volume IS DISTINCT FROM p_max_volume OR v_existing.max_reserve_points IS DISTINCT FROM p_max_reserve_points THEN
      RETURN jsonb_build_object('success', false, 'error', 'request_id_conflict');
    END IF;
    RETURN jsonb_build_object('success', true, 'already_created', true, 'offer_id', v_id);
  END IF;

  INSERT INTO public.custom_offers (id, user_id, unit_price_points, max_volume, max_reserve_points, expires_at, note, created_by)
  VALUES (v_id, p_user_id, p_unit_price_points, p_max_volume, p_max_reserve_points, p_expires_at, p_note, p_admin_id);
  RETURN jsonb_build_object('success', true, 'already_created', false, 'offer_id', v_id);
END;
$$;

-- Called when the customer's plan that used the offer is accepted. Idempotent for the same quote.
CREATE OR REPLACE FUNCTION public.consume_custom_offer_atomic(p_offer_id text, p_user_id uuid, p_quote_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_offer public.custom_offers%ROWTYPE;
BEGIN
  SELECT * INTO v_offer FROM public.custom_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND OR v_offer.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'offer_not_found');
  END IF;
  IF v_offer.status = 'used' THEN
    IF v_offer.quote_id IS NOT DISTINCT FROM p_quote_id THEN
      RETURN jsonb_build_object('success', true, 'already_used', true);
    END IF;
    RETURN jsonb_build_object('success', false, 'error', 'offer_already_used');
  END IF;
  IF v_offer.status <> 'open' OR v_offer.expires_at <= now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'offer_unavailable');
  END IF;
  UPDATE public.custom_offers SET status = 'used', quote_id = p_quote_id, used_at = now() WHERE id = p_offer_id;
  RETURN jsonb_build_object('success', true, 'already_used', false);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_custom_offer_atomic(uuid, uuid, numeric, integer, integer, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_custom_offer_atomic(uuid, uuid, numeric, integer, integer, timestamptz, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.consume_custom_offer_atomic(text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_custom_offer_atomic(text, uuid, text) TO service_role;
