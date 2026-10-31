-- ONE read-only SELECT (one result set). Run it after parts 01 to 05. Expected: 18 rows (8 tables, then 10 functions) and `ok = true` on EVERY row.
--
-- Tables (object_kind = 'table'): rls_on = true, policies = 0, anon / authenticated / public have NO privilege at all,
--   service_role_can_write_or_execute = true only for invoice_settings, invoice_item_types, invoice_clients (the rest are written by the functions).
-- Functions (object_kind = 'function'): anon, authenticated and PUBLIC have NO EXECUTE on any of the 10; search_path_fixed = true on all 10;
--   security_definer = true only for invoice_create_document, invoice_save_draft, invoice_set_status; and only those three are executable by service_role.
-- `ok` is computed here from exactly those rules, so a single `select ... where not ok` style glance is enough.
SELECT
  'table' AS object_kind,
  c.relname::text AS object_name,
  c.relrowsecurity AS rls_on,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::integer AS policies,
  has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS anon_any_privilege,
  has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS authenticated_any_privilege,
  has_table_privilege('public', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS public_any_privilege,
  has_table_privilege('service_role', c.oid, 'INSERT, UPDATE, DELETE') AS service_role_can_write_or_execute,
  NULL::boolean AS security_definer,
  NULL::boolean AS search_path_fixed,
  (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal)::integer AS guard_triggers,
  (c.relrowsecurity
    AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) = 0
    AND NOT has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    AND NOT has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    AND NOT has_table_privilege('public', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    AND has_table_privilege('service_role', c.oid, 'INSERT, UPDATE, DELETE') = (c.relname IN ('invoice_settings', 'invoice_item_types', 'invoice_clients'))
  ) AS ok
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'invoice\_%'
UNION ALL
SELECT
  'function',
  (f.proname || '(' || pg_get_function_identity_arguments(f.oid) || ')')::text,
  NULL::boolean,
  NULL::integer,
  has_function_privilege('anon', f.oid, 'EXECUTE'),
  has_function_privilege('authenticated', f.oid, 'EXECUTE'),
  has_function_privilege('public', f.oid, 'EXECUTE'),
  has_function_privilege('service_role', f.oid, 'EXECUTE'),
  f.prosecdef,
  coalesce(EXISTS (SELECT 1 FROM unnest(f.proconfig) cfg WHERE cfg LIKE 'search_path=%pg_temp%'), false),
  NULL::integer,
  (NOT has_function_privilege('anon', f.oid, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', f.oid, 'EXECUTE')
    AND NOT has_function_privilege('public', f.oid, 'EXECUTE')
    AND coalesce(EXISTS (SELECT 1 FROM unnest(f.proconfig) cfg WHERE cfg LIKE 'search_path=%pg_temp%'), false)
    AND f.prosecdef = (f.proname IN ('invoice_create_document', 'invoice_save_draft', 'invoice_set_status'))
    AND has_function_privilege('service_role', f.oid, 'EXECUTE') = (f.proname IN ('invoice_create_document', 'invoice_save_draft', 'invoice_set_status'))
  )
FROM pg_proc f
WHERE f.pronamespace = 'public'::regnamespace AND f.proname LIKE 'invoice\_%'
ORDER BY 1, 2;
