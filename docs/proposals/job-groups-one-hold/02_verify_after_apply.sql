-- 02_verify_after_apply.sql
-- Verification AFTER applying 01_job_groups_one_hold.sql. ONE final SELECT: check | expected | actual | ok, then an ALL row.
-- Every row must show ✓ and ALL must show ✓. Any ✗ -> STOP and send a screenshot to COMMANDER.
-- The V1 rows are the SAME rows, with the SAME reference md5 values, as in 00: after applying 01 the 6 existing money functions
-- must still match the reference exactly (row by row), and the combined fingerprint must equal the value 00 showed.
-- Read-only except the probe: close_job_group_atomic('__probe__', ...) returns group_not_found and writes nothing.
-- Needs 01 applied first (otherwise the probe fails with "function does not exist").

WITH
ref_fn(label, proname, nargs, ref_md5) AS (
  VALUES
  ('accept_quote_atomic (3 args)', 'accept_quote_atomic', 3, '47ec0be98e37b115cb81ba43ed5e4e17'),
  ('create_quote_atomic (8 args)', 'create_quote_atomic', 8, 'f65faafba82227a9167cde2b34d36e91'),
  ('release_job_atomic (2 args)', 'release_job_atomic', 2, '656bac1dea9a8dfb9a39f04a79de8132'),
  ('release_job_atomic (3 args)', 'release_job_atomic', 3, '87ecb52e24eaed03ad847e58028e5125'),
  ('reserve_credits_atomic (4 args)', 'reserve_credits_atomic', 4, '24df74bec3cd22e75850b418f7b5e094'),
  ('settle_job_atomic (3 args)', 'settle_job_atomic', 3, '106023a8c6d493958d07570cab7b371b')
),
live_fn AS (
  -- Version-stable hash: only fields that PostgreSQL 15 and 17 store or render identically
  -- (name, identity argument list, result type, prosrc = the function body text as stored, SECURITY DEFINER flag,
  -- volatility, proconfig). NOT pg_get_functiondef, whose header layout can differ between versions.
  SELECT p.proname,
         p.pronargs::int AS nargs,
         md5(p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|' || pg_get_function_result(p.oid)
             || '|' || p.prosrc || '|' || p.prosecdef::text || '|' || p.provolatile::text
             || '|' || COALESCE(array_to_string(p.proconfig, ','), '')) AS h
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('accept_quote_atomic', 'create_quote_atomic', 'reserve_credits_atomic', 'settle_job_atomic', 'release_job_atomic')
),
live_agg AS (
  SELECT proname, nargs, count(*) AS n, string_agg(h, ',' ORDER BY h) AS hs
  FROM live_fn
  GROUP BY proname, nargs
),
live_fp AS (
  SELECT count(*) AS fn_count,
         md5(string_agg(h, ',' ORDER BY proname, nargs, h)) AS fingerprint
  FROM live_fn
),
new_tables AS (
  SELECT count(*) AS valid_tables
  FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace
    AND c.relname IN ('job_groups', 'job_group_parts', 'job_group_keys', 'job_group_frozen')
    AND c.relrowsecurity IS TRUE
    AND has_table_privilege('service_role', c.oid, 'SELECT') IS TRUE
    AND has_table_privilege('anon', c.oid, 'SELECT') IS FALSE
    AND has_table_privilege('authenticated', c.oid, 'SELECT') IS FALSE
),
new_functions AS (
  SELECT count(*) AS valid_functions
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('accept_group_quote_atomic', 'draw_next_group_part_atomic', 'close_job_group_atomic', 'claim_next_job_group',
                      'freeze_and_settle_group_part_atomic', 'release_unfrozen_group_part_atomic', 'job_group_points_ar')
    AND p.prosecdef IS TRUE
    AND has_function_privilege('service_role', p.oid, 'EXECUTE') IS TRUE
    AND has_function_privilege('anon', p.oid, 'EXECUTE') IS FALSE
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE') IS FALSE
),
new_triggers AS (
  SELECT count(*) AS n
  FROM pg_trigger t
  WHERE NOT t.tgisinternal AND t.tgname IN ('trg_block_job_group_parts_mutation', 'trg_block_job_group_keys_mutation', 'trg_block_job_group_frozen_mutation')
),
probe AS (
  SELECT public.close_job_group_atomic('__probe__', 'all_parts_done', 'probe_final_line', 0, 0, NULL) AS res
),
checks AS (
  SELECT 10 + row_number() OVER (ORDER BY r.label) AS ord,
         'V1 ' || r.label AS "check",
         r.ref_md5 AS expected,
         COALESCE(l.hs, 'MISSING') AS actual,
         CASE WHEN l.n = 1 AND l.hs = r.ref_md5 THEN '✓' ELSE '✗' END AS ok
  FROM ref_fn r
  LEFT JOIN live_agg l ON l.proname = r.proname AND l.nargs = r.nargs
  UNION ALL
  SELECT 20, 'V1 money functions: exactly 6 signatures (no extra, none missing)', '6', fn_count::text,
         CASE WHEN fn_count = 6 THEN '✓' ELSE '✗' END
  FROM live_fp
  UNION ALL
  SELECT 21, 'V1 money functions combined fingerprint (00 and 02 must show the same value)', '54942340e91a38948f249e1e9e67c5c2', COALESCE(fingerprint, 'MISSING'),
         CASE WHEN fingerprint = '54942340e91a38948f249e1e9e67c5c2' THEN '✓' ELSE '✗' END
  FROM live_fp
  UNION ALL
  SELECT 40, 'V2 new tables present with RLS (service_role only)', '4', valid_tables::text,
         CASE WHEN valid_tables = 4 THEN '✓' ELSE '✗' END
  FROM new_tables
  UNION ALL
  SELECT 41, 'V3 new functions present and SECURITY DEFINER (service_role only)', '7', valid_functions::text,
         CASE WHEN valid_functions = 7 THEN '✓' ELSE '✗' END
  FROM new_functions
  UNION ALL
  SELECT 42, 'V3 append-only triggers present', '3', n::text, CASE WHEN n = 3 THEN '✓' ELSE '✗' END
  FROM new_triggers
  UNION ALL
  SELECT 50, 'V4 probe close_job_group_atomic returns group_not_found', 'group_not_found', COALESCE(res->>'error', 'none'),
         CASE WHEN (res->>'error') = 'group_not_found' AND (res->>'success')::boolean IS FALSE THEN '✓' ELSE '✗' END
  FROM probe
),
all_rows AS (
  SELECT ord, "check", expected, actual, ok FROM checks
  UNION ALL
  SELECT 999, 'ALL', 'all pass', CASE WHEN bool_and(ok = '✓') THEN 'all passed' ELSE 'some failed' END,
         CASE WHEN bool_and(ok = '✓') THEN '✓' ELSE '✗' END
  FROM checks
)
SELECT "check", expected, actual, ok
FROM all_rows
ORDER BY ord;
