-- NOT APPLIED. The owner applies this by hand after review. No money table or function is touched.
--
-- Why: the model planner kept its whole planning loop inside ONE chat request (the Hobby function limit is 60 s). A mission that needs several samples and model turns ended in
-- «غير متاحة» or «حصل تعثر مؤقت» at 30 to 60 s. With this table the loop is kept between steps: each step (a model call or a source call) saves its state, and the next step (the page's,
-- or the background driver's, /api/cron/drive every minute) continues from it. The customer's «خطة المهمة» panel reads the planner's events as they are written.
--
-- The code works WITHOUT this table: chat then plans in one request, as before (and ends with the planning budget's honest question instead of «غير متاحة»). Once the table exists the
-- sessions start by themselves; nothing else has to be switched on.
--
-- Access: only the service role (the routes read and write with it). RLS is on, no policy; anon and authenticated have nothing.

BEGIN;

CREATE TABLE IF NOT EXISTS public.planning_sessions (
  id               text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  user_id          uuid        NOT NULL,
  conversation_id  text        NOT NULL,
  user_msg_id      text        NOT NULL,
  assistant_msg_id text        NOT NULL,
  status           text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  version          integer     NOT NULL DEFAULT 0,            -- optimistic lock: a step takes the session by version
  lease_until      timestamptz,                               -- a step holds the session until then
  request          jsonb       NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  state            jsonb       CHECK (state IS NULL OR jsonb_typeof(state) = 'object'),   -- the planning loop's snapshot between steps; cleared when done
  result           jsonb       CHECK (result IS NULL OR jsonb_typeof(result) = 'object'), -- the answer the page shows, when done
  steps            integer     NOT NULL DEFAULT 0,
  errors           integer     NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS planning_sessions_running_idx ON public.planning_sessions (updated_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS planning_sessions_user_idx ON public.planning_sessions (user_id, created_at DESC);

ALTER TABLE public.planning_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.planning_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.planning_sessions TO service_role;

COMMIT;
