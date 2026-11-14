-- SPEND SAFETY MILESTONE (14 Nov 2026): CAMPAIGN SCOPE for the hard spend gate. NOT APPLIED. Requires the owner's separate approval.
-- Apply AFTER 001_spend_gate.sql (it extends that schema; it cannot run without it). Verification: 004_verify_campaign.sql. Rollback: 003_campaign_scope.rollback.sql.
--
-- What it adds (additive; no customer-money object is referenced, read or changed: credit_ledger, accept_quote_atomic, settle_job_atomic, release_job_atomic):
--   * a campaign grant: bound to ONE account, serving only the missions ENROLLED in it, kinds provider and model only, a window of at most 72 hours;
--   * ONE cumulative ceiling for the whole campaign: the sum of every campaign grant's spent + held + overrun, plus a new grant's ceiling, never passes 0.30 USD.
--     Revoking or expiring a grant gives nothing back, and a reservation still held counts in full;
--   * immutability: a grant's id, account, amounts, kinds, window and mission limit never change after issue, and a tripped or revoked grant never reopens;
--   * public.spend_enroll_mission(mission): service_role may call it, but the DATABASE decides: the mission's owner is read from public.missions and must be the
--     grant's account. The caller's word decides nothing;
--   * public.spend_reserve is replaced by a version that refuses (mission_not_enrolled) a campaign grant's reservation for a mission that is not enrolled in it.
--
-- It creates NO grant. The owner issues the campaign grant with spend_gate.issue_campaign_grant, in the database owner role (never service_role).

BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'spend_gate') THEN RAISE EXCEPTION '001_spend_gate.sql is not applied: nothing applied'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'spend_gate' AND table_name = 'grants' AND column_name = 'account_id') THEN RAISE EXCEPTION '003 is already applied: nothing applied'; END IF;
END $$;

SET LOCAL ROLE spend_gate_owner;

ALTER TABLE spend_gate.grants ADD COLUMN account_id uuid, ADD COLUMN max_missions integer;
-- a campaign grant has BOTH; a general grant has NEITHER
ALTER TABLE spend_gate.grants ADD CONSTRAINT grants_campaign_pair CHECK ((account_id IS NULL) = (max_missions IS NULL));
ALTER TABLE spend_gate.grants ADD CONSTRAINT grants_campaign_terms CHECK (
  account_id IS NULL OR (
    max_missions BETWEEN 1 AND 5
    AND ceiling_usd <= 0.30
    AND kinds <@ ARRAY['provider','model']::text[]
    AND closes_at <= opens_at + interval '72 hours'));

CREATE TABLE spend_gate.enrollments (
  grant_id text NOT NULL REFERENCES spend_gate.grants(id),
  mission_id text NOT NULL CHECK (length(mission_id) BETWEEN 1 AND 100),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grant_id, mission_id)
);
ALTER TABLE spend_gate.enrollments ENABLE ROW LEVEL SECURITY;

-- IMMUTABLE TERMS: only the counters and the state move, and the state only goes from open to revoked or tripped (a tripped or revoked grant never reopens)
CREATE FUNCTION spend_gate.grants_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, spend_gate, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.max_missions IS DISTINCT FROM OLD.max_missions
     OR NEW.ceiling_usd IS DISTINCT FROM OLD.ceiling_usd OR NEW.per_op_max_usd IS DISTINCT FROM OLD.per_op_max_usd OR NEW.per_mission_max_usd IS DISTINCT FROM OLD.per_mission_max_usd
     OR NEW.kinds IS DISTINCT FROM OLD.kinds OR NEW.opens_at IS DISTINCT FROM OLD.opens_at OR NEW.closes_at IS DISTINCT FROM OLD.closes_at
     OR NEW.issued_by IS DISTINCT FROM OLD.issued_by OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION 'a grant''s terms never change after it is issued: issue a new grant';
  END IF;
  IF OLD.state <> 'open' AND NEW.state IS DISTINCT FROM OLD.state THEN RAISE EXCEPTION 'a % grant never reopens', OLD.state; END IF;
  IF NEW.reserved_usd < 0 OR NEW.spent_usd < OLD.spent_usd OR NEW.overrun_usd < OLD.overrun_usd THEN RAISE EXCEPTION 'spent and overrun never go down'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER grants_immutable BEFORE UPDATE ON spend_gate.grants FOR EACH ROW EXECUTE FUNCTION spend_gate.grants_immutable();

