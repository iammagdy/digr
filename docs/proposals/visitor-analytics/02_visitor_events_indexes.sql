-- STEP 2 of 3: the indexes the admin screen's bounded reads use. NOT APPLIED. Apply after 01.
-- Every admin read is «newest first inside a date range» (started_at), optionally for one kind or one visitor; the funnel reads sign-in rows by account.

CREATE INDEX IF NOT EXISTS visitor_events_started_at_idx ON public.visitor_events (started_at DESC);
CREATE INDEX IF NOT EXISTS visitor_events_kind_started_at_idx ON public.visitor_events (kind, started_at DESC);
CREATE INDEX IF NOT EXISTS visitor_events_visitor_idx ON public.visitor_events (visitor_id, started_at DESC);
CREATE INDEX IF NOT EXISTS visitor_events_session_idx ON public.visitor_events (session_id);
CREATE INDEX IF NOT EXISTS visitor_events_user_idx ON public.visitor_events (user_id) WHERE user_id IS NOT NULL;
