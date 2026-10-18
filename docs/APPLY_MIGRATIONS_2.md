# Migration application guide, batch 2

Status: none of these files was applied by the author. The author only read from the database (SELECT). Apply them
yourself, in the order below, after the pull request is reviewed.

The application works before and after each file. Until a file is applied, the screens that need it say so in Arabic (or
keep working from the data that exists) and write nothing by hand; tests prove this (`tests/migration-fallbacks.test.ts`).
Run each complete file as one transaction. If the SQL editor reports an error before commit, roll back and stop.

Apply in this order, one file at a time, running its verification before the next:

## 1. `20261018140000_credit_ledger_kinds.sql`

Adds the side table `credit_ledger_kinds` (insert-only, keyed by ledger id) and the view `credit_ledger_typed`, which gives
every ledger row a kind: `topup_instapay`, `promo_code`, `admin_grant`, `reserve`, `charge`, `release`. Legacy rows are
classified by their type (`topup` rows are Instapay top-ups; `grant` and `goodwill` rows are admin credit). No ledger row
and no balance changes.

Verify:

```sql
SELECT to_regclass('public.credit_ledger_kinds') AS kinds_table, to_regclass('public.credit_ledger_typed') AS typed_view;
SELECT kind, count(*) AS rows, sum(delta) AS points FROM public.credit_ledger_typed GROUP BY kind ORDER BY kind;
SELECT (SELECT sum(delta) FROM public.credit_ledger) = (SELECT sum(delta) FROM public.credit_ledger_typed) AS balances_identical,
       (SELECT count(*) FROM public.credit_ledger) = (SELECT count(*) FROM public.credit_ledger_typed) AS rows_identical;
SELECT has_table_privilege('authenticated', 'public.credit_ledger_typed', 'SELECT') AS authenticated_can_read; -- must be false
```

Expected: both identical columns are `true`, the last column is `false`.

Rollback (only if file 2 was not applied or has no redemptions yet): `DROP VIEW public.credit_ledger_typed; DROP TABLE public.credit_ledger_kinds;`
The ledger is untouched either way. After file 2 has been used, dropping the kinds table loses which rows were promo or admin credit (the ledger ids `promo_...` and `adm_...` still show it), so prefer fixing forward.

## 2. `20261018140500_promo_codes_and_admin_grants.sql`

Needs file 1. Adds `promo_codes`, `promo_redemptions` and three functions, all `SECURITY DEFINER`, `SET search_path TO 'public', 'pg_temp'`, revoked from PUBLIC / anon / authenticated, granted to `service_role` only:

- `redeem_promo_code_atomic(p_user_id, p_code)`: locks the code row, checks active / dates / limits, one redemption per account, writes the credit row `promo_<code>_<user>` (type `grant`) and its kind.
- `admin_grant_credit_atomic(p_admin_id, p_user_id, p_points, p_note, p_request_id)`: verifies the admin role from the auth record inside the function, positive whole points only, idempotent by request id, row id `adm_<request id>`.
- `admin_save_promo_code_atomic(...)`: creates or edits a code (admin role verified inside).

Verify:

```sql
SELECT p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('redeem_promo_code_atomic', 'admin_grant_credit_atomic', 'admin_save_promo_code_atomic')
ORDER BY p.proname;
SELECT to_regclass('public.promo_codes') AS codes, to_regclass('public.promo_redemptions') AS redemptions;
SELECT count(*) AS codes_so_far FROM public.promo_codes;
```

Expected: three rows, `prosecdef` true, `proconfig` contains `search_path=public, pg_temp`, `service_role` true, `authenticated` false, `anon` false; `codes_so_far` is 0.

Rollback (before any code is redeemed): `DROP FUNCTION public.redeem_promo_code_atomic(uuid, text); DROP FUNCTION public.admin_grant_credit_atomic(uuid, uuid, numeric, text, text); DROP FUNCTION public.admin_save_promo_code_atomic(uuid, text, integer, integer, timestamptz, timestamptz, boolean, text); DROP TABLE public.promo_redemptions; DROP TABLE public.promo_codes;`
Credit rows already written stay in the append-only ledger; never delete them. Compensate with a normal ledger entry through the approved functions if a mistake was made.

After applying: open «الأكواد الترويجية» in the admin area and create the launch code (for example 500 points, the maximum number of friends, an expiry date).

## 3. `20261018141000_support_messages.sql`

Not a money table. Adds `support_messages`, closed to customers (RLS on, nothing granted to anon or authenticated). The contact form and the «بلّغ عن مشكلة» button store messages here; without it they still send the email when `RESEND_API_KEY` is set on the site.

Verify:

```sql
SELECT to_regclass('public.support_messages') AS support_table;
SELECT relrowsecurity AS rls_on FROM pg_class WHERE oid = 'public.support_messages'::regclass;
SELECT has_table_privilege('authenticated', 'public.support_messages', 'SELECT') AS authenticated_can_read,
       has_table_privilege('anon', 'public.support_messages', 'INSERT') AS anon_can_write;
```

Expected: the table exists, `rls_on` true, both privilege columns false.

Rollback: `DROP TABLE public.support_messages;` (loses stored messages only).

## What the author already checked

The same SQL ran on a scratch PostgreSQL 16 database (never Supabase), loaded with every earlier migration of this repository: one account cannot redeem a code twice, 25 parallel redemptions of a code with a limit of 7 gave exactly 7 credits, a non-admin is refused by the functions themselves, repeated admin grants with one request id credit once, the kind view classifies legacy rows and keeps `SUM(delta)` identical, and the ledger stays append-only. The test is `tests/sql/promo-and-grants.local-pg.test.ts` (run it with `DIGER_TEST_PG=<socket dir>:<port>` pointing at a scratch database; it is skipped otherwise).
