-- PROPOSAL, NOT APPLIED. Requires 02 and 03. Changes ONE existing function (treg_pool_record_failover) and ONE check constraint; creates no table and no new function.
--
-- Why (incident of 2026-10-31 15:50 Cairo): the only key (the main key) was marked «out_of_balance» by one 402, an urgent alert was opened and e-mailed, and the audit log
-- (treg_pool_events) holds NO row for it: when the failed key is the main key there is no next key, so the function logged nothing (only a failover logs an event). The status flip of
-- the main key is the most important thing the log could show; this adds it as kind «main_failed» with the reason the application passes (cause and endpoint, at most 60 characters).
--
-- The application does not depend on it: until it is applied the flip is recorded exactly as today (status, reason, alert) and nothing is lost.
-- Every other line of the function is unchanged from the live definition read on 2026-10-31 (03_treg_pool_functions.sql). The service role only; no new grants.

ALTER TABLE public.treg_pool_events DROP CONSTRAINT IF EXISTS treg_pool_events_kind_check;
ALTER TABLE public.treg_pool_events ADD CONSTRAINT treg_pool_events_kind_check
  CHECK (kind = ANY (ARRAY['key_added','key_removed','key_replaced','active_set','chain_set','rollout_on','rollout_off','failover','settings','main_failed']));

CREATE OR REPLACE FUNCTION public.treg_pool_record_failover(p_failed_key_id uuid, p_new_status text, p_reason text, p_source text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_failed public.treg_pool_keys%ROWTYPE;
  v_state public.treg_pool_state%ROWTYPE;
  v_to uuid;
  v_switched boolean := false;
  v_a_failover boolean := false;
  v_a_main boolean := false;
  v_a_main_failed boolean := false;
  v_to_is_main boolean := false;
BEGIN
  IF p_new_status IS NULL OR p_new_status NOT IN ('revoked', 'out_of_balance') THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_status'); END IF;
  IF p_source IS NULL OR p_source NOT IN ('website', 'worker', 'health') THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_source'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('treg_pool', 0));
  SELECT * INTO v_failed FROM public.treg_pool_keys WHERE id = p_failed_key_id AND removed_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'unknown_key'); END IF;
  SELECT * INTO v_state FROM public.treg_pool_state WHERE id = 1 FOR UPDATE;

  UPDATE public.treg_pool_keys SET status = p_new_status, status_reason = left(p_reason, 60), status_checked_at = now() WHERE id = p_failed_key_id;

  IF v_state.rollout_on AND v_state.active_key_id = p_failed_key_id THEN
    v_to := public.treg_pool_next_key(p_failed_key_id);
    IF v_to IS NOT NULL THEN
      UPDATE public.treg_pool_state SET active_key_id = v_to, generation = generation + 1, updated_at = now(), updated_by = NULL WHERE id = 1;
      v_switched := true;
      SELECT is_main INTO v_to_is_main FROM public.treg_pool_keys WHERE id = v_to;
      PERFORM public.treg_pool_log_event('failover', p_failed_key_id, v_to, p_reason, p_source, NULL);
      v_a_failover := public.treg_pool_claim_alert('failover', p_failed_key_id, p_new_status, v_to);
      IF v_to_is_main THEN v_a_main := public.treg_pool_claim_alert('chain_reached_main', v_to, 'chain_reached_main', NULL); END IF;
    ELSE
      -- the main key itself failed: nothing is left after it. NEW: the flip is logged (it used to leave no row at all)
      PERFORM public.treg_pool_log_event('main_failed', p_failed_key_id, NULL, p_reason, p_source, NULL);
      v_a_main_failed := public.treg_pool_claim_alert('main_failed', p_failed_key_id, p_new_status, NULL);
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'switched', v_switched, 'active_id', (SELECT active_key_id FROM public.treg_pool_state WHERE id = 1),
    'alert_failover', v_a_failover, 'alert_chain_reached_main', v_a_main, 'alert_main_failed', v_a_main_failed);
END;
$function$;

-- grants: exactly as before (a CREATE OR REPLACE keeps them; restated so the file stands on its own). Never anon, never authenticated.
REVOKE ALL ON FUNCTION public.treg_pool_record_failover(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.treg_pool_record_failover(uuid, text, text, text) TO service_role;
