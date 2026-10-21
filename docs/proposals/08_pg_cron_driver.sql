-- PROPOSAL (not applied, not in supabase/migrations). Nothing runs until the owner pastes this in the Supabase SQL editor.
-- Steps for the owner: docs/proposals/08_long_job_driver_setup.md
--
-- What it does: once a minute (when there is something to drive, otherwise about every other minute as a heartbeat) the database calls the app route /api/cron/drive with the cron secret. That route only asks the
-- EXISTING worker to run the next chunk of a job that is ALREADY approved and reserved (claim_job_chunk keeps two callers from
-- running the same chunk). It reserves, charges and releases nothing, and this file does not touch any money function or table.
--
-- Two Vault secrets are created ONCE by the owner, before this file (never paste a secret in chat, in a file or in the repository):
--   select vault.create_secret('<the SAME value as the CRON_SECRET environment variable in Vercel>', 'diger-cron-secret');
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
  v_last timestamptz;
BEGIN
  -- the route writes the time of each call to settings_private ('driver_tick'): the app says «you can close the page» only while that is
  -- under 3 minutes old. So with nothing to drive the call is still made when the last heartbeat is older than 100 seconds (about every
  -- other minute), and skipped otherwise: a heartbeat that proves the whole path works, without a call every minute while idle.
  BEGIN
    SELECT (value ->> 'at')::timestamptz INTO v_last FROM public.settings_private WHERE key = 'driver_tick';
  EXCEPTION WHEN OTHERS THEN
    v_last := NULL;
  END;

  -- nothing to drive and the heartbeat is fresh: skip the HTTP call entirely (same window as the route: idle at least 15 s, at most 25 minutes)
  IF NOT EXISTS (
    SELECT 1 FROM public.jobs
    WHERE status IN ('queued', 'running')
      AND (lease_until IS NULL OR lease_until < now())
      AND updated_at > now() - interval '25 minutes'
      AND updated_at < now() - interval '15 seconds'
  ) AND v_last IS NOT NULL AND v_last > now() - interval '100 seconds' THEN
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

-- every minute; unschedule first so running this file twice never creates a second schedule
DO $$
BEGIN
  PERFORM cron.unschedule('diger-drive-jobs') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'diger-drive-jobs');
  PERFORM cron.schedule('diger-drive-jobs', '* * * * *', 'select public.drive_jobs_tick()');
END $$;
