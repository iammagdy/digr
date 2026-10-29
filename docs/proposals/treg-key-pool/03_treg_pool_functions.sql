-- PROPOSAL, NOT APPLIED. ADDITIVE ONLY: new functions. Requires 01 and 02 first. No existing function is replaced or changed.
--
-- Every function is SECURITY DEFINER with a pinned search_path, revoked from PUBLIC / anon / authenticated and granted to service_role only.
-- The six ADMIN functions verify the admin role INSIDE from the auth record of p_admin_id (same pattern as admin_set_provider_key_atomic):
-- a route that forgot its own check still cannot change the pool. The RUNTIME functions (read the active key, record a switch, record a check,
-- record a call, mail outbox) are called by the website, the worker and the cron route with the service role.
-- One advisory lock ('treg_pool') serialises every writer, so two servers cannot switch the key at the same moment.

-- ---- internal helpers (no grant to anyone: only the functions below call them) ------------------------------------------------------

CREATE OR REPLACE FUNCTION public.treg_pool_log_event(p_kind text, p_key_id uuid, p_to_key_id uuid, p_reason text, p_source text, p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_k public.treg_pool_keys%ROWTYPE;
  v_t public.treg_pool_keys%ROWTYPE;
BEGIN
  IF p_key_id IS NOT NULL THEN SELECT * INTO v_k FROM public.treg_pool_keys WHERE id = p_key_id; END IF;
  IF p_to_key_id IS NOT NULL THEN SELECT * INTO v_t FROM public.treg_pool_keys WHERE id = p_to_key_id; END IF;
  INSERT INTO public.treg_pool_events (kind, key_id, key_number, key_label, to_key_id, to_key_number, to_key_label, reason, source, actor_id)
  VALUES (p_kind, p_key_id, v_k.number, v_k.label, p_to_key_id, v_t.number, v_t.label, left(p_reason, 60), p_source, p_actor);
END;
$$;

-- One alert per (problem, key) while it is open, and none again for the same pair within 30 minutes of the last one. Returns true when THIS call
-- created the alert (so exactly one caller sends the e-mail / the outbox row exists once).
CREATE OR REPLACE FUNCTION public.treg_pool_claim_alert(p_problem text, p_key_id uuid, p_reason text, p_to_key_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_scope uuid := coalesce(p_key_id, '00000000-0000-0000-0000-000000000000'::uuid);
  v_k public.treg_pool_keys%ROWTYPE;
  v_t public.treg_pool_keys%ROWTYPE;
  v_id bigint;
BEGIN
  IF p_problem IS NULL OR p_problem NOT IN ('failover','chain_reached_main','health_broken','main_failed','store_unreadable') THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.treg_pool_alerts a WHERE a.problem = p_problem AND a.scope = v_scope AND a.created_at > now() - interval '30 minutes') THEN
    RETURN false;
  END IF;
  IF p_key_id IS NOT NULL THEN SELECT * INTO v_k FROM public.treg_pool_keys WHERE id = p_key_id; END IF;
  IF p_to_key_id IS NOT NULL THEN SELECT * INTO v_t FROM public.treg_pool_keys WHERE id = p_to_key_id; END IF;
  INSERT INTO public.treg_pool_alerts (problem, scope, key_id, key_number, key_label, to_key_number, to_key_label, reason)
  VALUES (p_problem, v_scope, p_key_id, v_k.number, v_k.label, v_t.number, v_t.label, left(p_reason, 60))
  ON CONFLICT (problem, scope) WHERE cleared_at IS NULL DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.treg_pool_clear_alerts(p_key_id uuid, p_problems text[] DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  UPDATE public.treg_pool_alerts SET cleared_at = now()
  WHERE cleared_at IS NULL AND scope = coalesce(p_key_id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND (p_problems IS NULL OR problem = ANY (p_problems));
$$;

-- ---- ADMIN functions (the role is verified inside) -----------------------------------------------------------------------------------

-- 1. Add a key. p_ciphertext is what the application encrypted; the function never sees a plaintext key.
CREATE OR REPLACE FUNCTION public.admin_add_treg_pool_key(
  p_admin_id uuid, p_id uuid, p_label text, p_ciphertext text, p_last4 text, p_email text DEFAULT NULL, p_is_main boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_role text;
  v_pos integer;
  v_number integer;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  IF p_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_id', 'error_ar', 'بيانات المفتاح غير صالحة.'); END IF;
  IF p_label IS NULL OR char_length(btrim(p_label)) NOT BETWEEN 1 AND 60 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_label', 'error_ar', 'اسم المفتاح يجب أن يكون بين ١ و٦٠ حرفًا.');
  END IF;
  IF p_ciphertext IS NULL OR char_length(p_ciphertext) > 1300 OR p_ciphertext !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{22}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_ciphertext', 'error_ar', 'صيغة المفتاح المشفّر غير صالحة.');
  END IF;
  IF p_last4 IS NULL OR p_last4 !~ '^[^[:space:]]{1,4}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_last4', 'error_ar', 'بيانات المفتاح غير صالحة.');
  END IF;
  IF p_email IS NOT NULL AND (char_length(p_email) > 254 OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+$') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_email', 'error_ar', 'بيانات المفتاح غير صالحة.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('treg_pool', 0));
  IF coalesce(p_is_main, false) AND EXISTS (SELECT 1 FROM public.treg_pool_keys WHERE is_main AND removed_at IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'main_exists', 'error_ar', 'يوجد مفتاح رئيسي بالفعل؛ يمكن استبداله فقط.');
  END IF;
  IF (SELECT count(*) FROM public.treg_pool_keys WHERE removed_at IS NULL) >= 500 THEN
    RETURN jsonb_build_object('success', false, 'error', 'too_many', 'error_ar', 'بلغ عدد المفاتيح الحد الأقصى (٥٠٠).');
  END IF;
  SELECT coalesce(max(chain_position), 0) + 1 INTO v_pos FROM public.treg_pool_keys WHERE removed_at IS NULL;

  BEGIN
    INSERT INTO public.treg_pool_keys (id, label, is_main, in_chain, chain_position, ciphertext, last4, account_email, created_by)
    VALUES (p_id, btrim(p_label), coalesce(p_is_main, false), true, v_pos, p_ciphertext, p_last4, p_email, p_admin_id)
    RETURNING number INTO v_number;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'duplicate', 'error_ar', 'هذا المفتاح مضاف بالفعل.');
  END;
  PERFORM public.treg_pool_log_event('key_added', p_id, NULL, CASE WHEN coalesce(p_is_main, false) THEN 'main' ELSE 'pool' END, 'admin', p_admin_id);
  RETURN jsonb_build_object('success', true, 'id', p_id, 'number', v_number);
END;
$$;

-- 2. Replace the secret of a key (the main key can only be replaced, never removed). The row keeps its number, label and place in the chain.
CREATE OR REPLACE FUNCTION public.admin_replace_treg_pool_key(
  p_admin_id uuid, p_key_id uuid, p_ciphertext text, p_last4 text, p_email text DEFAULT NULL, p_label text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_role text;
  v_state public.treg_pool_state%ROWTYPE;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  IF p_ciphertext IS NULL OR char_length(p_ciphertext) > 1300 OR p_ciphertext !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{22}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_ciphertext', 'error_ar', 'صيغة المفتاح المشفّر غير صالحة.');
  END IF;
  IF p_last4 IS NULL OR p_last4 !~ '^[^[:space:]]{1,4}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_last4', 'error_ar', 'بيانات المفتاح غير صالحة.');
  END IF;
  IF p_email IS NOT NULL AND (char_length(p_email) > 254 OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+$') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_email', 'error_ar', 'بيانات المفتاح غير صالحة.');
  END IF;
  IF p_label IS NOT NULL AND char_length(btrim(p_label)) NOT BETWEEN 1 AND 60 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_label', 'error_ar', 'اسم المفتاح يجب أن يكون بين ١ و٦٠ حرفًا.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('treg_pool', 0));
  IF NOT EXISTS (SELECT 1 FROM public.treg_pool_keys WHERE id = p_key_id AND removed_at IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown_key', 'error_ar', 'المفتاح غير موجود.');
  END IF;
  UPDATE public.treg_pool_keys SET
    ciphertext = p_ciphertext, last4 = p_last4, account_email = p_email,
    label = coalesce(nullif(btrim(p_label), ''), label),
    status = 'unknown', status_reason = NULL, status_checked_at = NULL, balance_micro = NULL, balance_checked_at = NULL
  WHERE id = p_key_id;
  PERFORM public.treg_pool_clear_alerts(p_key_id, NULL);
  SELECT * INTO v_state FROM public.treg_pool_state WHERE id = 1 FOR UPDATE;
  IF v_state.active_key_id = p_key_id THEN
    UPDATE public.treg_pool_state SET generation = generation + 1, updated_at = now(), updated_by = p_admin_id WHERE id = 1;
  END IF;
  PERFORM public.treg_pool_log_event('key_replaced', p_key_id, NULL, NULL, 'admin', p_admin_id);
  RETURN jsonb_build_object('success', true, 'id', p_key_id);
END;
$$;

-- 3. Remove a key: never the main key, never the key in use. The secret is erased; the row stays for the call log.
CREATE OR REPLACE FUNCTION public.admin_remove_treg_pool_key(p_admin_id uuid, p_key_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_role text;
  v_key public.treg_pool_keys%ROWTYPE;
  v_state public.treg_pool_state%ROWTYPE;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('treg_pool', 0));
  SELECT * INTO v_key FROM public.treg_pool_keys WHERE id = p_key_id AND removed_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'unknown_key', 'error_ar', 'المفتاح غير موجود.'); END IF;
  IF v_key.is_main THEN
    RETURN jsonb_build_object('success', false, 'error', 'main_cannot_be_removed', 'error_ar', 'المفتاح الرئيسي لا يُحذف؛ يمكن استبداله فقط.');
  END IF;
  SELECT * INTO v_state FROM public.treg_pool_state WHERE id = 1 FOR UPDATE;
  IF v_state.active_key_id = p_key_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'key_in_use', 'error_ar', 'هذا المفتاح هو المستخدم الآن؛ فعّل مفتاحًا آخر أولًا.');
  END IF;
  UPDATE public.treg_pool_keys SET ciphertext = NULL, removed_at = now(), in_chain = false WHERE id = p_key_id;
  PERFORM public.treg_pool_clear_alerts(p_key_id, NULL);
  PERFORM public.treg_pool_log_event('key_removed', p_key_id, NULL, NULL, 'admin', p_admin_id);
  RETURN jsonb_build_object('success', true, 'id', p_key_id);
END;
$$;

-- 4. Choose the ONE active key. A key known to be revoked or out of balance needs p_force.
CREATE OR REPLACE FUNCTION public.admin_set_treg_active_key(p_admin_id uuid, p_key_id uuid, p_force boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_role text;
  v_key public.treg_pool_keys%ROWTYPE;
  v_gen bigint;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('treg_pool', 0));
  SELECT * INTO v_key FROM public.treg_pool_keys WHERE id = p_key_id AND removed_at IS NULL AND ciphertext IS NOT NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'unknown_key', 'error_ar', 'المفتاح غير موجود.'); END IF;
  IF v_key.status IN ('revoked', 'out_of_balance') AND NOT coalesce(p_force, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'key_not_usable', 'status', v_key.status, 'error_ar', 'هذا المفتاح ملغى أو رصيده انتهى؛ لن يُفعَّل إلا بتأكيد صريح.');
  END IF;
  UPDATE public.treg_pool_state SET active_key_id = p_key_id, generation = generation + 1, updated_at = now(), updated_by = p_admin_id WHERE id = 1
  RETURNING generation INTO v_gen;
  IF NOT v_key.is_main THEN PERFORM public.treg_pool_clear_alerts((SELECT id FROM public.treg_pool_keys WHERE is_main AND removed_at IS NULL), ARRAY['chain_reached_main']); END IF;
  PERFORM public.treg_pool_log_event('active_set', p_key_id, NULL, NULL, 'admin', p_admin_id);
  RETURN jsonb_build_object('success', true, 'active_id', p_key_id, 'generation', v_gen);
