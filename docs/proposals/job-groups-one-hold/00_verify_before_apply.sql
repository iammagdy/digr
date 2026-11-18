-- 00_verify_before_apply.sql
-- Verification BEFORE applying 01_job_groups_one_hold.sql. Read-only: ONE final SELECT, no writes, no BEGIN/ROLLBACK needed.
-- Paste into the Supabase SQL Editor. It returns one table: check | expected | actual | ok, then a final ALL row.
--   * every row must show ✓ and ALL must show ✓  ->  you may run 01.
--   * ANY ✗ (or ALL ✗)  ->  STOP. Do NOT run 01. Send a screenshot of the result to COMMANDER.
-- What it proves (all compared with the reference taken from the repo's reviewed supabase/migrations, built on a scratch database):
--   V1  each of the 6 existing money-function signatures has EXACTLY the reviewed body (md5 per signature), no extra/missing signature,
--       and the combined fingerprint (compare with the same row in 02 after applying 01).
--   V2  release_job_atomic (3 args) is SECURITY DEFINER.
--   V3  none of the objects 01 will create exists yet (tables, indexes, functions in ANY signature, the append-only trigger function
--       block_job_group_mutation, and the 3 triggers), so 01's CREATE OR REPLACE FUNCTION cannot overwrite anything that already exists.
--   V4  the two credit_ledger CHECK constraints are identical to the repo definitions (md5 of the whitespace-free definition).
--   V5  every column the job-group SQL uses exists with the exact data type of the repo migrations.
--   V6  no unexpected triggers on jobs / plans_quotes / job_events.   V7  anon/authenticated cannot execute the money functions.
-- Version note: the per-function hash uses only name, identity arguments, result type, prosrc (body text), SECURITY DEFINER flag,
-- volatility and proconfig. These are stored/rendered the same by PostgreSQL 15 and 17. Constraint definitions are compared after
-- removing all whitespace. If a row shows ✗ the ACTUAL column prints the live value so it can be compared by eye.

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
v2_secdef AS (
  SELECT bool_and(p.prosecdef) AS all_secdef
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'release_job_atomic'
    AND p.pronargs = 3
),
v3_objects AS (
  SELECT count(*) AS existing_new_objects
  FROM (
    SELECT to_regclass('public.job_groups')::text AS obj
    UNION ALL SELECT to_regclass('public.job_group_parts')::text
    UNION ALL SELECT to_regclass('public.job_group_keys')::text
    UNION ALL SELECT to_regclass('public.job_group_frozen')::text
    UNION ALL SELECT to_regproc('public.accept_group_quote_atomic')::text
    UNION ALL SELECT to_regproc('public.draw_next_group_part_atomic')::text
    UNION ALL SELECT to_regproc('public.close_job_group_atomic')::text
    UNION ALL SELECT to_regproc('public.claim_next_job_group')::text
    UNION ALL SELECT to_regproc('public.freeze_and_settle_group_part_atomic')::text
    UNION ALL SELECT to_regproc('public.release_unfrozen_group_part_atomic')::text
    UNION ALL SELECT to_regproc('public.job_group_points_ar')::text
  ) s
  WHERE obj IS NOT NULL
),
v3_fns AS (
  SELECT count(*) AS n, string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', '; ') AS found
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('block_job_group_mutation', 'job_group_points_ar', 'accept_group_quote_atomic', 'draw_next_group_part_atomic', 'close_job_group_atomic', 'claim_next_job_group', 'freeze_and_settle_group_part_atomic', 'release_unfrozen_group_part_atomic')
),
v3_block AS (
  SELECT count(*) AS n
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'block_job_group_mutation'
),
v3_idx AS (
  SELECT count(*) AS n, string_agg(c.relname, '; ') AS found
  FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('idx_job_groups_status_updated_at', 'idx_job_groups_status_attempt_id')
),
v3_trg AS (
  SELECT count(*) AS n, string_agg(t.tgname, '; ') AS found
  FROM pg_trigger t
  WHERE NOT t.tgisinternal AND t.tgname IN ('trg_block_job_group_parts_mutation', 'trg_block_job_group_keys_mutation', 'trg_block_job_group_frozen_mutation')
),
req_cols(tbl, col, typ) AS (
  VALUES
      ('jobs', 'id', 'text'),
      ('jobs', 'user_id', 'uuid'),
      ('jobs', 'status', 'text'),
      ('jobs', 'endpoint_id', 'text'),
      ('jobs', 'target_volume_min', 'integer'),
      ('jobs', 'target_volume_max', 'integer'),
      ('jobs', 'reserved_credits', 'numeric'),
      ('jobs', 'charged_credits', 'numeric'),
      ('jobs', 'delivered_units', 'integer'),
      ('jobs', 'unit_price', 'numeric'),
      ('jobs', 'attempt_count', 'integer'),
      ('jobs', 'step', 'integer'),
      ('jobs', 'next_attempt_at', 'timestamp with time zone'),
      ('jobs', 'lease_until', 'timestamp with time zone'),
      ('jobs', 'current_cursor', 'text'),
      ('jobs', 'error_message', 'text'),
      ('jobs', 'updated_at', 'timestamp with time zone'),
      ('jobs', 'created_at', 'timestamp with time zone'),
      ('plans_quotes', 'id', 'text'),
      ('plans_quotes', 'user_id', 'uuid'),
      ('plans_quotes', 'status', 'text'),
      ('plans_quotes', 'quote_hash', 'text'),
      ('plans_quotes', 'items', 'jsonb'),
      ('plans_quotes', 'total_reserved_credits', 'numeric'),
      ('plans_quotes', 'output_formats', 'jsonb'),
      ('plans_quotes', 'expires_at', 'timestamp with time zone'),
      ('plans_quotes', 'created_at', 'timestamp with time zone'),
      ('job_events', 'job_id', 'text'),
      ('job_events', 'user_id', 'uuid'),
      ('job_events', 'message', 'text'),
      ('job_events', 'units', 'integer'),
      ('job_events', 'event_type', 'text'),
      ('job_events', 'created_at', 'timestamp with time zone'),
      ('credit_ledger', 'id', 'text'),
      ('credit_ledger', 'user_id', 'uuid'),
      ('credit_ledger', 'delta', 'numeric'),
      ('credit_ledger', 'type', 'text'),
      ('credit_ledger', 'job_id', 'text'),
      ('credit_ledger', 'note', 'text'),
      ('credit_ledger', 'created_at', 'timestamp with time zone')
),
col_live AS (
  SELECT r.tbl, r.col, r.typ,
         (SELECT format_type(a.atttypid, a.atttypmod)
          FROM pg_attribute a
          WHERE a.attrelid = to_regclass('public.' || r.tbl)
            AND a.attname = r.col AND a.attnum > 0 AND NOT a.attisdropped) AS live_typ
  FROM req_cols r
),
col_sum AS (
  SELECT tbl,
         count(*) AS total,
         count(*) FILTER (WHERE live_typ IS NOT DISTINCT FROM typ) AS good,
         string_agg(col || ': ' || COALESCE(live_typ, 'MISSING') || ' (need ' || typ || ')', '; ')
           FILTER (WHERE live_typ IS DISTINCT FROM typ) AS bad_detail
  FROM col_live
  GROUP BY tbl
),
v6_triggers AS (
  SELECT count(*) AS unexpected_triggers
  FROM pg_trigger
  WHERE tgrelid IN ('public.jobs'::regclass, 'public.plans_quotes'::regclass, 'public.job_events'::regclass)
    AND NOT tgisinternal
),
v7_grants AS (
  SELECT count(*) AS anon_auth_exec_grants
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('accept_quote_atomic', 'create_quote_atomic', 'reserve_credits_atomic', 'settle_job_atomic', 'release_job_atomic')
    AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
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
  SELECT 30, 'V2 release_job_atomic (3 args) is SECURITY DEFINER', 'true', COALESCE(all_secdef, false)::text,
         CASE WHEN all_secdef IS TRUE THEN '✓' ELSE '✗' END
  FROM v2_secdef
  UNION ALL
  SELECT 40, 'V3 11 new tables/functions absent (by exact signature)', '0', existing_new_objects::text,
         CASE WHEN existing_new_objects = 0 THEN '✓' ELSE '✗' END
  FROM v3_objects
  UNION ALL
  SELECT 41, 'V3 no function with any of the 8 new function names exists (any signature)', '0',
         n::text || COALESCE(' :: ' || found, ''), CASE WHEN n = 0 THEN '✓' ELSE '✗' END
  FROM v3_fns
  UNION ALL
  SELECT 42, 'V3 block_job_group_mutation() absent (01 would CREATE OR REPLACE it)', '0', n::text,
         CASE WHEN n = 0 THEN '✓' ELSE '✗' END
  FROM v3_block
  UNION ALL
  SELECT 43, 'V3 the 2 new indexes absent', '0', n::text || COALESCE(' :: ' || found, ''),
         CASE WHEN n = 0 THEN '✓' ELSE '✗' END
  FROM v3_idx
  UNION ALL
  SELECT 44, 'V3 the 3 append-only triggers absent', '0', n::text || COALESCE(' :: ' || found, ''),
         CASE WHEN n = 0 THEN '✓' ELSE '✗' END
  FROM v3_trg
  UNION ALL
  SELECT 50, 'V4 constraint chk_ledger_type equals the repo definition', '9bc63fb4528416b1a054645b4df810fb',
         COALESCE(md5(regexp_replace(pg_get_constraintdef(c.oid), '\s+', '', 'g')), 'MISSING')
           || CASE WHEN md5(regexp_replace(pg_get_constraintdef(c.oid), '\s+', '', 'g')) IS DISTINCT FROM '9bc63fb4528416b1a054645b4df810fb'
                   THEN ' :: ' || COALESCE(pg_get_constraintdef(c.oid), 'constraint missing') ELSE '' END,
         CASE WHEN md5(regexp_replace(pg_get_constraintdef(c.oid), '\s+', '', 'g')) = '9bc63fb4528416b1a054645b4df810fb' THEN '✓' ELSE '✗' END
  FROM (SELECT 1) one
  LEFT JOIN pg_constraint c ON c.conrelid = 'public.credit_ledger'::regclass AND c.conname = 'chk_ledger_type'
  UNION ALL
  SELECT 51, 'V4 constraint chk_ledger_delta_direction equals the repo definition', '3249277c08b593ef9d7b4084b1902b01',
         COALESCE(md5(regexp_replace(pg_get_constraintdef(c.oid), '\s+', '', 'g')), 'MISSING')
           || CASE WHEN md5(regexp_replace(pg_get_constraintdef(c.oid), '\s+', '', 'g')) IS DISTINCT FROM '3249277c08b593ef9d7b4084b1902b01'
                   THEN ' :: ' || COALESCE(pg_get_constraintdef(c.oid), 'constraint missing') ELSE '' END,
         CASE WHEN md5(regexp_replace(pg_get_constraintdef(c.oid), '\s+', '', 'g')) = '3249277c08b593ef9d7b4084b1902b01' THEN '✓' ELSE '✗' END
  FROM (SELECT 1) one
  LEFT JOIN pg_constraint c ON c.conrelid = 'public.credit_ledger'::regclass AND c.conname = 'chk_ledger_delta_direction'
  UNION ALL
  SELECT 52, 'V4 credit_ledger has no extra unique index', '0', count(*)::text,
         CASE WHEN count(*) = 0 THEN '✓' ELSE '✗' END
  FROM pg_index
  WHERE indrelid = 'public.credit_ledger'::regclass AND indisunique AND NOT indisprimary
  UNION ALL
  SELECT 60 + row_number() OVER (ORDER BY tbl), 'V5 ' || tbl || ': required columns with exact types',
         total::text || ' of ' || total::text || ' match',
         good::text || ' of ' || total::text || ' match' || COALESCE(' :: ' || bad_detail, ''),
         CASE WHEN good = total THEN '✓' ELSE '✗' END
  FROM col_sum
  UNION ALL
  SELECT 70, 'V6 unexpected triggers on jobs / plans_quotes / job_events', '0 unexpected', unexpected_triggers::text || ' unexpected',
         CASE WHEN unexpected_triggers = 0 THEN '✓' ELSE '✗' END
  FROM v6_triggers
  UNION ALL
  SELECT 71, 'V7 money-function EXECUTE granted to anon/authenticated', '0 grants', anon_auth_exec_grants::text || ' grants',
         CASE WHEN anon_auth_exec_grants = 0 THEN '✓' ELSE '✗' END
  FROM v7_grants
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
