-- PROPOSAL, NOT APPLIED. Run by hand in the Supabase SQL editor after the owner's review.
-- ROLLBACK of Step 4 of 4 (LAST): create_quote_atomic back to the cap 600
-- Restores the production definition byte for byte.
-- Only the per-job cap constant changes (600 -> 25000). Locks, idempotency, deterministic ids and the charge formula are exactly the PRODUCTION definition
-- (read with SELECT on 2026-10-21, saved in tests/replica/prod-definitions/). Run 00_verify_before_apply.sql first: if the live definition differs, stop.
-- SECURITY DEFINER with a pinned search_path is kept; execute is revoked from PUBLIC, anon and authenticated and granted to service_role only (last two statements).

CREATE OR REPLACE FUNCTION public.create_quote_atomic(p_user_id uuid, p_quote_id text, p_quote_hash text, p_items jsonb, p_total_points numeric, p_output_formats text[], p_expires_at timestamp with time zone, p_previous_quote_ids text[] DEFAULT '{}'::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cap numeric := 600;
  v_existing public.plans_quotes%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR NULLIF(btrim(p_quote_id), '') IS NULL OR NULLIF(btrim(p_quote_hash), '') IS NULL THEN
    RAISE EXCEPTION 'user, quote id, and quote hash are required';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'quote items must be a non-empty JSON array';
  END IF;
  IF p_total_points IS NULL OR p_total_points <= 0 OR p_total_points > v_cap THEN
    RAISE EXCEPTION 'quote reserve must be between 0 and % points', v_cap;
  END IF;
  IF p_output_formats IS NULL OR cardinality(p_output_formats) = 0 OR
     EXISTS (SELECT 1 FROM unnest(p_output_formats) f WHERE f NOT IN ('xlsx','csv','pdf')) THEN
    RAISE EXCEPTION 'unsupported output formats';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'quote expiry must be in the future';
  END IF;

  -- Lock the user's profile, then supersede only the prior quotes for this conversation
  -- whose IDs the server resolved from its authenticated messages table.
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote owner profile does not exist';
  END IF;
  SELECT * INTO v_existing FROM public.plans_quotes WHERE id = p_quote_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id
       OR v_existing.quote_hash IS DISTINCT FROM p_quote_hash
       OR v_existing.items IS DISTINCT FROM p_items
       OR v_existing.total_reserved_credits IS DISTINCT FROM p_total_points THEN
      RAISE EXCEPTION 'quote idempotency conflict for %', p_quote_id;
    END IF;
    RETURN jsonb_build_object('success',true,'quote_id',p_quote_id,
      'status',v_existing.status,'total_reserved_credits',v_existing.total_reserved_credits,
      'expires_at',v_existing.expires_at,'already_created',true);
  END IF;
  PERFORM 1 FROM public.plans_quotes
  WHERE user_id = p_user_id AND status = 'quoted'
    AND id = ANY(COALESCE(p_previous_quote_ids, '{}'::text[]))
  FOR UPDATE;
  UPDATE public.plans_quotes
  SET status = 'expired'
  WHERE user_id = p_user_id
    AND status = 'quoted'
    AND id = ANY(COALESCE(p_previous_quote_ids, '{}'::text[]));

  INSERT INTO public.plans_quotes
    (id,user_id,quote_hash,status,items,total_reserved_credits,output_formats,expires_at,created_at)
  VALUES
    (p_quote_id,p_user_id,p_quote_hash,'quoted',p_items,p_total_points,to_jsonb(p_output_formats),p_expires_at,now());

  RETURN jsonb_build_object('success',true,'quote_id',p_quote_id,'status','quoted','total_reserved_credits',p_total_points,'expires_at',p_expires_at);
END;
$function$;

REVOKE ALL ON FUNCTION public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[]) TO service_role;