END;
$$;

-- 5. The fallback chain: the ordered list of NON-main keys. Keys not listed leave the chain. The main key is always the last step and cannot be left out.
CREATE OR REPLACE FUNCTION public.admin_set_treg_chain(p_admin_id uuid, p_ordered uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_role text;
  v_n integer;
  v_i integer;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  IF p_ordered IS NULL THEN p_ordered := ARRAY[]::uuid[]; END IF;
  v_n := coalesce(array_length(p_ordered, 1), 0);
  PERFORM pg_advisory_xact_lock(hashtextextended('treg_pool', 0));
  IF v_n <> (SELECT count(DISTINCT x) FROM unnest(p_ordered) AS x)
     OR v_n <> (SELECT count(*) FROM public.treg_pool_keys WHERE id = ANY (p_ordered) AND removed_at IS NULL AND NOT is_main) THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_chain', 'error_ar', 'ترتيب السلسلة غير صالح (المفتاح الرئيسي يبقى الأخير دائمًا ولا يدخل القائمة).');
  END IF;
  UPDATE public.treg_pool_keys SET in_chain = false WHERE removed_at IS NULL AND NOT is_main AND NOT (id = ANY (p_ordered));
  FOR v_i IN 1 .. v_n LOOP
    UPDATE public.treg_pool_keys SET in_chain = true, chain_position = v_i WHERE id = p_ordered[v_i];
  END LOOP;
  UPDATE public.treg_pool_keys SET chain_position = v_n + 1 WHERE is_main AND removed_at IS NULL;
  UPDATE public.treg_pool_state SET generation = generation + 1, updated_at = now(), updated_by = p_admin_id WHERE id = 1;
  PERFORM public.treg_pool_log_event('chain_set', NULL, NULL, v_n::text, 'admin', p_admin_id);
  RETURN jsonb_build_object('success', true, 'length', v_n);
END;
$$;

-- 6. The rollout switch (OFF by default). ON needs a main key; the first time it is turned ON the active key is the main key.
CREATE OR REPLACE FUNCTION public.admin_set_treg_rollout(p_admin_id uuid, p_on boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_role text;
  v_main uuid;
  v_state public.treg_pool_state%ROWTYPE;
  v_active uuid;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  IF p_on IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_request', 'error_ar', 'طلب غير صالح.'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('treg_pool', 0));
  SELECT * INTO v_state FROM public.treg_pool_state WHERE id = 1 FOR UPDATE;
  SELECT id INTO v_main FROM public.treg_pool_keys WHERE is_main AND removed_at IS NULL AND ciphertext IS NOT NULL;
  IF p_on AND v_main IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_main_key', 'error_ar', 'أضف المفتاح الرئيسي أولًا قبل تشغيل المجمّع.');
  END IF;
  v_active := v_state.active_key_id;
  IF p_on AND (v_active IS NULL OR NOT EXISTS (SELECT 1 FROM public.treg_pool_keys WHERE id = v_active AND removed_at IS NULL AND ciphertext IS NOT NULL)) THEN
    v_active := v_main;
  END IF;
  UPDATE public.treg_pool_state SET rollout_on = p_on, active_key_id = v_active, generation = generation + 1, updated_at = now(), updated_by = p_admin_id WHERE id = 1;
  PERFORM public.treg_pool_log_event(CASE WHEN p_on THEN 'rollout_on' ELSE 'rollout_off' END, v_active, NULL, NULL, 'admin', p_admin_id);
  RETURN jsonb_build_object('success', true, 'rollout_on', p_on, 'active_id', v_active);
END;
$$;

-- 7. Minimum balance (micro-USD) under which a key counts as «الرصيد خلص».
CREATE OR REPLACE FUNCTION public.admin_set_treg_pool_settings(p_admin_id uuid, p_min_balance_micro bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_role text;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  IF p_min_balance_micro IS NULL OR p_min_balance_micro < 0 OR p_min_balance_micro > 10000000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_value', 'error_ar', 'الحد الأدنى للرصيد يجب أن يكون بين ٠ و١٠ دولار.');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('treg_pool', 0));
  UPDATE public.treg_pool_state SET min_balance_micro = p_min_balance_micro, updated_at = now(), updated_by = p_admin_id WHERE id = 1;
  PERFORM public.treg_pool_log_event('settings', NULL, NULL, 'min_balance', 'admin', p_admin_id);
  RETURN jsonb_build_object('success', true, 'min_balance_micro', p_min_balance_micro);
END;
$$;

-- ---- RUNTIME functions (service role: website, worker, cron route) ---------------------------------------------------------------------

-- The key used to encrypt and decrypt pool keys, from Vault. Read by the website and the worker; cached in memory for ten minutes by the caller.
CREATE OR REPLACE FUNCTION public.treg_pool_enc_key()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'diger-treg-pool-enc-key' LIMIT 1;
$$;

-- What a call needs: the switch, the active key, the chain in order (main last). While the switch is OFF NO ciphertext is returned at all.
CREATE OR REPLACE FUNCTION public.treg_pool_runtime()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT jsonb_build_object(
    'rollout_on', s.rollout_on,
    'active_id', s.active_key_id,
    'generation', s.generation,
    'min_balance_micro', s.min_balance_micro,
    'keys', CASE WHEN s.rollout_on THEN coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', k.id, 'number', k.number, 'label', k.label, 'is_main', k.is_main, 'in_chain', k.in_chain, 'status', k.status, 'ciphertext', k.ciphertext)
                       ORDER BY k.is_main, k.chain_position, k.number)
      FROM public.treg_pool_keys k
      WHERE k.removed_at IS NULL AND k.ciphertext IS NOT NULL AND (k.in_chain OR k.id = s.active_key_id)
    ), '[]'::jsonb) ELSE '[]'::jsonb END
  )
  FROM public.treg_pool_state s WHERE s.id = 1;
