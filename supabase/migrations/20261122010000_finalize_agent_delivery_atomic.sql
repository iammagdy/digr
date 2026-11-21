-- Ordinary agent missions only. The existing quote, chunk, settle and release
-- functions remain the money writers. Keep receipts on rollback.
BEGIN;

CREATE TABLE public.agent_delivery_attempts (
  job_id text PRIMARY KEY REFERENCES public.jobs(id),
  mission_id text NOT NULL UNIQUE REFERENCES public.missions(id),
  started_at timestamptz NOT NULL,
  next_at timestamptz NOT NULL,
  phase text NOT NULL DEFAULT 'verifying' CHECK (phase IN ('verifying', 'release_only')),
  verify_count integer NOT NULL DEFAULT 0 CHECK (verify_count BETWEEN 0 AND 4),
  release_count integer NOT NULL DEFAULT 0 CHECK (release_count BETWEEN 0 AND 2),
  trial_id uuid,
  trial_worker text,
  trial_mode text CHECK (trial_mode IN ('verify', 'release_unsettled')),
  last_attempt_at timestamptz,
  last_error text,
  candidate jsonb,
  delivery jsonb,
  trial_verified boolean NOT NULL DEFAULT false
);

CREATE TABLE public.agent_delivery_receipts (
  job_id text PRIMARY KEY REFERENCES public.jobs(id),
  mission_id text NOT NULL UNIQUE REFERENCES public.missions(id),
  user_id uuid NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('settled', 'released')),
  snapshot_sha text,
  xlsx_sha text,
  csv_sha text,
  xlsx_path text,
  csv_path text,
  physical_units integer NOT NULL CHECK (physical_units >= 0),
  billable_units integer NOT NULL CHECK (billable_units BETWEEN 0 AND physical_units),
  charged_credits numeric NOT NULL CHECK (charged_credits >= 0),
  refunded_credits numeric NOT NULL CHECK (refunded_credits >= 0),
  binding jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_delivery_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_delivery_attempts, public.agent_delivery_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.agent_delivery_receipts TO service_role;

-- The wrappers must acquire locks in this order and derive all money inputs
-- from the original accepted quote, never from the worker's workbook payload.
CREATE FUNCTION public.agent_delivery_lock(p_mission_id text, p_worker_id text)
RETURNS TABLE (mission public.missions, job public.jobs, quote_item jsonb)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_quote public.plans_quotes%ROWTYPE;
BEGIN
  SELECT m.* INTO mission FROM public.missions AS m WHERE m.id = p_mission_id FOR UPDATE;
  IF NOT FOUND OR mission.status IS DISTINCT FROM 'executing' OR mission.approved_at IS NULL
     OR mission.plan IS NULL OR p_worker_id IS NULL OR btrim(p_worker_id) = ''
     OR mission.worker_id IS DISTINCT FROM p_worker_id OR mission.lease_until IS NULL
     OR mission.lease_until <= clock_timestamp() THEN
    RETURN;
  END IF;
  SELECT j.* INTO job FROM public.jobs AS j WHERE j.id = mission.job_id FOR UPDATE;
  IF NOT FOUND OR job.user_id IS DISTINCT FROM mission.user_id
     OR job.endpoint_id IS DISTINCT FROM 'agent-mission'
     OR mission.quote_id IS NULL OR job.id IS DISTINCT FROM 'job_quote_' || md5(mission.quote_id)
     OR job.reserved_credits IS NULL OR job.reserved_credits <= 0
     OR mission.reserved_points IS DISTINCT FROM job.reserved_credits
     OR job.unit_price IS NULL OR job.unit_price <= 0
     OR mission.unit_price_points IS DISTINCT FROM job.unit_price
     OR mission.lease_until <= clock_timestamp() THEN
    RETURN;
  END IF;
  SELECT * INTO v_quote FROM public.plans_quotes WHERE id = mission.quote_id FOR SHARE;
  IF NOT FOUND OR v_quote.user_id IS DISTINCT FROM mission.user_id OR v_quote.status IS DISTINCT FROM 'accepted'
     OR v_quote.total_reserved_credits IS DISTINCT FROM job.reserved_credits THEN
    RETURN;
  END IF;
  quote_item := CASE jsonb_typeof(v_quote.items)
    WHEN 'array' THEN v_quote.items -> 0
    WHEN 'object' THEN v_quote.items -> 'items' -> 0
    ELSE NULL END;
  IF quote_item ->> 'missionId' IS DISTINCT FROM mission.id
     OR COALESCE(quote_item ->> 'endpointId', quote_item ->> 'capabilitySlug') IS DISTINCT FROM job.endpoint_id
     OR (quote_item -> 'unitPricePoints') IS DISTINCT FROM to_jsonb(job.unit_price)
     OR (quote_item -> 'targetVolumeMax') IS DISTINCT FROM to_jsonb(job.target_volume_max)
     OR mission.lease_until <= clock_timestamp() THEN
    RETURN;
  END IF;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION public.agent_delivery_receipt_json(p_receipt public.agent_delivery_receipts)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(p_receipt.binding, '{}'::jsonb) || jsonb_build_object(
    'job_id', p_receipt.job_id, 'mission_id', p_receipt.mission_id,
    'kind', p_receipt.disposition, 'snapshot_sha', p_receipt.snapshot_sha,
    'xlsx_sha', p_receipt.xlsx_sha, 'csv_sha', p_receipt.csv_sha,
    'xlsx_path', p_receipt.xlsx_path, 'csv_path', p_receipt.csv_path,
    'physical_units', p_receipt.physical_units, 'billable_units', p_receipt.billable_units,
    'charged_credits', p_receipt.charged_credits, 'refunded_credits', p_receipt.refunded_credits
  );
