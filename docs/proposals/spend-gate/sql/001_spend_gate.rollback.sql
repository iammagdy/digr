-- ROUND 61: rollback of 001_spend_gate.sql. NOT APPLIED. Run as the database owner role.
-- Refuses while a reservation is still `held` (a paid call may be in flight), unless the owner sets: SET spend_gate.force_rollback = 'on';
-- First set DIGER_SPEND_GATE to off (or unset it) on Heroku and Vercel: with the functions gone, an `enforce` worker refuses every paid call (fail closed).
-- The audit trail (spend_gate.events) is dropped with the schema: export it first if it must be kept.
-- Customer money is untouched by the migration and by this rollback.

BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'spend_gate')
     AND EXISTS (SELECT 1 FROM spend_gate.reservations WHERE state = 'held')
     AND coalesce(current_setting('spend_gate.force_rollback', true), '') <> 'on' THEN
    RAISE EXCEPTION 'held reservations exist: a paid call may be in flight (SET spend_gate.force_rollback = ''on'' to drop anyway)';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.spend_reserve(text, text, text, numeric, text, integer);
DROP FUNCTION IF EXISTS public.spend_settle(uuid, numeric);
DROP FUNCTION IF EXISTS public.spend_stop(text);
DROP FUNCTION IF EXISTS public.spend_status();
DROP SCHEMA IF EXISTS spend_gate CASCADE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spend_gate_owner') THEN
    EXECUTE 'DROP OWNED BY spend_gate_owner';
    EXECUTE 'DROP ROLE spend_gate_owner';
  END IF;
END $$;

COMMIT;
