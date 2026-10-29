-- PROPOSAL, NOT APPLIED. ADDITIVE ONLY: one new function and one new pg_cron job. Requires 02 and 03. Reuses the TWO Vault secrets that
-- the existing job «diger-drive-jobs» already uses (diger-cron-secret, diger-app-base-url); it creates no secret and no extension.
--
-- What it does: once a minute the database LOOKS (no HTTP) whether anything is due:
--   (a) an admin e-mail is waiting in treg_pool_alerts, or
--   (b) the pool holds a key and the last background health check is older than 10 minutes.
-- Only then it calls /api/cron/treg-pool with the cron secret. That route sends the waiting e-mails and, when the claim succeeds
-- (treg_pool_claim_health_run, at most one run per 10 minutes whoever calls), checks every pool key with two cheap READ-ONLY TREG calls
-- (identity + balance). With no key in the pool the tick returns at once and today's platform is not touched at all.
-- It reserves, charges and releases nothing and does not touch any money table or function.
CREATE OR REPLACE FUNCTION public.treg_pool_tick()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_secret text;
  v_base text;
  v_due boolean;
BEGIN
  SELECT (
    EXISTS (SELECT 1 FROM public.treg_pool_alerts a WHERE a.emailed_at IS NULL AND a.email_attempts < 5 AND a.created_at > now() - interval '24 hours')
    OR (
      EXISTS (SELECT 1 FROM public.treg_pool_keys k WHERE k.removed_at IS NULL)
      AND coalesce((SELECT s.last_health_run_at IS NULL OR s.last_health_run_at < now() - interval '10 minutes' FROM public.treg_pool_state s WHERE s.id = 1), false)
    )
  ) INTO v_due;
  IF NOT coalesce(v_due, false) THEN RETURN; END IF;

  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'diger-cron-secret';
    SELECT decrypted_secret INTO v_base FROM vault.decrypted_secrets WHERE name = 'diger-app-base-url';
    IF coalesce(v_secret, '') = '' OR coalesce(v_base, '') = '' THEN RETURN; END IF;
    PERFORM net.http_get(
      url := rtrim(v_base, '/') || '/api/cron/treg-pool',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret),
      timeout_milliseconds := 55000
    );
  EXCEPTION WHEN OTHERS THEN
    -- a failed tick must never break the scheduler; the next minute tries again
    NULL;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.treg_pool_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.treg_pool_tick() TO service_role;

-- every minute; unschedule first so running this file twice never creates a second schedule
DO $$
BEGIN
  PERFORM cron.unschedule('diger-treg-pool-tick') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'diger-treg-pool-tick');
  PERFORM cron.schedule('diger-treg-pool-tick', '* * * * *', 'select public.treg_pool_tick()');
END $$;
