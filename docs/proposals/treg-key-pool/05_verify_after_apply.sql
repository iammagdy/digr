-- READ ONLY. Run after applying 01 to 04. Prints no secret and no key (lengths and booleans only).

-- 1. the objects exist, and nothing but the service role can touch them
select 'tables exist, row level security on' as check_name, '5 / 5' as must_be,
       count(*) filter (where c.relrowsecurity)::text || ' / ' || count(*)::text as found
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('treg_pool_keys','treg_pool_state','treg_pool_events','treg_pool_alerts','treg_pool_calls');

select t.table_name,
       has_table_privilege('anon', 'public.' || t.table_name, 'SELECT') as anon_select,            -- must be false
       has_table_privilege('authenticated', 'public.' || t.table_name, 'SELECT') as auth_select,    -- must be false
       has_table_privilege('service_role', 'public.' || t.table_name, 'SELECT') as service_select,  -- false for treg_pool_keys, true for the others
       has_table_privilege('service_role', 'public.' || t.table_name, 'INSERT') as service_insert    -- must be false (writes only through functions)
from (values ('treg_pool_keys'),('treg_pool_state'),('treg_pool_events'),('treg_pool_alerts'),('treg_pool_calls')) as t(table_name);

select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,              -- must be false
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,     -- must be false
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec    -- true except the three internal helpers (log_event, clear_alerts, next_key)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and (p.proname like 'treg\_pool\_%' or p.proname like 'admin\_%treg\_%')
order by p.proname;

-- 2. the switch is OFF, nothing is active, the pool is empty
select rollout_on as must_be_false, active_key_id as must_be_null, generation as must_be_0, min_balance_micro as expected_10000 from public.treg_pool_state;
select (select count(*) from public.treg_pool_keys) as keys_must_be_0, (select count(*) from public.treg_pool_alerts) as alerts_must_be_0, (select count(*) from public.treg_pool_calls) as calls_must_be_0;

-- 3. with the switch OFF the runtime function hands out NO ciphertext
select public.treg_pool_runtime() as runtime_must_have_empty_keys;

-- 4. the Vault key exists and has the right length (44 = base64 of 32 bytes). Only the length is printed.
select length(public.treg_pool_enc_key()) as enc_key_length_must_be_44;

-- 5. the cron job is there, once, every minute; the existing jobs are still there
select jobname, schedule, active from cron.job order by jobname;

-- 6. the tick does nothing while the pool is empty (it returns before any HTTP call): no new row in net._http_response within a minute of an empty-pool tick.
select 'existing key store untouched' as check_name, provider, version, active_last4 from public.provider_api_keys order by provider;
