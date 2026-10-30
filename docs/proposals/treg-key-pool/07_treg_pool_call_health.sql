-- PROPOSAL, NOT APPLIED. ADDITIVE ONLY: ONE new READ-ONLY function. Requires 02 and 03 (treg_pool_calls) and the existing provider_costs table. Nothing existing is altered.
--
-- Why (incident of 2026-10-30): key #2 showed «متصل» for 15 hours while every data call it made answered 403 «org suspended». The admin table showed the status of the
-- FREE identity and balance reads and the time of the last call of ANY kind, so a dead key looked alive. This function gives the table the two facts that cannot lie:
-- when the key last ANSWERED a data call, and how many calls failed since. It reads the cost rows the platform already writes (provider_costs, joined through
-- treg_pool_calls, like treg_pool_spend) and writes nothing.
--
--   last_ok_at         newest call of the key whose cost row says success OR empty (an empty answer is an answered call: the key worked, the source had no rows)
--   last_failed_at     newest call of the key whose cost row says failed
--   failed_since_ok    failed calls newer than last_ok_at (all failed calls when the key never answered), inside the window below
-- Window: the last 14 days (the join stays small; a key silent for 14 days reads «لا طلب ناجح مسجَّل»).
-- The service role only, like every runtime function of the pool.
CREATE OR REPLACE FUNCTION public.treg_pool_call_health()
RETURNS TABLE (key_number integer, last_ok_at timestamptz, last_failed_at timestamptz, failed_since_ok bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  WITH c AS (
    SELECT tc.key_number, p.status, p.created_at
    FROM public.treg_pool_calls tc
    JOIN public.provider_costs p ON p.id = tc.provider_cost_id
    WHERE p.created_at >= now() - interval '14 days'
  ),
  ok AS (
    SELECT c.key_number, max(c.created_at) AS t FROM c WHERE c.status IN ('success', 'empty') GROUP BY c.key_number
  )
  SELECT c.key_number,
         ok.t,
         max(c.created_at) FILTER (WHERE c.status = 'failed'),
         count(*) FILTER (WHERE c.status = 'failed' AND (ok.t IS NULL OR c.created_at > ok.t))
  FROM c LEFT JOIN ok ON ok.key_number = c.key_number
  GROUP BY c.key_number, ok.t
  ORDER BY c.key_number;
$$;

REVOKE ALL ON FUNCTION public.treg_pool_call_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.treg_pool_call_health() TO service_role;
