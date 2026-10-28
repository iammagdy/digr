-- PROPOSAL ONLY (NOT APPLIED; the owner reviews and applies it by hand).
--
-- Why: the admin «بحث عكسي» keeps a HISTORY of finished lookups so an earlier result reopens without a new (paid) call. The code works WITHOUT this table: when it is missing the
-- screen keeps the history in the admin's own browser (localStorage) and says so. Applying this moves the history to the server, shared by the admins.
--
-- What it stores: the typed value MASKED (never the raw phone or e-mail), the fields found with the source of each, the attempts and their cost. No customer data, no money table, no ledger.
-- Access: service role only (RLS on, no policy; anon and authenticated are revoked), like the other admin bookkeeping tables.
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_lookup_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('phone', 'email')),
  masked_input text NOT NULL CHECK (char_length(masked_input) <= 80),
  found boolean NOT NULL DEFAULT false,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_lookup_history_created_idx ON public.admin_lookup_history (created_at DESC);

ALTER TABLE public.admin_lookup_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_lookup_history FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.admin_lookup_history TO service_role;

COMMIT;
