-- FOR A SCRATCH POSTGRESQL ONLY (never Supabase): behaviour check of 01 and 02 after they are applied, with the Supabase roles stubbed (tests/sql/supabase-stubs.sql).
-- It writes test rows into the five agent tables only, and rolls everything back. NOT APPLIED to any Supabase project.
BEGIN;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;   -- as Supabase has it; the scratch stub does not
INSERT INTO auth.users (id, email) VALUES ('11111111-1111-1111-1111-111111111111', 'a@test.local'), ('22222222-2222-2222-2222-222222222222', 'b@test.local');
INSERT INTO public.missions (id, user_id, request_text, status, plan, plan_public, error) VALUES
  ('msn_aaaaaaaa', '11111111-1111-1111-1111-111111111111', 'mission of A', 'queued', '{"internal": "endpoint ids"}', '{"summary_ar": "x"}', 'internal error'),
  ('msn_bbbbbbbb', '22222222-2222-2222-2222-222222222222', 'mission of B', 'approved', NULL, NULL, NULL);
INSERT INTO public.mission_events (mission_id, kind, message_ar) VALUES ('msn_aaaaaaaa', 'progress', 'line of A'), ('msn_bbbbbbbb', 'progress', 'line of B');
INSERT INTO public.mission_calls (id, mission_id, phase, endpoint_id, status) VALUES ('msn_aaaaaaaa:call_0001', 'msn_aaaaaaaa', 'planning', 'x.y.z', 'ok');
INSERT INTO public.agent_worker_heartbeat (worker_id, beat_at) VALUES ('w1', now());
INSERT INTO public.agent_settings (key, value) VALUES ('planning_model', '{"model":"claude-sonnet-5-5"}');

-- a customer (A) reads only their own mission and its events
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
SELECT 'A sees missions', count(*) AS n, string_agg(id, ',') FROM public.missions;                  -- expected 1, msn_aaaaaaaa
SELECT 'A sees events', count(*) AS n, string_agg(message_ar, ',') FROM public.mission_events;     -- expected 1, line of A
SELECT 'A reads safe columns', id, status, plan_public FROM public.missions;
DO $$ BEGIN PERFORM plan FROM public.missions; RAISE EXCEPTION 'A READ THE INTERNAL PLAN'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: A cannot read the internal plan column'; END $$;
DO $$ BEGIN PERFORM error FROM public.missions; RAISE EXCEPTION 'A READ THE INTERNAL ERROR'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: A cannot read the error column'; END $$;
DO $$ BEGIN PERFORM * FROM public.mission_calls; RAISE EXCEPTION 'A READ CALLS'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: A cannot read mission_calls'; END $$;
DO $$ BEGIN PERFORM * FROM public.agent_settings; RAISE EXCEPTION 'A READ SETTINGS'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: A cannot read agent_settings'; END $$;
DO $$ BEGIN PERFORM * FROM public.agent_worker_heartbeat; RAISE EXCEPTION 'A READ HEARTBEAT'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: A cannot read the heartbeat'; END $$;
DO $$ BEGIN INSERT INTO public.missions (user_id, request_text) VALUES ('11111111-1111-1111-1111-111111111111', 'x'); RAISE EXCEPTION 'A INSERTED'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: A cannot insert'; END $$;
DO $$ BEGIN UPDATE public.missions SET status = 'completed'; RAISE EXCEPTION 'A UPDATED'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: A cannot update'; END $$;
DO $$ BEGIN DELETE FROM public.mission_events; RAISE EXCEPTION 'A DELETED'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: A cannot delete'; END $$;
DO $$ BEGIN PERFORM public.agent_claim_mission('wX', 60); RAISE EXCEPTION 'A CLAIMED'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: A cannot run the claim function'; END $$;
RESET ROLE;

-- anon reads nothing
SET LOCAL ROLE anon;
DO $$ BEGIN PERFORM * FROM public.missions; RAISE EXCEPTION 'ANON READ'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: anon cannot read missions'; END $$;
RESET ROLE;

-- the service role reads and writes everything, and claims atomically
SET LOCAL ROLE service_role;
SELECT 'service sees', count(*) FROM public.missions;                                              -- expected 2
SELECT 'claim 1', id, status, worker_id FROM public.agent_claim_mission('w1', 120);               -- msn_aaaaaaaa -> planning
SELECT 'claim 2', id, status, worker_id FROM public.agent_claim_mission('w2', 120);               -- msn_bbbbbbbb -> executing
SELECT 'claim 3 (none left)', count(*) FROM public.agent_claim_mission('w3', 120);                -- 0
UPDATE public.missions SET lease_until = now() - interval '1 second' WHERE id = 'msn_bbbbbbbb';   -- its worker died
SELECT 'takeover', id, status, worker_id FROM public.agent_claim_mission('w3', 120);              -- msn_bbbbbbbb, executing, w3
SELECT 'needs_input is not claimed', count(*) FROM (SELECT 1 FROM public.missions WHERE status = 'needs_input') s;
RESET ROLE;
ROLLBACK;
