-- READ ONLY. Paste in the Supabase SQL editor BEFORE applying anything: it shows what is live.
-- The repository definitions are the baseline of these proposals. If a live definition differs from the repository (the md5 of pg_get_functiondef below),
-- STOP and send the live definition back: the proposal files replace whole functions.

-- 1. the cap numbers inside the three functions (expected today: 600 in each)
SELECT p.proname,
       (regexp_match(pg_get_functiondef(p.oid), 'v_cap numeric := (\d+)'))[1]                         AS quote_cap,
       (regexp_match(pg_get_functiondef(p.oid), 'p_points_cap numeric DEFAULT (\d+)'))[1]             AS settle_default_cap,
       (regexp_match(pg_get_functiondef(p.oid), 'COALESCE\(p_points_cap,(\d+)\), (\d+)\)'))[2]       AS people_hard_cap
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('create_quote_atomic','settle_job_atomic','settle_people_job_atomic')
ORDER BY p.proname;

-- 2. the stored settings number (expected today: 600)
SELECT key, value ->> 'jobMaxPointsCap' AS job_max_points_cap FROM public.settings_private WHERE key = 'pricing';

-- 3. who can execute them (expected: only service_role among anon, authenticated, public)
SELECT p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_can,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role_can
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('create_quote_atomic','settle_job_atomic','settle_people_job_atomic','accept_quote_atomic')
ORDER BY p.proname;

-- 4. the record limit and the one-item rule of acceptance (NOT changed by these proposals): expected 5000 and 'single_item_quote_required'
SELECT (pg_get_functiondef(p.oid) LIKE '%v_target_max > 5000%')                  AS record_limit_5000,
       (pg_get_functiondef(p.oid) LIKE '%single_item_quote_required%')           AS one_item_rule
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'accept_quote_atomic';
