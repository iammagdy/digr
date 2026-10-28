-- NOT APPLIED. Owner applies by hand, after 01_agent_tables.sql.
-- agent_claim_mission: takes the next mission for a worker, atomically, so two workers (or two slots of one) never take the same one.
-- A mission is claimable when it waits to be PLANNED (`queued`) or EXECUTED (`approved`) with no live lease, or when its worker died (`planning` / `executing` with a lease that ran out).
-- It changes ONLY the missions table. It touches no money table and calls no money function.
CREATE OR REPLACE FUNCTION public.agent_claim_mission(p_worker_id text, p_lease_seconds integer DEFAULT 120)
RETURNS SETOF public.missions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id text;
  v_status text;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 10 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease must be 10 to 3600 seconds';
  END IF;

  SELECT m.id, m.status INTO v_id, v_status
  FROM public.missions m
  WHERE (m.status IN ('queued', 'approved') AND (m.lease_until IS NULL OR m.lease_until < now()))
     OR (m.status IN ('planning', 'executing') AND m.lease_until < now())
  ORDER BY m.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.missions m
  SET status = CASE WHEN v_status IN ('queued', 'planning') THEN 'planning' ELSE 'executing' END,
      worker_id = p_worker_id,
      lease_until = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  WHERE m.id = v_id
  RETURNING m.*;
END;
$$;

REVOKE ALL ON FUNCTION public.agent_claim_mission(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_claim_mission(text, integer) TO service_role;
