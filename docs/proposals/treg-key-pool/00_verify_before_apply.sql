-- READ ONLY. Run in the Supabase SQL editor BEFORE applying anything of this folder. Prints no secret and no key.
-- Expected: every "must_be" column equals its "found" column. If one differs, stop and tell the engineer.

-- 1. none of the new objects exists yet (so the files below only ADD)
select 'new tables absent' as check_name, 'none' as must_be,
       coalesce(string_agg(table_name, ', '), 'none') as found
from information_schema.tables
where table_schema = 'public'
  and table_name in ('treg_pool_keys','treg_pool_state','treg_pool_events','treg_pool_alerts','treg_pool_calls');

select 'new functions absent' as check_name, 'none' as must_be,
       coalesce(string_agg(routine_name, ', '), 'none') as found
from information_schema.routines
where routine_schema = 'public'
  and (routine_name like 'treg\_pool\_%' or routine_name like 'admin\_%treg\_%');

select 'new vault secret absent' as check_name, '0' as must_be, count(*)::text as found
from vault.secrets where name = 'diger-treg-pool-enc-key';

select 'new cron job absent' as check_name, '0' as must_be, count(*)::text as found
from cron.job where jobname = 'diger-treg-pool-tick';

-- 2. what the new files rely on is there
select 'extensions' as check_name, 'pg_cron, pg_net, pgcrypto, supabase_vault' as must_be,
       string_agg(extname, ', ' order by extname) as found
from pg_extension where extname in ('pg_cron','pg_net','pgcrypto','supabase_vault');

select 'existing vault secrets used by the cron tick (names only)' as check_name,
       'diger-app-base-url, diger-cron-secret' as must_be,
       string_agg(name, ', ' order by name) as found
from vault.secrets where name in ('diger-cron-secret','diger-app-base-url');

select 'provider_costs.id type (the per-key spend joins on it)' as check_name, 'bigint' as must_be, data_type as found
from information_schema.columns where table_schema = 'public' and table_name = 'provider_costs' and column_name = 'id';

select 'at least one admin account (admin functions check the role inside)' as check_name, '>= 1' as must_be,
       count(*)::text as found
from auth.users where raw_app_meta_data ->> 'role' = 'admin';

-- 3. today's key store is untouched by this work: provider, version and last 4 only (never the ciphertext)
select provider, version, active_last4, active_set_at from public.provider_api_keys order by provider;
