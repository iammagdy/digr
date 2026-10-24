-- READ ONLY. Paste in the Supabase SQL editor BEFORE applying anything. It shows that the table does not exist yet and which roles exist.
-- Nothing in this folder touches a money table, an existing function or an existing policy.

-- 1. the table must not exist yet (expected: 0 rows)
SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'visitor_events';

-- 2. the roles the access step names (expected: the three rows anon, authenticated, service_role)
SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') ORDER BY rolname;

-- 3. the jobs and profiles tables the admin screen counts from (read only; expected: both rows, with user_id / created_at on jobs and created_at on profiles)
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema = 'public' AND ((table_name = 'jobs' AND column_name IN ('user_id', 'created_at')) OR (table_name = 'profiles' AND column_name = 'created_at'))
ORDER BY table_name, column_name;
