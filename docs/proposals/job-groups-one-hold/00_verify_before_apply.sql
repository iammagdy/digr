-- 00_verify_before_apply.sql
-- Verification before applying 01_job_groups_one_hold.sql.
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
v2_secdef AS (
  SELECT bool_and(p.prosecdef) AS all_secdef
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'release_job_atomic'
    AND pg_get_function_identity_arguments(p.oid) LIKE '%boolean%'
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
v4_constraints AS (
  SELECT count(*) AS constraint_count
  FROM pg_constraint
  WHERE conrelid = 'public.credit_ledger'::regclass
    AND conname IN ('chk_ledger_type', 'chk_ledger_delta_direction')
),
v4_extra_idx AS (
  SELECT count(*) AS extra_unique_indexes
  FROM pg_index
  WHERE indrelid = 'public.credit_ledger'::regclass
    AND indisunique
    AND NOT indisprimary
),
v5_columns AS (
  SELECT count(*) AS missing_columns
  FROM (
    VALUES
      ('jobs', 'id'), ('jobs', 'user_id'), ('jobs', 'status'), ('jobs', 'endpoint_id'),
      ('jobs', 'target_volume_min'), ('jobs', 'target_volume_max'), ('jobs', 'reserved_credits'),
      ('jobs', 'charged_credits'), ('jobs', 'delivered_units'), ('jobs', 'unit_price'),
      ('jobs', 'attempt_count'), ('jobs', 'step'), ('jobs', 'next_attempt_at'),
      ('jobs', 'lease_until'), ('jobs', 'current_cursor'), ('jobs', 'error_message'),
      ('jobs', 'updated_at'), ('jobs', 'created_at'),
      ('plans_quotes', 'id'), ('plans_quotes', 'user_id'), ('plans_quotes', 'status'),
      ('plans_quotes', 'quote_hash'), ('plans_quotes', 'items'), ('plans_quotes', 'total_reserved_credits'),
      ('plans_quotes', 'output_formats'), ('plans_quotes', 'expires_at'), ('plans_quotes', 'created_at'),
      ('job_events', 'job_id'), ('job_events', 'user_id'), ('job_events', 'message'),
      ('job_events', 'units'), ('job_events', 'event_type'), ('job_events', 'created_at'),
      ('credit_ledger', 'id'), ('credit_ledger', 'user_id'), ('credit_ledger', 'delta'),
      ('credit_ledger', 'type'), ('credit_ledger', 'job_id'), ('credit_ledger', 'note'),
      ('credit_ledger', 'created_at')
  ) AS req(tbl, col)
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public'
   AND c.table_name = req.tbl
   AND c.column_name = req.col
  WHERE c.column_name IS NULL
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
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'accept_quote_atomic',
      'create_quote_atomic',
      'reserve_credits_atomic',
      'settle_job_atomic',
      'release_job_atomic'
    )
    AND (
      has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
    )
),
checks AS (
  SELECT 'V1 money functions count' AS "check",
         '6' AS expected,
         fn_count::text AS actual,
         CASE WHEN fn_count = 6 THEN '✓' ELSE '✗' END AS ok
  FROM money_fp
  UNION ALL
  SELECT 'V1 money functions fingerprint' AS "check",
         'compare with 02' AS expected,
         fingerprint AS actual,
         CASE WHEN fn_count = 6 AND fingerprint IS NOT NULL THEN '✓' ELSE '✗' END AS ok
  FROM money_fp
  UNION ALL
  SELECT 'V2 release_job_atomic 3-arg security definer' AS "check",
         'true' AS expected,
         COALESCE(all_secdef, false)::text AS actual,
         CASE WHEN all_secdef IS TRUE THEN '✓' ELSE '✗' END AS ok
  FROM v2_secdef
  UNION ALL
  SELECT 'V3 new tables and functions absent' AS "check",
         '0' AS expected,
         existing_new_objects::text AS actual,
         CASE WHEN existing_new_objects = 0 THEN '✓' ELSE '✗' END AS ok
  FROM v3_objects
  UNION ALL
  SELECT 'V4 ledger chk constraints present' AS "check",
         '2' AS expected,
         constraint_count::text AS actual,
         CASE WHEN constraint_count = 2 THEN '✓' ELSE '✗' END AS ok
  FROM v4_constraints
  UNION ALL
  SELECT 'V4 ledger no extra unique index' AS "check",
         '0' AS expected,
         extra_unique_indexes::text AS actual,
         CASE WHEN extra_unique_indexes = 0 THEN '✓' ELSE '✗' END AS ok
  FROM v4_extra_idx
  UNION ALL
  SELECT 'V5 required table columns present' AS "check",
         '0 missing' AS expected,
         missing_columns::text || ' missing' AS actual,
         CASE WHEN missing_columns = 0 THEN '✓' ELSE '✗' END AS ok
  FROM v5_columns
  UNION ALL
  SELECT 'V6 unexpected triggers absent' AS "check",
         '0 unexpected' AS expected,
         unexpected_triggers::text || ' unexpected' AS actual,
         CASE WHEN unexpected_triggers = 0 THEN '✓' ELSE '✗' END AS ok
  FROM v6_triggers
  UNION ALL
  SELECT 'V7 money function execute revoked from anon/auth' AS "check",
         '0 grants' AS expected,
         anon_auth_exec_grants::text || ' grants' AS actual,
         CASE WHEN anon_auth_exec_grants = 0 THEN '✓' ELSE '✗' END AS ok
  FROM v7_grants
)
SELECT "check", expected, actual, ok
FROM checks
UNION ALL
SELECT 'ALL' AS "check",
       'all pass' AS expected,
       CASE WHEN bool_and(ok = '✓') THEN 'all passed' ELSE 'some failed' END AS actual,
       CASE WHEN bool_and(ok = '✓') THEN '✓' ELSE '✗' END AS ok
FROM checks;
