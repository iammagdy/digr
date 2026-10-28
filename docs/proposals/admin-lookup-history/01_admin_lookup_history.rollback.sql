-- Rolls back 01_admin_lookup_history.sql (NOT APPLIED). Drops only the history table; nothing else depends on it.
BEGIN;
DROP TABLE IF EXISTS public.admin_lookup_history;
COMMIT;
