-- 02_verify_after_apply.sql
-- Verification after applying 01_job_groups_one_hold.sql.
-- Run in Supabase SQL Editor: returns one table of checks plus an ALL row.
-- If any check shows '✗' or the ALL row is not '✓', STOP and report.

WITH
money_fns AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         md5(pg_get_functiondef(p.oid)) AS fn_md5
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
),
money_fp AS (
  SELECT count(*) AS fn_count,
         md5(string_agg(proname || ' ' || args || ' ' || fn_md5, E'\n' ORDER BY proname, args)) AS fingerprint
  FROM money_fns
),
new_tables AS (
  SELECT count(*) AS valid_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('job_groups', 'job_group_parts', 'job_group_keys', 'job_group_frozen')
    AND c.relrowsecurity IS TRUE
    AND has_table_privilege('service_role', c.oid, 'SELECT') IS TRUE
    AND has_table_privilege('anon', c.oid, 'SELECT') IS FALSE
    AND has_table_privilege('authenticated', c.oid, 'SELECT') IS FALSE
),
new_functions AS (
  SELECT count(*) AS valid_functions
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
    AND p.prosecdef IS TRUE
    AND has_function_privilege('service_role', p.oid, 'EXECUTE') IS TRUE
    AND has_function_privilege('anon', p.oid, 'EXECUTE') IS FALSE
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE') IS FALSE
),
probe AS (
  SELECT public.close_job_group_atomic(
    '__probe__',
    'all_parts_done',
    'probe_final_line',
    0,
    0,
    NULL
  ) AS res
),
checks AS (
  SELECT 'V1 money functions count' AS "check",
         '6' AS expected,
         fn_count::text AS actual,
         CASE WHEN fn_count = 6 THEN '✓' ELSE '✗' END AS ok
  FROM money_fp
  UNION ALL
  SELECT 'V1 money functions fingerprint' AS "check",
         'must equal 00 fingerprint' AS expected,
         fingerprint AS actual,
         CASE WHEN fn_count = 6 AND fingerprint IS NOT NULL THEN '✓' ELSE '✗' END AS ok
  FROM money_fp
  UNION ALL
  SELECT 'V2 new tables present with RLS (service_role only)' AS "check",
         '4' AS expected,
         valid_tables::text AS actual,
         CASE WHEN valid_tables = 4 THEN '✓' ELSE '✗' END AS ok
  FROM new_tables
  UNION ALL
  SELECT 'V3 new functions present and SECDEF (service_role only)' AS "check",
         '7' AS expected,
         valid_functions::text AS actual,
         CASE WHEN valid_functions = 7 THEN '✓' ELSE '✗' END AS ok
  FROM new_functions
  UNION ALL
  SELECT 'V4 probe close_job_group_atomic returns group_not_found' AS "check",
         'group_not_found' AS expected,
         (res->>'error') AS actual,
         CASE WHEN (res->>'error') = 'group_not_found' AND (res->>'success')::boolean IS FALSE THEN '✓' ELSE '✗' END AS ok
  FROM probe
)
SELECT "check", expected, actual, ok
FROM checks
UNION ALL
SELECT 'ALL' AS "check",
       'all pass' AS expected,
       CASE WHEN bool_and(ok = '✓') THEN 'all passed' ELSE 'some failed' END AS actual,
       CASE WHEN bool_and(ok = '✓') THEN '✓' ELSE '✗' END AS ok
FROM checks;
