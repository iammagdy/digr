-- READ ONLY. Checks after applying 07_planning_sessions.sql (never changes anything).
SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'planning_sessions' ORDER BY ordinal_position;
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.planning_sessions'::regclass;
SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'planning_sessions' ORDER BY 1, 2;
-- after a mission request: one row per request, status 'done' with a result, state cleared
SELECT id, status, steps, errors, created_at, updated_at FROM public.planning_sessions ORDER BY created_at DESC LIMIT 5;
