-- Proposal only (not applied by the author): encrypted provider API keys and their audit trail.
--
-- The platform can switch a provider key from the admin panel without a redeploy. Keys are stored ENCRYPTED
-- (AES-256-GCM, random nonce per value, authenticated) by the application before they reach the database; the
-- encryption key lives only in the server environment (PROVIDER_KEYS_ENCRYPTION_KEY), never in the database.
-- This file adds only tables; the next file adds the functions that are the only way to change them.
--
-- Not a money table. Nothing here touches credit_ledger, jobs, topups, plans_quotes, provider_costs or profiles.

CREATE TABLE IF NOT EXISTS public.provider_api_keys (
  provider text PRIMARY KEY CHECK (provider IN ('treg', 'anthropic')),
  active_ciphertext text,
  active_last4 text CHECK (active_last4 IS NULL OR char_length(active_last4) BETWEEN 1 AND 4),
  active_set_at timestamptz,
  active_set_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  previous_ciphertext text,
  previous_last4 text CHECK (previous_last4 IS NULL OR char_length(previous_last4) BETWEEN 1 AND 4),
  previous_set_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.provider_api_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_api_keys FROM PUBLIC, anon, authenticated;
-- Read-only for the server. Writes happen only inside the SECURITY DEFINER functions of the next file.
GRANT SELECT ON TABLE public.provider_api_keys TO service_role;

-- Append-only audit trail: who, when, which provider, the last 4 characters only, and what happened.
CREATE TABLE IF NOT EXISTS public.provider_key_audit (
  id bigserial PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('treg', 'anthropic')),
  action text NOT NULL CHECK (action IN ('set', 'rollback')),
  last4 text CHECK (last4 IS NULL OR char_length(last4) BETWEEN 1 AND 4),
  -- Deliberately no foreign key: an ON DELETE action would try to UPDATE this append-only table and block deleting an
  -- admin account. The actor id stays as written.
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_key_audit_created_idx ON public.provider_key_audit (created_at DESC);

ALTER TABLE public.provider_key_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_key_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.provider_key_audit TO service_role;
REVOKE ALL ON SEQUENCE public.provider_key_audit_id_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.block_provider_key_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RAISE EXCEPTION 'provider_key_audit is append-only. UPDATE and DELETE operations are forbidden.';
END;
$$;

DROP TRIGGER IF EXISTS trg_block_provider_key_audit_mutation ON public.provider_key_audit;
CREATE TRIGGER trg_block_provider_key_audit_mutation
BEFORE UPDATE OR DELETE ON public.provider_key_audit
FOR EACH ROW EXECUTE FUNCTION public.block_provider_key_audit_mutation();
