-- NOT APPLIED. Rolls back 03_unknown_keys.sql.
BEGIN;
DROP TABLE IF EXISTS public.unknown_keys;
COMMIT;
