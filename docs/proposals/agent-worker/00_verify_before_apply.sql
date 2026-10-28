-- READ ONLY. Paste in the Supabase SQL editor BEFORE applying anything. NOT APPLIED.

-- 1. none of the objects exists yet (expected: 0 rows)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('missions', 'mission_events', 'mission_calls', 'agent_worker_heartbeat', 'agent_settings');

-- 2. the claim function does not exist yet (expected: 0 rows)
SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND proname = 'agent_claim_mission';

-- 3. the storage bucket does not exist yet (expected: 0 rows)
SELECT id FROM storage.buckets WHERE id = 'agent-missions';

-- 4. gen_random_uuid() is available (expected: true)
SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') AS has_gen_random_uuid;

-- 5. the roles the grants below name exist (expected: anon, authenticated, service_role)
SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') ORDER BY rolname;

-- 6. the existing money functions the agent calls are present (expected: 6 rows)
SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND proname IN ('create_quote_atomic', 'accept_quote_atomic', 'claim_job_chunk', 'complete_chunk', 'settle_job_atomic', 'release_job_atomic') GROUP BY proname ORDER BY proname;

-- 7. the job cap the quote function enforces (expected: 25000 once docs/proposals/job-cap-25000 is applied; 600 before it, and then a mission above 600 points cannot be approved)
SELECT pg_get_functiondef(p.oid) ~ 'v_cap numeric := 25000' AS create_quote_cap_is_25000
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND proname = 'create_quote_atomic';
