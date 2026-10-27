-- NOT APPLIED. Rollback of 05_sensitive_access.sql: drops the two tables (and with them the audit history: export it first if it matters).
BEGIN;
DROP TABLE IF EXISTS public.sensitive_lookup_audit;
DROP TABLE IF EXISTS public.verified_business_accounts;
COMMIT;
