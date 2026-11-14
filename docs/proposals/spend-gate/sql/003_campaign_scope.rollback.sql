-- SPEND SAFETY MILESTONE: rollback of 003_campaign_scope.sql. NOT APPLIED. It restores 001's spend_reserve and spend_status (copied verbatim from 001_spend_gate.sql),
-- drops the enrollment function and table, the campaign grant function, the mission-owner helper, the immutability trigger and the two columns.
-- It REFUSES to run while a campaign grant exists, because dropping the columns would turn it into a general grant that serves every mission.
-- Revoke the campaign grant first (spend_gate.revoke_grant) and keep the rows: a revoked campaign grant is refused too, until you delete it by hand as the owner.

BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'spend_gate' AND table_name = 'grants' AND column_name = 'account_id')
     AND EXISTS (SELECT 1 FROM spend_gate.grants WHERE account_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a campaign grant exists: rolling back would turn it into a general grant. Nothing changed.';
  END IF;
END $$;

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


CREATE OR REPLACE FUNCTION public.spend_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, spend_gate, pg_temp AS $$
  SELECT coalesce((SELECT jsonb_build_object('grant_id', id, 'state', state, 'kinds', kinds, 'ceiling_usd', ceiling_usd, 'reserved_usd', reserved_usd, 'spent_usd', spent_usd,
                                             'overrun_usd', overrun_usd, 'per_op_max_usd', per_op_max_usd, 'per_mission_max_usd', per_mission_max_usd, 'opens_at', opens_at, 'closes_at', closes_at)
                   FROM spend_gate.grants ORDER BY (state = 'open') DESC, issued_at DESC LIMIT 1), jsonb_build_object('grant_id', null));
$$;

DROP FUNCTION IF EXISTS public.spend_enroll_mission(text);
DROP FUNCTION IF EXISTS spend_gate.issue_campaign_grant(text, uuid, numeric, numeric, numeric, text[], timestamptz, timestamptz, integer, text, text);
DROP FUNCTION IF EXISTS spend_gate.mission_owner(text);
DROP TRIGGER IF EXISTS grants_immutable ON spend_gate.grants;
DROP FUNCTION IF EXISTS spend_gate.grants_immutable();
DROP TABLE IF EXISTS spend_gate.enrollments;
ALTER TABLE spend_gate.grants DROP CONSTRAINT IF EXISTS grants_campaign_terms, DROP CONSTRAINT IF EXISTS grants_campaign_pair;
ALTER TABLE spend_gate.grants DROP COLUMN IF EXISTS account_id, DROP COLUMN IF EXISTS max_missions;

COMMIT;
