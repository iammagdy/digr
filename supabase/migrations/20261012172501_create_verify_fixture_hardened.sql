-- Migration: create_verify_fixture_hardened
-- Hardened fixture creation RPC for live verifications:
-- 1. Whitelists permitted tables: jobs, topups, plans_quotes (credit_ledger strictly prohibited)
-- 2. Restricts to primary test user (00000000-0000-0000-0000-000000000001) and second test user (00000000-0000-0000-0000-000000000002)
-- 3. Strict regex validation for fixture id: ^vrun_[0-9]{13}_[0-9a-f-]{36}_[a-z0-9_]+$
-- 4. Replaces LIKE wildcard with exact left(value, length(v_prefix)) = v_prefix
-- 5. Rejects any unknown JSON keys per table
-- 6. Enforces status, range, and future expiration constraints

CREATE OR REPLACE FUNCTION public.create_verify_fixture(
  p_table TEXT,
  p_row JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id TEXT := p_row->>'id';
  v_user_id TEXT := p_row->>'user_id';
  v_prefix TEXT;
  v_unknown_keys TEXT;
  v_status TEXT := p_row->>'status';
  v_step INT := (p_row->>'step')::int;
  v_attempt_count INT := (p_row->>'attempt_count')::int;
  v_unit_price NUMERIC := (p_row->>'unit_price')::numeric;
  v_delivered_units INT := (p_row->>'delivered_units')::int;
  v_reserved_credits NUMERIC := (p_row->>'reserved_credits')::numeric;
  v_charged_credits NUMERIC := (p_row->>'charged_credits')::numeric;
  v_amount_egp NUMERIC := (p_row->>'amount_egp')::numeric;
  v_total_reserved NUMERIC := (p_row->>'total_reserved_credits')::numeric;
BEGIN
  -- 1. Table check: strictly limited to jobs, topups, plans_quotes (NEVER credit_ledger)
  IF p_table NOT IN ('jobs', 'topups', 'plans_quotes') THEN
    RAISE EXCEPTION 'Table % not permitted for test fixture creation', p_table;
  END IF;

  -- 2. Dedicated test user check: allow primary or second dedicated test user
  IF v_user_id IS NULL OR v_user_id::uuid NOT IN (
    '00000000-0000-0000-0000-000000000001'::uuid,
    '00000000-0000-0000-0000-000000000002'::uuid
  ) THEN
    RAISE EXCEPTION 'Fixture user_id must be an approved test user (00000000-0000-0000-0000-000000000001 or 00000000-0000-0000-0000-000000000002)';
  END IF;

  -- 3. Strict regex validation for fixture id: ^vrun_[0-9]{13}_[0-9a-f-]{36}_[a-z0-9_]+$
  IF v_id IS NULL OR v_id !~ '^vrun_[0-9]{13}_[0-9a-f-]{36}_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Fixture id must match pattern ^vrun_[0-9]{13}_[0-9a-f-]{36}_[a-z0-9_]+$: %', v_id;
  END IF;

  v_prefix := substring(v_id from '^(vrun_[0-9]{13}_[0-9a-f-]{36}_)');

  -- 4. Table-specific validation and unknown key rejection
  IF p_table = 'jobs' THEN
    SELECT string_agg(k, ', ') INTO v_unknown_keys
    FROM jsonb_object_keys(p_row) k
    WHERE k NOT IN (
      'id', 'user_id', 'status', 'endpoint_id', 'step', 'attempt_count',
      'unit_price', 'delivered_units', 'reserved_credits', 'charged_credits',
      'target_volume_min', 'target_volume_max', 'next_attempt_at', 'lease_until'
    );
    IF v_unknown_keys IS NOT NULL THEN
      RAISE EXCEPTION 'Unknown keys for jobs fixture: %', v_unknown_keys;
    END IF;

    -- Allows refused as tested in verify-release-job.ts and permitted in chk_jobs_status
    IF v_status NOT IN ('queued', 'running', 'completed', 'failed', 'refused') THEN
      RAISE EXCEPTION 'Invalid status for jobs fixture: %', v_status;
    END IF;
    IF v_step IS NOT NULL AND v_step < 0 THEN
      RAISE EXCEPTION 'step must be non-negative: %', v_step;
    END IF;
    IF v_attempt_count IS NOT NULL AND (v_attempt_count < 0 OR v_attempt_count > 10) THEN
      RAISE EXCEPTION 'attempt_count out of bounds [0, 10]: %', v_attempt_count;
    END IF;
    IF v_unit_price IS NOT NULL AND v_unit_price <= 0 THEN
      RAISE EXCEPTION 'unit_price must be positive: %', v_unit_price;
    END IF;
    IF v_delivered_units IS NOT NULL AND v_delivered_units < 0 THEN
      RAISE EXCEPTION 'delivered_units must be non-negative: %', v_delivered_units;
    END IF;
    IF v_reserved_credits IS NOT NULL AND v_reserved_credits < 0 THEN
      RAISE EXCEPTION 'reserved_credits must be non-negative: %', v_reserved_credits;
    END IF;
    IF v_charged_credits IS NOT NULL AND v_charged_credits < 0 THEN
      RAISE EXCEPTION 'charged_credits must be non-negative: %', v_charged_credits;
    END IF;

    INSERT INTO public.jobs (
      id, user_id, status, endpoint_id, step, attempt_count,
      unit_price, delivered_units, reserved_credits, charged_credits,
      target_volume_min, target_volume_max, next_attempt_at, lease_until,
      created_at, updated_at
    ) VALUES (
      v_id, v_user_id::uuid, v_status, p_row->>'endpoint_id',
      COALESCE(v_step, 0), COALESCE(v_attempt_count, 0),
      v_unit_price, COALESCE(v_delivered_units, 0),
      COALESCE(v_reserved_credits, 0), COALESCE(v_charged_credits, 0),
      (p_row->>'target_volume_min')::int, (p_row->>'target_volume_max')::int,
      (p_row->>'next_attempt_at')::timestamptz, (p_row->>'lease_until')::timestamptz,
      timezone('utc'::text, now()), timezone('utc'::text, now())
    );

  ELSIF p_table = 'topups' THEN
    SELECT string_agg(k, ', ') INTO v_unknown_keys
    FROM jsonb_object_keys(p_row) k
    WHERE k NOT IN (
      'id', 'user_id', 'amount_egp', 'reference',
      'sender_name', 'sender_phone', 'receipt_file_id', 'status'
    );
    IF v_unknown_keys IS NOT NULL THEN
      RAISE EXCEPTION 'Unknown keys for topups fixture: %', v_unknown_keys;
    END IF;

    -- Strict pending status only
    IF v_status != 'pending' THEN
      RAISE EXCEPTION 'Topup fixture status must be pending only: %', v_status;
    END IF;
    IF v_amount_egp IS NULL OR v_amount_egp <= 0 OR v_amount_egp > 100000 THEN
      RAISE EXCEPTION 'amount_egp out of bounds (0, 100000]: %', v_amount_egp;
    END IF;

    -- reference and receipt_file_id must start with the exact run prefix (using left() to avoid underscore wildcard)
    IF p_row->>'reference' IS NULL OR left(p_row->>'reference', length(v_prefix)) <> v_prefix THEN
      RAISE EXCEPTION 'Topup reference must start with fixture prefix %', v_prefix;
    END IF;
    IF p_row->>'receipt_file_id' IS NULL OR left(p_row->>'receipt_file_id', length(v_prefix)) <> v_prefix THEN
      RAISE EXCEPTION 'Topup receipt_file_id must start with fixture prefix %', v_prefix;
    END IF;

    INSERT INTO public.topups (
      id, user_id, amount_egp, reference,
      sender_name, sender_phone, receipt_file_id, status, created_at
    ) VALUES (
      v_id, v_user_id::uuid, v_amount_egp, p_row->>'reference',
      p_row->>'sender_name', p_row->>'sender_phone', p_row->>'receipt_file_id',
      v_status, timezone('utc'::text, now())
    );

  ELSIF p_table = 'plans_quotes' THEN
    SELECT string_agg(k, ', ') INTO v_unknown_keys
    FROM jsonb_object_keys(p_row) k
    WHERE k NOT IN (
      'id', 'user_id', 'quote_hash', 'status',
      'total_reserved_credits', 'items', 'output_formats', 'expires_at'
    );
    IF v_unknown_keys IS NOT NULL THEN
      RAISE EXCEPTION 'Unknown keys for plans_quotes fixture: %', v_unknown_keys;
    END IF;

    -- Strict quoted status only
    IF v_status != 'quoted' THEN
      RAISE EXCEPTION 'Quote fixture status must be quoted only: %', v_status;
    END IF;
    IF p_row->>'quote_hash' IS NULL OR p_row->>'quote_hash' !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'Quote quote_hash must match ^[0-9a-f]{64}$: %', p_row->>'quote_hash';
    END IF;
    IF jsonb_typeof(p_row->'items') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Quote items must be a JSON array';
    END IF;
    IF v_total_reserved IS NULL OR v_total_reserved <= 0 THEN
      RAISE EXCEPTION 'total_reserved_credits must be positive: %', v_total_reserved;
    END IF;
    IF p_row->>'expires_at' IS NULL OR (p_row->>'expires_at')::timestamptz <= timezone('utc'::text, now()) THEN
      RAISE EXCEPTION 'Quote expires_at must be in the future: %', p_row->>'expires_at';
    END IF;

    INSERT INTO public.plans_quotes (
      id, user_id, quote_hash, status,
      total_reserved_credits, items, output_formats, expires_at, created_at
    ) VALUES (
      v_id, v_user_id::uuid, p_row->>'quote_hash', v_status,
      v_total_reserved, p_row->'items', p_row->'output_formats',
      (p_row->>'expires_at')::timestamptz, timezone('utc'::text, now())
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'table', p_table,
    'id', v_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_verify_fixture(TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_verify_fixture(TEXT, JSONB) TO service_role;
