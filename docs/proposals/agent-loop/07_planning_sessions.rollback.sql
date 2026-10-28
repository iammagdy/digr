-- NOT APPLIED. Rolls back 07_planning_sessions.sql. Drops only the planning sessions table; the chat then plans in one request, as before.
BEGIN;
DROP TABLE IF EXISTS public.planning_sessions;
COMMIT;
