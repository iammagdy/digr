-- REPLICA TEST of 01_settle_job_min_atomic.sql. RUN ONLY ON A SCRATCH POSTGRESQL (never on Supabase production): psql -v ON_ERROR_STOP=1 -f 02_replica_test.sql
-- It creates the minimal public.jobs and public.credit_ledger of the production schema (only the columns the function reads or writes), installs the LIVE settle_job_atomic body (a copy, for the comparison) and
-- the proposed settle_job_min_atomic, then asserts the rule on real rows. Any failed assertion raises an exception and stops the script. NOT RUN in the session that wrote it (no PostgreSQL server was available there):
-- the owner or a reviewer runs it; its first block refuses to run against a database that already holds ledger rows.
--
-- What it proves:
--  1. 300 rows delivered at the job unit 0.666666 with minimum 200 and reserve 210: charge 200, the hold released first (rel_ before chg_), the ledger shows res_, rel_, chg_ with the deterministic ids.
--  2. 3 rows delivered (a partial delivery below the minimum): charge 200 = the minimum (the live function would charge ceil(3 x 0.666666) = 2).
--  3. nothing delivered: no chg_ row and charge 0 (the live function agrees).
--  4. a reserve below the minimum (150 < 200): the charge is the reserve, never above it.
--  5. the cap: a minimum above the cap is cut to the cap.
--  6. settling twice charges once (idempotent), and the second call returns already_settled.
--  7. above the minimum the two functions agree to the point (1,000 rows at 3.5 points: 3,500 both).
--  8. a job that is not running is refused; only service_role may execute (privileges checked).
DO $$ BEGIN
  IF to_regclass('public.credit_ledger') IS NOT NULL AND (SELECT count(*) FROM public.credit_ledger) > 0 THEN
    RAISE EXCEPTION 'this database already holds ledger rows: run this script on a scratch database only';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.jobs (
  id text PRIMARY KEY, user_id uuid, status text, lease_until timestamptz, current_cursor text, delivered_units integer, target_volume_max integer,
  unit_price numeric, reserved_credits numeric, charged_credits numeric, result_file_id text, updated_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id text PRIMARY KEY, user_id uuid, delta numeric, type text, job_id text, note text, created_at timestamptz
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;

-- the LIVE function (a verbatim copy of production, read on 2026-10-28), installed as settle_job_atomic for the comparison
CREATE OR REPLACE FUNCTION public.settle_job_atomic(p_job_id text, p_points_cap numeric DEFAULT 25000, p_result_file_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_job RECORD;
  v_raw_charge NUMERIC;
  v_final_charge NUMERIC;
  v_rel_exists BOOLEAN;
  v_chg_exists BOOLEAN;
BEGIN
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % not found', p_job_id;
  END IF;

  IF v_job.status = 'completed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_settled', true,
      'job_id', p_job_id,
      'charged_credits', v_job.charged_credits,
      'delivered_units', v_job.delivered_units
    );
  END IF;

  IF v_job.status != 'running' THEN
    RAISE EXCEPTION 'Cannot settle job % with status % (must be running)', p_job_id, v_job.status;
  END IF;

  IF v_job.lease_until IS NOT NULL AND v_job.lease_until > timezone('utc'::text, now()) THEN
    IF v_job.current_cursor = 'completed' OR
       COALESCE(v_job.delivered_units, 0) >= v_job.target_volume_max THEN
      UPDATE public.jobs
      SET lease_until = NULL,
          updated_at = timezone('utc'::text, now())
      WHERE id = p_job_id;
    ELSE
      RAISE EXCEPTION 'Cannot settle job % while active chunk lease is held until %', p_job_id, v_job.lease_until;
    END IF;
  END IF;

  IF v_job.unit_price IS NULL OR v_job.unit_price <= 0 THEN
    RAISE EXCEPTION 'Job % has invalid unit_price: %', p_job_id, v_job.unit_price;
  END IF;

  IF v_job.reserved_credits IS NULL OR v_job.reserved_credits <= 0 THEN
    RAISE EXCEPTION 'Job % has invalid reserved_credits', p_job_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = ('res_' || p_job_id)) THEN
    RAISE EXCEPTION 'Reserve record res_% does not exist for job %', p_job_id, p_job_id;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.credit_ledger WHERE id = ('rel_' || p_job_id)
  ) INTO v_rel_exists;

  IF NOT v_rel_exists THEN
    INSERT INTO public.credit_ledger (
      id,
      user_id,
      delta,
      type,
      job_id,
      note,
      created_at
    )
    VALUES (
      'rel_' || p_job_id,
      v_job.user_id,
      v_job.reserved_credits,
      'release',
      p_job_id,
      'إرجاع الحجز عند التسوية النهائية للمهمة',
      timezone('utc'::text, now())
    );
  END IF;

  v_raw_charge := CEIL(COALESCE(v_job.delivered_units, 0) * v_job.unit_price);
  v_final_charge := LEAST(v_raw_charge, v_job.reserved_credits, p_points_cap);

  SELECT EXISTS(
    SELECT 1 FROM public.credit_ledger WHERE id = ('chg_' || p_job_id)
  ) INTO v_chg_exists;

  IF NOT v_chg_exists AND v_final_charge > 0 THEN
    INSERT INTO public.credit_ledger (
      id,
      user_id,
      delta,
      type,
      job_id,
      note,
      created_at
    )
    VALUES (
      'chg_' || p_job_id,
      v_job.user_id,
      -v_final_charge,
      'charge',
      p_job_id,
      'خصم تكلفة النتائج المسلمة',
      timezone('utc'::text, now())
    );
  END IF;

  UPDATE public.jobs
  SET status = 'completed',
      charged_credits = v_final_charge,
      result_file_id = COALESCE(p_result_file_id, result_file_id),
      lease_until = NULL,
      updated_at = timezone('utc'::text, now())
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'success', true,
    'already_settled', false,
    'job_id', p_job_id,
    'user_id', v_job.user_id,
    'reserved_credits', v_job.reserved_credits,
    'charged_credits', v_final_charge,
    'delivered_units', v_job.delivered_units
  );
