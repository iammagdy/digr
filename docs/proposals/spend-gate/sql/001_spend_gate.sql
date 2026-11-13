-- ROUND 61: HARD SPEND GATE (docs/proposals/spend-gate/SPEC-v2.md). NOT APPLIED. Requires owner approval (SPEC-v2 §13, decision 2).
-- Additive only: a role, a schema, three tables, owner-only functions and four public functions for service_role. No existing object changes.
-- Customer money is not referenced anywhere in this file (credit_ledger, accept_quote_atomic, settle_job_atomic, release_job_atomic).
-- Rollback: 001_spend_gate.rollback.sql. Verification: 002_verify.sql.
--
-- Run as the database owner role (`postgres`: the Supabase dashboard SQL editor). It creates NO grant: until the owner issues one with
-- spend_gate.issue_grant, every reservation is refused (no_grant), and with DIGER_SPEND_GATE unset nothing calls these functions at all.

BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'spend_gate') THEN RAISE EXCEPTION 'spend_gate already exists: nothing applied'; END IF;
END $$;

DO $$ BEGIN CREATE ROLE spend_gate_owner NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- the database owner may act as it (to own and to issue); NO other role is ever granted it (002_verify.sql checks)
GRANT spend_gate_owner TO CURRENT_USER;

CREATE SCHEMA spend_gate AUTHORIZATION spend_gate_owner;
REVOKE ALL ON SCHEMA spend_gate FROM PUBLIC;
GRANT USAGE ON SCHEMA spend_gate TO CURRENT_USER;

SET LOCAL ROLE spend_gate_owner;

CREATE TABLE spend_gate.grants (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_:.-]{2,79}$'),
  ceiling_usd numeric(12,6) NOT NULL CHECK (ceiling_usd > 0 AND ceiling_usd <= 50),
  per_op_max_usd numeric(12,6) NOT NULL CHECK (per_op_max_usd > 0 AND per_op_max_usd <= 1),
  per_mission_max_usd numeric(12,6) NOT NULL CHECK (per_mission_max_usd > 0),
  kinds text[] NOT NULL CHECK (cardinality(kinds) >= 1 AND kinds <@ ARRAY['provider','model','chat','eval']::text[]),
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  reserved_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  spent_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  overrun_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (overrun_usd >= 0),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','revoked','tripped')),
  issued_by text NOT NULL CHECK (length(issued_by) BETWEEN 1 AND 100),
  issued_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  CHECK (closes_at > opens_at AND closes_at <= opens_at + interval '31 days'),
  CHECK (per_mission_max_usd <= ceiling_usd),
  -- THE invariant: held plus counted never passes the owner's amount (an overrun is recorded apart and trips the grant)
  CHECK (reserved_usd + spent_usd <= ceiling_usd + 0.000001)
);
CREATE UNIQUE INDEX grants_one_open ON spend_gate.grants ((true)) WHERE state = 'open';

CREATE TABLE spend_gate.reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (length(key) BETWEEN 1 AND 200),
  grant_id text NOT NULL REFERENCES spend_gate.grants(id),
  kind text NOT NULL CHECK (kind IN ('provider','model','chat','eval')),
  op text NOT NULL CHECK (length(op) BETWEEN 1 AND 200),
  bound_usd numeric(12,6) NOT NULL CHECK (bound_usd > 0 AND bound_usd <= 1),
  mission_id text CHECK (mission_id IS NULL OR length(mission_id) BETWEEN 1 AND 100),
  state text NOT NULL CHECK (state IN ('held','settled','expired')),
  actual_usd numeric(14,6),
  charge_known boolean,
  counted_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (counted_usd >= 0 AND counted_usd <= bound_usd),
  overrun_usd numeric(14,6) NOT NULL DEFAULT 0 CHECK (overrun_usd >= 0),
  held_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  settled_at timestamptz
);
CREATE INDEX reservations_held ON spend_gate.reservations (grant_id, state, expires_at);
CREATE INDEX reservations_mission ON spend_gate.reservations (grant_id, mission_id);

CREATE TABLE spend_gate.events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  grant_id text,
  kind text NOT NULL,
  actor text NOT NULL DEFAULT current_user,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE spend_gate.grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_gate.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_gate.events ENABLE ROW LEVEL SECURITY;

