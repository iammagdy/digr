-- Migration: Strict validation on public.jobs.unit_price
-- Drops default value to prevent accidental fallback, ensures strictly positive price

ALTER TABLE public.jobs ALTER COLUMN unit_price DROP DEFAULT;

ALTER TABLE public.jobs
  ADD CONSTRAINT chk_jobs_unit_price_positive CHECK (unit_price IS NULL OR unit_price > 0);
