-- NOT APPLIED. Removes what 01_agent_tables.sql created. Missions, their events and calls are DELETED (they hold no money: the ledger, jobs and quotes are untouched).
-- Run it only when no mission is approved or executing: an approved mission has money reserved under a job, and the job must be settled or released first (the admin page's
-- missions list shows them; or SELECT id, job_id, status FROM public.missions WHERE status IN ('approved','executing')).
BEGIN;
DROP TABLE IF EXISTS public.mission_calls;
DROP TABLE IF EXISTS public.mission_events;
DROP TABLE IF EXISTS public.missions;
DROP TABLE IF EXISTS public.agent_worker_heartbeat;
DROP TABLE IF EXISTS public.agent_settings;
COMMIT;
