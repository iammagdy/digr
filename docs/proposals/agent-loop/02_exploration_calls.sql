-- NOT APPLIED. Owner applies by hand after review. No money table or function is touched.
-- One row per budgeted exploration call (a real provider call made to learn an endpoint's answer shape). The provider cost itself is still recorded where every
-- provider cost is recorded (provider_costs, by the existing function); this table says WHY the call was made and where its raw answer is kept.

BEGIN;

CREATE TABLE IF NOT EXISTS public.exploration_calls (
  id                  text PRIMARY KEY DEFAULT ('exp_' || replace(gen_random_uuid()::text, '-', '')),
  request_id          text        NOT NULL,                       -- the exploration request (one per customer request or admin queue item)
  user_id             uuid,                                       -- the customer whose request it was; null for an admin queue item
  endpoint_id         text        NOT NULL CHECK (length(endpoint_id) BETWEEN 3 AND 200),
  params_digest       jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params_digest) = 'object'),   -- the parameter NAMES and their provenance, never customer values
  cost_usd            numeric(12, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  http_status         integer,
  rows_returned       integer     CHECK (rows_returned IS NULL OR rows_returned >= 0),
  duration_ms         integer     CHECK (duration_ms IS NULL OR duration_ms >= 0),
  storage_path        text,                                       -- partials/<...>: the raw answer, masked and size-capped
  budget_usd          numeric(12, 6) NOT NULL CHECK (budget_usd >= 0),   -- the request's exploration budget when the call was made
  refused_reason      text,                                       -- set when code refused the call before it was made (nothing was spent)
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exploration_calls_request_idx ON public.exploration_calls (request_id, created_at);
CREATE INDEX IF NOT EXISTS exploration_calls_endpoint_idx ON public.exploration_calls (endpoint_id, created_at DESC);

ALTER TABLE public.exploration_calls ENABLE ROW LEVEL SECURITY;   -- no policy: only the service role reads or writes
REVOKE ALL ON public.exploration_calls FROM PUBLIC, anon, authenticated;

COMMIT;