$$;

-- The next key after a failed one: the first live key of the chain AFTER it that is not known to be revoked or out of balance; when none is left,
-- the main key (always the last step, even if it is marked bad, because there is nothing after it). NULL only when the failed key IS the main key.
CREATE OR REPLACE FUNCTION public.treg_pool_next_key(p_failed_key_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  f public.treg_pool_keys%ROWTYPE;
  v_next uuid;
BEGIN
  SELECT * INTO f FROM public.treg_pool_keys WHERE id = p_failed_key_id AND removed_at IS NULL;
  IF NOT FOUND OR f.is_main THEN RETURN NULL; END IF;
  SELECT k.id INTO v_next FROM public.treg_pool_keys k
  WHERE k.removed_at IS NULL AND k.ciphertext IS NOT NULL AND k.in_chain AND NOT k.is_main AND k.id <> f.id
    AND k.status NOT IN ('revoked', 'out_of_balance')
    AND (NOT f.in_chain OR ROW(k.chain_position, k.number) > ROW(f.chain_position, f.number))
  ORDER BY k.chain_position, k.number LIMIT 1;
  IF v_next IS NULL THEN
    SELECT k.id INTO v_next FROM public.treg_pool_keys k WHERE k.is_main AND k.removed_at IS NULL AND k.ciphertext IS NOT NULL;
  END IF;
  RETURN v_next;
END;
$$;

-- The active key failed for an auth or balance reason (the application verified it first; a transient error never gets here).
-- Records the verdict, moves the active key to the next one ONLY IF the failed key is still the active one (two servers failing at once switch once),
-- and says which e-mails this caller newly opened. p_new_status: revoked | out_of_balance.
CREATE OR REPLACE FUNCTION public.treg_pool_record_failover(p_failed_key_id uuid, p_new_status text, p_reason text, p_source text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_failed public.treg_pool_keys%ROWTYPE;
  v_state public.treg_pool_state%ROWTYPE;
  v_to uuid;
  v_switched boolean := false;
  v_a_failover boolean := false;
  v_a_main boolean := false;
  v_a_main_failed boolean := false;
  v_to_is_main boolean := false;
BEGIN
  IF p_new_status IS NULL OR p_new_status NOT IN ('revoked', 'out_of_balance') THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_status'); END IF;
  IF p_source IS NULL OR p_source NOT IN ('website', 'worker', 'health') THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_source'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('treg_pool', 0));
  SELECT * INTO v_failed FROM public.treg_pool_keys WHERE id = p_failed_key_id AND removed_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'unknown_key'); END IF;
  SELECT * INTO v_state FROM public.treg_pool_state WHERE id = 1 FOR UPDATE;

  UPDATE public.treg_pool_keys SET status = p_new_status, status_reason = left(p_reason, 60), status_checked_at = now() WHERE id = p_failed_key_id;

  IF v_state.rollout_on AND v_state.active_key_id = p_failed_key_id THEN
    v_to := public.treg_pool_next_key(p_failed_key_id);
    IF v_to IS NOT NULL THEN
      UPDATE public.treg_pool_state SET active_key_id = v_to, generation = generation + 1, updated_at = now(), updated_by = NULL WHERE id = 1;
      v_switched := true;
      SELECT is_main INTO v_to_is_main FROM public.treg_pool_keys WHERE id = v_to;
      PERFORM public.treg_pool_log_event('failover', p_failed_key_id, v_to, p_reason, p_source, NULL);
      v_a_failover := public.treg_pool_claim_alert('failover', p_failed_key_id, p_new_status, v_to);
      IF v_to_is_main THEN v_a_main := public.treg_pool_claim_alert('chain_reached_main', v_to, 'chain_reached_main', NULL); END IF;
    ELSE
      -- the main key itself failed: nothing is left after it
      v_a_main_failed := public.treg_pool_claim_alert('main_failed', p_failed_key_id, p_new_status, NULL);
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'switched', v_switched, 'active_id', (SELECT active_key_id FROM public.treg_pool_state WHERE id = 1),
    'alert_failover', v_a_failover, 'alert_chain_reached_main', v_a_main, 'alert_main_failed', v_a_main_failed);
