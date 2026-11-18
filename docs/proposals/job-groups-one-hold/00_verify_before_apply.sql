-- READ ONLY verification before applying 01_job_groups_one_hold.sql.
-- Paste in the Supabase SQL editor BEFORE applying anything: it shows what is live.
-- If any result differs from what is expected, STOP and report.
BEGIN TRANSACTION READ ONLY;

-- V1: MD5 checksums of the five existing money functions (must match /tmp/job-groups-expected-md5.txt)
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

-- V2: release_job_atomic(text,text,boolean) exists and is SECURITY DEFINER
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       p.prosecdef AS is_security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'release_job_atomic'
  AND pg_get_function_identity_arguments(p.oid) LIKE '%boolean%';

-- V3: None of the new tables or functions exist yet (all must be NULL / 0)
SELECT 'job_groups' AS name, to_regclass('public.job_groups') AS exists
UNION ALL SELECT 'job_group_parts', to_regclass('public.job_group_parts')
UNION ALL SELECT 'job_group_keys', to_regclass('public.job_group_keys')
UNION ALL SELECT 'job_group_frozen', to_regclass('public.job_group_frozen')
UNION ALL SELECT 'accept_group_quote_atomic', to_regproc('public.accept_group_quote_atomic')
UNION ALL SELECT 'draw_next_group_part_atomic', to_regproc('public.draw_next_group_part_atomic')
UNION ALL SELECT 'close_job_group_atomic', to_regproc('public.close_job_group_atomic')
UNION ALL SELECT 'claim_next_job_group', to_regproc('public.claim_next_job_group')
UNION ALL SELECT 'freeze_and_settle_group_part_atomic', to_regproc('public.freeze_and_settle_group_part_atomic')
UNION ALL SELECT 'release_unfrozen_group_part_atomic', to_regproc('public.release_unfrozen_group_part_atomic')
UNION ALL SELECT 'job_group_points_ar', to_regproc('public.job_group_points_ar');

-- V4: Credit ledger constraints and unique indexes
SELECT conname, pg_get_constraintdef(oid) AS constraint_def
FROM pg_constraint
WHERE conrelid = 'public.credit_ledger'::regclass
  AND conname IN ('chk_ledger_type', 'chk_ledger_delta_direction')
ORDER BY conname;

SELECT indexrelid::regclass AS non_pk_unique_index
FROM pg_index
WHERE indrelid = 'public.credit_ledger'::regclass
  AND indisunique
  AND NOT indisprimary;

-- V5: Target columns and types used by F1-F6
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'jobs' AND column_name IN ('id', 'user_id', 'status', 'endpoint_id', 'target_volume_min', 'target_volume_max', 'reserved_credits', 'charged_credits', 'delivered_units', 'unit_price', 'attempt_count', 'step', 'next_attempt_at', 'lease_until', 'current_cursor', 'error_message', 'updated_at', 'created_at'))
    OR (table_name = 'plans_quotes' AND column_name IN ('id', 'user_id', 'status', 'quote_hash', 'items', 'total_reserved_credits', 'output_formats', 'expires_at', 'created_at'))
    OR (table_name = 'job_events' AND column_name IN ('job_id', 'user_id', 'message', 'units', 'event_type', 'created_at'))
    OR (table_name = 'credit_ledger' AND column_name IN ('id', 'user_id', 'delta', 'type', 'job_id', 'note', 'created_at'))
  )
ORDER BY table_name, column_name;

-- V6: User triggers on jobs, plans_quotes, credit_ledger, job_events
SELECT tgrelid::regclass AS table_name,
       tgname AS trigger_name,
       pg_get_triggerdef(oid) AS trigger_def
FROM pg_trigger
WHERE tgrelid IN (
    'public.jobs'::regclass,
    'public.plans_quotes'::regclass,
    'public.credit_ledger'::regclass,
    'public.job_events'::regclass
  )
  AND NOT tgisinternal
ORDER BY table_name, trigger_name;

-- V7: Permissions: anon and authenticated cannot EXECUTE the five money functions
SELECT p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
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
ORDER BY p.proname;

ROLLBACK;
