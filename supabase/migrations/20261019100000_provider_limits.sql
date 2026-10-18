-- Proposal only (not applied by the author): admin-editable provider spend limits with an append-only audit trail.
--
-- The limits live in the existing settings_private row with key 'provider_limits' (value JSON). The application keeps
-- working on its built-in constants (0.80 USD per day for the data provider) until this file is applied, and the admin
-- tab says so in Arabic. Nothing here touches credit_ledger, jobs, topups, plans_quotes, provider_costs or profiles.
--
-- Value shape (all USD except warnPercent):
--   { "dailyUsd": 0.80, "perJobUsd": 0.05|null, "perUserDailyUsd": 0.30|null, "warnPercent": 80, "llmDailyUsd": 50 }

-- 1. Append-only audit: who, when, old value, new value. No foreign key on purpose (an ON DELETE action would try to
--    UPDATE this append-only table and block deleting an admin account).
CREATE TABLE IF NOT EXISTS public.provider_limits_audit (
  id bigserial PRIMARY KEY,
  actor_id uuid,
  old_value jsonb,
  new_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_limits_audit_created_idx ON public.provider_limits_audit (created_at DESC);

ALTER TABLE public.provider_limits_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_limits_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.provider_limits_audit TO service_role;
REVOKE ALL ON SEQUENCE public.provider_limits_audit_id_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.block_provider_limits_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RAISE EXCEPTION 'provider_limits_audit is append-only. UPDATE and DELETE operations are forbidden.';
END;
$$;

DROP TRIGGER IF EXISTS trg_block_provider_limits_audit_mutation ON public.provider_limits_audit;
CREATE TRIGGER trg_block_provider_limits_audit_mutation
BEFORE UPDATE OR DELETE ON public.provider_limits_audit
FOR EACH ROW EXECUTE FUNCTION public.block_provider_limits_audit_mutation();

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
    IF v_key NOT IN ('dailyUsd', 'perJobUsd', 'perUserDailyUsd', 'warnPercent', 'llmDailyUsd') THEN
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
