-- Migration: one_open_addon_per_file
--
-- PREPARED FOR OWNER REVIEW. NOT APPLIED to any database by the work that prepared it. It was generated with `supabase migration new` (local only, no database contacted) and
-- exercised ONLY on a disposable local PostgreSQL 16 that held the missions table of docs/proposals/agent-worker/01_agent_tables.sql (docs/STAGE-4-FINANCIAL-SAFETY.md section 5).
-- Read docs/STAGE-4-FINANCIAL-SAFETY.md section 5 FIRST: it lists the read-only checks to run before this file, the lock behaviour, the rollback and what is NOT verified.
--
-- WHAT IT DOES: makes «one open add-on (review, review fix or edit) per delivered file» true in the DATABASE, not only in the application's creation protocol.
-- WHAT IT DOES NOT DO: it creates ONE index. It never deletes, updates or inserts a row, never touches a money table (credit_ledger, jobs, topups, plans_quotes), never changes a function, a policy or a grant.
--
-- THE KEY: plan->'addon'->>'of' is the id of the delivered mission the add-on belongs to (written only by the server through the service role; the customer's column grants leave `plan` out).
-- THE PREDICATE (deny-list): an add-on row holds the slot unless its status is one of the four that end a request: completed, failed, unserved, cancelled. So every started state (approved, executing, a request whose approval was attempted)
-- holds it, and a status added to the CHECK later HOLDS the slot (the refusal is «you have an open request», safe) instead of silently freeing it (two requests, unsafe).
-- Ordinary research missions have no `addon` key: their key is NULL, the predicate is false, and they are untouched.
--
-- PRECONDITIONS, checked below, each of which STOPS the migration with an exception and changes nothing: the table exists; `plan` is jsonb; no file already has two open add-on rows (the index could not be built over them).

DO $$
DECLARE
  v_type text;
  v_conflicts bigint;
BEGIN
  IF to_regclass('public.missions') IS NULL THEN
    RAISE EXCEPTION 'one_open_addon_per_file: table public.missions does not exist (apply the agent tables first)';
  END IF;

  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'missions' AND column_name = 'plan';
  IF v_type IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION 'one_open_addon_per_file: public.missions.plan must be jsonb, found %', coalesce(v_type, 'no such column');
  END IF;

  SELECT count(*) INTO v_conflicts
  FROM (
    SELECT plan->'addon'->>'of'
    FROM public.missions
    WHERE (plan->'addon'->>'of') IS NOT NULL
      AND status NOT IN ('completed', 'failed', 'unserved', 'cancelled')
    GROUP BY plan->'addon'->>'of'
    HAVING count(*) > 1
  ) AS violators;
  IF v_conflicts > 0 THEN
    RAISE EXCEPTION 'one_open_addon_per_file: % file(s) already have more than one open add-on row; repair them first (cancel the UNPAID duplicates, lowest id stays; a pair that includes a started row needs a person)', v_conflicts;
  END IF;
END
$$;

-- AUDIT FIX (PR #398 review): CREATE ... IF NOT EXISTS skips SILENTLY when ANY relation of that name exists, so a plain index, a different predicate or another table would have been taken for the guard
-- (and the COMMENT below would have labelled it). Step 1 stops the migration, changing nothing, unless the existing object of that name is exactly the guard; step 2 proves the same after the statement.
  -- the object of that name, if any, must be EXACTLY the guard: an index on public.missions, valid and ready, unique, one key (the expression), the same partial predicate, the same access method, operator class,
  -- collation and sort order. The reference is built by THIS server on a session-local temp table that has the real column types (so the text of the expression and of the predicate is compared in the server's own
  -- words, whatever its version) and dropped at once. Anything else (a plain index, another predicate, another key, another table, a view, a table, an INVALID leftover of a failed build) is NOT the guard.
DO $$
DECLARE
  v_oid oid;
  v_kind "char";
  v_same boolean;
BEGIN
  SELECT c.oid, c.relkind INTO v_oid, v_kind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'missions_one_open_addon_per_file';
  IF v_oid IS NULL THEN
    RETURN; -- the name is free: the statement below builds the guard
  END IF;
  IF v_kind IS DISTINCT FROM 'i' THEN
    RAISE EXCEPTION 'one_open_addon_per_file: public.missions_one_open_addon_per_file already exists with a different definition (it is a relation of kind %, not an index); it is NOT the safety guard. Drop or rename it, then run this migration again', v_kind;
  END IF;
  CREATE TEMP TABLE one_open_addon_ref (LIKE public.missions) ON COMMIT DROP;
  CREATE UNIQUE INDEX one_open_addon_ref_idx ON one_open_addon_ref ((plan->'addon'->>'of'))
    WHERE (plan->'addon'->>'of') IS NOT NULL
      AND status NOT IN ('completed', 'failed', 'unserved', 'cancelled');
  SELECT e.indrelid = 'public.missions'::regclass
     AND e.indisunique AND e.indisvalid AND e.indisready AND e.indislive
     AND e.indnkeyatts = r.indnkeyatts AND e.indnatts = r.indnatts
     AND e.indkey::text = r.indkey::text AND e.indclass::text = r.indclass::text
     AND e.indcollation::text = r.indcollation::text AND e.indoption::text = r.indoption::text
     AND ec.relam = rc.relam AND ec.relpersistence = 'p'
     AND pg_get_expr(e.indexprs, e.indrelid) IS NOT DISTINCT FROM pg_get_expr(r.indexprs, r.indrelid)
     AND pg_get_expr(e.indpred, e.indrelid) IS NOT DISTINCT FROM pg_get_expr(r.indpred, r.indrelid)
  INTO v_same
  FROM pg_index e
  JOIN pg_class ec ON ec.oid = e.indexrelid,
       pg_index r JOIN pg_class rc ON rc.oid = r.indexrelid
  WHERE e.indexrelid = v_oid AND r.indexrelid = 'pg_temp.one_open_addon_ref_idx'::regclass;
  DROP TABLE one_open_addon_ref;
  IF v_same IS NOT TRUE THEN
    RAISE EXCEPTION 'one_open_addon_per_file: public.missions_one_open_addon_per_file already exists with a different definition (%); it is NOT the safety guard. Drop or rename it, then run this migration again', pg_get_indexdef(v_oid);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS missions_one_open_addon_per_file
  ON public.missions ((plan->'addon'->>'of'))
  WHERE (plan->'addon'->>'of') IS NOT NULL
    AND status NOT IN ('completed', 'failed', 'unserved', 'cancelled');

DO $$
DECLARE
  v_oid oid;
  v_kind "char";
  v_same boolean;
BEGIN
  SELECT c.oid, c.relkind INTO v_oid, v_kind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'missions_one_open_addon_per_file';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'one_open_addon_per_file: the guard index does not exist after it was created';
  END IF;
  IF v_kind IS DISTINCT FROM 'i' THEN
    RAISE EXCEPTION 'one_open_addon_per_file: public.missions_one_open_addon_per_file already exists with a different definition (it is a relation of kind %, not an index); it is NOT the safety guard. Drop or rename it, then run this migration again', v_kind;
  END IF;
  CREATE TEMP TABLE one_open_addon_ref (LIKE public.missions) ON COMMIT DROP;
  CREATE UNIQUE INDEX one_open_addon_ref_idx ON one_open_addon_ref ((plan->'addon'->>'of'))
    WHERE (plan->'addon'->>'of') IS NOT NULL
      AND status NOT IN ('completed', 'failed', 'unserved', 'cancelled');
  SELECT e.indrelid = 'public.missions'::regclass
     AND e.indisunique AND e.indisvalid AND e.indisready AND e.indislive
     AND e.indnkeyatts = r.indnkeyatts AND e.indnatts = r.indnatts
     AND e.indkey::text = r.indkey::text AND e.indclass::text = r.indclass::text
     AND e.indcollation::text = r.indcollation::text AND e.indoption::text = r.indoption::text
     AND ec.relam = rc.relam AND ec.relpersistence = 'p'
     AND pg_get_expr(e.indexprs, e.indrelid) IS NOT DISTINCT FROM pg_get_expr(r.indexprs, r.indrelid)
     AND pg_get_expr(e.indpred, e.indrelid) IS NOT DISTINCT FROM pg_get_expr(r.indpred, r.indrelid)
  INTO v_same
  FROM pg_index e
  JOIN pg_class ec ON ec.oid = e.indexrelid,
       pg_index r JOIN pg_class rc ON rc.oid = r.indexrelid
  WHERE e.indexrelid = v_oid AND r.indexrelid = 'pg_temp.one_open_addon_ref_idx'::regclass;
  DROP TABLE one_open_addon_ref;
  IF v_same IS NOT TRUE THEN
    RAISE EXCEPTION 'one_open_addon_per_file: public.missions_one_open_addon_per_file already exists with a different definition (%); it is NOT the safety guard. Drop or rename it, then run this migration again', pg_get_indexdef(v_oid);
  END IF;
END
$$;

COMMENT ON INDEX public.missions_one_open_addon_per_file IS
  'One open add-on (review, review fix, edit) per delivered file: plan->addon->>of is unique among add-on rows that are not completed, failed, unserved or cancelled. Rollback: DROP INDEX public.missions_one_open_addon_per_file;';
