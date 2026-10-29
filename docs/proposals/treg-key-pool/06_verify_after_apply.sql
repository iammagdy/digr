-- READ ONLY. Run after 06. Prints no secret.
select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,              -- must be false
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,     -- must be false
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec    -- must be true
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'treg_pool_keys_for_check';

-- how many live keys it would return (0 while the pool is empty). Only the COUNT is printed, never the secrets it returns.
select jsonb_array_length(public.treg_pool_keys_for_check()) as live_keys_must_be_0_on_an_empty_pool;
