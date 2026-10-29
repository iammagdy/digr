-- ROLLBACK of 02. Run after 04 and 03 were rolled back. Switch the rollout OFF in the admin first (it is OFF by default).
-- Dropping the tables deletes the pool's keys, events, alerts and per-call key marks. The main key (provider_api_keys, Heroku TREG_TOKEN)
-- and every existing table are not affected, so the platform returns to exactly what it is today.
DROP TABLE IF EXISTS public.treg_pool_calls;
DROP TABLE IF EXISTS public.treg_pool_alerts;
DROP TABLE IF EXISTS public.treg_pool_events;
DROP TABLE IF EXISTS public.treg_pool_state;
DROP TABLE IF EXISTS public.treg_pool_keys;
DROP FUNCTION IF EXISTS public.block_treg_pool_events_mutation();
