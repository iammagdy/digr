-- Step 2: Ledger Triggers, CHECK constraints, and Privileges

-- Helper Function: Admin Check (SECURITY INVOKER)
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO service_role, authenticated;

-- Check constraints on credit_ledger
ALTER TABLE public.credit_ledger
  ADD CONSTRAINT chk_ledger_type CHECK (type IN ('reserve', 'release', 'charge', 'topup', 'grant', 'goodwill')),
  ADD CONSTRAINT chk_ledger_delta_direction CHECK (
    (type IN ('reserve', 'charge') AND delta < 0) OR
    (type IN ('release', 'topup', 'grant', 'goodwill') AND delta > 0)
  );

-- Block UPDATE and DELETE on credit_ledger
CREATE OR REPLACE FUNCTION public.block_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only. UPDATE and DELETE operations are forbidden.';
END;
$$;

CREATE TRIGGER trg_block_ledger_mutation
BEFORE UPDATE OR DELETE ON public.credit_ledger
FOR EACH ROW
EXECUTE FUNCTION public.block_ledger_mutation();

-- Block TRUNCATE on credit_ledger
CREATE OR REPLACE FUNCTION public.block_ledger_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger cannot be truncated.';
END;
$$;

CREATE TRIGGER trg_block_ledger_truncate
BEFORE TRUNCATE ON public.credit_ledger
FOR EACH STATEMENT
EXECUTE FUNCTION public.block_ledger_truncate();

-- Revoke mutation privileges from PUBLIC, anon, authenticated
REVOKE UPDATE, DELETE, TRUNCATE ON public.credit_ledger FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.topups FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.jobs FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.job_events FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.plans_quotes FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.artifact_versions FROM PUBLIC, anon, authenticated;
REVOKE INSERT, DELETE, TRUNCATE ON public.notifications FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.admin_audit_log FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.provider_costs FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.settings_private FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.llm_usage FROM PUBLIC, anon, authenticated;
