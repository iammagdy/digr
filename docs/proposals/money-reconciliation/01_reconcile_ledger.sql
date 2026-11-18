-- 01_reconcile_ledger.sql — money reconciliation (DT-20261118-01). READ ONLY.
-- ONE final SELECT: no writes, no BEGIN/ROLLBACK, no function that writes. Safe to paste into the Supabase SQL Editor at any time.
-- Result columns: check | expected | actual | ok. The last row is ALL.
--   ok = ✓  the rule holds.
--   ok = ✗  STOP: send a screenshot to COMMANDER. This file fixes nothing; a correction is an owner action (a NEW ledger row
--           through the atomic functions, never an edit).
--   ok = ℹ  information only; not counted in ALL.
-- actual = number of offenders, then up to 10 example ids (job, quote, group, top-up, ledger or user ids; never a name or an e-mail).
-- Rules: DIGER-TRUTH §5. Ledger ids: res_/rel_/chg_<job>, chg_meth_<job>, top_<topup>, adm_<request>, promo_<CODE>_<user>,
-- res_/rel_<grp_…> (group hold and remainder), gdr_<job> (group-to-part transfer, job_id = the group id).

WITH
led AS (
  SELECT id, user_id, delta, type, job_id FROM public.credit_ledger
),
res AS (SELECT substr(id, 5) AS job_id, user_id, delta FROM led WHERE id LIKE 'res\_%' AND id NOT LIKE 'res\_grp\_%'),
rel AS (SELECT substr(id, 5) AS job_id, user_id, delta FROM led WHERE id LIKE 'rel\_%' AND id NOT LIKE 'rel\_grp\_%'),
chg AS (SELECT substr(id, 5) AS job_id, user_id, delta FROM led WHERE id LIKE 'chg\_%' AND id NOT LIKE 'chg\_meth\_%'),
hj AS (
  SELECT j.id, j.user_id, j.status, j.reserved_credits, COALESCE(j.charged_credits, 0) AS charged, j.updated_at,
         r.delta AS res_delta, r.user_id AS res_user,
         l.delta AS rel_delta, l.user_id AS rel_user,
         c.delta AS chg_delta, c.user_id AS chg_user
  FROM public.jobs j
  JOIN res r ON r.job_id = j.id
  LEFT JOIN rel l ON l.job_id = j.id
  LEFT JOIN chg c ON c.job_id = j.id
),
jn AS (
  SELECT job_id, SUM(delta) AS net FROM led
  WHERE job_id IS NOT NULL AND id NOT LIKE 'chg\_meth\_%' AND id NOT LIKE 'gdr\_%'
  GROUP BY job_id
),
acc AS (SELECT 'job_quote_' || md5(id) AS job_id, id AS quote_id, total_reserved_credits FROM public.plans_quotes WHERE status = 'accepted'),
gl AS (
  SELECT job_id AS gid,
         SUM(delta) AS net,
         SUM(delta) FILTER (WHERE id LIKE 'gdr\_%') AS drawn,
         MAX(delta) FILTER (WHERE id = 'res_' || job_id) AS res_delta,
         MAX(delta) FILTER (WHERE id = 'rel_' || job_id) AS rel_delta,
         bool_or(user_id IS DISTINCT FROM (SELECT g.user_id FROM public.job_groups g WHERE g.id = led.job_id)) AS wrong_user
  FROM led WHERE job_id LIKE 'grp\_%' GROUP BY job_id
),
gp AS (
  SELECT p.group_id, SUM(COALESCE(j.charged_credits, 0)) AS charged
  FROM public.job_group_parts p JOIN public.jobs j ON j.id = p.job_id GROUP BY p.group_id
),
r01 AS (SELECT user_id::text AS k FROM led GROUP BY user_id HAVING SUM(delta) < 0),
r02 AS (
  SELECT id AS k FROM led WHERE
       (id LIKE 'res\_%' AND type <> 'reserve')
    OR ((id LIKE 'rel\_%' OR id LIKE 'gdr\_%') AND type <> 'release')
    OR (id LIKE 'chg\_%' AND type <> 'charge')
    OR (id LIKE 'top\_%' AND type <> 'topup')
    OR ((id LIKE 'adm\_%' OR id LIKE 'promo\_%') AND type <> 'grant')
),
r03 AS (
  SELECT id AS k FROM led WHERE
       ((id LIKE 'res\_%' OR id LIKE 'rel\_%') AND job_id IS DISTINCT FROM substr(id, 5))
    OR (id LIKE 'chg\_%' AND id NOT LIKE 'chg\_meth\_%' AND job_id IS DISTINCT FROM substr(id, 5))
    OR (id LIKE 'chg\_meth\_%' AND job_id IS DISTINCT FROM substr(id, 10))
),
r04 AS (SELECT id AS k FROM hj WHERE res_delta IS DISTINCT FROM -reserved_credits OR res_user IS DISTINCT FROM user_id),
r05 AS (SELECT id AS k FROM hj WHERE rel_delta IS NOT NULL AND (rel_delta IS DISTINCT FROM reserved_credits OR rel_user IS DISTINCT FROM user_id)),
r06 AS (
  SELECT id AS k FROM hj WHERE
       charged < 0 OR charged > reserved_credits
    OR (chg_user IS NOT NULL AND chg_user IS DISTINCT FROM user_id)
    OR (status = 'completed' AND ((charged > 0) IS DISTINCT FROM (chg_delta IS NOT NULL)))
    OR (chg_delta IS NOT NULL AND chg_delta IS DISTINCT FROM -charged)
),
r07 AS (SELECT id AS k FROM hj WHERE status = 'completed' AND rel_delta IS NULL),
r08 AS (SELECT id AS k FROM hj WHERE status IN ('failed', 'refused') AND (charged <> 0 OR chg_delta IS NOT NULL)),
r09 AS (
  SELECT hj.id AS k FROM hj JOIN jn ON jn.job_id = hj.id
  WHERE jn.net IS DISTINCT FROM CASE WHEN hj.status = 'completed' THEN -hj.charged
                                     WHEN hj.rel_delta IS NOT NULL THEN 0
                                     ELSE -hj.reserved_credits END
),
r10 AS (
  SELECT job_id AS k FROM led
  WHERE job_id IS NOT NULL AND job_id NOT LIKE 'grp\_%' AND id NOT LIKE 'chg\_meth\_%'
  GROUP BY job_id
  HAVING count(*) FILTER (WHERE type = 'reserve') > 1
      OR count(*) FILTER (WHERE type = 'release') > 1
      OR count(*) FILTER (WHERE type = 'charge') > 1
),
r11 AS (
  SELECT l.id AS k FROM led l
  WHERE l.job_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = l.job_id)
    AND NOT EXISTS (SELECT 1 FROM public.job_groups g WHERE g.id = l.job_id)
),
r12 AS (SELECT id AS k FROM hj WHERE status IN ('queued', 'running') AND rel_delta IS NULL AND updated_at < now() - interval '48 hours'),
r13 AS (SELECT id AS k FROM hj WHERE status IN ('failed', 'refused') AND rel_delta IS NULL AND updated_at < now() - interval '48 hours'),
r14 AS (SELECT acc.quote_id AS k FROM acc WHERE NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = acc.job_id)),
r15 AS (
  SELECT acc.quote_id AS k FROM acc JOIN public.jobs j ON j.id = acc.job_id
  WHERE j.reserved_credits IS DISTINCT FROM acc.total_reserved_credits
    AND NOT EXISTS (SELECT 1 FROM public.job_groups g WHERE g.quote_id = acc.quote_id)
),
r16 AS (SELECT j.id AS k FROM public.jobs j WHERE j.id LIKE 'job\_quote\_%' AND NOT EXISTS (SELECT 1 FROM acc WHERE acc.job_id = j.id)),
r17 AS (
  SELECT t.id AS k FROM public.topups t LEFT JOIN led l ON l.id = 'top_' || t.id
  WHERE (t.status = 'approved') IS DISTINCT FROM (l.id IS NOT NULL)
     OR (l.id IS NOT NULL AND l.user_id IS DISTINCT FROM t.user_id)
  UNION ALL
  SELECT l.id FROM led l WHERE l.id LIKE 'top\_%' AND NOT EXISTS (SELECT 1 FROM public.topups t WHERE 'top_' || t.id = l.id)
),
g01 AS (
  SELECT g.id AS k FROM public.job_groups g LEFT JOIN gl ON gl.gid = g.id
  WHERE gl.res_delta IS DISTINCT FROM -g.hold_credits OR COALESCE(gl.wrong_user, false)
),
g02 AS (
  SELECT g.id AS k FROM public.job_groups g LEFT JOIN gl ON gl.gid = g.id
  WHERE COALESCE(gl.drawn, 0) IS DISTINCT FROM g.drawn_credits
  UNION ALL
  SELECT p.job_id FROM public.job_group_parts p
  JOIN public.jobs j ON j.id = p.job_id
  LEFT JOIN led d ON d.id = 'gdr_' || p.job_id
  WHERE d.delta IS DISTINCT FROM p.reserved_credits
     OR d.job_id IS DISTINCT FROM p.group_id
     OR j.reserved_credits IS DISTINCT FROM p.reserved_credits
),
g03 AS (
  SELECT g.id AS k FROM public.job_groups g LEFT JOIN gl ON gl.gid = g.id
  WHERE (g.status = 'closed' AND (COALESCE(gl.rel_delta, 0) IS DISTINCT FROM g.hold_credits - g.drawn_credits
                                  OR g.released_credits IS DISTINCT FROM g.hold_credits - g.drawn_credits))
     OR (g.status = 'open' AND gl.rel_delta IS NOT NULL)
),
g04 AS (
  SELECT g.id AS k FROM public.job_groups g LEFT JOIN gl ON gl.gid = g.id
  WHERE gl.net IS DISTINCT FROM CASE WHEN g.status = 'closed' THEN 0 ELSE -(g.hold_credits - g.drawn_credits) END
),
g05 AS (
  SELECT g.id AS k FROM public.job_groups g LEFT JOIN gp ON gp.group_id = g.id
  WHERE g.drawn_credits > g.hold_credits
     OR COALESCE(gp.charged, 0) > g.hold_credits
     OR (g.status = 'closed' AND g.final_charged IS DISTINCT FROM COALESCE(gp.charged, 0))
),
append_only AS (
  SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
    AND (c.oid, t.tgname) IN (
      (to_regclass('public.credit_ledger'), 'trg_block_ledger_mutation'),
      (to_regclass('public.credit_ledger'), 'trg_block_ledger_truncate'),
      (to_regclass('public.credit_ledger_kinds'), 'trg_block_credit_kind_mutation'),
      (to_regclass('public.job_group_parts'), 'trg_block_job_group_parts_mutation'),
      (to_regclass('public.job_group_keys'), 'trg_block_job_group_keys_mutation'),
      (to_regclass('public.job_group_frozen'), 'trg_block_job_group_frozen_mutation'))
),
ledger_rules AS (
  SELECT conname FROM pg_constraint
  WHERE conrelid = to_regclass('public.credit_ledger') AND convalidated
    AND conname IN ('chk_ledger_type', 'chk_ledger_delta_direction', 'credit_ledger_pkey')
),
client_writes AS (
  SELECT r.rolname || ' ' || p.priv || ' ' || c.relname AS k
  FROM pg_class c
  CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
  JOIN pg_roles r ON r.rolname IN ('anon', 'authenticated')
  WHERE c.oid IN (to_regclass('public.credit_ledger'), to_regclass('public.credit_ledger_kinds'), to_regclass('public.job_group_parts'),
                  to_regclass('public.job_group_keys'), to_regclass('public.job_group_frozen'))
    AND has_table_privilege(r.oid, c.oid, p.priv)
),
service_truncate AS (
  SELECT c.relname AS k
  FROM pg_class c JOIN pg_roles r ON r.rolname = 'service_role'
  WHERE c.oid IN (to_regclass('public.credit_ledger_kinds'), to_regclass('public.job_group_parts'),
                  to_regclass('public.job_group_keys'), to_regclass('public.job_group_frozen'))
    AND has_table_privilege(r.oid, c.oid, 'TRUNCATE')
),
money_functions AS (
  SELECT DISTINCT proname FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname IN (
    'reserve_credits_atomic', 'create_quote_atomic', 'accept_quote_atomic', 'settle_job_atomic', 'settle_people_job_atomic',
    'release_job_atomic', 'approve_topup_atomic', 'purchase_methodology_atomic', 'redeem_promo_code_atomic', 'admin_grant_credit_atomic',
    'accept_group_quote_atomic', 'draw_next_group_part_atomic', 'freeze_and_settle_group_part_atomic',
    'release_unfrozen_group_part_atomic', 'close_job_group_atomic')
),
offenders(ord, chk, n, ex) AS (
  SELECT 10, 'R01 no user balance below zero', (SELECT count(*) FROM r01), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r01 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 11, 'R02 ledger id prefix matches its type', (SELECT count(*) FROM r02), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r02 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 12, 'R03 ledger id matches its job_id', (SELECT count(*) FROM r03), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r03 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 13, 'R04 hold res_<job> = minus the job reserve, same user', (SELECT count(*) FROM r04), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r04 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 14, 'R05 release rel_<job> = the job reserve, same user', (SELECT count(*) FROM r05), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r05 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 15, 'R06 charge chg_<job> = charged_credits, 0 <= charged <= reserve', (SELECT count(*) FROM r06), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r06 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 16, 'R07 every completed job has its release', (SELECT count(*) FROM r07), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r07 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 17, 'R08 no failed job is charged', (SELECT count(*) FROM r08), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r08 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 18, 'R09 job ledger adds up (completed -charged, released 0, active -reserve)', (SELECT count(*) FROM r09), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r09 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 19, 'R10 at most one reserve, one release, one charge per job', (SELECT count(*) FROM r10), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r10 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 20, 'R11 every ledger job_id is a job or a group', (SELECT count(*) FROM r11), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r11 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 21, 'R12 no active hold older than 48 h', (SELECT count(*) FROM r12), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r12 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 22, 'R13 no failed job unreleased after 48 h', (SELECT count(*) FROM r13), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r13 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 23, 'R14 every accepted quote has its job', (SELECT count(*) FROM r14), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r14 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 24, 'R15 job reserve = its quote total (groups excepted)', (SELECT count(*) FROM r15), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r15 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 25, 'R16 every quote job has an accepted quote', (SELECT count(*) FROM r16), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r16 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 26, 'R17 approved top-up <=> one top_<id> row, same user', (SELECT count(*) FROM r17), (SELECT string_agg(k, ', ') FROM (SELECT k FROM r17 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 30, 'G01 group hold res_<group> = minus hold_credits, same user', (SELECT count(*) FROM g01), (SELECT string_agg(k, ', ') FROM (SELECT k FROM g01 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 31, 'G02 transfers gdr_<part> = part reserves = drawn_credits', (SELECT count(*) FROM g02), (SELECT string_agg(k, ', ') FROM (SELECT k FROM g02 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 32, 'G03 closed group released exactly hold - drawn; open group none', (SELECT count(*) FROM g03), (SELECT string_agg(k, ', ') FROM (SELECT k FROM g03 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 33, 'G04 group ledger adds up (closed 0, open -(hold - drawn))', (SELECT count(*) FROM g04), (SELECT string_agg(k, ', ') FROM (SELECT k FROM g04 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 34, 'G05 parts charged <= hold; closed final_charged = parts charged', (SELECT count(*) FROM g05), (SELECT string_agg(k, ', ') FROM (SELECT k FROM g05 ORDER BY k LIMIT 10) s)
  UNION ALL SELECT 42, 'C03 anon/authenticated cannot write the append-only tables', (SELECT count(*) FROM client_writes), (SELECT string_agg(k, ', ') FROM (SELECT k FROM client_writes ORDER BY k LIMIT 10) s)
),
checks(ord, chk, expected, actual, ok) AS (
  SELECT ord, chk, '0',
         n::text || CASE WHEN n > 0 THEN ' e.g. ' || ex ELSE '' END,
         CASE WHEN n = 0 THEN '✓' ELSE '✗' END
  FROM offenders
  UNION ALL
  SELECT 40, 'C01 append-only triggers enabled (ledger x2, kinds, 3 group tables)', '6', (SELECT count(*) FROM append_only)::text,
         CASE WHEN (SELECT count(*) FROM append_only) = 6 THEN '✓' ELSE '✗' END
  UNION ALL
  SELECT 41, 'C02 ledger rules validated (type, sign, unique id)', '3', (SELECT count(*) FROM ledger_rules)::text,
         CASE WHEN (SELECT count(*) FROM ledger_rules) = 3 THEN '✓' ELSE '✗' END
),
info(ord, chk, expected, actual, ok) AS (
  SELECT 90, 'I01 service_role can TRUNCATE an append-only table that has no TRUNCATE trigger', 'info',
         (SELECT count(*) FROM service_truncate)::text || COALESCE(' : ' || (SELECT string_agg(k, ', ' ORDER BY k) FROM service_truncate), ''), 'ℹ'
  UNION ALL
  SELECT 91, 'I02 money functions present (of 15)', 'info', (SELECT count(*) FROM money_functions)::text, 'ℹ'
  UNION ALL
  SELECT 92, 'I03 points held now (active job holds + open group remainders)', 'info',
         (COALESCE((SELECT SUM(reserved_credits) FROM hj WHERE rel_delta IS NULL AND status <> 'completed'), 0)
          + COALESCE((SELECT SUM(hold_credits - drawn_credits) FROM public.job_groups WHERE status = 'open'), 0))::text, 'ℹ'
),
all_rows AS (
  SELECT ord, chk, expected, actual, ok FROM checks
  UNION ALL SELECT ord, chk, expected, actual, ok FROM info
  UNION ALL
  SELECT 999, 'ALL', 'all pass',
         CASE WHEN bool_and(ok = '✓') THEN 'all passed' ELSE 'some failed' END,
         CASE WHEN bool_and(ok = '✓') THEN '✓' ELSE '✗' END
  FROM checks
)
SELECT chk AS "check", expected, actual, ok
FROM all_rows
ORDER BY ord;
