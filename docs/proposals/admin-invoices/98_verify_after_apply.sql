-- ONE read-only SELECT. Run it after parts 01 to 05. Expected: 8 rows (one per invoice table), and on EVERY row:
--   rls_on = true, policies = 0, anon_any_privilege = false, authenticated_any_privilege = false, customer_callable_functions = false, functions_present = 10.
-- Also expected: item_types_seeded = 4 on the first run, direct_write_by_service_role = true only for invoice_settings, invoice_item_types, invoice_clients.
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_on,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
  has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS anon_any_privilege,
  has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS authenticated_any_privilege,
  has_table_privilege('service_role', c.oid, 'INSERT, UPDATE, DELETE') AS direct_write_by_service_role,
  (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS guard_triggers,
  (SELECT count(*) FROM pg_proc f WHERE f.pronamespace = 'public'::regnamespace AND f.proname LIKE 'invoice\_%') AS functions_present,
  (SELECT coalesce(bool_or(has_function_privilege('anon', f.oid, 'EXECUTE') OR has_function_privilege('authenticated', f.oid, 'EXECUTE')), false)
     FROM pg_proc f WHERE f.pronamespace = 'public'::regnamespace AND f.proname LIKE 'invoice\_%') AS customer_callable_functions,
  (SELECT count(*) FROM public.invoice_item_types) AS item_types_seeded
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'invoice\_%'
ORDER BY c.relname;
