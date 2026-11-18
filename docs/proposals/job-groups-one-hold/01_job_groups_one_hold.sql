-- 01_job_groups_one_hold.sql
-- Proposal: Job groups with one hold, sequential parts, and write-once frozen datasets.
-- Applied at GATE S.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Tables and Indexes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.job_groups (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  quote_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  parts_planned INT NOT NULL CHECK (parts_planned BETWEEN 2 AND 40),
  part_volumes INT[] NOT NULL,
  part_reserves NUMERIC[] NOT NULL,
  hold_credits NUMERIC NOT NULL CHECK (hold_credits > 0),
  drawn_credits NUMERIC NOT NULL DEFAULT 0,
  next_part INT NOT NULL,
  asked_original INT NOT NULL,
  reachable INT NOT NULL,
  unit_price NUMERIC NOT NULL CHECK (unit_price > 0),
  endpoint_id TEXT NOT NULL,
  first_job_id TEXT NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  close_reason TEXT,
  released_credits NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  final_delivered INT,
  final_charged NUMERIC,
  final_line TEXT,
  closing_notice_at TIMESTAMPTZ,
  halted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_job_groups_status_updated_at
  ON public.job_groups (status, updated_at);

CREATE INDEX IF NOT EXISTS idx_job_groups_status_attempt_id
  ON public.job_groups (status, last_attempt_at NULLS FIRST, id);

CREATE TABLE IF NOT EXISTS public.job_group_parts (
  group_id TEXT NOT NULL REFERENCES public.job_groups(id) ON DELETE RESTRICT,
  part_index INT NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES public.jobs(id) ON DELETE RESTRICT,
  quote_id TEXT NOT NULL UNIQUE,
  reserved_credits NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, part_index)
);

CREATE TABLE IF NOT EXISTS public.job_group_keys (
  group_id TEXT NOT NULL REFERENCES public.job_groups(id) ON DELETE RESTRICT,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 300),
  from_part INT NOT NULL,
  PRIMARY KEY (group_id, key)
);

CREATE TABLE IF NOT EXISTS public.job_group_frozen (
  group_id TEXT NOT NULL REFERENCES public.job_groups(id) ON DELETE RESTRICT,
  part_index INT NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES public.jobs(id) ON DELETE RESTRICT,
  path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  row_count INT NOT NULL CHECK (row_count > 0),
  charged_credits NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, part_index)
);

-- ---------------------------------------------------------------------------
-- 2. Append-Only Triggers & Row Level Security
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.block_job_group_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'table is append-only. UPDATE and DELETE operations are forbidden.';
END;
$$;

DROP TRIGGER IF EXISTS trg_block_job_group_parts_mutation ON public.job_group_parts;
CREATE TRIGGER trg_block_job_group_parts_mutation
  BEFORE UPDATE OR DELETE ON public.job_group_parts
  FOR EACH ROW EXECUTE FUNCTION public.block_job_group_mutation();

DROP TRIGGER IF EXISTS trg_block_job_group_keys_mutation ON public.job_group_keys;
CREATE TRIGGER trg_block_job_group_keys_mutation
  BEFORE UPDATE OR DELETE ON public.job_group_keys
  FOR EACH ROW EXECUTE FUNCTION public.block_job_group_mutation();

DROP TRIGGER IF EXISTS trg_block_job_group_frozen_mutation ON public.job_group_frozen;
CREATE TRIGGER trg_block_job_group_frozen_mutation
  BEFORE UPDATE OR DELETE ON public.job_group_frozen
  FOR EACH ROW EXECUTE FUNCTION public.block_job_group_mutation();

