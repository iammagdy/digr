-- READ ONLY. After applying 01 to 03. NOT APPLIED.

-- 1. five tables, RLS on (expected: five rows, rls_enabled = true)
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('missions', 'mission_events', 'mission_calls', 'agent_worker_heartbeat', 'agent_settings') ORDER BY c.relname;

-- 2. the only policies: a customer reads their own missions and their missions' events (expected: exactly these two rows, both SELECT)
SELECT tablename, policyname, cmd, roles FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('missions', 'mission_events', 'mission_calls', 'agent_worker_heartbeat', 'agent_settings') ORDER BY tablename, policyname;

-- 3. no write privilege for anon or authenticated on any of them (expected: 0 rows)
SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name IN ('missions', 'mission_events', 'mission_calls', 'agent_worker_heartbeat', 'agent_settings')
  AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT';

-- 4. anon has nothing at all (expected: 0 rows)
SELECT table_name, privilege_type FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name IN ('missions', 'mission_events', 'mission_calls', 'agent_worker_heartbeat', 'agent_settings') AND grantee IN ('anon', 'PUBLIC');

-- 5. authenticated reads only the customer-safe columns of missions (expected: 16 columns; none of plan, error, worker_id, lease_until, *_llm_usd, *_treg_usd, *_model, quote_id)
SELECT column_name FROM information_schema.column_privileges
WHERE table_schema = 'public' AND table_name = 'missions' AND grantee = 'authenticated' AND privilege_type = 'SELECT' ORDER BY column_name;

-- 6. authenticated and anon have no privilege on mission_calls, agent_settings, agent_worker_heartbeat (expected: 0 rows)
SELECT table_name, grantee FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name IN ('mission_calls', 'agent_settings', 'agent_worker_heartbeat') AND grantee IN ('anon', 'authenticated', 'PUBLIC');

-- 7. the claim function exists and only the service role may run it (expected: one row, is_security_definer = true; then no EXECUTE for anon / authenticated)
SELECT p.proname, p.prosecdef AS is_security_definer FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'agent_claim_mission';
SELECT has_function_privilege('anon', 'public.agent_claim_mission(text, integer)', 'EXECUTE') AS anon_can,
       has_function_privilege('authenticated', 'public.agent_claim_mission(text, integer)', 'EXECUTE') AS authenticated_can,
       has_function_privilege('service_role', 'public.agent_claim_mission(text, integer)', 'EXECUTE') AS service_role_can;

-- 8. the bucket is private (expected: one row, public = false)
SELECT id, public, file_size_limit FROM storage.buckets WHERE id = 'agent-missions';

-- 9. no storage policy was added for it (expected: 0 rows)
SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND (qual ILIKE '%agent-missions%' OR with_check ILIKE '%agent-missions%');

-- 10. the heartbeat table has the two memory columns (expected: two rows, rss_mb and tree_rss_mb, integer)
SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_worker_heartbeat' AND column_name IN ('rss_mb', 'tree_rss_mb') ORDER BY column_name;

-- 11. the money tables are untouched (expected: the same row counts as before applying; this proposal never writes them)
SELECT 'credit_ledger' AS t, count(*) FROM public.credit_ledger UNION ALL SELECT 'jobs', count(*) FROM public.jobs UNION ALL SELECT 'plans_quotes', count(*) FROM public.plans_quotes UNION ALL SELECT 'provider_costs', count(*) FROM public.provider_costs;