END;
$function$;

\i 01_settle_job_min_atomic.sql

CREATE OR REPLACE FUNCTION pg_temp.mk_job(p_id text, p_delivered integer, p_unit numeric, p_reserved numeric) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.jobs(id, user_id, status, lease_until, current_cursor, delivered_units, target_volume_max, unit_price, reserved_credits, updated_at)
  VALUES (p_id, '00000000-0000-0000-0000-0000000000aa', 'running', NULL, 'completed', p_delivered, 300, p_unit, p_reserved, now());
  INSERT INTO public.credit_ledger(id, user_id, delta, type, job_id, note, created_at)
  VALUES ('res_' || p_id, '00000000-0000-0000-0000-0000000000aa', -p_reserved, 'reserve', p_id, 'reserve', now());
END $$;

DO $$
DECLARE r jsonb; c numeric; n int;
BEGIN
  -- 1. full delivery of 300 rows at 0.666666: exactly the minimum
  PERFORM pg_temp.mk_job('job_t1', 300, 0.666666, 210);
  r := public.settle_job_min_atomic('job_t1', 200);
  ASSERT (r->>'charged_credits')::numeric = 200, 'test 1: a full delivery at the minimum must charge 200, got ' || (r->>'charged_credits');
  ASSERT (SELECT count(*) FROM public.credit_ledger WHERE job_id = 'job_t1') = 3, 'test 1: res_, rel_ and chg_ only';
  ASSERT (SELECT created_at FROM public.credit_ledger WHERE id = 'rel_job_t1') <= (SELECT created_at FROM public.credit_ledger WHERE id = 'chg_job_t1'), 'test 1: release first';
  ASSERT (SELECT delta FROM public.credit_ledger WHERE id = 'chg_job_t1') = -200, 'test 1: chg_ is -200';
  ASSERT (SELECT delta FROM public.credit_ledger WHERE id = 'rel_job_t1') = 210, 'test 1: rel_ returns the whole hold';

  -- 2. partial delivery below the minimum: the minimum; the live function charges ceil(3 x 0.666666) = 2
  PERFORM pg_temp.mk_job('job_t2', 3, 0.666666, 210);
  r := public.settle_job_min_atomic('job_t2', 200);
  ASSERT (r->>'charged_credits')::numeric = 200, 'test 2: 3 rows must be charged the minimum 200';
  PERFORM pg_temp.mk_job('job_t2_live', 3, 0.666666, 210);
  r := public.settle_job_atomic('job_t2_live');
  ASSERT (r->>'charged_credits')::numeric = 2, 'test 2: the live function charges 2 for 3 rows (the reason for this proposal)';

  -- 3. nothing delivered: no charge, no chg_ row
  PERFORM pg_temp.mk_job('job_t3', 0, 0.666666, 210);
  r := public.settle_job_min_atomic('job_t3', 200);
  ASSERT (r->>'charged_credits')::numeric = 0, 'test 3: nothing delivered is not charged';
  ASSERT NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = 'chg_job_t3'), 'test 3: no chg_ row';

  -- 4. a reserve below the minimum: never above the reserve
  PERFORM pg_temp.mk_job('job_t4', 10, 5, 150);
  r := public.settle_job_min_atomic('job_t4', 200);
  ASSERT (r->>'charged_credits')::numeric = 150, 'test 4: the charge is the reserve (150), never above it';

  -- 5. the cap
  PERFORM pg_temp.mk_job('job_t5', 10, 5, 90000);
  r := public.settle_job_min_atomic('job_t5', 40000, 25000);
  ASSERT (r->>'charged_credits')::numeric = 25000, 'test 5: a minimum above the cap is cut to the cap';

  -- 6. idempotent
  r := public.settle_job_min_atomic('job_t1', 200);
  ASSERT (r->>'already_settled')::boolean = true AND (r->>'charged_credits')::numeric = 200, 'test 6: settling twice returns the first result';
  ASSERT (SELECT count(*) FROM public.credit_ledger WHERE job_id = 'job_t1') = 3, 'test 6: no second ledger row';

  -- 7. above the minimum the two functions agree
  PERFORM pg_temp.mk_job('job_t7a', 1000, 3.5, 5000);
  PERFORM pg_temp.mk_job('job_t7b', 1000, 3.5, 5000);
  ASSERT (public.settle_job_min_atomic('job_t7a', 200)->>'charged_credits')::numeric = (public.settle_job_atomic('job_t7b')->>'charged_credits')::numeric, 'test 7: above the minimum both functions charge the same';

  -- 8. a job that is not running is refused
  INSERT INTO public.jobs(id, user_id, status, delivered_units, unit_price, reserved_credits) VALUES ('job_t8', '00000000-0000-0000-0000-0000000000aa', 'failed', 5, 1, 10);
  BEGIN
    PERFORM public.settle_job_min_atomic('job_t8', 200);
    RAISE EXCEPTION 'test 8: a failed job must be refused';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'test 8:%' THEN RAISE; END IF;
  END;
  ASSERT has_function_privilege('service_role', 'public.settle_job_min_atomic(text,numeric,numeric,text)', 'EXECUTE'), 'test 8: service_role may execute';
  ASSERT NOT has_function_privilege('public', 'public.settle_job_min_atomic(text,numeric,numeric,text)', 'EXECUTE'), 'test 8: PUBLIC may not execute';
  RAISE NOTICE 'ALL REPLICA ASSERTIONS PASSED';
END $$;

-- the rollback removes only the new function and leaves the live one as it was
\i 01_settle_job_min_atomic.rollback.sql
DO $$ BEGIN
  ASSERT to_regprocedure('public.settle_job_min_atomic(text,numeric,numeric,text)') IS NULL, 'rollback: the new function is gone';
  ASSERT to_regprocedure('public.settle_job_atomic(text,numeric,text)') IS NOT NULL, 'rollback: settle_job_atomic is untouched';
  RAISE NOTICE 'ROLLBACK CHECK PASSED';
END $$;
