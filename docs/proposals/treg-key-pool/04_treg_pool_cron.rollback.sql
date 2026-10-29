-- ROLLBACK of 04: stop the job, then drop the function. The existing jobs (diger-drive-jobs, diger-cron-cleanup) are not touched.
DO $$
BEGIN
  PERFORM cron.unschedule('diger-treg-pool-tick') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'diger-treg-pool-tick');
END $$;
DROP FUNCTION IF EXISTS public.treg_pool_tick();
