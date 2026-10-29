-- PROPOSAL, NOT APPLIED. ADDITIVE ONLY: five NEW tables, one seeded row, nothing existing is altered or dropped.
-- Requires 01_vault_encryption_key.sql first (not for these tables, for file 03's functions; order is 01, 02, 03, 04).
--
-- The TREG key pool. Keys are stored ONLY encrypted (AES-256-GCM, made by the application before the value reaches the database,
-- key in Vault). Nothing here is a money table: no credit_ledger, jobs, topups, plans_quotes, provider_costs or profiles column
-- or function is touched. The per-key spend is computed by a READ-ONLY function (file 03) that joins provider_costs.
--
-- Access: all five tables are service-role-only. The key table has NO grant at all, not even SELECT for service_role: ciphertext leaves the
-- database only through the two functions of file 03 that are meant to return it (treg_pool_runtime, nothing when the switch is OFF).

-- 1. The keys. A key is never deleted: removal clears the ciphertext and sets removed_at, so the call log keeps its number and label.
CREATE TABLE IF NOT EXISTS public.treg_pool_keys (
  id uuid PRIMARY KEY,                                     -- made by the application; also the authenticated data of the ciphertext
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,      -- 1, 2, 3 ... never reused
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 60),
  is_main boolean NOT NULL DEFAULT false,
  in_chain boolean NOT NULL DEFAULT true,
  chain_position integer NOT NULL DEFAULT 0,               -- order inside the chain; the main key is always last whatever this says
  ciphertext text,
  last4 text CHECK (last4 IS NULL OR char_length(last4) BETWEEN 1 AND 4),
  account_email text CHECK (account_email IS NULL OR char_length(account_email) <= 254),  -- the TREG account's own e-mail (admin screens only)
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','connected','error','revoked','out_of_balance')),
  status_reason text CHECK (status_reason IS NULL OR char_length(status_reason) <= 60),   -- a fixed reason code, never provider text
  status_checked_at timestamptz,
  balance_micro bigint,
  balance_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,                                         -- no foreign key (same choice as provider_key_audit)
  removed_at timestamptz,
  CONSTRAINT treg_pool_main_in_chain CHECK (NOT is_main OR in_chain),
  CONSTRAINT treg_pool_secret_matches_removal CHECK ((removed_at IS NULL) = (ciphertext IS NOT NULL)),
  CONSTRAINT treg_pool_ciphertext_shape CHECK (ciphertext IS NULL OR (char_length(ciphertext) <= 1300 AND ciphertext ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{22}$'))
);
-- at most one live main key
CREATE UNIQUE INDEX IF NOT EXISTS treg_pool_one_main ON public.treg_pool_keys ((true)) WHERE is_main AND removed_at IS NULL;
CREATE INDEX IF NOT EXISTS treg_pool_keys_live_idx ON public.treg_pool_keys (is_main, chain_position, number) WHERE removed_at IS NULL;

-- 2. The single state row: the rollout switch (OFF by default), the active key, the minimum balance.
CREATE TABLE IF NOT EXISTS public.treg_pool_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  rollout_on boolean NOT NULL DEFAULT false,
  active_key_id uuid REFERENCES public.treg_pool_keys(id),
  generation bigint NOT NULL DEFAULT 0,                    -- +1 on every switch, so a reader can tell it changed
  min_balance_micro bigint NOT NULL DEFAULT 10000 CHECK (min_balance_micro BETWEEN 0 AND 10000000),  -- 0.01 USD: at or below this a key counts as «الرصيد خلص»
  last_health_run_at timestamptz,
  worker_env_last4 text CHECK (worker_env_last4 IS NULL OR char_length(worker_env_last4) <= 4),       -- last 4 of Heroku's TREG_TOKEN, to show a mismatch with the main key
  worker_seen_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
INSERT INTO public.treg_pool_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 3. Append-only event trail: who switched what and why. Never a key, never ciphertext.
CREATE TABLE IF NOT EXISTS public.treg_pool_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('key_added','key_removed','key_replaced','active_set','chain_set','rollout_on','rollout_off','failover','settings')),
  key_id uuid, key_number integer, key_label text,
  to_key_id uuid, to_key_number integer, to_key_label text,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 60),
  source text CHECK (source IN ('admin','website','worker','health')),
  actor_id uuid
);
CREATE INDEX IF NOT EXISTS treg_pool_events_at_idx ON public.treg_pool_events (at DESC);

CREATE OR REPLACE FUNCTION public.block_treg_pool_events_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  RAISE EXCEPTION 'treg_pool_events is append-only. UPDATE and DELETE operations are forbidden.';
END;
$$;
DROP TRIGGER IF EXISTS trg_block_treg_pool_events_mutation ON public.treg_pool_events;
CREATE TRIGGER trg_block_treg_pool_events_mutation BEFORE UPDATE OR DELETE ON public.treg_pool_events
FOR EACH ROW EXECUTE FUNCTION public.block_treg_pool_events_mutation();

-- 4. Admin e-mail outbox + debounce. One OPEN row per (problem, key) at a time; a new row for the same pair is refused for 30 minutes
--    even after the old one closed (a flapping key does not become a flood). The Vercel cron route sends the e-mails (ADMIN_ALERT_EMAIL
--    lives there); the worker only writes rows.
CREATE TABLE IF NOT EXISTS public.treg_pool_alerts (
  id bigserial PRIMARY KEY,
  problem text NOT NULL CHECK (problem IN ('failover','chain_reached_main','health_broken','main_failed','store_unreadable')),
  scope uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',   -- the key's id, or the zero uuid for a problem that is not about one key
  key_id uuid, key_number integer, key_label text,
  to_key_number integer, to_key_label text,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  emailed_at timestamptz,
  email_attempts integer NOT NULL DEFAULT 0,
  email_lease_until timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS treg_pool_alerts_one_open ON public.treg_pool_alerts (problem, scope) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS treg_pool_alerts_pending_idx ON public.treg_pool_alerts (id) WHERE emailed_at IS NULL;

-- 5. Which pool key made which provider call: number and label only, never the key. One row per provider_costs row.
--    No foreign key to provider_costs on purpose: that table (and its cleanup) stays exactly as it is.
CREATE TABLE IF NOT EXISTS public.treg_pool_calls (
  provider_cost_id bigint PRIMARY KEY,
  key_id uuid NOT NULL,
  key_number integer NOT NULL,
  key_label text NOT NULL,
  source text NOT NULL CHECK (source IN ('website','worker')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS treg_pool_calls_key_idx ON public.treg_pool_calls (key_number, created_at DESC);

-- Access: service role only.
ALTER TABLE public.treg_pool_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.treg_pool_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.treg_pool_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.treg_pool_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.treg_pool_calls ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.treg_pool_keys   FROM PUBLIC, anon, authenticated, service_role;   -- no direct read at all: functions only
REVOKE ALL ON TABLE public.treg_pool_state  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.treg_pool_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.treg_pool_alerts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.treg_pool_calls  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.treg_pool_state, public.treg_pool_events, public.treg_pool_alerts, public.treg_pool_calls TO service_role;
-- writes happen only inside the SECURITY DEFINER functions of file 03

REVOKE ALL ON SEQUENCE public.treg_pool_keys_number_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.treg_pool_events_id_seq   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.treg_pool_alerts_id_seq   FROM PUBLIC, anon, authenticated;
