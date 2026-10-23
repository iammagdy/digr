-- PROPOSAL ONLY. NOT APPLIED. ROLLBACK of step 1. Run the rollbacks of steps 4, 3 and 2 FIRST (they stop using the function), then this file.
-- It removes the two functions, the audit table with its trigger, and the default policy row. Nothing else was touched by step 1.
DROP FUNCTION IF EXISTS public.admin_set_job_cap_policy_atomic(uuid, jsonb);
DROP FUNCTION IF EXISTS public.job_points_cap_for(uuid);
DROP TABLE IF EXISTS public.job_cap_policy_audit;
DROP FUNCTION IF EXISTS public.block_job_cap_policy_audit_mutation();
DELETE FROM public.settings_private WHERE key = 'job_cap_policy';
