-- ROLLBACK of 03_provider_costs_call_metadata.sql (proposal only; applied by the owner by hand, only if the proposal was applied).
--
-- Removes the new function and the three columns. The metadata written since (capability, status, duration) is lost; cost, units and
-- is_estimate of every row are untouched, so no money figure changes. The application falls back to commit_provider_spend by itself.

BEGIN;

DROP FUNCTION IF EXISTS public.commit_provider_spend_v2(BIGINT, NUMERIC, INT, TEXT, TEXT, INT);
DROP INDEX IF EXISTS public.idx_provider_costs_provider_created;
ALTER TABLE public.provider_costs DROP CONSTRAINT IF EXISTS provider_costs_status_check;
ALTER TABLE public.provider_costs DROP CONSTRAINT IF EXISTS provider_costs_capability_len_check;
ALTER TABLE public.provider_costs DROP CONSTRAINT IF EXISTS provider_costs_duration_check;
ALTER TABLE public.provider_costs
  DROP COLUMN IF EXISTS capability,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS duration_ms;

COMMIT;
