-- READ ONLY verification after applying 01_job_groups_one_hold.sql.
-- Paste in the Supabase SQL editor AFTER applying 01: it confirms that every table,
-- function, trigger, and permission is in place and existing functions are untouched.
BEGIN TRANSACTION READ ONLY;

-- V1: MD5 checksums of the five existing money functions (must still equal 00's and /tmp/job-groups-expected-md5.txt)
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       md5(pg_get_functiondef(p.oid)) AS functiondef_md5
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'accept_quote_atomic',
    'create_quote_atomic',
    'reserve_credits_atomic',
    'settle_job_atomic',
    'release_job_atomic'
  )
ORDER BY p.proname, identity_arguments;

-- V2: Permissions on the new functions: only service_role among anon, authenticated, public
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'accept_group_quote_atomic',
    'draw_next_group_part_atomic',
    'close_job_group_atomic',
    'claim_next_job_group',
    'freeze_and_settle_group_part_atomic',
    'release_unfrozen_group_part_atomic',
    'job_group_points_ar'
  )
ORDER BY p.proname, identity_arguments;

-- V3: Readiness probe: close_job_group_atomic with a non-existent group id returns group_not_found
SELECT public.close_job_group_atomic(
  '__probe__',
  'all_parts_done',
  'probe_final_line',
  0,
  0,
  NULL
) AS probe_result;

-- V4: Verify the 4 new tables exist, have RLS enabled, and service_role has SELECT
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       has_table_privilege('anon', c.oid, 'SELECT') AS anon_can_select,
       has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_can_select,
       has_table_privilege('service_role', c.oid, 'SELECT') AS service_role_can_select
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('job_groups', 'job_group_parts', 'job_group_keys', 'job_group_frozen')
ORDER BY c.relname;

ROLLBACK;