ALTER TABLE public.job_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_group_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_group_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_group_frozen ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.job_groups FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.job_group_parts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.job_group_keys FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.job_group_frozen FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.job_groups TO service_role;
GRANT SELECT ON public.job_group_parts TO service_role;
GRANT SELECT ON public.job_group_keys TO service_role;
GRANT SELECT ON public.job_group_frozen TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Points Formatting Helper: job_group_points_ar
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.job_group_points_ar(p NUMERIC)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p IS NULL THEN
    RETURN NULL;
  END IF;
  IF p = ROUND(p) THEN
    IF p = 1 THEN
      RETURN 'نقطة واحدة';
    ELSIF p = 2 THEN
      RETURN 'نقطتان';
    ELSIF p >= 3 AND p <= 10 THEN
      RETURN translate(p::BIGINT::TEXT, '0123456789', '٠١٢٣٤٥٦٧٨٩') || ' نقاط';
    ELSE
      RETURN translate(p::BIGINT::TEXT, '0123456789', '٠١٢٣٤٥٦٧٨٩') || ' نقطة';
    END IF;
  ELSE
    RETURN translate(p::TEXT, '0123456789.', '٠١٢٣٤٥٦٧٨٩٫') || ' نقطة';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.job_group_points_ar(NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_group_points_ar(NUMERIC) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. F1: accept_group_quote_atomic
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.accept_group_quote_atomic(
  p_quote_id TEXT,
  p_user_id UUID,
  p_expected_quote_hash TEXT,
  p_points_cap NUMERIC,
  p_start_event_ar TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_quote public.plans_quotes%ROWTYPE;
  v_group public.job_groups%ROWTYPE;
  v_res_gid public.credit_ledger%ROWTYPE;
  v_res_job1 public.credit_ledger%ROWTYPE;
  v_existing_job public.jobs%ROWTYPE;
  v_items JSONB;
  v_item JSONB;
  v_split JSONB;
  v_gid TEXT;
  v_job TEXT;
  v_unit_price NUMERIC;
  v_target_min INT;
  v_target_max INT;
  v_endpoint_id TEXT;
  v_parts_k INT;
  v_hold_credits NUMERIC;
  v_reachable INT;
  v_asked_original INT;
  v_active_jobs BIGINT;
  v_balance NUMERIC;
  v_r_1 NUMERIC;
  v_part_volumes INT[] := ARRAY[]::INT[];
  v_part_reserves NUMERIC[] := ARRAY[]::NUMERIC[];
  v_updated_rows INT;
  v_vol INT;
  v_res NUMERIC;
  v_sum_vol INT := 0;
  v_sum_res NUMERIC := 0;
  i INT;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
  -- 1 Argument checks
  IF p_quote_id IS NULL OR p_user_id IS NULL
     OR p_expected_quote_hash IS NULL
     OR p_expected_quote_hash !~ '^[0-9a-f]{64}$'
     OR p_points_cap IS NULL OR p_points_cap <= 0
     OR p_start_event_ar IS NULL OR length(p_start_event_ar) < 1 OR length(p_start_event_ar) > 2000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_required_argument');
  END IF;

  -- 2 SELECT quote FOR UPDATE
  SELECT * INTO v_quote
  FROM public.plans_quotes
  WHERE id = p_quote_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_not_found');
  END IF;
  IF v_quote.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_user_mismatch');
  END IF;
  IF v_quote.quote_hash IS DISTINCT FROM p_expected_quote_hash THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_hash_mismatch');
  END IF;

  -- 3 Deterministic IDs
  v_gid := 'grp_' || md5(p_quote_id);
  v_job := 'job_quote_' || md5(p_quote_id);

  -- 4 status 'accepted'
  IF v_quote.status = 'accepted' THEN
    SELECT * INTO v_group FROM public.job_groups WHERE id = v_gid;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'accepted_without_group');
    END IF;

    SELECT * INTO v_res_gid FROM public.credit_ledger WHERE id = 'res_' || v_gid;
    IF NOT FOUND OR v_res_gid.delta IS DISTINCT FROM (-v_group.hold_credits) THEN
      RAISE EXCEPTION 'Accepted group % missing or invalid res_%', p_quote_id, v_gid;
    END IF;

    SELECT * INTO v_res_job1 FROM public.credit_ledger WHERE id = 'res_' || v_job;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Accepted group % missing res_%', p_quote_id, v_job;
    END IF;

    SELECT * INTO v_existing_job FROM public.jobs WHERE id = v_job;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Accepted group % missing job %', p_quote_id, v_job;
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'already_accepted', true,
      'quote_id', p_quote_id,
      'job_id', v_job,
      'group_id', v_gid,
      'reserved_credits', v_group.hold_credits
    );
  END IF;

  -- 5 status != 'quoted' / expiration
  IF v_quote.status <> 'quoted' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_quote_status', 'status', v_quote.status);
  END IF;
  IF v_quote.expires_at <= v_now THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_expired');
  END IF;

  -- 6 Items and split plan validation
  IF jsonb_typeof(v_quote.items) = 'array' THEN
    v_items := v_quote.items;
  ELSIF jsonb_typeof(v_quote.items) = 'object' THEN
    v_items := v_quote.items -> 'items';
  ELSE
    v_items := NULL;
  END IF;

  IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_quote_items');
  END IF;
  IF jsonb_array_length(v_items) <> 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'single_item_quote_required');
  END IF;

  v_item := v_items -> 0;
  IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_item -> 'unitPricePoints') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing_item_unit_price');
  END IF;
  v_unit_price := (v_item ->> 'unitPricePoints')::NUMERIC;
  IF v_unit_price <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_item_unit_price');
  END IF;

  v_target_min := COALESCE(NULLIF(v_item ->> 'targetVolumeMin', '')::INT, 1);
  v_target_max := COALESCE(NULLIF(v_item ->> 'targetVolumeMax', '')::INT, 1);
  IF v_target_min < 1 OR v_target_max < v_target_min OR v_target_max > 5000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_target_volume');
  END IF;

  v_endpoint_id := COALESCE(
    NULLIF(v_item ->> 'endpointId', ''),
    NULLIF(v_item ->> 'capabilitySlug', ''),
    'default'
  );

  v_split := v_item -> 'params' -> 'split';
  IF jsonb_typeof(v_split) IS DISTINCT FROM 'object'
     OR (v_split ->> 'v') IS DISTINCT FROM '3' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_group_plan');
  END IF;

  v_parts_k := (v_split ->> 'parts')::INT;
  IF v_parts_k IS NULL OR v_parts_k < 2 OR v_parts_k > 40 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_group_plan');
  END IF;

  IF jsonb_typeof(v_split -> 'partVolumes') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_split -> 'partReserves') IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_split -> 'partVolumes') <> v_parts_k
     OR jsonb_array_length(v_split -> 'partReserves') <> v_parts_k THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_group_plan');
  END IF;

  FOR i IN 0 .. (v_parts_k - 1) LOOP
    IF jsonb_typeof(v_split -> 'partVolumes' -> i) <> 'number'
       OR jsonb_typeof(v_split -> 'partReserves' -> i) <> 'number' THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_group_plan');
    END IF;

    v_vol := (v_split -> 'partVolumes' ->> i)::INT;
    v_res := (v_split -> 'partReserves' ->> i)::NUMERIC;

    IF v_vol < 1 OR v_vol > 5000 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_group_plan');
    END IF;
    IF i = 0 AND v_vol <> v_target_max THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_group_plan');
    END IF;

    IF v_res <= 0 OR v_res > p_points_cap OR v_res < CEIL(v_vol * v_unit_price) THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_group_plan');
    END IF;
    IF i = 0 AND v_res <> v_quote.total_reserved_credits THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_group_plan');
    END IF;

    v_sum_vol := v_sum_vol + v_vol;
    v_sum_res := v_sum_res + v_res;
    v_part_volumes := array_append(v_part_volumes, v_vol);
    v_part_reserves := array_append(v_part_reserves, v_res);
  END LOOP;

  v_hold_credits := (v_split ->> 'hold')::NUMERIC;
  v_reachable := (v_split ->> 'reachable')::INT;
  v_asked_original := (v_split ->> 'askedOriginal')::INT;

  IF v_hold_credits IS DISTINCT FROM v_sum_res
     OR v_reachable IS DISTINCT FROM v_sum_vol
     OR v_asked_original IS NULL
     OR v_asked_original < v_reachable THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_group_plan');
  END IF;

  -- 7 Profile lock & concurrency limit
  PERFORM 1 FROM public.profiles WHERE id = v_quote.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'profile_not_found');
  END IF;

  SELECT count(*) INTO v_active_jobs
  FROM public.jobs
  WHERE user_id = v_quote.user_id AND status IN ('queued', 'running');
  IF v_active_jobs >= 2 THEN
    RETURN jsonb_build_object('success', false, 'error', 'concurrency_limit');
  END IF;

  -- 8 Balance check
  SELECT COALESCE(SUM(delta), 0) INTO v_balance
  FROM public.credit_ledger
  WHERE user_id = v_quote.user_id;

  IF v_balance < v_hold_credits THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_balance', 'balance', v_balance);
  END IF;

  -- 9 INSERT credit_ledger (res_<gid>)
  INSERT INTO public.credit_ledger (id, user_id, delta, type, job_id, note, created_at)
  VALUES ('res_' || v_gid, v_quote.user_id, -v_hold_credits, 'reserve', v_gid, 'حجز رصيد الطلب كاملًا لكل أجزائه', v_now);

  -- 10 INSERT job_groups
  v_r_1 := v_part_reserves[1];
  INSERT INTO public.job_groups (
    id, user_id, quote_id, status, parts_planned,
    part_volumes, part_reserves, hold_credits, drawn_credits,
    next_part, asked_original, reachable, unit_price,
    endpoint_id, first_job_id, deadline_at, created_at, updated_at
  ) VALUES (
    v_gid, v_quote.user_id, p_quote_id, 'open', v_parts_k,
    v_part_volumes, v_part_reserves, v_hold_credits, v_r_1,
    2, v_asked_original, v_reachable, v_unit_price,
    v_endpoint_id, v_job, v_now + interval '72 hours', v_now, v_now
  );

  -- 11 Transfer from group hold to part 1 in credit_ledger
  INSERT INTO public.credit_ledger (id, user_id, delta, type, job_id, note, created_at)
  VALUES ('gdr_' || v_job, v_quote.user_id, v_r_1, 'release', v_gid, 'تحويل من حجز الطلب إلى الجزء ١', v_now);

  INSERT INTO public.credit_ledger (id, user_id, delta, type, job_id, note, created_at)
  VALUES ('res_' || v_job, v_quote.user_id, -v_r_1, 'reserve', v_job, 'حجز الجزء من حجز الطلب', v_now);

  -- 12 INSERT jobs, job_events, job_group_parts
  INSERT INTO public.jobs (
    id, user_id, status, endpoint_id,
    target_volume_min, target_volume_max,
    reserved_credits, charged_credits, delivered_units,
    unit_price, attempt_count, step, next_attempt_at,
    created_at, updated_at
  ) VALUES (
    v_job, v_quote.user_id, 'queued', v_endpoint_id,
    v_target_min, v_target_max,
    v_r_1, 0, 0,
    v_unit_price, 0, 0, v_now,
    v_now, v_now
  );

  INSERT INTO public.job_events (job_id, user_id, message, units, event_type, created_at)
  VALUES (v_job, v_quote.user_id, p_start_event_ar, 0, 'progress', v_now);

  INSERT INTO public.job_group_parts (group_id, part_index, job_id, quote_id, reserved_credits, created_at)
  VALUES (v_gid, 1, v_job, p_quote_id, v_r_1, v_now);

  -- 13 UPDATE plans_quotes SET status='accepted'
  UPDATE public.plans_quotes
  SET status = 'accepted'
  WHERE id = p_quote_id AND status = 'quoted' AND expires_at > v_now;
  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION 'Quote % was not eligible for acceptance', p_quote_id;
  END IF;

  -- 14 RETURN
  RETURN jsonb_build_object(
    'success', true,
    'already_accepted', false,
    'quote_id', p_quote_id,
    'job_id', v_job,
    'group_id', v_gid,
    'reserved_credits', v_hold_credits
  );
