-- NOT APPLIED. The owner applies it by hand after review, after 00_verify_before_apply.sql.
-- Phase A of the agent worker (agent/): the tables the worker and the admin page «الوكيل» use.
-- NO MONEY TABLE IS TOUCHED: nothing here reads or writes credit_ledger, jobs, topups, profiles, plans_quotes or provider_costs, and no money function is created or changed.
-- Money moves only through the functions that already exist (create_quote_atomic, accept_quote_atomic, claim_job_chunk, complete_chunk, settle_job_atomic, release_job_atomic),
-- called by the worker and by the admin approve route with the service role. `job_id`, `quote_id` and `provider_cost_id` below are plain text/number links, not foreign keys.
--
-- Access: RLS is on for every table. A customer reads ONLY their own missions (through a column list that leaves out every internal column: the plan with its endpoint ids and
-- measured costs, the worker, the model cost, errors) and the events of their own missions. Nobody but the service role writes anything. mission_calls, agent_settings and
-- agent_worker_heartbeat have no policy and no grant for anon or authenticated: service role only.

BEGIN;

CREATE TABLE IF NOT EXISTS public.missions (
  id                  text PRIMARY KEY DEFAULT ('msn_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)) CHECK (id ~ '^msn_[a-z0-9]{8,40}$'),
  user_id             uuid        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_by          uuid,                                              -- the admin who typed the mission (Phase A: the admin page)
  request_text        text        NOT NULL CHECK (char_length(request_text) BETWEEN 3 AND 4000),
  status              text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','planning','needs_input','plan_ready','approved','executing','completed','failed','unserved','cancelled')),
  question_ar         text,                                              -- the ONE question the agent asked (Arabic)
  answer_text         text,                                              -- the answer, typed on the admin page
  plan                jsonb       CHECK (plan IS NULL OR jsonb_typeof(plan) = 'object'),            -- INTERNAL: stages with endpoint ids, measured costs, the calls that measured them, the price computed by code
  plan_public         jsonb       CHECK (plan_public IS NULL OR jsonb_typeof(plan_public) = 'object'), -- what a customer may read: Arabic titles, rows, links between stages, sample rows, price in points
  job_id              text,                                              -- the job the approval reserved under (soft link)
  quote_id            text,
  reserved_points     numeric,
  unit_price_points   numeric,
  planning_model      text,
  planning_llm_usd    numeric(12,6) NOT NULL DEFAULT 0 CHECK (planning_llm_usd >= 0),
  execution_model     text,
  execution_llm_usd   numeric(12,6) NOT NULL DEFAULT 0 CHECK (execution_llm_usd >= 0),
  planning_treg_usd   numeric(12,6) NOT NULL DEFAULT 0 CHECK (planning_treg_usd >= 0),
  execution_treg_usd  numeric(12,6) NOT NULL DEFAULT 0 CHECK (execution_treg_usd >= 0),
  delivered_units     integer     CHECK (delivered_units IS NULL OR delivered_units >= 0),
  charged_points      numeric     CHECK (charged_points IS NULL OR charged_points >= 0),
  summary_ar          text,
  error               text,                                              -- INTERNAL
  files               jsonb       CHECK (files IS NULL OR jsonb_typeof(files) = 'array'),
  worker_id           text,
  lease_until         timestamptz,
  approved_at         timestamptz,
  approved_by         uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS missions_status_lease_idx ON public.missions (status, lease_until);
CREATE INDEX IF NOT EXISTS missions_user_idx ON public.missions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.mission_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mission_id  text        NOT NULL REFERENCES public.missions(id) ON DELETE CASCADE,
  kind        text        NOT NULL CHECK (kind IN ('progress','plan','question','answer','call','result','system','refusal')),
  message_ar  text        NOT NULL CHECK (char_length(message_ar) BETWEEN 1 AND 1200),   -- one Arabic line the live panel shows; the worker has checked it (Arabic only, Arabic-Indic digits, no provider, no endpoint id, no USD)
  counts      jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mission_events_mission_idx ON public.mission_events (mission_id, id);

-- INTERNAL: one row per treg_call the agent made or was refused (cost, endpoint, where the raw page is saved). Never readable by a customer.
CREATE TABLE IF NOT EXISTS public.mission_calls (
  id                text PRIMARY KEY,                                      -- '<mission id>:call_0001'
  mission_id        text        NOT NULL REFERENCES public.missions(id) ON DELETE CASCADE,
  phase             text        NOT NULL CHECK (phase IN ('planning','execution')),
  endpoint_id       text        NOT NULL,
  params_digest     jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params_digest) = 'object'),
  status            text        NOT NULL CHECK (status IN ('ok','failed','empty','refused')),
  refused_reason    text,
  http_status       integer,
  rows_returned     integer     CHECK (rows_returned IS NULL OR rows_returned >= 0),
  cost_usd          numeric(12,6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),        -- the ACTUAL charge (the same figure committed into provider_costs)
  estimate_usd      numeric(12,6) NOT NULL DEFAULT 0 CHECK (estimate_usd >= 0),
  provider_cost_id  bigint,                                                -- provider_costs.id (soft link; that table is written only by the approved functions)
  storage_path      text,                                                  -- agent-missions/<mission id>/raw/call_0001.json
  duration_ms       integer     CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mission_calls_mission_idx ON public.mission_calls (mission_id, created_at);

-- One row per running worker process, written every 30 seconds with the memory it uses. The admin page calls the worker alive while the newest beat is younger than 90 seconds, and shows the memory.
CREATE TABLE IF NOT EXISTS public.agent_worker_heartbeat (
  worker_id        text PRIMARY KEY,
  beat_at          timestamptz NOT NULL,
  active_missions  integer     NOT NULL DEFAULT 0 CHECK (active_missions >= 0),
  model            text,
  version          text,
  rss_mb           integer     CHECK (rss_mb IS NULL OR rss_mb >= 0),        -- memory of the worker process (MB), written with every beat
  tree_rss_mb      integer     CHECK (tree_rss_mb IS NULL OR tree_rss_mb >= 0) -- the worker plus the processes it started (MB): what the dyno's 512 MB counts
);

-- Settings the owner changes from the admin page. Key `planning_model`: {"model": "claude-haiku-5-5" | "claude-sonnet-5-5"}.
CREATE TABLE IF NOT EXISTS public.agent_settings (
  key         text PRIMARY KEY,
  value       jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

ALTER TABLE public.missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mission_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mission_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_worker_heartbeat ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.missions, public.mission_events, public.mission_calls, public.agent_worker_heartbeat, public.agent_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.missions, public.mission_events, public.mission_calls, public.agent_worker_heartbeat, public.agent_settings TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.mission_events_id_seq TO service_role;

-- a customer reads their OWN missions, and only these columns (no plan, no worker, no model cost, no error, no quote)
GRANT SELECT (id, user_id, request_text, status, question_ar, answer_text, plan_public, job_id, reserved_points, unit_price_points, delivered_units, charged_points, summary_ar, files, created_at, updated_at)
  ON public.missions TO authenticated;
DROP POLICY IF EXISTS missions_read_own ON public.missions;
CREATE POLICY missions_read_own ON public.missions FOR SELECT TO authenticated USING (user_id = auth.uid());

-- and the events of their own missions
GRANT SELECT (id, mission_id, kind, message_ar, counts, created_at) ON public.mission_events TO authenticated;
DROP POLICY IF EXISTS mission_events_read_own ON public.mission_events;
CREATE POLICY mission_events_read_own ON public.mission_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.missions m WHERE m.id = mission_events.mission_id AND m.user_id = auth.uid()));

-- no INSERT / UPDATE / DELETE policy and no such grant on any table: only the service role writes.
-- mission_calls, agent_worker_heartbeat, agent_settings: no policy and no grant for anon or authenticated.

COMMIT;
