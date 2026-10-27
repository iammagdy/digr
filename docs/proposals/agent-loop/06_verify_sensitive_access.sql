-- READ ONLY. After applying 05. NOT APPLIED.

-- 1. both tables exist with RLS on (expected: two rows, rls_enabled = true)
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('verified_business_accounts', 'sensitive_lookup_audit') ORDER BY c.relname;

-- 2. exactly one policy, the admin read of the audit table (expected: one row)
SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('verified_business_accounts', 'sensitive_lookup_audit');

-- 3. privileges: anon and PUBLIC have none; authenticated has SELECT on the audit table only (expected: one row)
SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name IN ('verified_business_accounts', 'sensitive_lookup_audit') AND grantee IN ('anon', 'authenticated', 'PUBLIC');

-- 4. the money tables are untouched (expected: the same row counts as before)
SELECT 'credit_ledger' AS t, count(*) FROM public.credit_ledger UNION ALL SELECT 'jobs', count(*) FROM public.jobs UNION ALL SELECT 'plans_quotes', count(*) FROM public.plans_quotes;
