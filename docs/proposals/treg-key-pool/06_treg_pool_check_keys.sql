-- PROPOSAL, NOT APPLIED. ADDITIVE ONLY: ONE new function. Requires 02 and 03. Found while building STEP 2 (a gap in file 03).
--
-- Why: the background health check (every 10 minutes, also while the rollout switch is OFF, decision D7) and the admin's «فحص الآن» must read the keys
-- they check. treg_pool_runtime() deliberately returns NO ciphertext while the switch is OFF and none for a key outside the chain, so it cannot serve them.
-- This function returns the secrets of live keys to the SERVICE ROLE ONLY (same trust level as treg_pool_runtime: the website's server and the cron route),
-- oldest check first, so a pool of 100+ keys is checked in rounds. It writes nothing and touches no existing object.
CREATE OR REPLACE FUNCTION public.treg_pool_keys_for_check(p_ids uuid[] DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'number', x.number, 'label', x.label, 'is_main', x.is_main, 'status', x.status, 'ciphertext', x.ciphertext)
                            ORDER BY x.status_checked_at NULLS FIRST, x.number), '[]'::jsonb)
  FROM (
    SELECT k.id, k.number, k.label, k.is_main, k.status, k.ciphertext, k.status_checked_at
    FROM public.treg_pool_keys k
    WHERE k.removed_at IS NULL AND k.ciphertext IS NOT NULL AND (p_ids IS NULL OR k.id = ANY (p_ids))
    ORDER BY k.status_checked_at NULLS FIRST, k.number
    LIMIT greatest(1, least(coalesce(p_limit, 200), 500))
  ) x;
$$;

REVOKE ALL ON FUNCTION public.treg_pool_keys_for_check(uuid[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.treg_pool_keys_for_check(uuid[], integer) TO service_role;
