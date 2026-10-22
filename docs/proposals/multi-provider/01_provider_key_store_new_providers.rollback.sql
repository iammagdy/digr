-- ROLLBACK of 01_provider_key_store_new_providers.sql (proposal only; applied by the owner by hand, only if the proposal was applied).
--
-- Puts the two-provider whitelist back in the constraints and in both functions. Rows already written for «firecrawl» or «contextdev»
-- (keys, and audit rows, which cannot be deleted because the audit is append-only) are NOT touched: the constraints are re-added
-- NOT VALID so those rows stay, and the old functions simply refuse the new provider names again. To drop the stored keys of the two
-- providers as well, delete their provider_api_keys rows by hand (the audit rows stay by design).

BEGIN;

ALTER TABLE public.provider_api_keys DROP CONSTRAINT IF EXISTS provider_api_keys_provider_check;
ALTER TABLE public.provider_api_keys
  ADD CONSTRAINT provider_api_keys_provider_check CHECK (provider IN ('treg', 'anthropic')) NOT VALID;

ALTER TABLE public.provider_key_audit DROP CONSTRAINT IF EXISTS provider_key_audit_provider_check;
ALTER TABLE public.provider_key_audit
  ADD CONSTRAINT provider_key_audit_provider_check CHECK (provider IN ('treg', 'anthropic')) NOT VALID;

-- 1. Set a new active key. The current active key becomes "previous" (one-step rollback).
CREATE OR REPLACE FUNCTION public.admin_set_provider_key_atomic(
  p_admin_id uuid,
  p_provider text,
  p_ciphertext text,
  p_last4 text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_role text;
  v_row public.provider_api_keys%ROWTYPE;
  v_version integer;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  IF p_provider IS NULL OR p_provider NOT IN ('treg', 'anthropic') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_provider', 'error_ar', 'مزود غير معروف.');
  END IF;
  IF p_ciphertext IS NULL OR char_length(p_ciphertext) > 1300
     OR p_ciphertext !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{22}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_ciphertext', 'error_ar', 'صيغة المفتاح المشفّر غير صالحة.');
  END IF;
  IF p_last4 IS NULL OR p_last4 !~ '^[^[:space:]]{1,4}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_last4', 'error_ar', 'بيانات المفتاح غير صالحة.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('provider_key:' || p_provider, 0));
  SELECT * INTO v_row FROM public.provider_api_keys WHERE provider = p_provider FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.provider_api_keys (provider, active_ciphertext, active_last4, active_set_at, active_set_by, version)
    VALUES (p_provider, p_ciphertext, p_last4, now(), p_admin_id, 1);
    v_version := 1;
  ELSE
    UPDATE public.provider_api_keys SET
      previous_ciphertext = active_ciphertext,
      previous_last4 = active_last4,
      previous_set_at = active_set_at,
      active_ciphertext = p_ciphertext,
      active_last4 = p_last4,
      active_set_at = now(),
      active_set_by = p_admin_id,
      version = version + 1,
      updated_at = now()
    WHERE provider = p_provider
    RETURNING version INTO v_version;
  END IF;

  INSERT INTO public.provider_key_audit (provider, action, last4, actor_id) VALUES (p_provider, 'set', p_last4, p_admin_id);
  RETURN jsonb_build_object('success', true, 'provider', p_provider, 'version', v_version, 'last4', p_last4);
END;
$$;

-- 2. One-step rollback: the previous key becomes active and the replaced key becomes "previous".
CREATE OR REPLACE FUNCTION public.admin_rollback_provider_key_atomic(
  p_admin_id uuid,
  p_provider text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_role text;
  v_row public.provider_api_keys%ROWTYPE;
  v_version integer;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  IF p_provider IS NULL OR p_provider NOT IN ('treg', 'anthropic') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_provider', 'error_ar', 'مزود غير معروف.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('provider_key:' || p_provider, 0));
  SELECT * INTO v_row FROM public.provider_api_keys WHERE provider = p_provider FOR UPDATE;
  IF NOT FOUND OR v_row.previous_ciphertext IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_previous_key', 'error_ar', 'لا يوجد مفتاح سابق للرجوع إليه.');
  END IF;

  UPDATE public.provider_api_keys SET
    active_ciphertext = v_row.previous_ciphertext,
    active_last4 = v_row.previous_last4,
    active_set_at = now(),
    active_set_by = p_admin_id,
    previous_ciphertext = v_row.active_ciphertext,
    previous_last4 = v_row.active_last4,
    previous_set_at = v_row.active_set_at,
    version = version + 1,
    updated_at = now()
  WHERE provider = p_provider
  RETURNING version INTO v_version;

  INSERT INTO public.provider_key_audit (provider, action, last4, actor_id) VALUES (p_provider, 'rollback', v_row.previous_last4, p_admin_id);
  RETURN jsonb_build_object('success', true, 'provider', p_provider, 'version', v_version, 'last4', v_row.previous_last4);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_provider_key_atomic(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_provider_key_atomic(uuid, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_rollback_provider_key_atomic(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_rollback_provider_key_atomic(uuid, text) TO service_role;

COMMIT;
