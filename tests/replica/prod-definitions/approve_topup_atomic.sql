-- PRODUCTION definitions read 2026-10-21 (pg_get_functiondef, project pfinlfaqwnytesedchik). Definitions only, no data.
CREATE OR REPLACE FUNCTION public.approve_topup_atomic(p_topup_id text, p_confirmed_amount_egp numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_topup record;
  v_effective_amount numeric;
  v_credit_value_egp numeric := 0.1;
  v_credits integer;
  v_ledger_id text;
  v_existing_ledger record;
  v_new_balance numeric;
BEGIN
  -- 1. Lock topup row FOR UPDATE
  SELECT * INTO v_topup
  FROM public.topups
  WHERE id = p_topup_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'topup_not_found', 'error_ar', 'طلب الشحن غير موجود.');
  END IF;

  -- 2. Idempotency check: if already approved, return early with current balance
  IF v_topup.status = 'approved' THEN
    SELECT COALESCE(SUM(delta), 0) INTO v_new_balance
    FROM public.credit_ledger WHERE user_id = v_topup.user_id;

    RETURN jsonb_build_object(
      'success', true,
      'already_approved', true,
      'user_id', v_topup.user_id,
      'amount_egp', v_topup.amount_egp,
      'balance', v_new_balance
    );
  END IF;

  IF v_topup.status != 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status', 'error_ar', 'لا يمكن اعتماد طلب بحالة: ' || v_topup.status);
  END IF;

  -- 3. Exact matching credit conversion calculation
  v_effective_amount := COALESCE(p_confirmed_amount_egp, v_topup.amount_egp);
  IF v_effective_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount', 'error_ar', 'مبلغ الشحن يجب أن يكون أكبر من الصفر.');
  END IF;

  SELECT (value->>'creditValueEgp')::numeric INTO v_credit_value_egp
  FROM public.settings_public WHERE key = 'pricing';
  IF v_credit_value_egp IS NULL OR v_credit_value_egp <= 0 THEN
    v_credit_value_egp := 0.1;
  END IF;

  v_credits := floor(v_effective_amount / v_credit_value_egp)::integer;

  -- 4. Ledger conflict verification: check existing row matching user & amount
  v_ledger_id := 'top_' || p_topup_id;
  SELECT user_id, delta INTO v_existing_ledger
  FROM public.credit_ledger
  WHERE id = v_ledger_id;

  IF FOUND THEN
    IF v_existing_ledger.user_id != v_topup.user_id OR v_existing_ledger.delta != v_credits THEN
      RAISE EXCEPTION 'ledger_conflict: existing row % has mismatched user or delta', v_ledger_id;
    END IF;
  ELSE
    INSERT INTO public.credit_ledger (id, user_id, delta, type, note)
    VALUES (
      v_ledger_id,
      v_topup.user_id,
      v_credits,
      'topup',
      'شحن رصيد (طلب: ' || p_topup_id || '، مرجع: ' || COALESCE(v_topup.reference, '-') || ')'
    );
  END IF;

  -- 5. Update topup status to approved (only real columns in public.topups)
  UPDATE public.topups
  SET 
    status = 'approved',
    amount_egp = v_effective_amount
  WHERE id = p_topup_id;

  SELECT COALESCE(SUM(delta), 0) INTO v_new_balance
  FROM public.credit_ledger WHERE user_id = v_topup.user_id;

  RETURN jsonb_build_object(
    'success', true,
    'already_approved', false,
    'user_id', v_topup.user_id,
    'credits', v_credits,
    'effective_amount_egp', v_effective_amount,
    'balance', v_new_balance
  );
END;
$function$
