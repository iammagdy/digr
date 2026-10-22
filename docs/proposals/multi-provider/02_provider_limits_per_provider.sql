-- PROPOSAL ONLY (not applied by the author; the owner reviews and applies it by hand). Part 2 of 3 of docs/proposals/multi-provider/.
--
-- Per-provider daily limits. The admin-editable limits live in the settings_private row 'provider_limits'. This replaces the one
-- function that writes it so that two more keys are accepted: firecrawlDailyUsd and contextdevDailyUsd (USD, same validation as dailyUsd:
-- a number, not negative, at most 1e12). Everything else is unchanged: admin verified INSIDE the function, one audit row per change with the
-- old and the new value, service_role only. The existing dailyUsd keeps being TREG's daily limit.
-- A provider with no limit saved has a limit of 0: the application allows no spend on it until the owner sets one.
--
-- Requires 20261019100000_provider_limits.sql (applied already). Idempotent (CREATE OR REPLACE).

BEGIN;

-- 2. The only way to change the limits. SECURITY DEFINER, pinned search_path, service_role only; the admin role is
--    verified INSIDE the function from the auth record of p_admin_id (raw_app_meta_data role = admin), the same
--    pattern as admin_grant_credit_atomic. p_limits is a PARTIAL object: only the keys present change; a JSON null for
--    perJobUsd / perUserDailyUsd clears that ceiling. Every key is validated here again (type, range).
CREATE OR REPLACE FUNCTION public.admin_set_provider_limits_atomic(
  p_admin_id uuid,
  p_limits jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_role text;
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_val jsonb;
  c_max constant numeric := 1000000000000;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  IF p_limits IS NULL OR jsonb_typeof(p_limits) <> 'object' OR p_limits = '{}'::jsonb THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_limits', 'error_ar', 'لم يصل أي تعديل صالح.');
  END IF;

  FOR v_key, v_val IN SELECT key, value FROM jsonb_each(p_limits) LOOP
    IF v_key NOT IN ('dailyUsd', 'perJobUsd', 'perUserDailyUsd', 'warnPercent', 'llmDailyUsd', 'firecrawlDailyUsd', 'contextdevDailyUsd') THEN
      RETURN jsonb_build_object('success', false, 'error', 'unknown_key', 'error_ar', 'إعداد غير معروف.');
    END IF;
    IF v_key IN ('perJobUsd', 'perUserDailyUsd') AND jsonb_typeof(v_val) = 'null' THEN
      CONTINUE;
    END IF;
    IF jsonb_typeof(v_val) <> 'number' THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_a_number', 'error_ar', 'القيمة يجب أن تكون رقمًا.');
    END IF;
    IF (v_val #>> '{}')::numeric < 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'negative', 'error_ar', 'لا يمكن أن تكون القيمة سالبة.');
    END IF;
    IF v_key = 'warnPercent' AND (v_val #>> '{}')::numeric > 100 THEN
      RETURN jsonb_build_object('success', false, 'error', 'percent_range', 'error_ar', 'نسبة التنبيه يجب أن تكون بين ٠ و١٠٠.');
    END IF;
    IF v_key <> 'warnPercent' AND (v_val #>> '{}')::numeric > c_max THEN
      RETURN jsonb_build_object('success', false, 'error', 'too_large', 'error_ar', 'الرقم أكبر من الحد المسموح.');
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('provider_limits', 0));
  SELECT value INTO v_old FROM public.settings_private WHERE key = 'provider_limits' FOR UPDATE;
  -- A null ceiling is stored as an absent key (no ceiling); everything else overwrites its own key only.
  v_new := (COALESCE(v_old, '{}'::jsonb) || (SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) FROM jsonb_each(p_limits) WHERE jsonb_typeof(value) <> 'null'))
           - COALESCE((SELECT array_agg(key) FROM jsonb_each(p_limits) WHERE jsonb_typeof(value) = 'null'), ARRAY[]::text[]);

  INSERT INTO public.settings_private (key, value, updated_at)
  VALUES ('provider_limits', v_new, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  INSERT INTO public.provider_limits_audit (actor_id, old_value, new_value) VALUES (p_admin_id, v_old, v_new);
  RETURN jsonb_build_object('success', true, 'limits', v_new);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_provider_limits_atomic(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_provider_limits_atomic(uuid, jsonb) TO service_role;

COMMIT;
