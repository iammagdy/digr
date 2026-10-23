-- PROPOSAL ONLY. NOT APPLIED. For owner review (docs/proposals/job-cap-balance/README.md).
-- Step 1: the per-job cap becomes a POLICY the owner can read and change with an audit trail, and one function answers «what is this
-- customer's cap right now?». Installed with the policy on «fixed» at 600, which is today's behaviour: applying this file changes nothing
-- until step 2 is applied AND the owner sets the policy to «balance» through admin_set_job_cap_policy_atomic.
--
-- The policy lives in settings_private (key 'job_cap_policy'). Shape (all numbers are POINTS):
--   { "mode": "fixed" | "balance", "fixedCap": 600, "balanceFloor": 600, "balanceCeiling": 600 }
--   fixed   : every job's reserve may be at most fixedCap.
--   balance : a job's reserve may be at most the customer's available balance at the time the quote is written (the balance already has every
--             hold taken out), never below balanceFloor (so a customer with a small balance still gets today's 600 quote and can top up for it)
--             and never above balanceCeiling (the safety ceiling for the provider's balance, the daily limits and a long job's duration).
--   A hard maximum of 10,000 is inside the function: no setting can pass it.
-- Nothing here touches credit_ledger, jobs, topups, plans_quotes, provider_costs or profiles. It only reads credit_ledger (SUM(delta)).

-- 1. Append-only audit of every policy change: who, when, old value, new value.
CREATE TABLE IF NOT EXISTS public.job_cap_policy_audit (
  id bigserial PRIMARY KEY,
  actor_id uuid,
  old_value jsonb,
  new_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_cap_policy_audit_created_idx ON public.job_cap_policy_audit (created_at DESC);
ALTER TABLE public.job_cap_policy_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_cap_policy_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.job_cap_policy_audit TO service_role;
REVOKE ALL ON SEQUENCE public.job_cap_policy_audit_id_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.block_job_cap_policy_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RAISE EXCEPTION 'job_cap_policy_audit is append-only. UPDATE and DELETE operations are forbidden.';
END;
$$;
DROP TRIGGER IF EXISTS trg_block_job_cap_policy_audit_mutation ON public.job_cap_policy_audit;
CREATE TRIGGER trg_block_job_cap_policy_audit_mutation
BEFORE UPDATE OR DELETE ON public.job_cap_policy_audit
FOR EACH ROW EXECUTE FUNCTION public.block_job_cap_policy_audit_mutation();

-- 2. The default policy: exactly today's behaviour (fixed 600). Never overwrites a policy that is already there.
INSERT INTO public.settings_private (key, value)
VALUES ('job_cap_policy', jsonb_build_object('mode', 'fixed', 'fixedCap', 600, 'balanceFloor', 600, 'balanceCeiling', 600))
ON CONFLICT (key) DO NOTHING;

-- 3. The cap of one customer. Read only. A missing, unreadable or invalid policy is read as today's fixed 600, never as «no cap».
CREATE OR REPLACE FUNCTION public.job_points_cap_for(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  c_default constant numeric := 600;
  c_hard_max constant numeric := 10000;
  v_policy jsonb;
  v_fixed numeric;
  v_floor numeric;
  v_ceiling numeric;
  v_balance numeric;
  v_num text;
BEGIN
  SELECT value INTO v_policy FROM public.settings_private WHERE key = 'job_cap_policy';
  IF v_policy IS NULL OR jsonb_typeof(v_policy) <> 'object' THEN RETURN c_default; END IF;

  v_num := v_policy ->> 'fixedCap';
  v_fixed := CASE WHEN v_num ~ '^[0-9]+(\.[0-9]+)?$' AND v_num::numeric >= 1 THEN LEAST(v_num::numeric, c_hard_max) ELSE c_default END;
  IF COALESCE(v_policy ->> 'mode', 'fixed') <> 'balance' THEN RETURN v_fixed; END IF;

  v_num := v_policy ->> 'balanceFloor';
  v_floor := CASE WHEN v_num ~ '^[0-9]+(\.[0-9]+)?$' AND v_num::numeric >= 1 THEN LEAST(v_num::numeric, c_hard_max) ELSE c_default END;
  v_num := v_policy ->> 'balanceCeiling';
  v_ceiling := CASE WHEN v_num ~ '^[0-9]+(\.[0-9]+)?$' AND v_num::numeric >= 1 THEN LEAST(v_num::numeric, c_hard_max) ELSE v_floor END;
  v_ceiling := GREATEST(v_ceiling, v_floor);

  SELECT COALESCE(SUM(delta), 0) INTO v_balance FROM public.credit_ledger WHERE user_id = p_user_id;
  RETURN LEAST(GREATEST(v_floor, FLOOR(v_balance)), v_ceiling);
END;
$$;
REVOKE ALL ON FUNCTION public.job_points_cap_for(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_points_cap_for(uuid) TO service_role;

-- 4. The only way to change the policy: SECURITY DEFINER, pinned search_path, service_role only, the admin role verified INSIDE from the auth
--    record of p_admin_id (the pattern of admin_set_provider_limits_atomic). A partial object: only the keys present change.
CREATE OR REPLACE FUNCTION public.admin_set_job_cap_policy_atomic(p_admin_id uuid, p_policy jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  c_hard_max constant numeric := 10000;
  v_role text;
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_val jsonb;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  IF p_policy IS NULL OR jsonb_typeof(p_policy) <> 'object' OR p_policy = '{}'::jsonb THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_policy', 'error_ar', 'لم يصل أي تعديل صالح.');
  END IF;
  FOR v_key, v_val IN SELECT key, value FROM jsonb_each(p_policy) LOOP
    IF v_key NOT IN ('mode', 'fixedCap', 'balanceFloor', 'balanceCeiling') THEN
      RETURN jsonb_build_object('success', false, 'error', 'unknown_key', 'error_ar', 'إعداد غير معروف.');
    END IF;
    IF v_key = 'mode' THEN
      IF jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') NOT IN ('fixed', 'balance') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_mode', 'error_ar', 'الوضع إما ثابت أو حسب الرصيد.');
      END IF;
    ELSE
      IF jsonb_typeof(v_val) <> 'number' THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_number', 'error_ar', 'القيمة يجب أن تكون رقمًا.');
      END IF;
      IF (v_val #>> '{}')::numeric < 1 THEN
        RETURN jsonb_build_object('success', false, 'error', 'too_small', 'error_ar', 'القيمة يجب ألا تقل عن نقطة واحدة.');
      END IF;
      IF (v_val #>> '{}')::numeric > c_hard_max THEN
        RETURN jsonb_build_object('success', false, 'error', 'too_large', 'error_ar', 'الرقم أكبر من الحد الأقصى المسموح.');
      END IF;
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('job_cap_policy', 0));
  SELECT value INTO v_old FROM public.settings_private WHERE key = 'job_cap_policy' FOR UPDATE;
  v_new := COALESCE(v_old, jsonb_build_object('mode', 'fixed', 'fixedCap', 600, 'balanceFloor', 600, 'balanceCeiling', 600)) || p_policy;
  IF (v_new ->> 'balanceFloor')::numeric > (v_new ->> 'balanceCeiling')::numeric THEN
    RETURN jsonb_build_object('success', false, 'error', 'floor_above_ceiling', 'error_ar', 'الحد الأدنى أكبر من الحد الأعلى.');
  END IF;

  INSERT INTO public.settings_private (key, value, updated_at) VALUES ('job_cap_policy', v_new, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  INSERT INTO public.job_cap_policy_audit (actor_id, old_value, new_value) VALUES (p_admin_id, v_old, v_new);
  RETURN jsonb_build_object('success', true, 'policy', v_new);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_job_cap_policy_atomic(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_job_cap_policy_atomic(uuid, jsonb) TO service_role;