END;
$$;

-- The result of a background (or admin-requested) health check of one key. p_status NULL = a transient result (timeout, 5xx, network): only the
-- time and a reason code are recorded and nothing else changes. A key that is NOT the active one and turns bad opens the «health_broken» alert once.
-- For the ACTIVE key the answer says needs_failover so the caller runs treg_pool_record_failover (which opens the failover e-mail instead).
CREATE OR REPLACE FUNCTION public.treg_pool_record_check(p_key_id uuid, p_status text, p_reason text, p_balance_micro bigint, p_email text, p_source text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_prev text;
  v_state public.treg_pool_state%ROWTYPE;
  v_active boolean;
  v_alert boolean := false;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('connected', 'error', 'revoked', 'out_of_balance') THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_status'); END IF;
  IF p_source IS NULL OR p_source NOT IN ('website', 'worker', 'health', 'admin') THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_source'); END IF;
  IF p_email IS NOT NULL AND (char_length(p_email) > 254 OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+$') THEN p_email := NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('treg_pool', 0));
  SELECT status INTO v_prev FROM public.treg_pool_keys WHERE id = p_key_id AND removed_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'unknown_key'); END IF;
  SELECT * INTO v_state FROM public.treg_pool_state WHERE id = 1 FOR UPDATE;
  v_active := v_state.rollout_on AND v_state.active_key_id = p_key_id;

  IF p_status IS NULL THEN
    UPDATE public.treg_pool_keys SET status_reason = left(p_reason, 60), status_checked_at = now() WHERE id = p_key_id;
    RETURN jsonb_build_object('success', true, 'status', v_prev, 'needs_failover', false, 'alert_health', false);
  END IF;

  UPDATE public.treg_pool_keys SET
    status = p_status, status_reason = left(p_reason, 60), status_checked_at = now(),
    balance_micro = coalesce(p_balance_micro, balance_micro),
    balance_checked_at = CASE WHEN p_balance_micro IS NULL THEN balance_checked_at ELSE now() END,
    account_email = coalesce(p_email, account_email)
  WHERE id = p_key_id;

  IF p_status = 'connected' THEN
    PERFORM public.treg_pool_clear_alerts(p_key_id, ARRAY['failover', 'health_broken', 'main_failed']);
  ELSIF p_status IS DISTINCT FROM v_prev AND NOT v_active THEN
    v_alert := public.treg_pool_claim_alert('health_broken', p_key_id, p_status, NULL);
  END IF;
  RETURN jsonb_build_object('success', true, 'status', p_status, 'needs_failover', v_active AND p_status IN ('revoked', 'out_of_balance'), 'alert_health', v_alert);
END;
$$;

-- Which pool key made which provider call (number and label only). Called after a call is recorded in provider_costs. Never fails a call.
CREATE OR REPLACE FUNCTION public.treg_pool_record_call(p_cost_id bigint, p_key_id uuid, p_source text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  IF p_cost_id IS NULL OR p_key_id IS NULL OR p_source IS NULL OR p_source NOT IN ('website', 'worker') THEN RETURN; END IF;
  INSERT INTO public.treg_pool_calls (provider_cost_id, key_id, key_number, key_label, source)
  SELECT p_cost_id, k.id, k.number, k.label, p_source FROM public.treg_pool_keys k WHERE k.id = p_key_id
  ON CONFLICT (provider_cost_id) DO NOTHING;
END;
$$;

-- Spend per key, READ ONLY: the cost rows the platform already wrote (provider_costs), grouped by the key that made the call.
CREATE OR REPLACE FUNCTION public.treg_pool_spend()
RETURNS TABLE (key_number integer, key_label text, calls bigint, spend_usd numeric, spend_today_usd numeric, last_call_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT c.key_number,
         (array_agg(c.key_label ORDER BY c.created_at DESC))[1],
         count(*),
         coalesce(sum(p.cost_usd), 0),
         coalesce(sum(p.cost_usd) FILTER (WHERE p.created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')), 0),
         max(p.created_at)
  FROM public.treg_pool_calls c
  JOIN public.provider_costs p ON p.id = c.provider_cost_id
  GROUP BY c.key_number
  ORDER BY c.key_number;
$$;

-- What the admin table shows: no ciphertext, ever.
CREATE OR REPLACE FUNCTION public.treg_pool_overview()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT jsonb_build_object(
    'state', jsonb_build_object('rollout_on', s.rollout_on, 'active_key_id', s.active_key_id, 'generation', s.generation, 'min_balance_micro', s.min_balance_micro,
                                'last_health_run_at', s.last_health_run_at, 'worker_env_last4', s.worker_env_last4, 'worker_seen_at', s.worker_seen_at),
    'keys', coalesce((SELECT jsonb_agg(jsonb_build_object('id', k.id, 'number', k.number, 'label', k.label, 'is_main', k.is_main, 'in_chain', k.in_chain,
                       'chain_position', k.chain_position, 'last4', k.last4, 'account_email', k.account_email, 'status', k.status, 'status_reason', k.status_reason,
                       'status_checked_at', k.status_checked_at, 'balance_micro', k.balance_micro, 'balance_checked_at', k.balance_checked_at, 'created_at', k.created_at)
                       ORDER BY k.number) FROM public.treg_pool_keys k WHERE k.removed_at IS NULL), '[]'::jsonb),
    'events', coalesce((SELECT jsonb_agg(e ORDER BY e.at DESC) FROM (
                       SELECT at, kind, key_number, key_label, to_key_number, to_key_label, reason, source FROM public.treg_pool_events ORDER BY id DESC LIMIT 20) e), '[]'::jsonb)
  )
  FROM public.treg_pool_state s WHERE s.id = 1;
$$;

-- The background health check may run at most once per interval (the cron tick asks; the first caller wins).
CREATE OR REPLACE FUNCTION public.treg_pool_claim_health_run(p_min_interval_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  UPDATE public.treg_pool_state SET last_health_run_at = now()
  WHERE id = 1 AND (last_health_run_at IS NULL OR last_health_run_at < now() - make_interval(secs => greatest(coalesce(p_min_interval_seconds, 600), 60)));
  RETURN FOUND;
END;
$$;

-- The worker reports the last 4 characters of Heroku's TREG_TOKEN, so the admin table can warn when it is not the main key.
CREATE OR REPLACE FUNCTION public.treg_pool_note_worker(p_env_last4 text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  UPDATE public.treg_pool_state SET worker_env_last4 = nullif(left(coalesce(p_env_last4, ''), 4), ''), worker_seen_at = now() WHERE id = 1;
$$;

-- Mail outbox for the cron route: take up to p_limit alerts that were not e-mailed, lease them for 3 minutes, return them as json.
CREATE OR REPLACE FUNCTION public.treg_pool_take_pending_alerts(p_limit integer DEFAULT 10)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v jsonb;
BEGIN
  WITH picked AS (
    SELECT a.id FROM public.treg_pool_alerts a
    WHERE a.emailed_at IS NULL AND a.email_attempts < 5 AND a.created_at > now() - interval '24 hours'
      AND (a.email_lease_until IS NULL OR a.email_lease_until < now())
    ORDER BY a.id LIMIT greatest(1, least(coalesce(p_limit, 10), 25)) FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE public.treg_pool_alerts a SET email_lease_until = now() + interval '3 minutes', email_attempts = a.email_attempts + 1
    FROM picked WHERE a.id = picked.id
    RETURNING a.id, a.problem, a.key_number, a.key_label, a.to_key_number, a.to_key_label, a.reason, a.created_at
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', upd.id, 'problem', upd.problem, 'key_number', upd.key_number, 'key_label', upd.key_label,
         'to_key_number', upd.to_key_number, 'to_key_label', upd.to_key_label, 'reason', upd.reason, 'created_at', upd.created_at) ORDER BY upd.id), '[]'::jsonb)
  INTO v FROM upd;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.treg_pool_mark_alert_emailed(p_alert_id bigint, p_ok boolean)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  UPDATE public.treg_pool_alerts SET emailed_at = CASE WHEN p_ok THEN now() ELSE emailed_at END, email_lease_until = CASE WHEN p_ok THEN email_lease_until ELSE NULL END
  WHERE id = p_alert_id;
$$;

-- ---- privileges: service role only ---------------------------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.treg_pool_log_event(text, uuid, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.treg_pool_clear_alerts(uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.treg_pool_next_key(uuid) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.treg_pool_claim_alert(text, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_add_treg_pool_key(uuid, uuid, text, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_replace_treg_pool_key(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_remove_treg_pool_key(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_set_treg_active_key(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_set_treg_chain(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_set_treg_rollout(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_set_treg_pool_settings(uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.treg_pool_enc_key() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.treg_pool_runtime() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.treg_pool_record_failover(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.treg_pool_record_check(uuid, text, text, bigint, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.treg_pool_record_call(bigint, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.treg_pool_spend() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.treg_pool_overview() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.treg_pool_claim_health_run(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.treg_pool_note_worker(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.treg_pool_take_pending_alerts(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.treg_pool_mark_alert_emailed(bigint, boolean) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.treg_pool_claim_alert(text, uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_add_treg_pool_key(uuid, uuid, text, text, text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_replace_treg_pool_key(uuid, uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_remove_treg_pool_key(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_treg_active_key(uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_treg_chain(uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_treg_rollout(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_treg_pool_settings(uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.treg_pool_enc_key() TO service_role;
GRANT EXECUTE ON FUNCTION public.treg_pool_runtime() TO service_role;
GRANT EXECUTE ON FUNCTION public.treg_pool_record_failover(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.treg_pool_record_check(uuid, text, text, bigint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.treg_pool_record_call(bigint, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.treg_pool_spend() TO service_role;
GRANT EXECUTE ON FUNCTION public.treg_pool_overview() TO service_role;
GRANT EXECUTE ON FUNCTION public.treg_pool_claim_health_run(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.treg_pool_note_worker(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.treg_pool_take_pending_alerts(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.treg_pool_mark_alert_emailed(bigint, boolean) TO service_role;
