-- PROPOSAL, NOT APPLIED. ROLLBACK of 01_settle_job_min_atomic.sql: removes the new function. settle_job_atomic was never changed, so nothing else needs restoring.
-- Ledger rows written by the new function stay (the ledger is append-only); a job it settled is a normal completed job.
DROP FUNCTION IF EXISTS public.settle_job_min_atomic(text, numeric, numeric, text);
