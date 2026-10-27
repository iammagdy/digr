-- NOT APPLIED. Rolls back 02_exploration_calls.sql.
BEGIN;
DROP TABLE IF EXISTS public.exploration_calls;
COMMIT;
