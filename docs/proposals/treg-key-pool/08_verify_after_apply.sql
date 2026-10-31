-- READ ONLY. Run after 08. Prints no secret.
-- 1) the constraint now allows «main_failed»
select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'treg_pool_events_kind_check';   -- must contain 'main_failed'
-- 2) who may run the function: anon false, authenticated false, service_role true
select has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'treg_pool_record_failover';
-- 3) the function body logs the event for a failed main key
select position('main_failed' in pg_get_functiondef(p.oid)) > 0 as logs_main_failed
from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'treg_pool_record_failover';
