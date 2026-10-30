-- READ ONLY. Run after 07. Prints no secret.
-- 1) who may run it: anon false, authenticated false, service_role true
select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,              -- must be false
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,     -- must be false
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec    -- must be true
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'treg_pool_call_health';

-- 2) what it returns now: one row per key that made a call in the last 14 days (counts and times only)
select * from public.treg_pool_call_health();

-- 3) the same figures worked out by hand for the key that last answered, as a cross-check (the two last_ok_at columns must be equal for every key)
select h.key_number, h.last_ok_at as from_function,
       (select max(p.created_at) from public.treg_pool_calls tc join public.provider_costs p on p.id = tc.provider_cost_id
         where tc.key_number = h.key_number and p.status in ('success', 'empty') and p.created_at >= now() - interval '14 days') as by_hand
from public.treg_pool_call_health() h;