END;
$$;

REVOKE ALL ON FUNCTION public.accept_group_quote_atomic(TEXT, UUID, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_group_quote_atomic(TEXT, UUID, TEXT, NUMERIC, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. F2: draw_next_group_part_atomic
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.draw_next_group_part_atomic(
  p_group_id TEXT,
  p_part_index INT,
  p_items JSONB,
  p_event_ar TEXT,
  p_delivered_so_far INT,
  p_points_cap NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group public.job_groups%ROWTYPE;
  v_existing_part public.job_group_parts%ROWTYPE;
  v_prev_part public.job_group_parts%ROWTYPE;
  v_prev_job public.jobs%ROWTYPE;
  v_calc_delivered INT;
  v_r NUMERIC;
  v_v INT;
  v_item JSONB;
  v_item_min INT;
  v_qid TEXT;
  v_job TEXT;
  v_output_formats TEXT[];
  v_frozen_count INT;
  v_keys_count INT;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
  -- 1 Argument checks
  IF p_group_id IS NULL OR p_part_index IS NULL
     OR p_items IS NULL OR p_event_ar IS NULL
     OR p_delivered_so_far IS NULL OR p_points_cap IS NULL
     OR length(p_event_ar) < 1 OR length(p_event_ar) > 2000
     OR p_points_cap <= 0 OR p_part_index < 2 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_required_argument');
  END IF;

  -- 2 SELECT group FOR UPDATE
  SELECT * INTO v_group
  FROM public.job_groups
  WHERE id = p_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'group_not_found');
  END IF;

  -- 3 Idempotency
  SELECT * INTO v_existing_part
  FROM public.job_group_parts
  WHERE group_id = p_group_id AND part_index = p_part_index;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_drawn', true,
      'job_id', v_existing_part.job_id,
      'quote_id', v_existing_part.quote_id
    );
  END IF;

  -- 4 Status & state checks
  IF v_group.status <> 'open' THEN
    RETURN jsonb_build_object('success', false, 'error', 'group_closed');
  END IF;
  IF v_group.halted_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'group_halted');
  END IF;
  IF p_part_index <> v_group.next_part THEN
    RETURN jsonb_build_object('success', false, 'error', 'out_of_order');
  END IF;
  IF p_part_index > v_group.parts_planned THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_more_parts');
  END IF;
  IF v_now >= v_group.deadline_at THEN
    RETURN jsonb_build_object('success', false, 'error', 'deadline_passed');
  END IF;

  -- 5 Previous part lock and check
  SELECT * INTO v_prev_part
  FROM public.job_group_parts
  WHERE group_id = p_group_id AND part_index = p_part_index - 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Group % missing previous part %', p_group_id, p_part_index - 1;
  END IF;

  SELECT * INTO v_prev_job
  FROM public.jobs
  WHERE id = v_prev_part.job_id
  FOR UPDATE;

  IF v_prev_job.status NOT IN ('completed', 'failed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'previous_part_active');
  END IF;

  -- 5b UNFROZEN RELEASE halt
  IF v_prev_job.status = 'failed'
     AND v_prev_job.current_cursor = 'completed'
     AND NOT EXISTS (
       SELECT 1 FROM public.job_group_frozen
       WHERE group_id = p_group_id AND part_index = p_part_index - 1
     ) THEN
    UPDATE public.job_groups
    SET halted_at = COALESCE(halted_at, v_now),
        updated_at = v_now
    WHERE id = p_group_id;
    RETURN jsonb_build_object('success', false, 'error', 'group_halted');
  END IF;

  -- 6 FROZEN check
  IF v_prev_job.status = 'completed' AND COALESCE(v_prev_job.delivered_units, 0) > 0 THEN
    SELECT count(*) INTO v_frozen_count
    FROM public.job_group_frozen
    WHERE group_id = p_group_id
      AND part_index = p_part_index - 1
      AND job_id = v_prev_job.id
      AND row_count = v_prev_job.delivered_units;

    SELECT count(*) INTO v_keys_count
    FROM public.job_group_keys
    WHERE group_id = p_group_id
      AND from_part = p_part_index - 1;

    IF v_frozen_count <> 1 OR v_keys_count <> v_prev_job.delivered_units THEN
      RETURN jsonb_build_object('success', false, 'error', 'part_not_frozen');
    END IF;
  END IF;

  -- 7 TOTALS check
  SELECT COALESCE(SUM(j.delivered_units), 0) INTO v_calc_delivered
  FROM public.job_group_parts p
  JOIN public.jobs j ON j.id = p.job_id
  WHERE p.group_id = p_group_id AND j.status = 'completed';

  IF p_delivered_so_far <> v_calc_delivered THEN
    RETURN jsonb_build_object('success', false, 'error', 'totals_mismatch');
  END IF;

  -- 8 Reserve and volume
  v_r := v_group.part_reserves[p_part_index];
  v_v := v_group.part_volumes[p_part_index];
  IF v_r > p_points_cap OR v_group.drawn_credits + v_r > v_group.hold_credits THEN
    RETURN jsonb_build_object('success', false, 'error', 'hold_exhausted');
  END IF;

  -- 9 ITEM check
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_items) <> 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_part_item');
  END IF;

  v_item := p_items -> 0;
  IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
     OR (v_item ->> 'unitPricePoints')::NUMERIC IS DISTINCT FROM v_group.unit_price
     OR (v_item ->> 'targetVolumeMax')::INT IS DISTINCT FROM v_v
     OR COALESCE(NULLIF(v_item ->> 'endpointId', ''), NULLIF(v_item ->> 'capabilitySlug', '')) IS DISTINCT FROM v_group.endpoint_id
     OR (v_item -> 'params' -> 'split' ->> 'v') IS DISTINCT FROM '3'
     OR (v_item -> 'params' -> 'split' ->> 'part')::INT IS DISTINCT FROM p_part_index
     OR (v_item -> 'params' -> 'split' ->> 'groupId') IS DISTINCT FROM p_group_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_part_item');
  END IF;

  -- 10 IDs
  v_qid := v_group.quote_id || '_p' || p_part_index;
  v_job := 'job_quote_' || md5(v_qid);

  -- 11 INSERT plans_quotes
  SELECT output_formats INTO v_output_formats
  FROM public.plans_quotes
  WHERE id = v_group.quote_id;

  INSERT INTO public.plans_quotes (
    id, user_id, quote_hash, status, items,
    total_reserved_credits, output_formats, expires_at, created_at
  ) VALUES (
    v_qid, v_group.user_id, encode(sha256(convert_to(p_items::text, 'UTF8')), 'hex'),
    'accepted', p_items, v_r, v_output_formats, v_now, v_now
  );

  -- 13 INSERT credit_ledger
  INSERT INTO public.credit_ledger (id, user_id, delta, type, job_id, note, created_at)
  VALUES ('gdr_' || v_job, v_group.user_id, v_r, 'release', p_group_id, 'تحويل من حجز الطلب إلى الجزء ' || translate(p_part_index::text, '0123456789', '٠١٢٣٤٥٦٧٨٩'), v_now);

  INSERT INTO public.credit_ledger (id, user_id, delta, type, job_id, note, created_at)
  VALUES ('res_' || v_job, v_group.user_id, -v_r, 'reserve', v_job, 'حجز الجزء من حجز الطلب', v_now);

  -- 14 INSERT jobs & job_group_parts
  v_item_min := COALESCE(NULLIF(v_item ->> 'targetVolumeMin', '')::INT, 1);
  INSERT INTO public.jobs (
    id, user_id, status, endpoint_id,
    target_volume_min, target_volume_max,
    reserved_credits, charged_credits, delivered_units,
    unit_price, attempt_count, step, next_attempt_at,
    created_at, updated_at
  ) VALUES (
    v_job, v_group.user_id, 'queued', v_group.endpoint_id,
    LEAST(v_item_min, v_v), v_v,
    v_r, 0, 0,
    v_group.unit_price, 0, 0, v_now,
    v_now, v_now
  );

  INSERT INTO public.job_group_parts (group_id, part_index, job_id, quote_id, reserved_credits, created_at)
  VALUES (p_group_id, p_part_index, v_job, v_qid, v_r, v_now);

  -- 15 INSERT job_events
  INSERT INTO public.job_events (job_id, user_id, message, units, event_type, created_at)
  VALUES (v_group.first_job_id, v_group.user_id, p_event_ar, 0, 'progress', v_now);

  -- 16 UPDATE job_groups
  UPDATE public.job_groups
  SET drawn_credits = drawn_credits + v_r,
      next_part = p_part_index + 1,
      updated_at = v_now
  WHERE id = p_group_id;

  -- 17 RETURN
  RETURN jsonb_build_object(
    'success', true,
    'already_drawn', false,
    'job_id', v_job,
    'quote_id', v_qid,
    'reserved_credits', v_r
  );
