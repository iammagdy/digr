-- Migration: Add scheduling, chunk leasing, unit price, and provider cost estimate tracking columns
-- Idempotent: Uses IF NOT EXISTS

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
  ADD COLUMN IF NOT EXISTS step INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS unit_price NUMERIC DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_jobs_status_next_attempt ON public.jobs (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease_until ON public.jobs (lease_until);

ALTER TABLE public.provider_costs
  ADD COLUMN IF NOT EXISTS is_estimate BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_provider_costs_created_at_cost ON public.provider_costs (created_at, cost_usd);
