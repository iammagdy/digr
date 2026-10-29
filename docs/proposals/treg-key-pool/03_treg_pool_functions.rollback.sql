-- ROLLBACK of 03. Run after 04 was rolled back, before 02's rollback. Nothing existing depends on these functions until the application code that
-- uses them is merged; with the rollout switch OFF the application does not call them for any key.
DROP FUNCTION IF EXISTS public.treg_pool_mark_alert_emailed(bigint, boolean);
DROP FUNCTION IF EXISTS public.treg_pool_take_pending_alerts(integer);
DROP FUNCTION IF EXISTS public.treg_pool_note_worker(text);
DROP FUNCTION IF EXISTS public.treg_pool_claim_health_run(integer);
DROP FUNCTION IF EXISTS public.treg_pool_overview();
DROP FUNCTION IF EXISTS public.treg_pool_spend();
DROP FUNCTION IF EXISTS public.treg_pool_record_call(bigint, uuid, text);
DROP FUNCTION IF EXISTS public.treg_pool_record_check(uuid, text, text, bigint, text, text);
DROP FUNCTION IF EXISTS public.treg_pool_record_failover(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.treg_pool_next_key(uuid);
DROP FUNCTION IF EXISTS public.treg_pool_runtime();
DROP FUNCTION IF EXISTS public.treg_pool_enc_key();
DROP FUNCTION IF EXISTS public.admin_set_treg_pool_settings(uuid, bigint);
DROP FUNCTION IF EXISTS public.admin_set_treg_rollout(uuid, boolean);
DROP FUNCTION IF EXISTS public.admin_set_treg_chain(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.admin_set_treg_active_key(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.admin_remove_treg_pool_key(uuid, uuid);
DROP FUNCTION IF EXISTS public.admin_replace_treg_pool_key(uuid, uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public.admin_add_treg_pool_key(uuid, uuid, text, text, text, text, boolean);
DROP FUNCTION IF EXISTS public.treg_pool_clear_alerts(uuid, text[]);
DROP FUNCTION IF EXISTS public.treg_pool_claim_alert(text, uuid, text, uuid);
DROP FUNCTION IF EXISTS public.treg_pool_log_event(text, uuid, uuid, text, text, uuid);
