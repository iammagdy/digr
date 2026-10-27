-- NOT APPLIED. Owner applies by hand after review. No money table or function is touched (not credit_ledger, jobs, topups, profiles, plans_quotes, provider_costs).
-- 1. verified_business_accounts: which customer accounts the admin marked «verified business» (they may use the SENSITIVE data category, with a stated purpose).
--    A separate table, so `profiles` stays untouched; one row per account, written only by the service role (the admin panel).
-- 2. sensitive_lookup_audit: ONE row per sensitive lookup (and per refused attempt): who, which endpoint and its category (internal), the looked-up value MASKED, the purpose,
--    the job, the time and the cost. Admin read through RLS; written only by the service role; no access for any customer account.
-- Until this file is applied nobody is «verified» (the sensitive category is admin-only) and a customer's sensitive lookup is refused because it cannot be audited.

BEGIN;

CREATE TABLE IF NOT EXISTS public.verified_business_accounts (
  user_id      uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  verified     boolean     NOT NULL DEFAULT false,
  verified_by  uuid,
  verified_at  timestamptz,
  note         text        CHECK (note IS NULL OR length(note) <= 200)
);

ALTER TABLE public.verified_business_accounts ENABLE ROW LEVEL SECURITY;   -- no policy: only the service role reads or writes
REVOKE ALL ON public.verified_business_accounts FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.sensitive_lookup_audit (
  id                 text PRIMARY KEY CHECK (id ~ '^sla_[0-9a-f]{32}$'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  account_id         uuid        NOT NULL,
  is_admin           boolean     NOT NULL DEFAULT false,
  endpoint_id        text        NOT NULL CHECK (length(endpoint_id) BETWEEN 3 AND 200),
  endpoint_category  text        NOT NULL CHECK (length(endpoint_category) BETWEEN 1 AND 60),
  masked_value       text        NOT NULL DEFAULT '' CHECK (length(masked_value) <= 200),   -- a phone keeps its last 3 digits, an email its domain; never the value
  purpose            text        NOT NULL DEFAULT '' CHECK (length(purpose) <= 300),
  job_id             text,
  cost_usd           numeric(12, 6) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  outcome            text        NOT NULL CHECK (outcome IN ('pending', 'called', 'failed', 'refused_access', 'refused_purpose', 'refused_limit', 'refused_audit'))
);

CREATE INDEX IF NOT EXISTS sensitive_lookup_audit_account_day_idx ON public.sensitive_lookup_audit (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sensitive_lookup_audit_job_idx ON public.sensitive_lookup_audit (job_id);

ALTER TABLE public.sensitive_lookup_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sensitive_lookup_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sensitive_lookup_audit TO authenticated;      -- visible only through the policy below: the admin reads, a customer sees no row
DROP POLICY IF EXISTS sensitive_lookup_audit_admin_read ON public.sensitive_lookup_audit;
CREATE POLICY sensitive_lookup_audit_admin_read ON public.sensitive_lookup_audit FOR SELECT TO authenticated USING (public.is_admin());
-- no INSERT, UPDATE or DELETE policy: the service role (which bypasses RLS) is the only writer; the audit is never edited by a customer or by the admin panel's browser session

COMMIT;
