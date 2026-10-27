-- READ ONLY. Paste in the Supabase SQL editor BEFORE applying anything. NOT APPLIED.

-- 1. none of the three tables exists yet (expected: 0 rows)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('recipes', 'exploration_calls', 'unknown_keys');

-- 2. gen_random_uuid() is available (expected: true; it is built in since PostgreSQL 13)
SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') AS has_gen_random_uuid;

-- 3. the roles the grants below name exist (expected: anon, authenticated, service_role)
SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') ORDER BY rolname;
