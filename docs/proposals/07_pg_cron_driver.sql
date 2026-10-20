-- PROPOSAL (not applied, not in supabase/migrations). Apply order: 7 of 7. Needs the route src/app/api/cron/drive (parked branch).
-- 4g: a driver so an approved job keeps running with the page closed. The platform's own cron is daily (Hobby plan), so the
-- database scheduler calls the app every minute. The driver only asks the existing worker route to run the next chunk of a job
-- that is ALREADY approved and reserved; it reserves, charges and releases nothing.
--
-- The owner creates two Vault secrets ONCE in the SQL editor (never paste them in chat or into a file):
--   select vault.create_secret('<the same value as the CRON_SECRET environment variable>', 'diger-cron-secret');
--   select vault.create_secret('https://diger.tech', 'diger-app-base-url');
-- Without them the tick does nothing and breaks nothing.

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.drive_jobs_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_secret text;
  v_base text;
BEGIN
  -- nothing to drive: skip the HTTP call entirely
  IF NOT EXISTS (
    SELECT 1 FROM public.jobs
    WHERE status IN ('queued', 'running')
      AND (lease_until IS NULL OR lease_until < now())
      AND updated_at > now() - interval '25 minutes'
  ) THEN
    RETURN;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'diger-cron-secret';
    SELECT decrypted_secret INTO v_base FROM vault.decrypted_secrets WHERE name = 'diger-app-base-url';
    IF coalesce(v_secret, '') = '' OR coalesce(v_base, '') = '' THEN
      RETURN;
    END IF;
    PERFORM net.http_get(
      url := rtrim(v_base, '/') || '/api/cron/drive',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret),
      timeout_milliseconds := 55000
    );
  EXCEPTION WHEN OTHERS THEN
    -- a failed tick must never break the scheduler; the next minute tries again
    NULL;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.drive_jobs_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drive_jobs_tick() TO service_role;

-- every minute; unschedule first so re-running this file never creates a second schedule
DO $$
BEGIN
  PERFORM cron.unschedule('diger-drive-jobs') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'diger-drive-jobs');
  PERFORM cron.schedule('diger-drive-jobs', '* * * * *', 'select public.drive_jobs_tick()');
END $$;