$$;

CREATE FUNCTION public.claim_agent_delivery_attempt_atomic(
  p_mission_id text, p_worker_id text, p_operation text, p_trial_id uuid, p_binding jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ctx record;
  a public.agent_delivery_attempts%ROWTYPE;
  r public.agent_delivery_receipts%ROWTYPE;
  v_now timestamptz;
  v_began boolean := false;
  v_legacy boolean;
  v_interval integer;
  v_verify_schedule integer[] := ARRAY[0, 15, 60, 150, 165];
  v_release_schedule integer[] := ARRAY[165, 225];
BEGIN
  SELECT * INTO ctx FROM public.agent_delivery_lock(p_mission_id, p_worker_id);
  IF NOT FOUND THEN RETURN jsonb_build_object('kind', 'error', 'error', 'unowned_or_unlinked'); END IF;
  SELECT * INTO r FROM public.agent_delivery_receipts WHERE job_id = (ctx.job).id;
  IF FOUND THEN RETURN jsonb_build_object('kind','receipt','receipt',public.agent_delivery_receipt_json(r)); END IF;
  IF EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = 'chg_' || (ctx.job).id)
     OR (ctx.job).status = 'completed' THEN
    RETURN jsonb_build_object('kind','error','error','unbound_money');
  END IF;

  v_now := clock_timestamp();
  v_legacy := (ctx.job).status IS DISTINCT FROM 'running' OR (ctx.job).step IS DISTINCT FROM 0;
  SELECT * INTO a FROM public.agent_delivery_attempts WHERE job_id = (ctx.job).id;
  IF p_operation = 'status' THEN
    IF a.job_id IS NOT NULL THEN RETURN jsonb_build_object('kind','progress','progress',to_jsonb(a)); END IF;
    RETURN jsonb_build_object('kind',CASE WHEN v_legacy THEN 'legacy_mismatch' ELSE 'not_started' END);
  END IF;
  IF p_operation = 'begin' THEN
    IF a.job_id IS NULL THEN
      INSERT INTO public.agent_delivery_attempts (job_id,mission_id,started_at,next_at,phase)
      VALUES ((ctx.job).id,p_mission_id,v_now,v_now,CASE WHEN v_legacy THEN 'release_only' ELSE 'verifying' END)
      RETURNING * INTO a;
      v_began := true;
    END IF;
    RETURN jsonb_build_object('kind','progress','progress',to_jsonb(a),'began',v_began AND NOT v_legacy);
  END IF;
  IF a.job_id IS NULL OR a.mission_id IS DISTINCT FROM p_mission_id THEN
    RETURN jsonb_build_object('kind','error','error','missing_journal');
  END IF;

  IF p_operation = 'park' THEN
    IF a.next_at IS NULL OR (a.phase = 'release_only' AND a.release_count = 2) THEN
      RETURN jsonb_build_object('kind','exhausted','progress',to_jsonb(a));
    END IF;
    -- The mission row remains locked, so a late worker cannot park a successor.
    UPDATE public.missions m SET status = 'approved', worker_id = NULL, lease_until = a.next_at, updated_at = v_now
    WHERE m.id = p_mission_id AND m.worker_id = p_worker_id;
    RETURN jsonb_build_object('kind','parked','next_at',a.next_at);
  END IF;

  IF p_operation = 'claim' THEN
    IF p_trial_id IS NULL THEN RETURN jsonb_build_object('kind','error','error','missing_trial'); END IF;
    IF a.trial_id = p_trial_id THEN
      IF a.trial_worker IS DISTINCT FROM p_worker_id
         OR (a.phase = 'release_only' AND a.trial_mode IS DISTINCT FROM 'release_unsettled') THEN
        RETURN jsonb_build_object('kind','error','error','expired_trial');
      END IF;
      RETURN jsonb_build_object('kind','attempt','mode',a.trial_mode,'trial_id',a.trial_id,'next_at',a.next_at,'progress',to_jsonb(a));
    END IF;
    IF a.phase = 'release_only' AND a.release_count = 2 THEN
      RETURN jsonb_build_object('kind','exhausted','progress',to_jsonb(a));
    END IF;
    IF v_now < a.next_at THEN RETURN jsonb_build_object('kind','wait','next_at',a.next_at,'progress',to_jsonb(a)); END IF;
    IF a.phase = 'release_only' OR a.verify_count = 4 OR v_legacy THEN
      UPDATE public.agent_delivery_attempts SET phase = 'release_only', release_count = a.release_count + 1,
        trial_id = p_trial_id, trial_worker = p_worker_id, trial_mode = 'release_unsettled',
        trial_verified = false, last_error = NULL, last_attempt_at = v_now,
        next_at = greatest(a.started_at + make_interval(secs => v_release_schedule[2]), v_now + interval '15 seconds')
      WHERE job_id = a.job_id RETURNING * INTO a;
    ELSE
      v_interval := v_verify_schedule[a.verify_count + 2];
      UPDATE public.agent_delivery_attempts SET verify_count = a.verify_count + 1,
        trial_id = p_trial_id, trial_worker = p_worker_id, trial_mode = 'verify',
        trial_verified = false, last_error = NULL, last_attempt_at = v_now,
        next_at = greatest(a.started_at + make_interval(secs => v_interval), v_now + interval '15 seconds')
      WHERE job_id = a.job_id RETURNING * INTO a;
    END IF;
    RETURN jsonb_build_object('kind','attempt','mode',a.trial_mode,'trial_id',a.trial_id,'next_at',a.next_at,'progress',to_jsonb(a));
  END IF;

  IF a.phase <> 'verifying' OR a.trial_mode IS DISTINCT FROM 'verify' OR p_trial_id IS NULL
     OR a.trial_id IS DISTINCT FROM p_trial_id OR a.trial_worker IS DISTINCT FROM p_worker_id THEN
    RETURN jsonb_build_object('kind','error','error','expired_trial');
  END IF;
  IF jsonb_typeof(p_binding) IS DISTINCT FROM 'object' OR octet_length(p_binding::text) > 2097152 THEN
    RETURN jsonb_build_object('kind','error','error','invalid_binding');
  END IF;

  CASE p_operation
    WHEN 'bind_candidate' THEN
      IF (a.candidate IS NOT NULL AND a.candidate IS DISTINCT FROM p_binding)
         OR (p_binding -> 'empty' IS DISTINCT FROM 'true'::jsonb AND NOT COALESCE(
           p_binding ->> 'path' ~ '^settlement/candidate-[a-z0-9-]+\.xlsx$'
           AND p_binding ->> 'xlsx_sha' ~ '^[0-9a-f]{64}$', false)) THEN
        RETURN jsonb_build_object('kind','error','error','candidate_conflict');
      END IF;
      UPDATE public.agent_delivery_attempts SET candidate = p_binding WHERE job_id = a.job_id;
    WHEN 'bind_snapshot' THEN
      IF a.candidate IS NULL OR a.last_error IS NOT NULL
         OR NOT COALESCE(p_binding ->> 'snapshot_sha' ~ '^[0-9a-f]{64}$', false)
         OR p_binding ->> 'job_id' IS DISTINCT FROM a.job_id
         OR p_binding ->> 'xlsx_sha' IS DISTINCT FROM a.candidate ->> 'xlsx_sha'
         OR (a.delivery IS NOT NULL AND a.delivery IS DISTINCT FROM p_binding) THEN
        RETURN jsonb_build_object('kind','error','error','snapshot_conflict');
      END IF;
      UPDATE public.agent_delivery_attempts SET delivery = p_binding, trial_verified = true WHERE job_id = a.job_id;
    WHEN 'unreadable' THEN
      IF NOT COALESCE(p_binding ->> 'code' IN ('candidate_missing','storage_unavailable','manifest_invalid','binding_mismatch'), false) THEN
        RETURN jsonb_build_object('kind','error','error','invalid_fault');
      END IF;
      UPDATE public.agent_delivery_attempts SET last_error = p_binding ->> 'code', trial_verified = false,
        phase = CASE WHEN p_binding ->> 'code' = 'binding_mismatch' THEN 'release_only' ELSE phase END,
        next_at = CASE WHEN p_binding ->> 'code' = 'binding_mismatch' THEN v_now
                       ELSE greatest(next_at, v_now + interval '15 seconds') END
      WHERE job_id = a.job_id RETURNING * INTO a;
      RETURN jsonb_build_object('kind','recorded','next_at',a.next_at);
    ELSE RETURN jsonb_build_object('kind','error','error','invalid_operation');
  END CASE;
  RETURN jsonb_build_object('kind','bound');
