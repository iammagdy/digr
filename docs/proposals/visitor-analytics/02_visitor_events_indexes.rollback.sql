-- ROLLBACK of step 2. NOT APPLIED. Drops the five indexes; the table and its rows stay.
DROP INDEX IF EXISTS public.visitor_events_user_idx;
DROP INDEX IF EXISTS public.visitor_events_session_idx;
DROP INDEX IF EXISTS public.visitor_events_visitor_idx;
DROP INDEX IF EXISTS public.visitor_events_kind_started_at_idx;
DROP INDEX IF EXISTS public.visitor_events_started_at_idx;