END;
$$;

REVOKE ALL ON FUNCTION public.draw_next_group_part_atomic(TEXT, INT, JSONB, TEXT, INT, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.draw_next_group_part_atomic(TEXT, INT, JSONB, TEXT, INT, NUMERIC) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. F3: close_job_group_atomic
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.close_job_group_atomic(
  p_group_id TEXT,
  p_reason TEXT,
  p_final_line_ar TEXT,
  p_delivered_total INT,
  p_charged_total NUMERIC,
  p_part_release_ar TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group public.job_groups%ROWTYPE;
  v_cur_idx INT;
  v_cur public.jobs%ROWTYPE;
  v_release BOOLEAN := false;
  v_z INT;
  v_c NUMERIC;
  v_z2 INT;
  v_c2 NUMERIC;
  v_rel JSONB;
  v_rem NUMERIC;
  v_line TEXT;
  v_rop TEXT;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
  -- 1 Argument checks
  IF p_group_id IS NULL OR p_reason IS NULL
     OR p_reason NOT IN ('all_parts_done', 'deadline', 'deadline_stuck', 'empty_parts', 'operator', 'part_unfrozen') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_required_argument');
  END IF;

  IF p_reason <> 'operator' THEN
    IF p_final_line_ar IS NULL OR p_delivered_total IS NULL OR p_charged_total IS NULL
       OR length(p_final_line_ar) < 1 OR length(p_final_line_ar) > 2000 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_required_argument');
    END IF;
  END IF;

  IF p_reason IN ('deadline_stuck', 'operator') THEN
    IF p_part_release_ar IS NULL OR length(p_part_release_ar) < 1 OR length(p_part_release_ar) > 2000 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_required_argument');
    END IF;
  END IF;

  -- 2 SELECT group FOR UPDATE
  SELECT * INTO v_group
  FROM public.job_groups
  WHERE id = p_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'group_not_found');
  END IF;

  -- 3 status 'closed'
  IF v_group.status = 'closed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_closed', true,
      'released_credits', v_group.released_credits,
      'delivered_total', v_group.final_delivered,
      'charged_total', v_group.final_charged,
      'asked_original', v_group.asked_original,
      'final_line', v_group.final_line
    );
  END IF;

  -- 4 LOCK all parts' jobs in ascending id order
  PERFORM 1
  FROM public.jobs
  WHERE id IN (SELECT job_id FROM public.job_group_parts WHERE group_id = p_group_id)
  ORDER BY id
  FOR UPDATE;

  -- 5 CLASSIFY
  v_cur_idx := v_group.next_part - 1;
  SELECT j.* INTO v_cur
  FROM public.job_group_parts p
  JOIN public.jobs j ON j.id = p.job_id
  WHERE p.group_id = p_group_id AND p.part_index = v_cur_idx;

  IF p_reason = 'part_unfrozen' THEN
    IF v_group.halted_at IS NULL AND NOT (
      v_cur.status = 'failed' AND v_cur.current_cursor = 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM public.job_group_frozen
        WHERE group_id = p_group_id AND part_index = v_cur_idx
      )
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'group_not_halted');
    END IF;
  END IF;

  IF v_cur.status IN ('completed', 'failed') THEN
    v_release := false;
  ELSIF v_cur.status IN ('queued', 'running') AND p_reason = 'deadline_stuck' THEN
    IF NOT (
      v_now >= v_group.deadline_at AND (
        (v_cur.lease_until IS NOT NULL AND v_cur.lease_until < v_now - interval '30 minutes')
        OR (v_cur.lease_until IS NULL AND v_cur.updated_at < v_now - interval '30 minutes')
        OR (v_now >= v_group.deadline_at + interval '2 hours')
      )
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'part_not_stuck');
    END IF;
    v_release := true;
  ELSIF v_cur.status IN ('queued', 'running') AND p_reason = 'operator' THEN
    v_release := true;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'part_active');
  END IF;

  -- 5e FREEZE guard
  IF v_cur.status = 'completed' AND NOT EXISTS (
    SELECT 1 FROM public.job_group_frozen
    WHERE group_id = p_group_id AND part_index = v_cur_idx
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'part_not_frozen');
  END IF;

  -- 6 EXPECTED TOTALS
  SELECT
    COALESCE(SUM(j.delivered_units) FILTER (WHERE j.status = 'completed'), 0),
    COALESCE(SUM(CASE WHEN v_release AND j.id = v_cur.id THEN 0 ELSE j.charged_credits END), 0)
  INTO v_z, v_c
  FROM public.job_group_parts p
  JOIN public.jobs j ON j.id = p.job_id
  WHERE p.group_id = p_group_id;

  IF p_reason <> 'operator' THEN
    IF p_delivered_total <> v_z OR p_charged_total <> v_c THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'totals_mismatch',
        'delivered_total', v_z,
        'charged_total', v_c
      );
    END IF;
  END IF;

  -- 7 MUTATE
  IF v_release THEN
    v_rel := public.release_job_atomic(v_cur.id, p_part_release_ar, true);
    IF v_rel IS NULL OR (v_rel ->> 'success')::BOOLEAN IS NOT TRUE THEN
      RAISE EXCEPTION 'group_close_release_failed %', v_cur.id;
    END IF;
  END IF;

  -- 8 RE-VERIFY
  SELECT
    COALESCE(SUM(j.delivered_units) FILTER (WHERE j.status = 'completed'), 0),
    COALESCE(SUM(j.charged_credits), 0)
  INTO v_z2, v_c2
  FROM public.job_group_parts p
  JOIN public.jobs j ON j.id = p.job_id
  WHERE p.group_id = p_group_id;

  IF v_z2 <> v_z OR v_c2 <> v_c THEN
    RAISE EXCEPTION 'group_close_totals_changed';
  END IF;

  -- 9 Remainder release
  v_rem := v_group.hold_credits - v_group.drawn_credits;
  IF v_rem > 0 THEN
    INSERT INTO public.credit_ledger (id, user_id, delta, type, job_id, note, created_at)
    VALUES ('rel_' || p_group_id, v_group.user_id, v_rem, 'release', p_group_id, 'باقي حجز الطلب بعد آخر جزء: حجز مؤقت مُحرَّر', v_now);
  END IF;

  -- 10 Final line
  IF p_reason = 'operator' THEN
    v_line := 'المسلَّم ' || translate(v_z::text, '0123456789', '٠١٢٣٤٥٦٧٨٩') || ' من ' || translate(v_group.asked_original::text, '0123456789', '٠١٢٣٤٥٦٧٨٩') || ' مطلوب.';
    IF v_z < v_group.asked_original THEN
      IF v_group.next_part <= v_group.parts_planned OR v_release THEN
        v_rop := 'أوقفنا الأجزاء الباقية من هذا الطلب من جانبنا.';
      ELSE
        v_rop := 'لم يصلنا سبب محدد لتوقف المعالجة قبل اكتمال العدد.';
      END IF;
      v_line := v_line || ' السبب: ' || v_rop;
    END IF;
    v_line := v_line || ' الخصم الإجمالي ' || public.job_group_points_ar(v_c) || '، والباقي حجز مؤقت مُحرَّر.';
  ELSE
    v_line := p_final_line_ar;
  END IF;

  INSERT INTO public.job_events (job_id, user_id, message, units, event_type, created_at)
  VALUES (v_group.first_job_id, v_group.user_id, v_line, v_z, 'progress', v_now);

  -- 11 UPDATE job_groups
  UPDATE public.job_groups
  SET status = 'closed',
      close_reason = p_reason,
      released_credits = v_rem,
      final_delivered = v_z,
      final_charged = v_c,
      final_line = v_line,
      closed_at = v_now,
      updated_at = v_now,
      halted_at = CASE WHEN p_reason = 'part_unfrozen' THEN COALESCE(halted_at, v_now) ELSE halted_at END
  WHERE id = p_group_id;

  RETURN jsonb_build_object(
    'success', true,
    'already_closed', false,
    'released_credits', v_rem,
    'delivered_total', v_z,
    'charged_total', v_c,
    'asked_original', v_group.asked_original,
    'final_line', v_line,
    'part_released', v_release
  );