END;
$$;

CREATE FUNCTION public.finalize_agent_delivery_atomic(
  p_mission_id text, p_worker_id text, p_delivery jsonb, p_mode text, p_trial_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ctx record;
  a public.agent_delivery_attempts%ROWTYPE;
  r public.agent_delivery_receipts%ROWTYPE;
  v_job_id text;
  v_result jsonb;
  v_count int := 0;
  v_billed int := 0;
  v_cap constant numeric := 25000;
  v_charge numeric := 0;
  v_expected numeric := 0;
  v_disposition text := 'released';
  v_prefix text;
  v_csv_path text;
  v_xlsx_path text;
  v_stage jsonb;
  v_price jsonb;
  v_release_reason text := 'تعذّر حفظ ملفات النتيجة، فعاد الحجز المؤقت كاملًا.';
BEGIN
  SELECT * INTO ctx FROM public.agent_delivery_lock(p_mission_id, p_worker_id);
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','unowned_or_unlinked'); END IF;
  v_job_id := (ctx.job).id;
  SELECT * INTO r FROM public.agent_delivery_receipts WHERE job_id = v_job_id;
  IF FOUND THEN
    IF (p_mode = 'deliver' AND p_delivery IS NOT DISTINCT FROM r.binding AND r.binding IS NOT NULL)
       OR (p_mode = 'release_unsettled' AND p_delivery IS NULL) THEN
      RETURN jsonb_build_object('success',true,'kind',r.disposition,'charged_credits',r.charged_credits,
        'refunded_credits',r.refunded_credits,'replayed',true,'receipt',public.agent_delivery_receipt_json(r));
    END IF;
    RETURN jsonb_build_object('success',false,'error','receipt_conflict');
  END IF;

  SELECT * INTO a FROM public.agent_delivery_attempts WHERE job_id = v_job_id;
  IF NOT FOUND OR a.mission_id IS DISTINCT FROM p_mission_id OR p_trial_id IS NULL
     OR a.trial_id IS DISTINCT FROM p_trial_id OR a.trial_worker IS DISTINCT FROM p_worker_id THEN
    RETURN jsonb_build_object('success',false,'error','expired_trial');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = 'res_' || v_job_id AND job_id = v_job_id
                 AND user_id = (ctx.job).user_id AND type = 'reserve' AND delta = -(ctx.job).reserved_credits)
     OR EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = 'chg_' || v_job_id)
     OR (ctx.job).status = 'completed' THEN
    RETURN jsonb_build_object('success',false,'error','unbound_money');
  END IF;

  IF p_mode = 'release_unsettled' THEN
    IF p_delivery IS NOT NULL OR a.phase <> 'release_only' OR a.trial_mode IS DISTINCT FROM 'release_unsettled' THEN
      RETURN jsonb_build_object('success',false,'error','not_release_trial');
    END IF;
  ELSIF p_mode = 'deliver' THEN
    IF a.phase <> 'verifying' OR a.trial_mode IS DISTINCT FROM 'verify' OR NOT a.trial_verified
       OR a.delivery IS NULL OR a.delivery IS DISTINCT FROM p_delivery
       OR (ctx.job).status IS DISTINCT FROM 'running' OR (ctx.job).step IS DISTINCT FROM 0
       OR EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = 'rel_' || v_job_id) THEN
      RETURN jsonb_build_object('success',false,'error','delivery_binding_mismatch');
    END IF;
    IF NOT COALESCE(p_delivery -> 'version' = '1'::jsonb
      AND p_delivery ->> 'physical_units' ~ '^[0-9]{1,5}$' AND p_delivery ->> 'billable_units' ~ '^[0-9]{1,5}$'
      AND p_delivery ->> 'cost_usd' ~ '^[0-9]{1,9}(\.[0-9]{1,6})?$'
      AND jsonb_typeof(p_delivery -> 'counts') = 'object', false) THEN
      RETURN jsonb_build_object('success',false,'error','invalid_delivery');
    END IF;
    v_count := (p_delivery ->> 'physical_units')::integer;
    v_billed := (p_delivery ->> 'billable_units')::integer;
    IF v_billed > v_count OR v_count > (ctx.job).target_volume_max
       OR EXISTS (SELECT 1 FROM jsonb_each_text(p_delivery -> 'counts') WHERE value !~ '^[0-9]{1,5}$' OR value IS NULL) THEN
      RETURN jsonb_build_object('success',false,'error','invalid_counts');
    END IF;
    IF v_count <> COALESCE((SELECT sum(value::integer) FROM jsonb_each_text(p_delivery -> 'counts')),0) THEN
      RETURN jsonb_build_object('success',false,'error','invalid_counts');
    END IF;
    IF v_count = 0 THEN
      IF a.candidate -> 'empty' IS DISTINCT FROM 'true'::jsonb OR p_delivery ->> 'xlsx_sha' IS NOT NULL
         OR p_delivery ->> 'csv_sha' IS NOT NULL OR p_delivery ->> 'xlsx_path' IS NOT NULL
         OR p_delivery ->> 'csv_path' IS NOT NULL THEN
        RETURN jsonb_build_object('success',false,'error','invalid_empty_output');
      END IF;
    ELSE
      IF NOT COALESCE(p_delivery ->> 'xlsx_sha' ~ '^[0-9a-f]{64}$' AND p_delivery ->> 'csv_sha' ~ '^[0-9a-f]{64}$', false) THEN
        RETURN jsonb_build_object('success',false,'error','invalid_output_hash');
      END IF;
      v_prefix := (ctx.job).user_id::text || '/' || v_job_id || '/sealed/' || (p_delivery ->> 'xlsx_sha');
      v_xlsx_path := v_prefix || '/result.xlsx';
      v_csv_path := v_prefix || '/result.csv';
      IF p_delivery ->> 'xlsx_path' IS DISTINCT FROM v_xlsx_path OR p_delivery ->> 'csv_path' IS DISTINCT FROM v_csv_path THEN
        RETURN jsonb_build_object('success',false,'error','invalid_output_path');
      END IF;
    END IF;
    v_release_reason := COALESCE(p_delivery ->> 'release_reason', 'لم يُسلَّم شيء من هذه المهمة، فعاد الحجز المؤقت كاملًا.');

    v_stage := NULLIF(p_delivery -> 'stage_units','null'::jsonb);
    v_price := ctx.quote_item -> 'stageUnitsPoints';
    IF v_price IS NOT NULL AND v_billed > 0 THEN
      IF NOT COALESCE(v_stage ->> 'base' ~ '^[0-9]{1,5}$' AND v_stage ->> 'estimated' ~ '^[0-9]{1,5}$', false) THEN
        RETURN jsonb_build_object('success',false,'error','invalid_stage_counts');
      END IF;
      IF (v_stage ->> 'base')::integer + (v_stage ->> 'estimated')::integer <> v_billed THEN
        RETURN jsonb_build_object('success',false,'error','invalid_stage_counts');
      END IF;
      v_expected := ceil((v_stage ->> 'base')::numeric * (v_price ->> 'base')::numeric
        + (v_stage ->> 'estimated')::numeric * (v_price ->> 'estimated')::numeric);
    ELSE
      IF v_price IS NULL AND v_stage IS NOT NULL THEN
        RETURN jsonb_build_object('success',false,'error','unexpected_stage_counts');
      END IF;
      v_expected := ceil(v_billed * (ctx.job).unit_price);
    END IF;
    v_expected := least(v_expected, ceil(v_billed * (ctx.job).unit_price), (ctx.job).reserved_credits, v_cap);
    v_result := public.complete_chunk(v_job_id,0,'completed',v_billed,(p_delivery ->> 'cost_usd')::numeric);
    IF v_result -> 'success' IS DISTINCT FROM 'true'::jsonb OR v_result -> 'already_completed' IS DISTINCT FROM 'false'::jsonb
       OR v_result ->> 'job_id' IS DISTINCT FROM v_job_id OR v_result -> 'delivered_units' IS DISTINCT FROM to_jsonb(v_billed) THEN
      RAISE EXCEPTION 'Unconfirmed delivery completion';
    END IF;
  ELSE
    RETURN jsonb_build_object('success',false,'error','invalid_mode');
  END IF;

  IF v_billed > 0 THEN
    v_disposition := 'settled';
    IF v_stage IS NOT NULL THEN
      v_result := public.settle_job_by_stage_atomic(v_job_id,v_stage,v_cap,v_csv_path);
    ELSE
      v_result := public.settle_job_atomic(v_job_id,v_cap,v_csv_path);
    END IF;
    IF v_result -> 'success' IS DISTINCT FROM 'true'::jsonb OR v_result -> 'already_settled' IS DISTINCT FROM 'false'::jsonb
       OR v_result ->> 'job_id' IS DISTINCT FROM v_job_id OR v_result -> 'charged_credits' IS DISTINCT FROM to_jsonb(v_expected) THEN
      RAISE EXCEPTION 'Unconfirmed delivery settlement';
    END IF;
    v_charge := v_expected;
  ELSE
    v_result := public.release_job_atomic(v_job_id,v_release_reason,true);
    IF v_result -> 'success' IS DISTINCT FROM 'true'::jsonb OR v_result ->> 'job_id' IS DISTINCT FROM v_job_id
       OR v_result -> 'released_credits' IS DISTINCT FROM to_jsonb((ctx.job).reserved_credits) THEN
      RAISE EXCEPTION 'Unconfirmed delivery release';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = 'rel_' || v_job_id AND job_id = v_job_id
                 AND user_id = (ctx.job).user_id AND type = 'release' AND delta = (ctx.job).reserved_credits)
     OR (v_charge = 0 AND EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = 'chg_' || v_job_id))
     OR (v_charge > 0 AND NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = 'chg_' || v_job_id
       AND job_id = v_job_id AND user_id = (ctx.job).user_id AND type = 'charge' AND delta = -v_charge)) THEN
    RAISE EXCEPTION 'Delivery ledger verification failed';
  END IF;
  INSERT INTO public.agent_delivery_receipts (
    job_id, mission_id, user_id, disposition, snapshot_sha, xlsx_sha, csv_sha, xlsx_path, csv_path,
    physical_units, billable_units, charged_credits, refunded_credits, binding
  ) VALUES (
    v_job_id,p_mission_id,(ctx.job).user_id,v_disposition,p_delivery ->> 'snapshot_sha',p_delivery ->> 'xlsx_sha',
    p_delivery ->> 'csv_sha',v_xlsx_path,v_csv_path,v_count,v_billed,v_charge,(ctx.job).reserved_credits-v_charge,p_delivery
  ) RETURNING * INTO r;
  RETURN jsonb_build_object('success',true,'kind',r.disposition,'charged_credits',r.charged_credits,
    'refunded_credits',r.refunded_credits,'replayed',false,'receipt',public.agent_delivery_receipt_json(r));
END;
$$;

REVOKE ALL ON FUNCTION public.agent_delivery_lock(text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_delivery_receipt_json(public.agent_delivery_receipts) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_agent_delivery_attempt_atomic(text,text,text,uuid,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_agent_delivery_atomic(text,text,jsonb,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_agent_delivery_attempt_atomic(text,text,text,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_agent_delivery_atomic(text,text,jsonb,text,uuid) TO service_role;
COMMIT;
