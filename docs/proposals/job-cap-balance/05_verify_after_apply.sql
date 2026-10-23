-- PROPOSAL ONLY. READ ONLY checks to run by hand AFTER applying the steps (nothing here writes).
-- 1. The policy in force (must read fixed / 600 until the owner changes it):
SELECT value FROM public.settings_private WHERE key = 'job_cap_policy';
-- 2. The cap of one real customer (replace the id): 600 while «fixed»; between the floor and the ceiling once «balance».
SELECT public.job_points_cap_for('00000000-0000-0000-0000-000000000000'::uuid) AS cap_now;
-- 3. Nobody but service_role may run the new or changed functions (every row must say false except service_role = true):
SELECT p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS can_execute
FROM pg_proc p CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) AS r(rolname)
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('job_points_cap_for','admin_set_job_cap_policy_atomic','create_quote_atomic','settle_job_atomic','settle_people_job_atomic')
ORDER BY p.proname, r.rolname;
-- 4. The ledger is still append-only (the trigger must exist):
SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.credit_ledger'::regclass AND NOT tgisinternal;
