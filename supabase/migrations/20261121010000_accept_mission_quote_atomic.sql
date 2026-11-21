BEGIN;

CREATE OR REPLACE FUNCTION public.accept_mission_quote_atomic(
  p_mission_id text,
  p_user_id uuid,
  p_actor_id uuid,
  p_expected_plan jsonb,
  p_expected_updated_at timestamptz,
  p_quote_id text,
  p_quote_hash text,
  p_items jsonb,
  p_total_points numeric,
  p_output_formats text[],
  p_expires_at timestamptz,
  p_lease_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  mission public.missions%ROWTYPE;
  created jsonb;
  accepted jsonb;
  claimed jsonb;
  refusal text;
  job text;
  reserve numeric;
  unit_price numeric;
  linked integer;
BEGIN
  SELECT * INTO mission
  FROM public.missions
  WHERE id = p_mission_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_plan_ready');
  END IF;
  IF mission.status IN ('approved', 'executing') AND mission.job_id IS NOT NULL AND mission.quote_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_approved');
  END IF;
  IF mission.status <> 'plan_ready' OR mission.job_id IS NOT NULL OR mission.quote_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_plan_ready');
  END IF;
  IF p_expected_plan IS NULL OR p_expected_updated_at IS NULL
     OR mission.plan IS DISTINCT FROM p_expected_plan
     OR mission.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN jsonb_build_object('success', false, 'error', 'stale_plan');
  END IF;

  IF mission.plan ? 'addon' OR p_actor_id IS NULL OR p_lease_seconds IS DISTINCT FROM 21600
     OR p_quote_id IS NULL OR p_quote_id !~ '^quote_[0-9a-f]{24}$'
     OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_failed');
  END IF;
  IF jsonb_array_length(p_items) <> 1
     OR p_items -> 0 ->> 'missionId' IS DISTINCT FROM p_mission_id
     OR p_items -> 0 ->> 'endpointId' IS DISTINCT FROM 'agent-mission'
     OR p_items -> 0 ->> 'capabilitySlug' IS DISTINCT FROM 'agent-mission' THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_failed');
  END IF;

  -- Legacy accept could commit before attaching the mission. Leave that hold for reconciliation.
  IF EXISTS (
    SELECT 1 FROM public.plans_quotes
    WHERE user_id = p_user_id AND status = 'accepted'
      AND items @> jsonb_build_array(jsonb_build_object(
        'missionId', p_mission_id, 'endpointId', 'agent-mission', 'capabilitySlug', 'agent-mission'))
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'approval_pending');
  END IF;

  unit_price := (p_items -> 0 ->> 'unitPricePoints')::numeric;
  BEGIN
    created := public.create_quote_atomic(
      p_user_id, p_quote_id, p_quote_hash, p_items, p_total_points,
      p_output_formats, p_expires_at, ARRAY[]::text[]);
    IF created ->> 'success' IS DISTINCT FROM 'true' OR created ->> 'already_created' = 'true' THEN
      refusal := 'quote_failed';
      RAISE SQLSTATE 'P7130';
    END IF;

    accepted := public.accept_quote_atomic(p_quote_id, p_user_id, p_quote_hash);
    IF accepted ->> 'success' IS DISTINCT FROM 'true' THEN
      refusal := CASE accepted ->> 'error'
        WHEN 'insufficient_balance' THEN 'insufficient_balance'
        WHEN 'concurrency_limit' THEN 'concurrency_limit'
        WHEN 'quote_expired' THEN 'quote_expired'
        ELSE 'accept_failed' END;
      RAISE SQLSTATE 'P7130';
    END IF;

    job := accepted ->> 'job_id';
    reserve := (accepted ->> 'reserved_credits')::numeric;
    IF job IS NULL OR accepted ->> 'quote_id' IS DISTINCT FROM p_quote_id
       OR reserve IS DISTINCT FROM p_total_points THEN
      RAISE EXCEPTION 'Invalid mission quote acceptance';
    END IF;
    claimed := public.claim_job_chunk(job, 0, p_lease_seconds);
    IF claimed ->> 'claimed' IS DISTINCT FROM 'true' THEN
      refusal := 'claim_failed';
      RAISE SQLSTATE 'P7130';
    END IF;

    UPDATE public.missions
    SET approved_at = now(), approved_by = p_actor_id, status = 'approved',
        worker_id = NULL, lease_until = NULL, job_id = job, quote_id = p_quote_id,
        reserved_points = reserve, unit_price_points = unit_price, error = NULL, updated_at = now()
    WHERE id = p_mission_id AND user_id = p_user_id AND status = 'plan_ready';
    GET DIAGNOSTICS linked = ROW_COUNT;
    IF linked <> 1 THEN
      RAISE EXCEPTION 'Mission approval did not attach exactly one job';
    END IF;
  EXCEPTION WHEN SQLSTATE 'P7130' THEN
    -- Leaving the subtransaction by exception rolled back every money and job write.
    RETURN jsonb_build_object('success', false, 'error', refusal);
  END;

  RETURN jsonb_build_object('success', true, 'job_id', job, 'quote_id', p_quote_id,
    'reserved_credits', reserve);
END;
$function$;

REVOKE ALL ON FUNCTION public.accept_mission_quote_atomic(
  text, uuid, uuid, jsonb, timestamptz, text, text, jsonb, numeric, text[], timestamptz, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_mission_quote_atomic(
  text, uuid, uuid, jsonb, timestamptz, text, text, jsonb, numeric, text[], timestamptz, integer
) TO service_role;

COMMIT;