END;
$$;

REVOKE ALL ON FUNCTION public.close_job_group_atomic(TEXT, TEXT, TEXT, INT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_job_group_atomic(TEXT, TEXT, TEXT, INT, NUMERIC, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. F4: claim_next_job_group
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_next_job_group(
  p_quiet_seconds INT,
  p_closing_notice_ar TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_g public.job_groups%ROWTYPE;
  v_cur_job public.jobs%ROWTYPE;
  v_is_frozen BOOLEAN;
  v_delivered_sum INT;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
  -- 1 Argument checks
  IF p_quiet_seconds IS NULL OR p_quiet_seconds < 60 OR p_quiet_seconds > 3600
     OR p_closing_notice_ar IS NULL OR length(p_closing_notice_ar) < 1 OR length(p_closing_notice_ar) > 2000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_required_argument');
  END IF;

  -- 2 Pick candidate group
  WITH c AS (
    SELECT g.id
    FROM public.job_groups g
    JOIN public.job_group_parts p ON p.group_id = g.id AND p.part_index = g.next_part - 1
    JOIN public.jobs j ON j.id = p.job_id
    WHERE g.status = 'open'
      AND (g.last_attempt_at IS NULL OR g.last_attempt_at < v_now - interval '30 seconds')
      AND (
        (
          (j.status IN ('completed', 'failed')
           OR (j.status = 'running' AND j.current_cursor = 'completed' AND (j.lease_until IS NULL OR j.lease_until < v_now)))
          AND j.updated_at <= v_now - make_interval(secs => p_quiet_seconds)
        )
        OR v_now >= g.deadline_at
      )
    ORDER BY g.last_attempt_at NULLS FIRST, g.id
    LIMIT 1
    FOR UPDATE OF g SKIP LOCKED
  )
  UPDATE public.job_groups g
  SET last_attempt_at = v_now
  FROM c
  WHERE g.id = c.id
  RETURNING g.* INTO v_g;

  -- 3 No row
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'group', null);
  END IF;

  -- 4 Current job details
  SELECT j.* INTO v_cur_job
  FROM public.job_group_parts p
  JOIN public.jobs j ON j.id = p.job_id
  WHERE p.group_id = v_g.id AND p.part_index = v_g.next_part - 1;

  -- 4b Closing notice
  IF v_now >= v_g.deadline_at
     AND v_cur_job.status IN ('queued', 'running')
     AND v_cur_job.current_cursor IS DISTINCT FROM 'completed'
     AND v_g.closing_notice_at IS NULL THEN
    SELECT COALESCE(SUM(j.delivered_units), 0) INTO v_delivered_sum
    FROM public.job_group_parts p
    JOIN public.jobs j ON j.id = p.job_id
    WHERE p.group_id = v_g.id AND j.status = 'completed';

    INSERT INTO public.job_events (job_id, user_id, message, units, event_type, created_at)
    VALUES (v_g.first_job_id, v_g.user_id, p_closing_notice_ar, v_delivered_sum, 'progress', v_now);

    UPDATE public.job_groups
    SET closing_notice_at = v_now
    WHERE id = v_g.id;

    v_g.closing_notice_at := v_now;
  END IF;

  -- 5 Frozen status check
  SELECT EXISTS (
    SELECT 1 FROM public.job_group_frozen
    WHERE group_id = v_g.id AND part_index = v_g.next_part - 1
  ) INTO v_is_frozen;

  RETURN jsonb_build_object(
    'success', true,
    'group', row_to_json(v_g),
    'current', jsonb_build_object(
      'job_id', v_cur_job.id,
      'status', v_cur_job.status,
      'current_cursor', v_cur_job.current_cursor,
      'delivered_units', v_cur_job.delivered_units,
      'charged_credits', v_cur_job.charged_credits,
      'error_message', v_cur_job.error_message,
      'updated_at', v_cur_job.updated_at,
      'lease_until', v_cur_job.lease_until
    ),
    'frozen', v_is_frozen
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_job_group(INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_job_group(INT, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 8. F5: freeze_and_settle_group_part_atomic
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.freeze_and_settle_group_part_atomic(
  p_group_id TEXT,
  p_part_index INT,
  p_job_id TEXT,
  p_path TEXT,
  p_sha256 TEXT,
  p_row_count INT,
  p_keys TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group public.job_groups%ROWTYPE;
  v_frozen public.job_group_frozen%ROWTYPE;
  v_part public.job_group_parts%ROWTYPE;
  v_job public.jobs%ROWTYPE;
  v_keys_len INT;
  v_set JSONB;
  v_job_status TEXT;
  v_job_delivered INT;
  v_job_charged NUMERIC;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
  -- 1 Argument checks
  IF p_group_id IS NULL OR p_part_index IS NULL
     OR p_job_id IS NULL OR p_path IS NULL
     OR p_sha256 IS NULL OR p_row_count IS NULL
     OR p_keys IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
     OR p_row_count <= 0 OR p_part_index < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_required_argument');
  END IF;

  -- 2 SELECT group FOR UPDATE
  SELECT * INTO v_group
  FROM public.job_groups
  WHERE id = p_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'group_not_found');
  END IF;

  -- 3 Existing frozen check
  SELECT * INTO v_frozen
  FROM public.job_group_frozen
  WHERE group_id = p_group_id AND part_index = p_part_index;
  IF FOUND THEN
    IF v_frozen.sha256 = p_sha256 AND v_frozen.path = p_path THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_frozen', true,
        'path', v_frozen.path,
        'sha256', v_frozen.sha256,
        'row_count', v_frozen.row_count,
        'charged_credits', v_frozen.charged_credits
      );
    ELSE
      RETURN jsonb_build_object(
        'success', false,
        'error', 'freeze_conflict',
        'path', v_frozen.path,
        'sha256', v_frozen.sha256
      );
    END IF;
  END IF;

  -- 4 Part & job check
  SELECT * INTO v_part
  FROM public.job_group_parts
  WHERE group_id = p_group_id AND part_index = p_part_index AND job_id = p_job_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'part_not_found');
  END IF;

  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF v_job.status <> 'running' OR v_job.current_cursor IS DISTINCT FROM 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'part_not_awaiting_freeze', 'status', v_job.status);
  END IF;

  -- 5 Path validation
  IF p_path <> (v_job.user_id::text || '/' || p_job_id || '/frozen-' || p_sha256 || '.json') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_path');
  END IF;

  -- 6 Count check
  IF p_row_count <> v_job.delivered_units THEN
    RETURN jsonb_build_object('success', false, 'error', 'count_mismatch');
  END IF;

  -- 7 Keys validation
  SELECT count(DISTINCT k) INTO v_keys_len
  FROM unnest(p_keys) k
  WHERE length(k) BETWEEN 1 AND 300;

  IF cardinality(p_keys) <> p_row_count OR v_keys_len <> p_row_count THEN
    RETURN jsonb_build_object('success', false, 'error', 'keys_mismatch');
  END IF;

  -- 8 Keys overlap check
  IF EXISTS (
    SELECT 1 FROM public.job_group_keys
    WHERE group_id = p_group_id AND key = ANY(p_keys)
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'keys_overlap');
  END IF;

  -- 9 SETTLE
  v_set := public.settle_job_atomic(p_job_id, v_job.reserved_credits, NULL);
  IF v_set IS NULL
     OR (v_set ->> 'success')::BOOLEAN IS NOT TRUE
     OR (v_set ->> 'already_settled')::BOOLEAN IS TRUE THEN
    RAISE EXCEPTION 'group_part_settle_failed %', p_job_id;
  END IF;

  -- 10 VERIFY
  SELECT status, delivered_units, charged_credits
  INTO v_job_status, v_job_delivered, v_job_charged
  FROM public.jobs
  WHERE id = p_job_id;

  IF v_job_status <> 'completed' OR v_job_delivered <> p_row_count THEN
    RAISE EXCEPTION 'group_part_settle_mismatch';
  END IF;

  -- 11 INSERT frozen record & keys
  INSERT INTO public.job_group_frozen (
    group_id, part_index, job_id, path,
    sha256, row_count, charged_credits, created_at
  ) VALUES (
    p_group_id, p_part_index, p_job_id, p_path,
    p_sha256, p_row_count, v_job_charged, v_now
  );

  INSERT INTO public.job_group_keys (group_id, key, from_part)
  SELECT p_group_id, k, p_part_index
  FROM unnest(p_keys) k;

  -- 12 RETURN
  RETURN jsonb_build_object(
    'success', true,
    'already_frozen', false,
    'path', p_path,
    'sha256', p_sha256,
    'row_count', p_row_count,
    'charged_credits', v_job_charged
  );
END;
$$;

REVOKE ALL ON FUNCTION public.freeze_and_settle_group_part_atomic(TEXT, INT, TEXT, TEXT, TEXT, INT, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.freeze_and_settle_group_part_atomic(TEXT, INT, TEXT, TEXT, TEXT, INT, TEXT[]) TO service_role;

-- ---------------------------------------------------------------------------
-- 9. F6: release_unfrozen_group_part_atomic
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.release_unfrozen_group_part_atomic(
  p_group_id TEXT,
  p_part_index INT,
  p_job_id TEXT,
  p_release_ar TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group public.job_groups%ROWTYPE;
  v_part public.job_group_parts%ROWTYPE;
  v_job public.jobs%ROWTYPE;
  v_rel JSONB;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
  -- 1 Argument checks
  IF p_group_id IS NULL OR p_part_index IS NULL
     OR p_job_id IS NULL OR p_release_ar IS NULL
     OR length(p_release_ar) < 1 OR length(p_release_ar) > 2000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_required_argument');
  END IF;

  -- 2 SELECT group FOR UPDATE
  SELECT * INTO v_group
  FROM public.job_groups
  WHERE id = p_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'group_not_found');
  END IF;

  -- 3 SELECT part & lock job
  SELECT * INTO v_part
  FROM public.job_group_parts
  WHERE group_id = p_group_id AND part_index = p_part_index AND job_id = p_job_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'part_not_found');
  END IF;

  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  -- 4 State validation
  IF v_job.status = 'failed' THEN
    IF v_job.current_cursor = 'completed' AND NOT EXISTS (
      SELECT 1 FROM public.job_group_frozen
      WHERE group_id = p_group_id AND part_index = p_part_index
    ) THEN
      UPDATE public.job_groups
      SET halted_at = COALESCE(halted_at, v_now),
          updated_at = v_now
      WHERE id = p_group_id;
    END IF;
    RETURN jsonb_build_object('success', true, 'already_released', true);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.job_group_frozen
    WHERE group_id = p_group_id AND part_index = p_part_index
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'part_frozen');
  END IF;

  IF v_job.status <> 'running' OR v_job.current_cursor IS DISTINCT FROM 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'part_not_awaiting_freeze');
  END IF;

  -- 5 Release & Halt
  v_rel := public.release_job_atomic(p_job_id, p_release_ar, true);
  IF v_rel IS NULL OR (v_rel ->> 'success')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'group_part_release_failed %', p_job_id;
  END IF;

  UPDATE public.job_groups
  SET halted_at = COALESCE(halted_at, v_now),
      updated_at = v_now
  WHERE id = p_group_id;

  -- 6 RETURN
  RETURN jsonb_build_object(
    'success', true,
    'already_released', false,
    'released_credits', (v_rel ->> 'released_credits')::NUMERIC
  );
END;
$$;

REVOKE ALL ON FUNCTION public.release_unfrozen_group_part_atomic(TEXT, INT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_unfrozen_group_part_atomic(TEXT, INT, TEXT, TEXT) TO service_role;

COMMIT;
