-- ROUND 61: read-only checks after applying 001_spend_gate.sql. Every row must say ok = true. Changes nothing.
SELECT 'schema exists' AS check, EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'spend_gate') AS ok
UNION ALL SELECT 'every grant was issued by the owner function (none by the migration)', (SELECT count(*) FROM spend_gate.grants) = (SELECT count(DISTINCT grant_id) FROM spend_gate.events WHERE kind = 'issued')
UNION ALL SELECT 'service_role has no table privilege in spend_gate', NOT EXISTS (
  SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'spend_gate' AND grantee IN ('service_role','authenticated','anon','PUBLIC'))
UNION ALL SELECT 'service_role cannot use the spend_gate schema', NOT has_schema_privilege('service_role', 'spend_gate', 'USAGE')
UNION ALL SELECT 'service_role cannot issue a grant', NOT has_function_privilege('service_role', 'spend_gate.issue_grant(text,numeric,numeric,numeric,text[],timestamptz,timestamptz,text,text)', 'EXECUTE')
UNION ALL SELECT 'service_role cannot revoke a grant', NOT has_function_privilege('service_role', 'spend_gate.revoke_grant(text,text)', 'EXECUTE')
UNION ALL SELECT 'anon cannot reserve', NOT has_function_privilege('anon', 'public.spend_reserve(text,text,text,numeric,text,integer)', 'EXECUTE')
UNION ALL SELECT 'authenticated cannot reserve', NOT has_function_privilege('authenticated', 'public.spend_reserve(text,text,text,numeric,text,integer)', 'EXECUTE')
UNION ALL SELECT 'authenticated cannot settle', NOT has_function_privilege('authenticated', 'public.spend_settle(uuid,numeric)', 'EXECUTE')
UNION ALL SELECT 'service_role can reserve and settle', has_function_privilege('service_role', 'public.spend_reserve(text,text,text,numeric,text,integer)', 'EXECUTE')
                                                      AND has_function_privilege('service_role', 'public.spend_settle(uuid,numeric)', 'EXECUTE')
UNION ALL SELECT 'only the database owner is a member of spend_gate_owner', NOT EXISTS (
  SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
  WHERE r.rolname = 'spend_gate_owner' AND u.rolname IN ('service_role','authenticated','anon','authenticator'))
UNION ALL SELECT 'spend_gate_owner cannot log in', NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'spend_gate_owner')
UNION ALL SELECT 'the public functions are SECURITY DEFINER with a fixed search_path', (
  SELECT bool_and(p.prosecdef AND p.proconfig::text LIKE '%search_path=pg_catalog, spend_gate, pg_temp%') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('spend_reserve','spend_settle','spend_stop','spend_status'))
UNION ALL SELECT 'the money functions do not mention spend_gate', NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
    AND p.proname IN ('accept_quote_atomic','settle_job_atomic','release_job_atomic','create_quote_atomic','settle_people_job_atomic') AND pg_get_functiondef(p.oid) LIKE '%spend_gate%')
UNION ALL SELECT 'the open grant (if any) keeps its invariant', NOT EXISTS (SELECT 1 FROM spend_gate.grants WHERE reserved_usd + spent_usd > ceiling_usd + 0.000001);
