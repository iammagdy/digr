-- Step 3: Atomic Reserve Function and Function Search Path Hardening

CREATE OR REPLACE FUNCTION public.block_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only. UPDATE and DELETE operations are forbidden.';
END;
$$;

CREATE OR REPLACE FUNCTION public.block_ledger_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger cannot be truncated.';
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_credits_atomic(
  p_user_id UUID,
  p_job_id TEXT,
  p_amount NUMERIC,
  p_note TEXT DEFAULT 'حجز رصيد للطلب'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res_id TEXT := 'res_' || p_job_id;
  v_current_balance NUMERIC;
BEGIN
  -- Validate amount strictly positive
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'p_amount must be strictly positive';
  END IF;

  -- 1. Take lock FIRST on profiles row to serialize concurrent calls
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile for user % does not exist', p_user_id;
  END IF;

  -- 2. Check true balance
  SELECT COALESCE(SUM(delta), 0) INTO v_current_balance
  FROM public.credit_ledger
  WHERE user_id = p_user_id;

  -- 3. Idempotent re-check: if res_<job_id> exists, ALWAYS return already_reserved=true
  IF EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = v_res_id) THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_reserved', true,
      'balance', v_current_balance
    );
  END IF;

  -- 4. Balance check (cannot be reached if already reserved)
  IF v_current_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient_balance',
      'balance', v_current_balance
    );
  END IF;

  -- 5. Insert deterministic reservation entry
  INSERT INTO public.credit_ledger (id, user_id, delta, type, job_id, note, created_at)
  VALUES (v_res_id, p_user_id, -p_amount, 'reserve', p_job_id, p_note, NOW())
  ON CONFLICT (id) DO NOTHING;

  -- 6. Return updated balance
  SELECT COALESCE(SUM(delta), 0) INTO v_current_balance
  FROM public.credit_ledger
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'already_reserved', false,
    'balance', v_current_balance
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reserve_credits_atomic(UUID, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_credits_atomic(UUID, TEXT, NUMERIC, TEXT) TO service_role;
