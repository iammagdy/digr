-- DT-20261119-02 (D-0105) · READ-ONLY verification of the 22 migrations that differ between the repo and production's supabase_migrations.schema_migrations.
-- ONE SELECT, no write, no function created, no DDL: it only reads pg_catalog, information_schema, supabase_migrations.schema_migrations and capability_registry. Run it in the Supabase SQL editor and send the 22 result rows back.
-- It changes nothing (no schema, no row). Nobody on the team runs it: Megz does.
--
-- One result row per migration (22 rows):
--   group_      A = the 8 files whose NAME is in production under ANOTHER version (repo version -> production version);  B = the 14 repo files not recorded in production.
--   status      present = every STRUCTURAL check is true (tables, columns, indexes, constraints, RLS, privileges, triggers, functions with their exact signature and privileges, extensions, registry rows; and, where the migration only REPLACES a function that already existed, the distinctive line of the new body: prevent_claim_after_collection_complete, admin_invoices_statement, record_production_quote_and_settle);
--               PARTIAL = some are missing (see `missing`);  MISSING = none is there.
--   body_marker how many functions still hold the distinctive line of the repo's definition (INFORMATION ONLY: a function may have been replaced on purpose by a LATER migration, e.g. the 25,000-point cap
--               of D-0064; a `0 of n` there never makes a migration «missing»; the team reads it with the repo and decides).
--   data_note   data checks (registry rows), also information only.
--   recorded_in_prod  true when production's schema_migrations already holds a row for the repo version (A: for the PRODUCTION version of the same name).
-- Nothing is concluded from this query alone: the team reads the 22 rows, then writes the recording SQL only for the migrations that show `present`.
WITH checks(migration, kind, item, ok) AS (
  SELECT 'fix_provider_spend_scope'::text, 'S'::text, 'function reserve_provider_spend_atomic(text,text,numeric,numeric)'::text, coalesce((to_regprocedure('public.reserve_provider_spend_atomic(text,text,numeric,numeric)') is not null),false)
  UNION ALL
  SELECT 'fix_provider_spend_scope'::text, 'S'::text, 'privileges of reserve_provider_spend_atomic(text,text,numeric,numeric): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.reserve_provider_spend_atomic(text,text,numeric,numeric)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.reserve_provider_spend_atomic(text,text,numeric,numeric)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.reserve_provider_spend_atomic(text,text,numeric,numeric)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.reserve_provider_spend_atomic(text,text,numeric,numeric)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'fix_provider_spend_scope'::text, 'B'::text, 'body of reserve_provider_spend_atomic(text,text,numeric,numeric) holds «WHERE provider = p_provider»'::text, coalesce((coalesce(position('WHERE provider = p_provider' in pg_get_functiondef(to_regprocedure('public.reserve_provider_spend_atomic(text,text,numeric,numeric)')))>0,false)),false)
  UNION ALL
  SELECT 'request_attempt_history'::text, 'S'::text, 'column messages.request_status'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='request_status')),false)
  UNION ALL
  SELECT 'request_attempt_history'::text, 'S'::text, 'column messages.request_error'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='request_error')),false)
  UNION ALL
  SELECT 'request_attempt_history'::text, 'S'::text, 'column messages.request_quote_id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='request_quote_id')),false)
  UNION ALL
  SELECT 'request_attempt_history'::text, 'S'::text, 'constraint messages.messages_request_status_check with «needs_input»'::text, coalesce((exists(select 1 from pg_constraint where conrelid=to_regclass('public.messages') and conname='messages_request_status_check' and pg_get_constraintdef(oid) like '%needs_input%')),false)
  UNION ALL
  SELECT 'request_attempt_history'::text, 'S'::text, 'index idx_messages_request_history'::text, coalesce((exists(select 1 from pg_indexes where schemaname='public' and indexname='idx_messages_request_history')),false)
  UNION ALL
  SELECT 'request_attempt_history'::text, 'S'::text, 'index idx_messages_request_quote_id'::text, coalesce((exists(select 1 from pg_indexes where schemaname='public' and indexname='idx_messages_request_quote_id')),false)
  UNION ALL
  SELECT 'register_professional_people_search'::text, 'S'::text, 'capability_registry row professional-people-search'::text, coalesce((exists(select 1 from public.capability_registry where slug='professional-people-search')),false)
  UNION ALL
  SELECT 'register_professional_people_search'::text, 'D'::text, 'capability_registry icypeas-people-search is switched off (data; may have changed on purpose)'::text, coalesce((exists(select 1 from public.capability_registry where slug='icypeas-people-search' and enabled=false)),false)
  UNION ALL
  SELECT 'cleanup_capability_registry_social'::text, 'S'::text, 'table capability_registry_backup_20261017175000'::text, coalesce((to_regclass('public.capability_registry_backup_20261017175000') is not null),false)
  UNION ALL
  SELECT 'cleanup_capability_registry_social'::text, 'S'::text, 'privileges of capability_registry_backup_20261017175000: service_role SELECT; anon/authenticated/public none'::text, coalesce((coalesce(has_table_privilege('service_role',to_regclass('public.capability_registry_backup_20261017175000'),'SELECT') and not has_table_privilege('anon',to_regclass('public.capability_registry_backup_20261017175000'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.capability_registry_backup_20261017175000'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.capability_registry_backup_20261017175000'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'cleanup_capability_registry_social'::text, 'S'::text, 'capability_registry row social-tiktok-comments'::text, coalesce((exists(select 1 from public.capability_registry where slug='social-tiktok-comments')),false)
  UNION ALL
  SELECT 'cleanup_capability_registry_social'::text, 'S'::text, 'capability_registry row social-youtube-comments'::text, coalesce((exists(select 1 from public.capability_registry where slug='social-youtube-comments')),false)
  UNION ALL
  SELECT 'cleanup_capability_registry_social'::text, 'S'::text, 'capability_registry row social-facebook-comments'::text, coalesce((exists(select 1 from public.capability_registry where slug='social-facebook-comments')),false)
  UNION ALL
  SELECT 'cleanup_capability_registry_social'::text, 'S'::text, 'capability_registry row social-tiktok-videos'::text, coalesce((exists(select 1 from public.capability_registry where slug='social-tiktok-videos')),false)
  UNION ALL
  SELECT 'cleanup_capability_registry_social'::text, 'S'::text, 'capability_registry row social-youtube-videos'::text, coalesce((exists(select 1 from public.capability_registry where slug='social-youtube-videos')),false)
  UNION ALL
  SELECT 'cleanup_capability_registry_social'::text, 'S'::text, 'capability_registry row social-facebook-posts'::text, coalesce((exists(select 1 from public.capability_registry where slug='social-facebook-posts')),false)
  UNION ALL
  SELECT 'cleanup_capability_registry_social'::text, 'D'::text, 'no capability_registry row is left on the retired endpoints (data; may have changed on purpose)'::text, coalesce((not exists(select 1 from public.capability_registry where endpoint_id = any(array['facebook.page.posts','google.serp.organic','instagram.user.profile','instagram.user.posts','telegram.channel.messages','tikhub.tiktok.search.video','tikhub.tiktok.user.posts','twitter.search.tweets','twitter.user.tweets','youtube.channel.details','youtube.search.video','internal-facebook-post-comments','internal-youtube-comments']))),false)
  UNION ALL
  SELECT 'settle_completed_jobs_with_stale_lease'::text, 'S'::text, 'function settle_job_atomic(text,numeric,text)'::text, coalesce((to_regprocedure('public.settle_job_atomic(text,numeric,text)') is not null),false)
  UNION ALL
  SELECT 'settle_completed_jobs_with_stale_lease'::text, 'S'::text, 'privileges of settle_job_atomic(text,numeric,text): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.settle_job_atomic(text,numeric,text)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.settle_job_atomic(text,numeric,text)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.settle_job_atomic(text,numeric,text)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.settle_job_atomic(text,numeric,text)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'settle_completed_jobs_with_stale_lease'::text, 'B'::text, 'body of settle_job_atomic(text,numeric,text) holds «Cannot settle job % while active chunk lease is he»'::text, coalesce((coalesce(position('Cannot settle job % while active chunk lease is held until %' in pg_get_functiondef(to_regprocedure('public.settle_job_atomic(text,numeric,text)')))>0,false)),false)
  UNION ALL
  SELECT 'create_quote_atomic'::text, 'S'::text, 'function create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])'::text, coalesce((to_regprocedure('public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])') is not null),false)
  UNION ALL
  SELECT 'create_quote_atomic'::text, 'S'::text, 'privileges of create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[]): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'create_quote_atomic'::text, 'B'::text, 'body of create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[]) holds «quote items must be a non-empty JSON array»'::text, coalesce((coalesce(position('quote items must be a non-empty JSON array' in pg_get_functiondef(to_regprocedure('public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])')))>0,false)),false)
  UNION ALL
  SELECT 'approve_topup_atomic_privileges'::text, 'S'::text, 'function approve_topup_atomic(text,numeric)'::text, coalesce((to_regprocedure('public.approve_topup_atomic(text,numeric)') is not null),false)
  UNION ALL
  SELECT 'approve_topup_atomic_privileges'::text, 'S'::text, 'privileges of approve_topup_atomic(text,numeric): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.approve_topup_atomic(text,numeric)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.approve_topup_atomic(text,numeric)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.approve_topup_atomic(text,numeric)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.approve_topup_atomic(text,numeric)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'approve_topup_atomic_privileges'::text, 'S'::text, 'function reject_topup_atomic(text)'::text, coalesce((to_regprocedure('public.reject_topup_atomic(text)') is not null),false)
  UNION ALL
  SELECT 'approve_topup_atomic_privileges'::text, 'S'::text, 'privileges of reject_topup_atomic(text): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.reject_topup_atomic(text)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.reject_topup_atomic(text)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.reject_topup_atomic(text)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.reject_topup_atomic(text)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'approve_topup_atomic_privileges'::text, 'B'::text, 'body of approve_topup_atomic(text,numeric) holds «''error'', ''invalid_amount''»'::text, coalesce((coalesce(position('''error'', ''invalid_amount''' in pg_get_functiondef(to_regprocedure('public.approve_topup_atomic(text,numeric)')))>0,false)),false)
  UNION ALL
  SELECT 'approve_topup_atomic_privileges'::text, 'B'::text, 'body of reject_topup_atomic(text) holds «''error'', ''invalid_status''»'::text, coalesce((coalesce(position('''error'', ''invalid_status''' in pg_get_functiondef(to_regprocedure('public.reject_topup_atomic(text)')))>0,false)),false)
  UNION ALL
  SELECT 'settle_decision_maker_fields'::text, 'S'::text, 'function settle_people_job_atomic(text,integer,integer,integer,numeric,text)'::text, coalesce((to_regprocedure('public.settle_people_job_atomic(text,integer,integer,integer,numeric,text)') is not null),false)
  UNION ALL
  SELECT 'settle_decision_maker_fields'::text, 'S'::text, 'privileges of settle_people_job_atomic(text,integer,integer,integer,numeric,text): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.settle_people_job_atomic(text,integer,integer,integer,numeric,text)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.settle_people_job_atomic(text,integer,integer,integer,numeric,text)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.settle_people_job_atomic(text,integer,integer,integer,numeric,text)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.settle_people_job_atomic(text,integer,integer,integer,numeric,text)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'settle_decision_maker_fields'::text, 'B'::text, 'body of settle_people_job_atomic(text,integer,integer,integer,numeric,text) holds «Cannot settle job % while collection is incomplete»'::text, coalesce((coalesce(position('Cannot settle job % while collection is incomplete' in pg_get_functiondef(to_regprocedure('public.settle_people_job_atomic(text,integer,integer,integer,numeric,text)')))>0,false)),false)
  UNION ALL
  SELECT 'welcome_email_on_confirm'::text, 'S'::text, 'extension pg_net'::text, coalesce((exists(select 1 from pg_extension where extname='pg_net')),false)
  UNION ALL
  SELECT 'welcome_email_on_confirm'::text, 'S'::text, 'Vault (extension supabase_vault or vault, or the vault.decrypted_secrets view)'::text, coalesce((exists(select 1 from pg_extension where extname in ('supabase_vault','vault')) or to_regclass('vault.decrypted_secrets') is not null),false)
  UNION ALL
  SELECT 'welcome_email_on_confirm'::text, 'S'::text, 'function send_welcome_email()'::text, coalesce((to_regprocedure('public.send_welcome_email()') is not null),false)
  UNION ALL
  SELECT 'welcome_email_on_confirm'::text, 'S'::text, 'privileges of send_welcome_email(): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.send_welcome_email()'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.send_welcome_email()'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.send_welcome_email()'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.send_welcome_email()'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'welcome_email_on_confirm'::text, 'B'::text, 'body of send_welcome_email() holds «send-email-service-role-key»'::text, coalesce((coalesce(position('send-email-service-role-key' in pg_get_functiondef(to_regprocedure('public.send_welcome_email()')))>0,false)),false)
  UNION ALL
  SELECT 'welcome_email_on_confirm'::text, 'S'::text, 'trigger on_email_confirmed_send_welcome on auth.users (enabled)'::text, coalesce((exists(select 1 from pg_trigger where tgname='on_email_confirmed_send_welcome' and tgrelid=to_regclass('auth.users') and not tgisinternal and tgenabled='O')),false)
  UNION ALL
  SELECT 'prevent_claim_after_collection_complete'::text, 'S'::text, 'function claim_job_chunk(text,integer,integer)'::text, coalesce((to_regprocedure('public.claim_job_chunk(text,integer,integer)') is not null),false)
  UNION ALL
  SELECT 'prevent_claim_after_collection_complete'::text, 'S'::text, 'body of claim_job_chunk(text,integer,integer) holds «''already_completed''»'::text, coalesce((coalesce(position('''already_completed''' in pg_get_functiondef(to_regprocedure('public.claim_job_chunk(text,integer,integer)')))>0,false)),false)
  UNION ALL
  SELECT 'seed_company_and_people_capabilities'::text, 'S'::text, 'capability_registry row icypeas-companies-search'::text, coalesce((exists(select 1 from public.capability_registry where slug='icypeas-companies-search')),false)
  UNION ALL
  SELECT 'seed_company_and_people_capabilities'::text, 'S'::text, 'capability_registry row icypeas-people-search'::text, coalesce((exists(select 1 from public.capability_registry where slug='icypeas-people-search')),false)
  UNION ALL
  SELECT 'credit_ledger_kinds'::text, 'S'::text, 'table credit_ledger_kinds'::text, coalesce((to_regclass('public.credit_ledger_kinds') is not null),false)
  UNION ALL
  SELECT 'credit_ledger_kinds'::text, 'S'::text, 'column credit_ledger_kinds.ledger_id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='credit_ledger_kinds' and column_name='ledger_id')),false)
  UNION ALL
  SELECT 'credit_ledger_kinds'::text, 'S'::text, 'column credit_ledger_kinds.kind'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='credit_ledger_kinds' and column_name='kind')),false)
  UNION ALL
  SELECT 'credit_ledger_kinds'::text, 'S'::text, 'column credit_ledger_kinds.actor_id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='credit_ledger_kinds' and column_name='actor_id')),false)
  UNION ALL
  SELECT 'credit_ledger_kinds'::text, 'S'::text, 'column credit_ledger_kinds.created_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='credit_ledger_kinds' and column_name='created_at')),false)
  UNION ALL
  SELECT 'credit_ledger_kinds'::text, 'S'::text, 'RLS on credit_ledger_kinds'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.credit_ledger_kinds')),false)),false)
  UNION ALL
  SELECT 'credit_ledger_kinds'::text, 'S'::text, 'privileges of credit_ledger_kinds: service_role SELECT,INSERT; anon/authenticated/public none'::text, coalesce((coalesce(has_table_privilege('service_role',to_regclass('public.credit_ledger_kinds'),'SELECT,INSERT') and not has_table_privilege('anon',to_regclass('public.credit_ledger_kinds'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.credit_ledger_kinds'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.credit_ledger_kinds'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'credit_ledger_kinds'::text, 'S'::text, 'function block_credit_kind_mutation()'::text, coalesce((to_regprocedure('public.block_credit_kind_mutation()') is not null),false)
  UNION ALL
  SELECT 'credit_ledger_kinds'::text, 'S'::text, 'trigger trg_block_credit_kind_mutation on public.credit_ledger_kinds (enabled)'::text, coalesce((exists(select 1 from pg_trigger where tgname='trg_block_credit_kind_mutation' and tgrelid=to_regclass('public.credit_ledger_kinds') and not tgisinternal and tgenabled='O')),false)
  UNION ALL
  SELECT 'credit_ledger_kinds'::text, 'S'::text, 'view credit_ledger_typed with security_invoker'::text, coalesce((coalesce((select 'security_invoker=true' = any(reloptions) from pg_class where oid=to_regclass('public.credit_ledger_typed')),false)),false)
  UNION ALL
  SELECT 'credit_ledger_kinds'::text, 'S'::text, 'privileges of credit_ledger_typed: service_role SELECT; anon/authenticated/public none'::text, coalesce((coalesce(has_table_privilege('service_role',to_regclass('public.credit_ledger_typed'),'SELECT') and not has_table_privilege('anon',to_regclass('public.credit_ledger_typed'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.credit_ledger_typed'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.credit_ledger_typed'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'table promo_codes'::text, coalesce((to_regclass('public.promo_codes') is not null),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_codes.code'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_codes' and column_name='code')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_codes.points'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_codes' and column_name='points')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_codes.max_redemptions'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_codes' and column_name='max_redemptions')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_codes.per_account_limit'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_codes' and column_name='per_account_limit')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_codes.starts_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_codes' and column_name='starts_at')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_codes.expires_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_codes' and column_name='expires_at')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_codes.active'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_codes' and column_name='active')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_codes.created_by'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_codes' and column_name='created_by')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_codes.note'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_codes' and column_name='note')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_codes.created_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_codes' and column_name='created_at')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_codes.updated_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_codes' and column_name='updated_at')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'table promo_redemptions'::text, coalesce((to_regclass('public.promo_redemptions') is not null),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_redemptions.id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_redemptions' and column_name='id')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_redemptions.code'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_redemptions' and column_name='code')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_redemptions.user_id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_redemptions' and column_name='user_id')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_redemptions.ledger_id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_redemptions' and column_name='ledger_id')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'column promo_redemptions.redeemed_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='promo_redemptions' and column_name='redeemed_at')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'index promo_redemptions_user_idx'::text, coalesce((exists(select 1 from pg_indexes where schemaname='public' and indexname='promo_redemptions_user_idx')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'RLS on promo_codes'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.promo_codes')),false)),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'RLS on promo_redemptions'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.promo_redemptions')),false)),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'privileges of promo_codes: service_role SELECT; anon/authenticated/public none'::text, coalesce((coalesce(has_table_privilege('service_role',to_regclass('public.promo_codes'),'SELECT') and not has_table_privilege('anon',to_regclass('public.promo_codes'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.promo_codes'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.promo_codes'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'privileges of promo_redemptions: service_role SELECT; anon/authenticated/public none'::text, coalesce((coalesce(has_table_privilege('service_role',to_regclass('public.promo_redemptions'),'SELECT') and not has_table_privilege('anon',to_regclass('public.promo_redemptions'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.promo_redemptions'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.promo_redemptions'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'unique (code, user_id) on promo_redemptions'::text, coalesce((exists(select 1 from pg_constraint where conrelid=to_regclass('public.promo_redemptions') and contype='u')),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'function redeem_promo_code_atomic(uuid,text)'::text, coalesce((to_regprocedure('public.redeem_promo_code_atomic(uuid,text)') is not null),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'privileges of redeem_promo_code_atomic(uuid,text): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.redeem_promo_code_atomic(uuid,text)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.redeem_promo_code_atomic(uuid,text)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.redeem_promo_code_atomic(uuid,text)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.redeem_promo_code_atomic(uuid,text)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'B'::text, 'body of redeem_promo_code_atomic(uuid,text) holds «''error'', ''invalid_code''»'::text, coalesce((coalesce(position('''error'', ''invalid_code''' in pg_get_functiondef(to_regprocedure('public.redeem_promo_code_atomic(uuid,text)')))>0,false)),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'function admin_grant_credit_atomic(uuid,uuid,numeric,text,text)'::text, coalesce((to_regprocedure('public.admin_grant_credit_atomic(uuid,uuid,numeric,text,text)') is not null),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'privileges of admin_grant_credit_atomic(uuid,uuid,numeric,text,text): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.admin_grant_credit_atomic(uuid,uuid,numeric,text,text)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.admin_grant_credit_atomic(uuid,uuid,numeric,text,text)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.admin_grant_credit_atomic(uuid,uuid,numeric,text,text)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.admin_grant_credit_atomic(uuid,uuid,numeric,text,text)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'B'::text, 'body of admin_grant_credit_atomic(uuid,uuid,numeric,text,text) holds «''error'', ''invalid_note''»'::text, coalesce((coalesce(position('''error'', ''invalid_note''' in pg_get_functiondef(to_regprocedure('public.admin_grant_credit_atomic(uuid,uuid,numeric,text,text)')))>0,false)),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'function admin_save_promo_code_atomic(uuid,text,integer,integer,timestamptz,timestamptz,boolean,text)'::text, coalesce((to_regprocedure('public.admin_save_promo_code_atomic(uuid,text,integer,integer,timestamptz,timestamptz,boolean,text)') is not null),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'S'::text, 'privileges of admin_save_promo_code_atomic(uuid,text,integer,integer,timestamptz,timestamptz,boolean,text): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.admin_save_promo_code_atomic(uuid,text,integer,integer,timestamptz,timestamptz,boolean,text)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.admin_save_promo_code_atomic(uuid,text,integer,integer,timestamptz,timestamptz,boolean,text)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.admin_save_promo_code_atomic(uuid,text,integer,integer,timestamptz,timestamptz,boolean,text)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.admin_save_promo_code_atomic(uuid,text,integer,integer,timestamptz,timestamptz,boolean,text)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'promo_codes_and_admin_grants'::text, 'B'::text, 'body of admin_save_promo_code_atomic(uuid,text,integer,integer,timestamptz,timestamptz,boolean,text) holds «''error'', ''invalid_points''»'::text, coalesce((coalesce(position('''error'', ''invalid_points''' in pg_get_functiondef(to_regprocedure('public.admin_save_promo_code_atomic(uuid,text,integer,integer,timestamptz,timestamptz,boolean,text)')))>0,false)),false)
  UNION ALL
  SELECT 'support_messages'::text, 'S'::text, 'table support_messages'::text, coalesce((to_regclass('public.support_messages') is not null),false)
  UNION ALL
  SELECT 'support_messages'::text, 'S'::text, 'column support_messages.id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='support_messages' and column_name='id')),false)
  UNION ALL
  SELECT 'support_messages'::text, 'S'::text, 'column support_messages.user_id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='support_messages' and column_name='user_id')),false)
  UNION ALL
  SELECT 'support_messages'::text, 'S'::text, 'column support_messages.name'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='support_messages' and column_name='name')),false)
  UNION ALL
  SELECT 'support_messages'::text, 'S'::text, 'column support_messages.email'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='support_messages' and column_name='email')),false)
  UNION ALL
  SELECT 'support_messages'::text, 'S'::text, 'column support_messages.message'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='support_messages' and column_name='message')),false)
  UNION ALL
  SELECT 'support_messages'::text, 'S'::text, 'column support_messages.job_id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='support_messages' and column_name='job_id')),false)
  UNION ALL
  SELECT 'support_messages'::text, 'S'::text, 'column support_messages.source'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='support_messages' and column_name='source')),false)
  UNION ALL
  SELECT 'support_messages'::text, 'S'::text, 'column support_messages.status'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='support_messages' and column_name='status')),false)
  UNION ALL
  SELECT 'support_messages'::text, 'S'::text, 'column support_messages.emailed'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='support_messages' and column_name='emailed')),false)
  UNION ALL
  SELECT 'support_messages'::text, 'S'::text, 'column support_messages.created_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='support_messages' and column_name='created_at')),false)
  UNION ALL
  SELECT 'support_messages'::text, 'S'::text, 'index support_messages_created_idx'::text, coalesce((exists(select 1 from pg_indexes where schemaname='public' and indexname='support_messages_created_idx')),false)
  UNION ALL
  SELECT 'support_messages'::text, 'S'::text, 'RLS on support_messages'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.support_messages')),false)),false)
  UNION ALL
  SELECT 'support_messages'::text, 'S'::text, 'privileges of support_messages: service_role SELECT,INSERT,UPDATE; anon/authenticated/public none'::text, coalesce((coalesce(has_table_privilege('service_role',to_regclass('public.support_messages'),'SELECT,INSERT,UPDATE') and not has_table_privilege('anon',to_regclass('public.support_messages'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.support_messages'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.support_messages'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'table provider_api_keys'::text, coalesce((to_regclass('public.provider_api_keys') is not null),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_api_keys.provider'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_api_keys' and column_name='provider')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_api_keys.active_ciphertext'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_api_keys' and column_name='active_ciphertext')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_api_keys.active_last4'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_api_keys' and column_name='active_last4')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_api_keys.active_set_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_api_keys' and column_name='active_set_at')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_api_keys.active_set_by'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_api_keys' and column_name='active_set_by')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_api_keys.previous_ciphertext'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_api_keys' and column_name='previous_ciphertext')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_api_keys.previous_last4'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_api_keys' and column_name='previous_last4')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_api_keys.previous_set_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_api_keys' and column_name='previous_set_at')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_api_keys.version'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_api_keys' and column_name='version')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_api_keys.updated_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_api_keys' and column_name='updated_at')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'table provider_key_audit'::text, coalesce((to_regclass('public.provider_key_audit') is not null),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_key_audit.id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_key_audit' and column_name='id')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_key_audit.provider'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_key_audit' and column_name='provider')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_key_audit.action'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_key_audit' and column_name='action')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_key_audit.last4'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_key_audit' and column_name='last4')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_key_audit.actor_id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_key_audit' and column_name='actor_id')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'column provider_key_audit.created_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_key_audit' and column_name='created_at')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'index provider_key_audit_created_idx'::text, coalesce((exists(select 1 from pg_indexes where schemaname='public' and indexname='provider_key_audit_created_idx')),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'RLS on provider_api_keys'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.provider_api_keys')),false)),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'RLS on provider_key_audit'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.provider_key_audit')),false)),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'privileges of provider_api_keys: service_role SELECT; anon/authenticated/public none'::text, coalesce((coalesce(has_table_privilege('service_role',to_regclass('public.provider_api_keys'),'SELECT') and not has_table_privilege('anon',to_regclass('public.provider_api_keys'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.provider_api_keys'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.provider_api_keys'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'privileges of provider_key_audit: service_role SELECT; anon/authenticated/public none'::text, coalesce((coalesce(has_table_privilege('service_role',to_regclass('public.provider_key_audit'),'SELECT') and not has_table_privilege('anon',to_regclass('public.provider_key_audit'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.provider_key_audit'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.provider_key_audit'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'function block_provider_key_audit_mutation()'::text, coalesce((to_regprocedure('public.block_provider_key_audit_mutation()') is not null),false)
  UNION ALL
  SELECT 'provider_api_keys_tables'::text, 'S'::text, 'trigger trg_block_provider_key_audit_mutation on public.provider_key_audit (enabled)'::text, coalesce((exists(select 1 from pg_trigger where tgname='trg_block_provider_key_audit_mutation' and tgrelid=to_regclass('public.provider_key_audit') and not tgisinternal and tgenabled='O')),false)
  UNION ALL
  SELECT 'provider_api_keys_functions'::text, 'S'::text, 'function admin_set_provider_key_atomic(uuid,text,text,text)'::text, coalesce((to_regprocedure('public.admin_set_provider_key_atomic(uuid,text,text,text)') is not null),false)
  UNION ALL
  SELECT 'provider_api_keys_functions'::text, 'S'::text, 'privileges of admin_set_provider_key_atomic(uuid,text,text,text): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.admin_set_provider_key_atomic(uuid,text,text,text)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.admin_set_provider_key_atomic(uuid,text,text,text)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.admin_set_provider_key_atomic(uuid,text,text,text)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.admin_set_provider_key_atomic(uuid,text,text,text)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'provider_api_keys_functions'::text, 'B'::text, 'body of admin_set_provider_key_atomic(uuid,text,text,text) holds «''error'', ''invalid_ciphertext''»'::text, coalesce((coalesce(position('''error'', ''invalid_ciphertext''' in pg_get_functiondef(to_regprocedure('public.admin_set_provider_key_atomic(uuid,text,text,text)')))>0,false)),false)
  UNION ALL
  SELECT 'provider_api_keys_functions'::text, 'S'::text, 'function admin_rollback_provider_key_atomic(uuid,text)'::text, coalesce((to_regprocedure('public.admin_rollback_provider_key_atomic(uuid,text)') is not null),false)
  UNION ALL
  SELECT 'provider_api_keys_functions'::text, 'S'::text, 'privileges of admin_rollback_provider_key_atomic(uuid,text): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.admin_rollback_provider_key_atomic(uuid,text)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.admin_rollback_provider_key_atomic(uuid,text)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.admin_rollback_provider_key_atomic(uuid,text)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.admin_rollback_provider_key_atomic(uuid,text)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'provider_api_keys_functions'::text, 'B'::text, 'body of admin_rollback_provider_key_atomic(uuid,text) holds «''error'', ''no_previous_key''»'::text, coalesce((coalesce(position('''error'', ''no_previous_key''' in pg_get_functiondef(to_regprocedure('public.admin_rollback_provider_key_atomic(uuid,text)')))>0,false)),false)
  UNION ALL
  SELECT 'provider_limits'::text, 'S'::text, 'table provider_limits_audit'::text, coalesce((to_regclass('public.provider_limits_audit') is not null),false)
  UNION ALL
  SELECT 'provider_limits'::text, 'S'::text, 'column provider_limits_audit.id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_limits_audit' and column_name='id')),false)
  UNION ALL
  SELECT 'provider_limits'::text, 'S'::text, 'column provider_limits_audit.actor_id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_limits_audit' and column_name='actor_id')),false)
  UNION ALL
  SELECT 'provider_limits'::text, 'S'::text, 'column provider_limits_audit.old_value'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_limits_audit' and column_name='old_value')),false)
  UNION ALL
  SELECT 'provider_limits'::text, 'S'::text, 'column provider_limits_audit.new_value'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_limits_audit' and column_name='new_value')),false)
  UNION ALL
  SELECT 'provider_limits'::text, 'S'::text, 'column provider_limits_audit.created_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='provider_limits_audit' and column_name='created_at')),false)
  UNION ALL
  SELECT 'provider_limits'::text, 'S'::text, 'index provider_limits_audit_created_idx'::text, coalesce((exists(select 1 from pg_indexes where schemaname='public' and indexname='provider_limits_audit_created_idx')),false)
  UNION ALL
  SELECT 'provider_limits'::text, 'S'::text, 'RLS on provider_limits_audit'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.provider_limits_audit')),false)),false)
  UNION ALL
  SELECT 'provider_limits'::text, 'S'::text, 'privileges of provider_limits_audit: service_role SELECT; anon/authenticated/public none'::text, coalesce((coalesce(has_table_privilege('service_role',to_regclass('public.provider_limits_audit'),'SELECT') and not has_table_privilege('anon',to_regclass('public.provider_limits_audit'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.provider_limits_audit'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.provider_limits_audit'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'provider_limits'::text, 'S'::text, 'function block_provider_limits_audit_mutation()'::text, coalesce((to_regprocedure('public.block_provider_limits_audit_mutation()') is not null),false)
  UNION ALL
  SELECT 'provider_limits'::text, 'S'::text, 'trigger trg_block_provider_limits_audit_mutation on public.provider_limits_audit (enabled)'::text, coalesce((exists(select 1 from pg_trigger where tgname='trg_block_provider_limits_audit_mutation' and tgrelid=to_regclass('public.provider_limits_audit') and not tgisinternal and tgenabled='O')),false)
  UNION ALL
  SELECT 'provider_limits'::text, 'S'::text, 'function admin_set_provider_limits_atomic(uuid,jsonb)'::text, coalesce((to_regprocedure('public.admin_set_provider_limits_atomic(uuid,jsonb)') is not null),false)
  UNION ALL
  SELECT 'provider_limits'::text, 'S'::text, 'privileges of admin_set_provider_limits_atomic(uuid,jsonb): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.admin_set_provider_limits_atomic(uuid,jsonb)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.admin_set_provider_limits_atomic(uuid,jsonb)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.admin_set_provider_limits_atomic(uuid,jsonb)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.admin_set_provider_limits_atomic(uuid,jsonb)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'provider_limits'::text, 'B'::text, 'body of admin_set_provider_limits_atomic(uuid,jsonb) holds «''error'', ''unknown_key''»'::text, coalesce((coalesce(position('''error'', ''unknown_key''' in pg_get_functiondef(to_regprocedure('public.admin_set_provider_limits_atomic(uuid,jsonb)')))>0,false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'table invoice_settings'::text, coalesce((to_regclass('public.invoice_settings') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'RLS on invoice_settings'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.invoice_settings')),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'table invoice_item_types'::text, coalesce((to_regclass('public.invoice_item_types') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'RLS on invoice_item_types'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.invoice_item_types')),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'table invoice_clients'::text, coalesce((to_regclass('public.invoice_clients') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'RLS on invoice_clients'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.invoice_clients')),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'table invoice_number_counters'::text, coalesce((to_regclass('public.invoice_number_counters') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'RLS on invoice_number_counters'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.invoice_number_counters')),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'table invoice_documents'::text, coalesce((to_regclass('public.invoice_documents') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'RLS on invoice_documents'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.invoice_documents')),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'table invoice_batches'::text, coalesce((to_regclass('public.invoice_batches') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'RLS on invoice_batches'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.invoice_batches')),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'table invoice_lines'::text, coalesce((to_regclass('public.invoice_lines') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'RLS on invoice_lines'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.invoice_lines')),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'table invoice_status_events'::text, coalesce((to_regclass('public.invoice_status_events') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'RLS on invoice_status_events'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.invoice_status_events')),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'no direct access to invoice_settings for anon/authenticated/public'::text, coalesce((coalesce(not has_table_privilege('anon',to_regclass('public.invoice_settings'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.invoice_settings'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.invoice_settings'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'no direct access to invoice_item_types for anon/authenticated/public'::text, coalesce((coalesce(not has_table_privilege('anon',to_regclass('public.invoice_item_types'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.invoice_item_types'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.invoice_item_types'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'no direct access to invoice_clients for anon/authenticated/public'::text, coalesce((coalesce(not has_table_privilege('anon',to_regclass('public.invoice_clients'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.invoice_clients'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.invoice_clients'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'no direct access to invoice_number_counters for anon/authenticated/public'::text, coalesce((coalesce(not has_table_privilege('anon',to_regclass('public.invoice_number_counters'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.invoice_number_counters'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.invoice_number_counters'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'no direct access to invoice_documents for anon/authenticated/public'::text, coalesce((coalesce(not has_table_privilege('anon',to_regclass('public.invoice_documents'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.invoice_documents'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.invoice_documents'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'no direct access to invoice_batches for anon/authenticated/public'::text, coalesce((coalesce(not has_table_privilege('anon',to_regclass('public.invoice_batches'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.invoice_batches'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.invoice_batches'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'no direct access to invoice_lines for anon/authenticated/public'::text, coalesce((coalesce(not has_table_privilege('anon',to_regclass('public.invoice_lines'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.invoice_lines'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.invoice_lines'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'no direct access to invoice_status_events for anon/authenticated/public'::text, coalesce((coalesce(not has_table_privilege('anon',to_regclass('public.invoice_status_events'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.invoice_status_events'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.invoice_status_events'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'index invoice_item_types_name_uq'::text, coalesce((exists(select 1 from pg_indexes where schemaname='public' and indexname='invoice_item_types_name_uq')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'index invoice_documents_status_idx'::text, coalesce((exists(select 1 from pg_indexes where schemaname='public' and indexname='invoice_documents_status_idx')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'index invoice_documents_client_idx'::text, coalesce((exists(select 1 from pg_indexes where schemaname='public' and indexname='invoice_documents_client_idx')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'index invoice_batches_doc_idx'::text, coalesce((exists(select 1 from pg_indexes where schemaname='public' and indexname='invoice_batches_doc_idx')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'index invoice_lines_doc_idx'::text, coalesce((exists(select 1 from pg_indexes where schemaname='public' and indexname='invoice_lines_doc_idx')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'index invoice_status_events_doc_idx'::text, coalesce((exists(select 1 from pg_indexes where schemaname='public' and indexname='invoice_status_events_doc_idx')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'trigger invoice_documents_number on public.invoice_documents (enabled)'::text, coalesce((exists(select 1 from pg_trigger where tgname='invoice_documents_number' and tgrelid=to_regclass('public.invoice_documents') and not tgisinternal and tgenabled='O')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'trigger invoice_documents_guard_t on public.invoice_documents (enabled)'::text, coalesce((exists(select 1 from pg_trigger where tgname='invoice_documents_guard_t' and tgrelid=to_regclass('public.invoice_documents') and not tgisinternal and tgenabled='O')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'trigger invoice_documents_no_delete on public.invoice_documents (enabled)'::text, coalesce((exists(select 1 from pg_trigger where tgname='invoice_documents_no_delete' and tgrelid=to_regclass('public.invoice_documents') and not tgisinternal and tgenabled='O')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'trigger invoice_documents_no_truncate on public.invoice_documents (enabled)'::text, coalesce((exists(select 1 from pg_trigger where tgname='invoice_documents_no_truncate' and tgrelid=to_regclass('public.invoice_documents') and not tgisinternal and tgenabled='O')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'trigger invoice_counters_no_delete on public.invoice_number_counters (enabled)'::text, coalesce((exists(select 1 from pg_trigger where tgname='invoice_counters_no_delete' and tgrelid=to_regclass('public.invoice_number_counters') and not tgisinternal and tgenabled='O')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'trigger invoice_counters_no_truncate on public.invoice_number_counters (enabled)'::text, coalesce((exists(select 1 from pg_trigger where tgname='invoice_counters_no_truncate' and tgrelid=to_regclass('public.invoice_number_counters') and not tgisinternal and tgenabled='O')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'trigger invoice_lines_guard on public.invoice_lines (enabled)'::text, coalesce((exists(select 1 from pg_trigger where tgname='invoice_lines_guard' and tgrelid=to_regclass('public.invoice_lines') and not tgisinternal and tgenabled='O')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'trigger invoice_batches_guard on public.invoice_batches (enabled)'::text, coalesce((exists(select 1 from pg_trigger where tgname='invoice_batches_guard' and tgrelid=to_regclass('public.invoice_batches') and not tgisinternal and tgenabled='O')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'trigger invoice_events_no_change on public.invoice_status_events (enabled)'::text, coalesce((exists(select 1 from pg_trigger where tgname='invoice_events_no_change' and tgrelid=to_regclass('public.invoice_status_events') and not tgisinternal and tgenabled='O')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'trigger invoice_events_no_truncate on public.invoice_status_events (enabled)'::text, coalesce((exists(select 1 from pg_trigger where tgname='invoice_events_no_truncate' and tgrelid=to_regclass('public.invoice_status_events') and not tgisinternal and tgenabled='O')),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'function invoice_create_document(uuid,text,jsonb,uuid,uuid)'::text, coalesce((to_regprocedure('public.invoice_create_document(uuid,text,jsonb,uuid,uuid)') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'privileges of invoice_create_document(uuid,text,jsonb,uuid,uuid): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.invoice_create_document(uuid,text,jsonb,uuid,uuid)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.invoice_create_document(uuid,text,jsonb,uuid,uuid)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.invoice_create_document(uuid,text,jsonb,uuid,uuid)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.invoice_create_document(uuid,text,jsonb,uuid,uuid)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'B'::text, 'body of invoice_create_document(uuid,text,jsonb,uuid,uuid) holds «invoice_admin_required»'::text, coalesce((coalesce(position('invoice_admin_required' in pg_get_functiondef(to_regprocedure('public.invoice_create_document(uuid,text,jsonb,uuid,uuid)')))>0,false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'function invoice_save_draft(uuid,uuid,integer,jsonb)'::text, coalesce((to_regprocedure('public.invoice_save_draft(uuid,uuid,integer,jsonb)') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'privileges of invoice_save_draft(uuid,uuid,integer,jsonb): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.invoice_save_draft(uuid,uuid,integer,jsonb)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.invoice_save_draft(uuid,uuid,integer,jsonb)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.invoice_save_draft(uuid,uuid,integer,jsonb)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.invoice_save_draft(uuid,uuid,integer,jsonb)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'B'::text, 'body of invoice_save_draft(uuid,uuid,integer,jsonb) holds «invoice_locked»'::text, coalesce((coalesce(position('invoice_locked' in pg_get_functiondef(to_regprocedure('public.invoice_save_draft(uuid,uuid,integer,jsonb)')))>0,false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'function invoice_set_status(uuid,uuid,text,integer,jsonb,date,text,text)'::text, coalesce((to_regprocedure('public.invoice_set_status(uuid,uuid,text,integer,jsonb,date,text,text)') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'privileges of invoice_set_status(uuid,uuid,text,integer,jsonb,date,text,text): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.invoice_set_status(uuid,uuid,text,integer,jsonb,date,text,text)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.invoice_set_status(uuid,uuid,text,integer,jsonb,date,text,text)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.invoice_set_status(uuid,uuid,text,integer,jsonb,date,text,text)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.invoice_set_status(uuid,uuid,text,integer,jsonb,date,text,text)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'B'::text, 'body of invoice_set_status(uuid,uuid,text,integer,jsonb,date,text,text) holds «invoice_bad_transition»'::text, coalesce((coalesce(position('invoice_bad_transition' in pg_get_functiondef(to_regprocedure('public.invoice_set_status(uuid,uuid,text,integer,jsonb,date,text,text)')))>0,false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'function invoice__apply_fields(uuid,jsonb)'::text, coalesce((to_regprocedure('public.invoice__apply_fields(uuid,jsonb)') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'privileges of invoice__apply_fields(uuid,jsonb): nobody'::text, coalesce((coalesce(not has_function_privilege('service_role',to_regprocedure('public.invoice__apply_fields(uuid,jsonb)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.invoice__apply_fields(uuid,jsonb)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.invoice__apply_fields(uuid,jsonb)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.invoice__apply_fields(uuid,jsonb)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'B'::text, 'body of invoice__apply_fields(uuid,jsonb) holds «client_phone = coalesce(p_payload->>''client_phone''»'::text, coalesce((coalesce(position('client_phone = coalesce(p_payload->>''client_phone'', '''')' in pg_get_functiondef(to_regprocedure('public.invoice__apply_fields(uuid,jsonb)')))>0,false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'function invoice__replace_children(uuid,jsonb)'::text, coalesce((to_regprocedure('public.invoice__replace_children(uuid,jsonb)') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'privileges of invoice__replace_children(uuid,jsonb): nobody'::text, coalesce((coalesce(not has_function_privilege('service_role',to_regprocedure('public.invoice__replace_children(uuid,jsonb)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.invoice__replace_children(uuid,jsonb)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.invoice__replace_children(uuid,jsonb)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.invoice__replace_children(uuid,jsonb)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'B'::text, 'body of invoice__replace_children(uuid,jsonb) holds «invoice_too_large»'::text, coalesce((coalesce(position('invoice_too_large' in pg_get_functiondef(to_regprocedure('public.invoice__replace_children(uuid,jsonb)')))>0,false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'function invoice_assign_number()'::text, coalesce((to_regprocedure('public.invoice_assign_number()') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'privileges of invoice_assign_number(): nobody'::text, coalesce((coalesce(not has_function_privilege('service_role',to_regprocedure('public.invoice_assign_number()'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.invoice_assign_number()'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.invoice_assign_number()'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.invoice_assign_number()'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'B'::text, 'body of invoice_assign_number() holds «v_year»'::text, coalesce((coalesce(position('v_year' in pg_get_functiondef(to_regprocedure('public.invoice_assign_number()')))>0,false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'function invoice_documents_guard()'::text, coalesce((to_regprocedure('public.invoice_documents_guard()') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'privileges of invoice_documents_guard(): nobody'::text, coalesce((coalesce(not has_function_privilege('service_role',to_regprocedure('public.invoice_documents_guard()'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.invoice_documents_guard()'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.invoice_documents_guard()'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.invoice_documents_guard()'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'B'::text, 'body of invoice_documents_guard() holds «invoice_immutable_field»'::text, coalesce((coalesce(position('invoice_immutable_field' in pg_get_functiondef(to_regprocedure('public.invoice_documents_guard()')))>0,false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'function invoice_never_delete()'::text, coalesce((to_regprocedure('public.invoice_never_delete()') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'privileges of invoice_never_delete(): nobody'::text, coalesce((coalesce(not has_function_privilege('service_role',to_regprocedure('public.invoice_never_delete()'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.invoice_never_delete()'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.invoice_never_delete()'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.invoice_never_delete()'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'B'::text, 'body of invoice_never_delete() holds «invoice_never_deleted»'::text, coalesce((coalesce(position('invoice_never_deleted' in pg_get_functiondef(to_regprocedure('public.invoice_never_delete()')))>0,false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'function invoice_children_guard()'::text, coalesce((to_regprocedure('public.invoice_children_guard()') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'privileges of invoice_children_guard(): nobody'::text, coalesce((coalesce(not has_function_privilege('service_role',to_regprocedure('public.invoice_children_guard()'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.invoice_children_guard()'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.invoice_children_guard()'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.invoice_children_guard()'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'B'::text, 'body of invoice_children_guard() holds «invoice_locked»'::text, coalesce((coalesce(position('invoice_locked' in pg_get_functiondef(to_regprocedure('public.invoice_children_guard()')))>0,false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'function invoice_events_append_only()'::text, coalesce((to_regprocedure('public.invoice_events_append_only()') is not null),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'privileges of invoice_events_append_only(): nobody'::text, coalesce((coalesce(not has_function_privilege('service_role',to_regprocedure('public.invoice_events_append_only()'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.invoice_events_append_only()'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.invoice_events_append_only()'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.invoice_events_append_only()'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'B'::text, 'body of invoice_events_append_only() holds «invoice_events_append_only»'::text, coalesce((coalesce(position('invoice_events_append_only' in pg_get_functiondef(to_regprocedure('public.invoice_events_append_only()')))>0,false)),false)
  UNION ALL
  SELECT 'admin_invoices'::text, 'S'::text, 'service_role may write only invoice_settings, invoice_item_types, invoice_clients'::text, coalesce((coalesce(has_table_privilege('service_role',to_regclass('public.invoice_settings'),'INSERT,UPDATE') and has_table_privilege('service_role',to_regclass('public.invoice_item_types'),'INSERT,UPDATE') and has_table_privilege('service_role',to_regclass('public.invoice_clients'),'INSERT,UPDATE') and not has_table_privilege('service_role',to_regclass('public.invoice_documents'),'INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'admin_invoices_statement'::text, 'S'::text, 'constraint invoice_documents.invoice_documents_doc_type_check with «statement»'::text, coalesce((exists(select 1 from pg_constraint where conrelid=to_regclass('public.invoice_documents') and conname='invoice_documents_doc_type_check' and pg_get_constraintdef(oid) like '%statement%')),false)
  UNION ALL
  SELECT 'admin_invoices_statement'::text, 'S'::text, 'constraint invoice_number_counters.invoice_number_counters_doc_type_check with «statement»'::text, coalesce((exists(select 1 from pg_constraint where conrelid=to_regclass('public.invoice_number_counters') and conname='invoice_number_counters_doc_type_check' and pg_get_constraintdef(oid) like '%statement%')),false)
  UNION ALL
  SELECT 'admin_invoices_statement'::text, 'S'::text, 'constraint invoice_documents.invoice_documents_statement_no_money'::text, coalesce((exists(select 1 from pg_constraint where conrelid=to_regclass('public.invoice_documents') and conname='invoice_documents_statement_no_money')),false)
  UNION ALL
  SELECT 'admin_invoices_statement'::text, 'S'::text, 'body of invoice_assign_number() holds «WHEN ''statement'' THEN ''STM''»'::text, coalesce((coalesce(position('WHEN ''statement'' THEN ''STM''' in pg_get_functiondef(to_regprocedure('public.invoice_assign_number()')))>0,false)),false)
  UNION ALL
  SELECT 'admin_invoices_statement'::text, 'S'::text, 'body of invoice__replace_children(uuid,jsonb) holds «invoice_statement_no_prices»'::text, coalesce((coalesce(position('invoice_statement_no_prices' in pg_get_functiondef(to_regprocedure('public.invoice__replace_children(uuid,jsonb)')))>0,false)),false)
  UNION ALL
  SELECT 'admin_invoices_statement'::text, 'S'::text, 'body of invoice_set_status(uuid,uuid,text,integer,jsonb,date,text,text) holds «IF p_to = ''paid'' AND v_doc.doc_type <> ''invoice'' T»'::text, coalesce((coalesce(position('IF p_to = ''paid'' AND v_doc.doc_type <> ''invoice'' THEN RAISE EXCEPTION ''invoice_bad_transition''; END IF;' in pg_get_functiondef(to_regprocedure('public.invoice_set_status(uuid,uuid,text,integer,jsonb,date,text,text)')))>0,false)),false)
  UNION ALL
  SELECT 'admin_invoices_statement'::text, 'S'::text, 'function invoice_assign_number()'::text, coalesce((to_regprocedure('public.invoice_assign_number()') is not null),false)
  UNION ALL
  SELECT 'admin_invoices_statement'::text, 'S'::text, 'function invoice__replace_children(uuid,jsonb)'::text, coalesce((to_regprocedure('public.invoice__replace_children(uuid,jsonb)') is not null),false)
  UNION ALL
  SELECT 'admin_invoices_statement'::text, 'S'::text, 'function invoice_set_status(uuid,uuid,text,integer,jsonb,date,text,text)'::text, coalesce((to_regprocedure('public.invoice_set_status(uuid,uuid,text,integer,jsonb,date,text,text)') is not null),false)
  UNION ALL
  SELECT 'record_production_quote_and_settle'::text, 'S'::text, 'function create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])'::text, coalesce((to_regprocedure('public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])') is not null),false)
  UNION ALL
  SELECT 'record_production_quote_and_settle'::text, 'S'::text, 'privileges of create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[]): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'record_production_quote_and_settle'::text, 'S'::text, 'body of create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[]) holds «v_cap numeric := 25000;»'::text, coalesce((coalesce(position('v_cap numeric := 25000;' in pg_get_functiondef(to_regprocedure('public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])')))>0,false)),false)
  UNION ALL
  SELECT 'record_production_quote_and_settle'::text, 'S'::text, 'function settle_job_atomic(text,numeric,text)'::text, coalesce((to_regprocedure('public.settle_job_atomic(text,numeric,text)') is not null),false)
  UNION ALL
  SELECT 'record_production_quote_and_settle'::text, 'S'::text, 'privileges of settle_job_atomic(text,numeric,text): service_role only'::text, coalesce((coalesce(has_function_privilege('service_role',to_regprocedure('public.settle_job_atomic(text,numeric,text)'),'EXECUTE') and not has_function_privilege('anon',to_regprocedure('public.settle_job_atomic(text,numeric,text)'),'EXECUTE') and not has_function_privilege('authenticated',to_regprocedure('public.settle_job_atomic(text,numeric,text)'),'EXECUTE') and not has_function_privilege('public',to_regprocedure('public.settle_job_atomic(text,numeric,text)'),'EXECUTE'),false)),false)
  UNION ALL
  SELECT 'record_production_quote_and_settle'::text, 'S'::text, 'body of settle_job_atomic(text,numeric,text) holds «p_points_cap numeric DEFAULT 25000»'::text, coalesce((coalesce(position('p_points_cap numeric DEFAULT 25000' in pg_get_functiondef(to_regprocedure('public.settle_job_atomic(text,numeric,text)')))>0,false)),false)
  UNION ALL
  SELECT 'one_open_addon_per_file'::text, 'S'::text, 'index missions_one_open_addon_per_file'::text, coalesce((exists(select 1 from pg_indexes where schemaname='public' and indexname='missions_one_open_addon_per_file')),false)
  UNION ALL
  SELECT 'one_open_addon_per_file'::text, 'S'::text, 'the index is unique, partial, on plan->addon->>of, and excludes ALL FOUR ending statuses (completed, failed, unserved, cancelled)'::text, coalesce((coalesce((select pg_get_indexdef(indexrelid) like '%UNIQUE%' and pg_get_indexdef(indexrelid) like '%addon%' and pg_get_indexdef(indexrelid) like '%completed%' and pg_get_indexdef(indexrelid) like '%failed%' and pg_get_indexdef(indexrelid) like '%unserved%' and pg_get_indexdef(indexrelid) like '%cancelled%' from pg_index where indexrelid=to_regclass('public.missions_one_open_addon_per_file')),false)),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'table admin_campaigns'::text, coalesce((to_regclass('public.admin_campaigns') is not null),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='id')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.name'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='name')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.subject'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='subject')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.badge'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='badge')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.heading'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='heading')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.body'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='body')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.cta_label'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='cta_label')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.cta_path'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='cta_path')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.audience'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='audience')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.status'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='status')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.revision'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='revision')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.test_sent_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='test_sent_at')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.test_content_hash'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='test_content_hash')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.created_by'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='created_by')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.updated_by'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='updated_by')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.created_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='created_at')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaigns.updated_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaigns' and column_name='updated_at')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'table admin_campaign_sends'::text, coalesce((to_regclass('public.admin_campaign_sends') is not null),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaign_sends.campaign_id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaign_sends' and column_name='campaign_id')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaign_sends.user_id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaign_sends' and column_name='user_id')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaign_sends.status'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaign_sends' and column_name='status')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaign_sends.reason'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaign_sends' and column_name='reason')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaign_sends.provider_message_id'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaign_sends' and column_name='provider_message_id')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaign_sends.created_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaign_sends' and column_name='created_at')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'column admin_campaign_sends.updated_at'::text, coalesce((exists(select 1 from information_schema.columns where table_schema='public' and table_name='admin_campaign_sends' and column_name='updated_at')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'index admin_campaigns_created_at_idx'::text, coalesce((exists(select 1 from pg_indexes where schemaname='public' and indexname='admin_campaigns_created_at_idx')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'index admin_campaign_sends_status_idx'::text, coalesce((exists(select 1 from pg_indexes where schemaname='public' and indexname='admin_campaign_sends_status_idx')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'RLS on admin_campaigns'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.admin_campaigns')),false)),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'RLS on admin_campaign_sends'::text, coalesce((coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.admin_campaign_sends')),false)),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'privileges of admin_campaigns: service_role SELECT,INSERT,UPDATE; anon/authenticated/public none'::text, coalesce((coalesce(has_table_privilege('service_role',to_regclass('public.admin_campaigns'),'SELECT,INSERT,UPDATE') and not has_table_privilege('anon',to_regclass('public.admin_campaigns'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.admin_campaigns'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.admin_campaigns'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'privileges of admin_campaign_sends: service_role SELECT,INSERT,UPDATE; anon/authenticated/public none'::text, coalesce((coalesce(has_table_privilege('service_role',to_regclass('public.admin_campaign_sends'),'SELECT,INSERT,UPDATE') and not has_table_privilege('anon',to_regclass('public.admin_campaign_sends'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',to_regclass('public.admin_campaign_sends'),'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('public',to_regclass('public.admin_campaign_sends'),'SELECT,INSERT,UPDATE,DELETE'),false)),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'service_role cannot DELETE admin_campaigns'::text, coalesce((coalesce(not has_table_privilege('service_role',to_regclass('public.admin_campaigns'),'DELETE'),false)),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'service_role cannot DELETE admin_campaign_sends'::text, coalesce((coalesce(not has_table_privilege('service_role',to_regclass('public.admin_campaign_sends'),'DELETE'),false)),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'primary key of admin_campaigns'::text, coalesce((exists(select 1 from pg_constraint where conrelid=to_regclass('public.admin_campaigns') and contype='p')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'primary key of admin_campaign_sends'::text, coalesce((exists(select 1 from pg_constraint where conrelid=to_regclass('public.admin_campaign_sends') and contype='p')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'foreign key of admin_campaign_sends'::text, coalesce((exists(select 1 from pg_constraint where conrelid=to_regclass('public.admin_campaign_sends') and contype='f')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'check on admin_campaigns with «news_opt_in»'::text, coalesce((exists(select 1 from pg_constraint where conrelid=to_regclass('public.admin_campaigns') and contype='c' and pg_get_constraintdef(oid) like '%news_opt_in%')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'check on admin_campaigns with «cancelled»'::text, coalesce((exists(select 1 from pg_constraint where conrelid=to_regclass('public.admin_campaigns') and contype='c' and pg_get_constraintdef(oid) like '%cancelled%')),false)
  UNION ALL
  SELECT 'admin_campaigns'::text, 'S'::text, 'check on admin_campaign_sends with «uncertain»'::text, coalesce((exists(select 1 from pg_constraint where conrelid=to_regclass('public.admin_campaign_sends') and contype='c' and pg_get_constraintdef(oid) like '%uncertain%')),false)
),
meta(migration, group_, repo_version, prod_version) AS (
  VALUES
  ('fix_provider_spend_scope','A','20261016205259','20261016205309'::text),
  ('request_attempt_history','A','20261017071747','20261017072355'::text),
  ('register_professional_people_search','A','20261017150000','20261017181315'::text),
  ('cleanup_capability_registry_social','A','20261017175000','20261017181323'::text),
  ('settle_completed_jobs_with_stale_lease','A','20261017175500','20261017181338'::text),
  ('create_quote_atomic','A','20261017180000','20261017181346'::text),
  ('approve_topup_atomic_privileges','A','20261017180500','20261017181352'::text),
  ('settle_decision_maker_fields','A','20261017181000','20261017184147'::text),
  ('welcome_email_on_confirm','B','20261013170000',NULL::text),
  ('prevent_claim_after_collection_complete','B','20261015185600',NULL::text),
  ('seed_company_and_people_capabilities','B','20261016011500',NULL::text),
  ('credit_ledger_kinds','B','20261018140000',NULL::text),
  ('promo_codes_and_admin_grants','B','20261018140500',NULL::text),
  ('support_messages','B','20261018141000',NULL::text),
  ('provider_api_keys_tables','B','20261018160000',NULL::text),
  ('provider_api_keys_functions','B','20261018160500',NULL::text),
  ('provider_limits','B','20261019100000',NULL::text),
  ('admin_invoices','B','20261031120000',NULL::text),
  ('admin_invoices_statement','B','20261031150000',NULL::text),
  ('record_production_quote_and_settle','B','20261104222000',NULL::text),
  ('one_open_addon_per_file','B','20261104222136',NULL::text),
  ('admin_campaigns','B','20261119010000',NULL::text)
)
SELECT
  m.group_,
  m.migration,
  m.repo_version,
  m.prod_version,
  CASE WHEN count(*) FILTER (WHERE c.kind='S' AND c.ok) = count(*) FILTER (WHERE c.kind='S') THEN 'present'
       WHEN count(*) FILTER (WHERE c.kind='S' AND c.ok) = 0 THEN 'MISSING'
       ELSE 'PARTIAL' END AS status,
  count(*) FILTER (WHERE c.kind='S' AND c.ok)::text || ' of ' || count(*) FILTER (WHERE c.kind='S')::text AS structural_ok,
  coalesce(string_agg(c.item, ' | ' ORDER BY c.item) FILTER (WHERE c.kind='S' AND NOT c.ok), '') AS missing,
  CASE WHEN count(*) FILTER (WHERE c.kind='B')=0 THEN 'n/a' ELSE count(*) FILTER (WHERE c.kind='B' AND c.ok)::text || ' of ' || count(*) FILTER (WHERE c.kind='B')::text END AS body_marker,
  coalesce(string_agg(c.item, ' | ') FILTER (WHERE c.kind='B' AND NOT c.ok), '') AS body_differs,
  coalesce(string_agg(c.item || ' = ' || c.ok::text, ' | ') FILTER (WHERE c.kind='D'), '') AS data_note,
  exists(SELECT 1 FROM supabase_migrations.schema_migrations s WHERE s.version = coalesce(m.prod_version, m.repo_version)) AS recorded_in_prod
FROM meta m JOIN checks c ON c.migration = m.migration
GROUP BY m.group_, m.migration, m.repo_version, m.prod_version
ORDER BY m.group_, m.repo_version;
