-- Proposal only (not applied by the author): typed credit rows.
--
-- Real Instapay income, promotional credit and manual admin credit must stay distinguishable forever.
-- credit_ledger already allows the types reserve, release, charge, topup, grant, goodwill, so no ledger
-- column or constraint changes. A side table keyed by the ledger id records the kind for rows written by
-- the approved promo / admin-grant functions (next migration), and the view below derives the kind for
-- every row, including all legacy rows, so SUM(delta) balances are untouched.
--
-- Why a side table and not a column: ALTER TABLE on the append-only ledger takes an exclusive lock and
-- rewrites its constraints on a live money table; an insert-only side table has no such risk and can be
-- dropped without touching a single ledger row.

CREATE TABLE IF NOT EXISTS public.credit_ledger_kinds (
  ledger_id text PRIMARY KEY REFERENCES public.credit_ledger(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('topup_instapay', 'promo_code', 'admin_grant')),
  actor_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.credit_ledger_kinds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.credit_ledger_kinds FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.credit_ledger_kinds TO service_role;

CREATE OR REPLACE FUNCTION public.block_credit_kind_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger_kinds is append-only. UPDATE and DELETE operations are forbidden.';
END;
$$;

DROP TRIGGER IF EXISTS trg_block_credit_kind_mutation ON public.credit_ledger_kinds;
CREATE TRIGGER trg_block_credit_kind_mutation
BEFORE UPDATE OR DELETE ON public.credit_ledger_kinds
FOR EACH ROW EXECUTE FUNCTION public.block_credit_kind_mutation();

-- Every ledger row with its kind. Legacy rows: topup -> topup_instapay (top_<topupId> rows are the approved
-- Instapay top-ups); grant / goodwill rows without a kind record -> admin_grant; reserve, charge and
-- release keep their own type.
CREATE OR REPLACE VIEW public.credit_ledger_typed
WITH (security_invoker = true) AS
SELECT
  l.id,
  l.user_id,
  l.delta,
  l.type,
  l.job_id,
  l.topup_id,
  l.note,
  l.created_at,
  CASE
    WHEN k.kind IS NOT NULL THEN k.kind
    WHEN l.type = 'topup' THEN 'topup_instapay'
    WHEN l.type IN ('grant', 'goodwill') THEN 'admin_grant'
    ELSE l.type
  END AS kind,
  k.actor_id
FROM public.credit_ledger l
LEFT JOIN public.credit_ledger_kinds k ON k.ledger_id = l.id;

REVOKE ALL ON TABLE public.credit_ledger_typed FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.credit_ledger_typed TO service_role;
