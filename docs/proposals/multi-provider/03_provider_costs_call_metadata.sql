-- PROPOSAL ONLY (not applied by the author; the owner reviews and applies it by hand). Part 3 of 3 of docs/proposals/multi-provider/.
--
-- What each recorded provider call says about itself, so the per-provider call log in the admin tab can show it (the capability, the
-- status success / failed / empty, and the duration). provider_costs is a MONEY table: it changes only through approved SQL functions, so
-- this proposal adds ONE function, commit_provider_spend_v2, next to the existing commit_provider_spend. The application calls the new
-- function when it exists and the old one when it does not; the old function, reserve_provider_spend_atomic and every other function stay
-- exactly as they are. No existing row is changed: the three new columns are nullable and stay NULL on old rows (the log shows «غير متاح»).
--
-- The new function does what the old one does and nothing more: it updates ONLY a row that is still an estimate (is_estimate = true) with the
-- real cost and units, flips it to a real row, and records the three facts. The cost is never negative and a status outside the three words
-- is refused. A row that is not an estimate (already committed) raises, as the old function does. SECURITY DEFINER, pinned search_path,
-- REVOKE from PUBLIC / anon / authenticated, GRANT to service_role only.
--
-- Requires 20261012135329_provider_spend_cap_atomic.sql (applied already). Idempotent.

BEGIN;

ALTER TABLE public.provider_costs
  ADD COLUMN IF NOT EXISTS capability text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS duration_ms integer;

ALTER TABLE public.provider_costs DROP CONSTRAINT IF EXISTS provider_costs_status_check;
ALTER TABLE public.provider_costs
  ADD CONSTRAINT provider_costs_status_check CHECK (status IS NULL OR status IN ('success', 'failed', 'empty'));
ALTER TABLE public.provider_costs DROP CONSTRAINT IF EXISTS provider_costs_capability_len_check;
ALTER TABLE public.provider_costs
  ADD CONSTRAINT provider_costs_capability_len_check CHECK (capability IS NULL OR char_length(capability) <= 80);
ALTER TABLE public.provider_costs DROP CONSTRAINT IF EXISTS provider_costs_duration_check;
ALTER TABLE public.provider_costs
  ADD CONSTRAINT provider_costs_duration_check CHECK (duration_ms IS NULL OR duration_ms >= 0);

-- The call log reads one provider's rows newest first.
CREATE INDEX IF NOT EXISTS idx_provider_costs_provider_created ON public.provider_costs (provider, created_at DESC);

CREATE OR REPLACE FUNCTION public.commit_provider_spend_v2(
  p_cost_id BIGINT,
  p_actual_cost_usd NUMERIC,
  p_units INT,
  p_capability TEXT,
  p_status TEXT,
  p_duration_ms INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated INT;
BEGIN
  IF p_actual_cost_usd IS NULL OR p_actual_cost_usd < 0 THEN
    RAISE EXCEPTION 'Provider cost must not be negative';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('success', 'failed', 'empty') THEN
    RAISE EXCEPTION 'Provider call status must be success, failed or empty';
  END IF;

  -- Update ONLY if the row is currently marked as an estimate (the same rule as commit_provider_spend)
  UPDATE public.provider_costs
  SET cost_usd = p_actual_cost_usd,
      units = GREATEST(COALESCE(p_units, 0), 0),
      is_estimate = false,
      capability = left(p_capability, 80),
      status = p_status,
      duration_ms = GREATEST(COALESCE(p_duration_ms, 0), 0)
  WHERE id = p_cost_id AND is_estimate = true;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RAISE EXCEPTION 'Provider cost % not found or already committed', p_cost_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'cost_id', p_cost_id,
    'actual_cost', p_actual_cost_usd,
    'units', GREATEST(COALESCE(p_units, 0), 0),
    'status', p_status
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.commit_provider_spend_v2(BIGINT, NUMERIC, INT, TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_provider_spend_v2(BIGINT, NUMERIC, INT, TEXT, TEXT, INT) TO service_role;

COMMIT;