-- internal: called with the grant row already locked
CREATE FUNCTION spend_gate.expire_stale(p_grant text) RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, spend_gate, pg_temp AS $$
DECLARE n integer; total numeric;
BEGIN
  WITH x AS (
    UPDATE spend_gate.reservations SET state = 'expired', counted_usd = bound_usd, charge_known = false, settled_at = now()
    WHERE grant_id = p_grant AND state = 'held' AND expires_at <= now()
    RETURNING bound_usd)
  SELECT count(*), coalesce(sum(bound_usd), 0) INTO n, total FROM x;
  IF n > 0 THEN
    -- an expired reservation may have been sent: its whole bound is SPENT, never released
    UPDATE spend_gate.grants SET reserved_usd = reserved_usd - total, spent_usd = spent_usd + total WHERE id = p_grant;
    INSERT INTO spend_gate.events (grant_id, kind, detail) VALUES (p_grant, 'expired_as_spent', jsonb_build_object('count', n, 'usd', total));
  END IF;
  RETURN n;
END $$;

-- OWNER ONLY: issue a grant. Never executable by service_role, authenticated or anon.
CREATE FUNCTION spend_gate.issue_grant(p_id text, p_ceiling_usd numeric, p_per_op_max_usd numeric, p_per_mission_max_usd numeric, p_kinds text[],
                                       p_opens_at timestamptz, p_closes_at timestamptz, p_issued_by text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, spend_gate, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM spend_gate.grants WHERE state = 'open') THEN RAISE EXCEPTION 'one open grant at a time: revoke the open one first'; END IF;
  INSERT INTO spend_gate.grants (id, ceiling_usd, per_op_max_usd, per_mission_max_usd, kinds, opens_at, closes_at, issued_by, reason)
  VALUES (p_id, p_ceiling_usd, p_per_op_max_usd, p_per_mission_max_usd, p_kinds, p_opens_at, p_closes_at, p_issued_by, p_reason);
  INSERT INTO spend_gate.events (grant_id, kind, actor, detail) VALUES (p_id, 'issued', session_user, jsonb_build_object('ceiling_usd', p_ceiling_usd, 'per_op_max_usd', p_per_op_max_usd,
    'per_mission_max_usd', p_per_mission_max_usd, 'kinds', p_kinds, 'opens_at', p_opens_at, 'closes_at', p_closes_at, 'issued_by', p_issued_by, 'reason', p_reason));
  RETURN jsonb_build_object('ok', true, 'grant_id', p_id);
END $$;