RESET ROLE;

-- The mission's owner, read as the TABLE OWNER (the database owner role bypasses row-level security on public.missions): only a user id, for one mission.
-- Executable by spend_gate_owner alone; nothing else is exposed.
CREATE FUNCTION spend_gate.mission_owner(p_mission text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT user_id::uuid FROM public.missions WHERE id = p_mission;
$$;
REVOKE ALL ON FUNCTION spend_gate.mission_owner(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION spend_gate.mission_owner(text) TO spend_gate_owner;
GRANT USAGE ON SCHEMA spend_gate TO spend_gate_owner;

SET LOCAL ROLE spend_gate_owner;

-- OWNER ONLY. Cumulative: this grant's ceiling plus everything every campaign grant has already used (spent + held + overrun) cannot pass 0.30 USD.
CREATE FUNCTION spend_gate.issue_campaign_grant(p_id text, p_account uuid, p_ceiling_usd numeric, p_per_op_max_usd numeric, p_per_mission_max_usd numeric, p_kinds text[],
                                                p_opens_at timestamptz, p_closes_at timestamptz, p_max_missions integer, p_issued_by text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, spend_gate, pg_temp AS $$
DECLARE used numeric;
BEGIN
  IF p_account IS NULL THEN RAISE EXCEPTION 'a campaign grant belongs to one account'; END IF;
  -- one lock serializes issuing against every reservation and every other issue
  PERFORM 1 FROM spend_gate.grants WHERE state = 'open' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM spend_gate.grants WHERE state = 'open') THEN RAISE EXCEPTION 'one open grant at a time: revoke the open one first'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('spend_gate.campaign'));
  SELECT coalesce(sum(spent_usd + reserved_usd + overrun_usd), 0) INTO used FROM spend_gate.grants WHERE account_id IS NOT NULL;
  IF p_ceiling_usd + used > 0.30 THEN RAISE EXCEPTION 'the campaign''s cumulative ceiling (0.30 USD) would be passed: % already used or held', used; END IF;
  INSERT INTO spend_gate.grants (id, ceiling_usd, per_op_max_usd, per_mission_max_usd, kinds, opens_at, closes_at, issued_by, reason, account_id, max_missions)
  VALUES (p_id, p_ceiling_usd, p_per_op_max_usd, p_per_mission_max_usd, p_kinds, p_opens_at, p_closes_at, p_issued_by, p_reason, p_account, p_max_missions);
  INSERT INTO spend_gate.events (grant_id, kind, actor, detail) VALUES (p_id, 'issued_campaign', session_user, jsonb_build_object('account', p_account, 'ceiling_usd', p_ceiling_usd,
    'per_op_max_usd', p_per_op_max_usd, 'per_mission_max_usd', p_per_mission_max_usd, 'kinds', p_kinds, 'opens_at', p_opens_at, 'closes_at', p_closes_at, 'max_missions', p_max_missions,
    'campaign_used_before_usd', used, 'issued_by', p_issued_by, 'reason', p_reason));
  RETURN jsonb_build_object('ok', true, 'grant_id', p_id, 'campaign_used_before_usd', used);
END $$;

RESET ROLE;

-- The general issue_grant of 001 stays available to the owner, but it can never create an account-bound grant, and a general grant cannot be issued while a campaign grant is open
-- (the unique open-grant index already guarantees one open grant at a time).

-- ENROLLMENT. service_role may call it; the database reads the mission's owner itself.
CREATE FUNCTION public.spend_enroll_mission(p_mission_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, spend_gate, pg_temp AS $$
DECLARE g spend_gate.grants%ROWTYPE; owner uuid; n integer; last_state text;
BEGIN
  IF p_mission_id IS NULL OR length(p_mission_id) NOT BETWEEN 1 AND 100 THEN RETURN jsonb_build_object('ok', false, 'reason', 'bad_input'); END IF;
  SELECT * INTO g FROM spend_gate.grants WHERE state = 'open' FOR UPDATE;
  IF g.id IS NULL THEN
    SELECT state INTO last_state FROM spend_gate.grants ORDER BY issued_at DESC LIMIT 1;
    RETURN jsonb_build_object('ok', false, 'reason', CASE last_state WHEN 'tripped' THEN 'grant_tripped' WHEN 'revoked' THEN 'grant_revoked' ELSE 'no_grant' END);
  END IF;
  IF now() < g.opens_at THEN RETURN jsonb_build_object('ok', false, 'reason', 'grant_not_open'); END IF;
  IF now() >= g.closes_at THEN RETURN jsonb_build_object('ok', false, 'reason', 'grant_expired'); END IF;
  IF g.account_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_a_campaign_grant'); END IF;
  IF EXISTS (SELECT 1 FROM spend_gate.enrollments WHERE grant_id = g.id AND mission_id = p_mission_id) THEN
    RETURN jsonb_build_object('ok', true, 'grant_id', g.id, 'replay', true);
  END IF;
  owner := spend_gate.mission_owner(p_mission_id);
  IF owner IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_mission'); END IF;
  IF owner <> g.account_id THEN RETURN jsonb_build_object('ok', false, 'reason', 'wrong_account'); END IF;
  SELECT count(*) INTO n FROM spend_gate.enrollments WHERE grant_id = g.id;
  IF n >= g.max_missions THEN RETURN jsonb_build_object('ok', false, 'reason', 'campaign_full'); END IF;
  INSERT INTO spend_gate.enrollments (grant_id, mission_id) VALUES (g.id, p_mission_id);
  INSERT INTO spend_gate.events (grant_id, kind, detail) VALUES (g.id, 'enrolled', jsonb_build_object('mission', p_mission_id));
  RETURN jsonb_build_object('ok', true, 'grant_id', g.id, 'replay', false);
END $$;

-- RESERVE, replaced: identical to 001 except the campaign check (a campaign grant serves enrolled missions only; a call with no mission has no claim on it).
CREATE OR REPLACE FUNCTION public.spend_reserve(p_key text, p_kind text, p_op text, p_bound_usd numeric, p_mission_id text, p_ttl_seconds integer) RETURNS jsonb
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
  b := ceil(p_bound_usd * 1000000) / 1000000;
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
  IF g.account_id IS NOT NULL AND (p_mission_id IS NULL OR NOT EXISTS (SELECT 1 FROM spend_gate.enrollments WHERE grant_id = g.id AND mission_id = p_mission_id)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'mission_not_enrolled');
  END IF;
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

-- STATUS, replaced: the same fields plus the campaign's own (account, enrolled missions, what the whole campaign has used).
CREATE OR REPLACE FUNCTION public.spend_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, spend_gate, pg_temp AS $$
  SELECT coalesce((SELECT jsonb_build_object('grant_id', id, 'state', state, 'kinds', kinds, 'ceiling_usd', ceiling_usd, 'reserved_usd', reserved_usd, 'spent_usd', spent_usd,
                                             'overrun_usd', overrun_usd, 'per_op_max_usd', per_op_max_usd, 'per_mission_max_usd', per_mission_max_usd, 'opens_at', opens_at, 'closes_at', closes_at,
                                             'campaign', account_id IS NOT NULL, 'account_id', account_id, 'max_missions', max_missions,
                                             'enrolled', (SELECT count(*) FROM spend_gate.enrollments e WHERE e.grant_id = grants.id),
                                             'campaign_used_usd', (SELECT coalesce(sum(spent_usd + reserved_usd + overrun_usd), 0) FROM spend_gate.grants WHERE account_id IS NOT NULL))
                   FROM spend_gate.grants ORDER BY (state = 'open') DESC, issued_at DESC LIMIT 1), jsonb_build_object('grant_id', null));
$$;

-- Ownership and privileges of the one new public function (CREATE OR REPLACE kept the owner and the grants of spend_reserve and spend_status)
GRANT CREATE ON SCHEMA public TO spend_gate_owner;
ALTER FUNCTION public.spend_enroll_mission(text) OWNER TO spend_gate_owner;
REVOKE CREATE ON SCHEMA public FROM spend_gate_owner;
REVOKE ALL ON FUNCTION public.spend_enroll_mission(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.spend_enroll_mission(text) TO service_role;

REVOKE ALL ON ALL TABLES IN SCHEMA spend_gate FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA spend_gate FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION spend_gate.issue_grant(text, numeric, numeric, numeric, text[], timestamptz, timestamptz, text, text) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION spend_gate.revoke_grant(text, text) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION spend_gate.expire_stale_open() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION spend_gate.issue_campaign_grant(text, uuid, numeric, numeric, numeric, text[], timestamptz, timestamptz, integer, text, text) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION spend_gate.mission_owner(text) TO spend_gate_owner;

COMMIT;
