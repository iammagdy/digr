-- READ ONLY. Paste in the Supabase SQL editor after EACH step; the expected answer is in the comment of each query.

-- After step 1 (settle_job_atomic): settle_default_cap = 25000
-- After step 2 (settle_people_job_atomic): settle_default_cap = 25000, people_hard_cap = 25000
-- After step 4 (create_quote_atomic): quote_cap = 25000
SELECT p.proname,
       (regexp_match(pg_get_functiondef(p.oid), 'v_cap numeric := (\d+)'))[1]                         AS quote_cap,
       (regexp_match(pg_get_functiondef(p.oid), 'p_points_cap numeric DEFAULT (\d+)'))[1]             AS settle_default_cap,
       (regexp_match(pg_get_functiondef(p.oid), 'COALESCE\(p_points_cap,(\d+)\), (\d+)\)'))[2]       AS people_hard_cap,
       md5(pg_get_functiondef(p.oid))                                                                  AS definition_md5
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('create_quote_atomic','settle_job_atomic','settle_people_job_atomic')
ORDER BY p.proname;

-- After step 3: job_max_points_cap = 25000
SELECT key, value ->> 'jobMaxPointsCap' AS job_max_points_cap FROM public.settings_private WHERE key = 'pricing';

-- After every step: the execute rights are unchanged (anon_can = false, authenticated_can = false, service_role_can = true on all three)
SELECT p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_can,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role_can
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('create_quote_atomic','settle_job_atomic','settle_people_job_atomic')
ORDER BY p.proname;

-- After step 4: nothing was written to a money table by these steps (the ledger row count and the append-only trigger are untouched)
SELECT count(*) AS ledger_rows FROM public.credit_ledger;
SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.credit_ledger'::regclass AND NOT tgisinternal;

-- The reserve limit of the quote writer is now the cap and not one point more (expected: ok = true). Run it ONLY if you want a live probe; it writes nothing
-- (it calls the quote writer inside a transaction that is rolled back):
-- BEGIN;
--   SELECT public.create_quote_atomic((SELECT id FROM public.profiles LIMIT 1), 'q_probe_cap', repeat('0',64), '[{"capabilitySlug":"probe"}]'::jsonb, 25000, ARRAY['xlsx'], now() + interval '1 hour', '{}');
-- ROLLBACK;
