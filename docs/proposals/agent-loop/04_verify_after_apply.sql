-- READ ONLY. After applying 01 to 03. NOT APPLIED.

-- 1. three tables, RLS on (expected: three rows, rls_enabled = true)
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('recipes', 'exploration_calls', 'unknown_keys') ORDER BY c.relname;

-- 2. no policy at all (expected: 0 rows): only the service role can use them
SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('recipes', 'exploration_calls', 'unknown_keys');

-- 3. no privilege for anon or authenticated (expected: 0 rows)
SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name IN ('recipes', 'exploration_calls', 'unknown_keys') AND grantee IN ('anon', 'authenticated', 'PUBLIC');

-- 4. the immutability trigger and the one-reviewed-version index exist (expected: 1 and 1)
SELECT count(*) AS triggers FROM pg_trigger WHERE tgname = 'recipes_guard_update' AND NOT tgisinternal;
SELECT count(*) AS indexes FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'recipes_one_reviewed_per_slug';

-- 5. the money tables are untouched (expected: the same row counts as before; this proposal never writes them)
SELECT 'credit_ledger' AS t, count(*) FROM public.credit_ledger UNION ALL SELECT 'jobs', count(*) FROM public.jobs UNION ALL SELECT 'plans_quotes', count(*) FROM public.plans_quotes;