-- OWNER ONLY: revoke. (There is deliberately no function that raises, reopens or extends a grant: a new grant is a new owner act.)
CREATE FUNCTION spend_gate.revoke_grant(p_id text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, spend_gate, pg_temp AS $$
BEGIN
  UPDATE spend_gate.grants SET state = 'revoked' WHERE id = p_id AND state <> 'revoked';
  INSERT INTO spend_gate.events (grant_id, kind, actor, detail) VALUES (p_id, 'revoked', session_user, jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('ok', FOUND);
END $$;

-- OWNER (or an optional schedule): expire the stale reservations of the open grant. Safety does not depend on it (reserve does it first).
CREATE FUNCTION spend_gate.expire_stale_open() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, spend_gate, pg_temp AS $$
DECLARE g text;
BEGIN
  SELECT id INTO g FROM spend_gate.grants WHERE state = 'open' FOR UPDATE;
  IF g IS NULL THEN RETURN 0; END IF;
  RETURN spend_gate.expire_stale(g);
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- The four functions service_role may execute. SECURITY DEFINER, owned by spend_gate_owner. None takes a ceiling or a maximum from its caller.
-- ---------------------------------------------------------------------------------------------------------------------------------------

CREATE FUNCTION public.spend_reserve(p_key text, p_kind text, p_op text, p_bound_usd numeric, p_mission_id text, p_ttl_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, spend_gate, pg_temp AS $$
DECLARE g spend_gate.grants%ROWTYPE; r spend_gate.reservations%ROWTYPE; b numeric; used numeric; last_state text; rid uuid;
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR p_op IS NULL OR length(p_op) NOT BETWEEN 1 AND 200
     OR p_kind IS NULL OR p_kind NOT IN ('provider','model','chat','eval')
     OR p_bound_usd IS NULL OR NOT (p_bound_usd > 0) OR p_bound_usd > 1
     OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 5 AND 900
     OR (p_mission_id IS NOT NULL AND length(p_mission_id) NOT BETWEEN 1 AND 100) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_input');
  END IF;
  -- amounts are kept to the micro-dollar, rounded UP: a bound is never stored below what was asked
  b := ceil(p_bound_usd * 1000000) / 1000000;
  -- one lock serializes every reservation (and every replay of a key) against the open grant
  SELECT * INTO g FROM spend_gate.grants WHERE state = 'open' FOR UPDATE;
  SELECT * INTO r FROM spend_gate.reservations WHERE key = p_key;
  IF FOUND THEN
    IF r.bound_usd = b AND r.kind = p_kind AND r.mission_id IS NOT DISTINCT FROM p_mission_id THEN
      RETURN jsonb_build_object('ok', true, 'reservation_id', r.id, 'grant_id', r.grant_id, 'replay', true);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'key_conflict');
  END IF;
  IF g.id IS NULL THEN
    SELECT state INTO last_state FROM spend_gate.grants ORDER BY issued_at DESC LIMIT 1;
    RETURN jsonb_build_object('ok', false, 'reason', CASE last_state WHEN 'tripped' THEN 'grant_tripped' WHEN 'revoked' THEN 'grant_revoked' ELSE 'no_grant' END);
  END IF;
  IF now() < g.opens_at THEN RETURN jsonb_build_object('ok', false, 'reason', 'grant_not_open'); END IF;
  IF now() >= g.closes_at THEN RETURN jsonb_build_object('ok', false, 'reason', 'grant_expired'); END IF;
  PERFORM spend_gate.expire_stale(g.id);
  SELECT * INTO g FROM spend_gate.grants WHERE id = g.id;
  IF NOT (p_kind = ANY (g.kinds)) THEN RETURN jsonb_build_object('ok', false, 'reason', 'kind_not_covered'); END IF;
  IF b > g.per_op_max_usd THEN RETURN jsonb_build_object('ok', false, 'reason', 'over_op_max'); END IF;
  IF g.reserved_usd + g.spent_usd + b > g.ceiling_usd THEN RETURN jsonb_build_object('ok', false, 'reason', 'over_ceiling'); END IF;
  IF p_mission_id IS NOT NULL THEN
    SELECT coalesce(sum(CASE WHEN state = 'held' THEN bound_usd ELSE counted_usd + overrun_usd END), 0) INTO used
      FROM spend_gate.reservations WHERE grant_id = g.id AND mission_id = p_mission_id;
    IF used + b > g.per_mission_max_usd THEN RETURN jsonb_build_object('ok', false, 'reason', 'over_mission_ceiling'); END IF;
  END IF;
  INSERT INTO spend_gate.reservations (key, grant_id, kind, op, bound_usd, mission_id, state, expires_at)
  VALUES (p_key, g.id, p_kind, p_op, b, p_mission_id, 'held', now() + make_interval(secs => p_ttl_seconds))
  RETURNING id INTO rid;
  UPDATE spend_gate.grants SET reserved_usd = reserved_usd + b WHERE id = g.id;
  RETURN jsonb_build_object('ok', true, 'reservation_id', rid, 'grant_id', g.id, 'replay', false);
END $$;

-- p_actual_usd NULL = the charge is not known: the whole bound stays spent.
CREATE FUNCTION public.spend_settle(p_reservation uuid, p_actual_usd numeric) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, spend_gate, pg_temp AS $$
DECLARE r spend_gate.reservations%ROWTYPE; gid text; a numeric; counted numeric; over numeric;
BEGIN
  IF p_reservation IS NULL OR (p_actual_usd IS NOT NULL AND (p_actual_usd < 0 OR p_actual_usd > 1000)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_input');
  END IF;
  SELECT grant_id INTO gid FROM spend_gate.reservations WHERE id = p_reservation;
  IF gid IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_reservation'); END IF;
  -- same lock order as reserve (grant, then reservation): no deadlock
  PERFORM 1 FROM spend_gate.grants WHERE id = gid FOR UPDATE;
  SELECT * INTO r FROM spend_gate.reservations WHERE id = p_reservation FOR UPDATE;
  IF r.state = 'held' AND r.expires_at <= now() THEN
    PERFORM spend_gate.expire_stale(gid);
    SELECT * INTO r FROM spend_gate.reservations WHERE id = p_reservation;
  END IF;
  IF r.state <> 'held' THEN
    RETURN jsonb_build_object('ok', true, 'state', r.state, 'counted_usd', r.counted_usd, 'overrun_usd', r.overrun_usd, 'replay', true);
  END IF;
  IF p_actual_usd IS NULL THEN
    counted := r.bound_usd; over := 0;
  ELSE
    a := ceil(p_actual_usd * 1000000) / 1000000;
    counted := least(a, r.bound_usd); over := greatest(0, a - r.bound_usd);
  END IF;
  UPDATE spend_gate.reservations SET state = 'settled', actual_usd = a, charge_known = (p_actual_usd IS NOT NULL), counted_usd = counted, overrun_usd = over, settled_at = now()
   WHERE id = r.id;
  UPDATE spend_gate.grants SET reserved_usd = reserved_usd - r.bound_usd, spent_usd = spent_usd + counted, overrun_usd = overrun_usd + over,
         state = CASE WHEN over > 0 AND state = 'open' THEN 'tripped' ELSE state END
   WHERE id = gid;
  IF over > 0 THEN
    INSERT INTO spend_gate.events (grant_id, kind, detail) VALUES (gid, 'tripped_overrun', jsonb_build_object('reservation', r.id, 'op', r.op, 'bound_usd', r.bound_usd, 'actual_usd', a));
  END IF;
  RETURN jsonb_build_object('ok', true, 'state', 'settled', 'counted_usd', counted, 'overrun_usd', over, 'replay', false);
END $$;

-- The kill switch service_role may hold: it can only STOP spending.
CREATE FUNCTION public.spend_stop(p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, spend_gate, pg_temp AS $$
DECLARE gid text;
BEGIN
  UPDATE spend_gate.grants SET state = 'tripped' WHERE state = 'open' RETURNING id INTO gid;
  IF gid IS NOT NULL THEN
    INSERT INTO spend_gate.events (grant_id, kind, detail) VALUES (gid, 'stopped', jsonb_build_object('reason', left(coalesce(p_reason, ''), 300)));
  END IF;
  RETURN jsonb_build_object('ok', true, 'stopped', gid IS NOT NULL);
END $$;

-- What a caller may know: the open (or latest) grant's amounts and state. No write.
CREATE FUNCTION public.spend_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, spend_gate, pg_temp AS $$
  SELECT coalesce((SELECT jsonb_build_object('grant_id', id, 'state', state, 'kinds', kinds, 'ceiling_usd', ceiling_usd, 'reserved_usd', reserved_usd, 'spent_usd', spent_usd,
                                             'overrun_usd', overrun_usd, 'per_op_max_usd', per_op_max_usd, 'per_mission_max_usd', per_mission_max_usd, 'opens_at', opens_at, 'closes_at', closes_at)
                   FROM spend_gate.grants ORDER BY (state = 'open') DESC, issued_at DESC LIMIT 1), jsonb_build_object('grant_id', null));
$$;

-- Ownership: the public functions belong to spend_gate_owner (they run with its rights, which are only over spend_gate)
GRANT CREATE ON SCHEMA public TO spend_gate_owner;
ALTER FUNCTION public.spend_reserve(text, text, text, numeric, text, integer) OWNER TO spend_gate_owner;
ALTER FUNCTION public.spend_settle(uuid, numeric) OWNER TO spend_gate_owner;
ALTER FUNCTION public.spend_stop(text) OWNER TO spend_gate_owner;
ALTER FUNCTION public.spend_status() OWNER TO spend_gate_owner;
REVOKE CREATE ON SCHEMA public FROM spend_gate_owner;

-- Privileges. Supabase grants new public functions to anon/authenticated/service_role by default privileges: every one is revoked explicitly.
REVOKE ALL ON ALL TABLES IN SCHEMA spend_gate FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA spend_gate FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA spend_gate FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SCHEMA spend_gate FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION spend_gate.issue_grant(text, numeric, numeric, numeric, text[], timestamptz, timestamptz, text, text) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION spend_gate.revoke_grant(text, text) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION spend_gate.expire_stale_open() TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.spend_reserve(text, text, text, numeric, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.spend_settle(uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.spend_stop(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.spend_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.spend_reserve(text, text, text, numeric, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.spend_settle(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.spend_stop(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.spend_status() TO service_role;

COMMIT;
