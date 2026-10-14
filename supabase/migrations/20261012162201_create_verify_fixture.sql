-- Migration: create_verify_fixture
-- Temporary fixture creation RPC for live verifications
-- Restricted to test user 00000000-0000-0000-0000-000000000001, vrun_ prefix, jobs/topups/plans_quotes tables.
-- NEVER writes to credit_ledger.

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
BEGIN
  -- 1. Table check: strictly limited to jobs, topups, plans_quotes (NEVER credit_ledger)
  IF p_table NOT IN ('jobs', 'topups', 'plans_quotes') THEN
    RAISE EXCEPTION 'Table % not permitted for test fixture creation', p_table;
  END IF;

  -- 2. Dedicated test user check
  IF v_user_id IS NULL OR v_user_id::uuid != '00000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'Fixture user_id must be test user 00000000-0000-0000-0000-000000000001';
  END IF;

  -- 3. Deterministic test prefix check (vrun_ prefix)
  IF v_id IS NULL OR NOT (v_id LIKE 'vrun_%') THEN
    RAISE EXCEPTION 'Fixture id must start with vrun_ prefix: %', v_id;
  END IF;

  -- 4. Insert row into permitted table
  IF p_table = 'jobs' THEN
    INSERT INTO public.jobs (
      id,
      user_id,
      status,
      endpoint_id,
      step,
      attempt_count,
      unit_price,
      delivered_units,
      reserved_credits,
      charged_credits,
      target_volume_min,
      target_volume_max,
      next_attempt_at,
      lease_until,
      created_at,
      updated_at
    ) VALUES (
      v_id,
      v_user_id::uuid,
      p_row->>'status',
      p_row->>'endpoint_id',
      COALESCE((p_row->>'step')::int, 0),
      COALESCE((p_row->>'attempt_count')::int, 0),
      (p_row->>'unit_price')::numeric,
      COALESCE((p_row->>'delivered_units')::int, 0),
      COALESCE((p_row->>'reserved_credits')::numeric, 0),
      COALESCE((p_row->>'charged_credits')::numeric, 0),
      (p_row->>'target_volume_min')::int,
      (p_row->>'target_volume_max')::int,
      (p_row->>'next_attempt_at')::timestamptz,
      (p_row->>'lease_until')::timestamptz,
      timezone('utc'::text, now()),
      timezone('utc'::text, now())
    );
  ELSIF p_table = 'topups' THEN
    INSERT INTO public.topups (
      id,
      user_id,
      amount_egp,
      reference,
      sender_name,
      sender_phone,
      receipt_file_id,
      status,
      created_at
    ) VALUES (
      v_id,
      v_user_id::uuid,
      (p_row->>'amount_egp')::numeric,
      p_row->>'reference',
      p_row->>'sender_name',
      p_row->>'sender_phone',
      p_row->>'receipt_file_id',
      p_row->>'status',
      timezone('utc'::text, now())
    );
  ELSIF p_table = 'plans_quotes' THEN
    INSERT INTO public.plans_quotes (
      id,
      user_id,
      quote_hash,
      status,
      total_reserved_credits,
      items,
      output_formats,
      expires_at,
      created_at
    ) VALUES (
      v_id,
      v_user_id::uuid,
      p_row->>'quote_hash',
      p_row->>'status',
      (p_row->>'total_reserved_credits')::numeric,
      p_row->'items',
      p_row->'output_formats',
      (p_row->>'expires_at')::timestamptz,
      timezone('utc'::text, now())
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
