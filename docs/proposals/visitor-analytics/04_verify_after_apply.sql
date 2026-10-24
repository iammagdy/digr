-- READ ONLY. Paste after step 3 (and after each earlier step to see how far it got). The expected answer is in each comment.

-- 1. the table and its columns (expected: 10 rows, none called ip, user_agent, query, body, email or token)
SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'visitor_events' ORDER BY ordinal_position;

-- 2. RLS on and NO policy (expected: rls_enabled = true, policies = 0)
SELECT c.relrowsecurity AS rls_enabled, (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'visitor_events') AS policies
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'visitor_events';

-- 3. privileges (expected: anon_any = false, authenticated_any = false, public_any = false, service_role_select / insert / delete = true)
SELECT has_table_privilege('anon', 'public.visitor_events', 'SELECT,INSERT,UPDATE,DELETE')          AS anon_any,
       has_table_privilege('authenticated', 'public.visitor_events', 'SELECT,INSERT,UPDATE,DELETE') AS authenticated_any,
       has_table_privilege('public', 'public.visitor_events', 'SELECT,INSERT,UPDATE,DELETE')        AS public_any,
       has_table_privilege('service_role', 'public.visitor_events', 'SELECT')                       AS service_role_select,
       has_table_privilege('service_role', 'public.visitor_events', 'INSERT')                       AS service_role_insert,
       has_table_privilege('service_role', 'public.visitor_events', 'DELETE')                       AS service_role_delete;

-- 4. the indexes (expected: the primary key and the five of step 2)
SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'visitor_events' ORDER BY indexname;

-- 5. rows (expected: 0 right after applying, then growing as visitors arrive; a sample of the newest, no sensitive column exists)
SELECT count(*) AS rows_total FROM public.visitor_events;
SELECT kind, path, country, device_class, started_at FROM public.visitor_events ORDER BY started_at DESC LIMIT 5;
