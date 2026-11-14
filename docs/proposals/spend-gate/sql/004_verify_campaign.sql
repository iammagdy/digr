-- SPEND SAFETY MILESTONE: read-only checks after applying 003_campaign_scope.sql (run 002_verify.sql too). Every row must say ok = true. Changes nothing.
SELECT 'grants carry the campaign columns' AS check, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'spend_gate' AND table_name = 'grants' AND column_name IN ('account_id','max_missions')) = 2 AS ok
UNION ALL SELECT 'the enrollments table exists with row-level security and no policy', EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'spend_gate' AND c.relname = 'enrollments' AND c.relrowsecurity)
                                                                                        AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'spend_gate')
UNION ALL SELECT 'the grant terms are immutable (trigger present)', EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'spend_gate' AND c.relname = 'grants' AND t.tgname = 'grants_immutable' AND NOT t.tgisinternal)
UNION ALL SELECT 'a campaign grant is capped at 0.30 USD, provider and model only, 72 hours (constraint present)', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grants_campaign_terms' AND pg_get_constraintdef(oid) LIKE '%0.30%' AND pg_get_constraintdef(oid) LIKE '%72:00:00%' AND pg_get_constraintdef(oid) LIKE '%model%' AND pg_get_constraintdef(oid) NOT LIKE '%chat%')
UNION ALL SELECT 'service_role has no table privilege in spend_gate (enrollments included)', NOT EXISTS (
  SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'spend_gate' AND grantee IN ('service_role','authenticated','anon','PUBLIC'))
UNION ALL SELECT 'service_role cannot issue a campaign grant', NOT has_function_privilege('service_role', 'spend_gate.issue_campaign_grant(text,uuid,numeric,numeric,numeric,text[],timestamptz,timestamptz,integer,text,text)', 'EXECUTE')
UNION ALL SELECT 'service_role cannot read a mission owner through the helper', NOT has_function_privilege('service_role', 'spend_gate.mission_owner(text)', 'EXECUTE')
UNION ALL SELECT 'service_role can enroll; anon and authenticated cannot', has_function_privilege('service_role', 'public.spend_enroll_mission(text)', 'EXECUTE')
                                                                       AND NOT has_function_privilege('anon', 'public.spend_enroll_mission(text)', 'EXECUTE')
                                                                       AND NOT has_function_privilege('authenticated', 'public.spend_enroll_mission(text)', 'EXECUTE')
UNION ALL SELECT 'spend_reserve refuses a campaign grant''s unenrolled mission (function body)', (SELECT pg_get_functiondef(p.oid) LIKE '%mission_not_enrolled%' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'spend_reserve')
UNION ALL SELECT 'the public gate functions are SECURITY DEFINER with a fixed search_path', (
  SELECT bool_and(p.prosecdef AND p.proconfig::text LIKE '%search_path=pg_catalog, spend_gate, pg_temp%') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('spend_reserve','spend_settle','spend_stop','spend_status','spend_enroll_mission'))
UNION ALL SELECT 'the money functions do not mention spend_gate', NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
    AND p.proname IN ('accept_quote_atomic','settle_job_atomic','release_job_atomic','create_quote_atomic','settle_people_job_atomic') AND pg_get_functiondef(p.oid) LIKE '%spend_gate%')
UNION ALL SELECT 'every campaign grant is within the cumulative ceiling', coalesce((SELECT sum(spent_usd + reserved_usd + overrun_usd) FROM spend_gate.grants WHERE account_id IS NOT NULL), 0) <= 0.30 + 0.000001
UNION ALL SELECT 'no campaign grant holds more than it may', NOT EXISTS (SELECT 1 FROM spend_gate.grants WHERE account_id IS NOT NULL AND reserved_usd + spent_usd > ceiling_usd + 0.000001);
