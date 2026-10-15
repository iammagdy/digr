-- Migration: purchase_methodology_atomic
-- Purpose: Atomic payment deduction for on-demand academic methodology document generation

CREATE OR REPLACE FUNCTION public.purchase_methodology_atomic(
  p_user_id UUID,
  p_job_id TEXT,
  p_amount NUMERIC DEFAULT 10,
  p_note TEXT DEFAULT 'شراء صياغة المنهجية الأكاديمية للطلب'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_chg_id TEXT := 'chg_meth_' || p_job_id;
  v_current_balance NUMERIC;
BEGIN
  -- 1. Validate amount strictly positive
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'p_amount must be strictly positive';
  END IF;

  -- 2. Lock profile row for atomic update
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile for user % does not exist', p_user_id;
  END IF;

  -- 3. Calculate current balance
  SELECT COALESCE(SUM(delta), 0) INTO v_current_balance
  FROM public.credit_ledger
  WHERE user_id = p_user_id;

  -- 4. Idempotent check: if already purchased, return success without double charging
  IF EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = v_chg_id) THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_purchased', true,
      'balance', v_current_balance,
      'charged', 0
    );
  END IF;

  -- 5. Balance check
  IF v_current_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient_balance',
      'balance', v_current_balance
    );
  END IF;

  -- 6. Insert deterministic charge record into immutable credit_ledger
  INSERT INTO public.credit_ledger (id, user_id, delta, type, job_id, note, created_at)
  VALUES (v_chg_id, p_user_id, -p_amount, 'charge', p_job_id, p_note, NOW())
  ON CONFLICT (id) DO NOTHING;

  -- 7. Calculate updated balance
  SELECT COALESCE(SUM(delta), 0) INTO v_current_balance
  FROM public.credit_ledger
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'already_purchased', false,
    'balance', v_current_balance,
    'charged', p_amount
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purchase_methodology_atomic(UUID, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_methodology_atomic(UUID, TEXT, NUMERIC, TEXT) TO service_role;
