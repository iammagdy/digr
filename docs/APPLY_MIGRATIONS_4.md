# Apply migrations 4: provider spend limits

Proposal only. The author did NOT apply anything. Apply by hand, in this order, after reading each file.

## Order

| # | File | What it adds |
|---|---|---|
| 1 | `supabase/migrations/20261019100000_provider_limits.sql` | `provider_limits_audit` (append-only), the trigger that blocks UPDATE/DELETE on it, and `admin_set_provider_limits_atomic(uuid, jsonb)` (SECURITY DEFINER, service_role only, admin checked inside) |

Items B (data extraction quality) and C (planning) of this change need no migration.

It touches no money table (credit_ledger, jobs, topups, plans_quotes, provider_costs, profiles). It writes only the
`provider_limits` row of the existing `settings_private` table.

## Works before and after

- Before the file is applied: the admin «مزودو الخدمة» tab shows a plain Arabic notice that the settings store is not
  ready, the fields are read-only, and every enforcement point keeps using the current constants (0.80 USD per day for the
  data provider; the old `pricing.providerDailySpendCapUsd` row still counts). The code logs one non-secret line
  (`[provider_limits:fallback_to_defaults]`) only when the store cannot be read at all.
- After the file is applied: saving writes the limits and an audit row in one transaction; the next worker chunk on that
  server uses them at once, other servers within 30 seconds, without a redeploy.

## Verification (one SELECT per file)

```sql
-- 1. the audit table, the trigger and the function exist, and the function is service_role only
select
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'provider_limits_audit') as audit_table,
  (select count(*) from pg_trigger where tgname = 'trg_block_provider_limits_audit_mutation') as audit_trigger,
  (select prosecdef from pg_proc where proname = 'admin_set_provider_limits_atomic') as security_definer,
  has_function_privilege('anon', 'public.admin_set_provider_limits_atomic(uuid,jsonb)', 'execute') as anon_can_run,
  has_function_privilege('authenticated', 'public.admin_set_provider_limits_atomic(uuid,jsonb)', 'execute') as authenticated_can_run,
  has_function_privilege('service_role', 'public.admin_set_provider_limits_atomic(uuid,jsonb)', 'execute') as service_role_can_run;
-- expected: 1 | 1 | true | false | false | true
```

## Rollback

```sql
-- Stops admin edits and returns to the built-in constants. The audit rows are kept on purpose.
drop function if exists public.admin_set_provider_limits_atomic(uuid, jsonb);
delete from public.settings_private where key = 'provider_limits';
-- Optional, only if the audit history is not needed: it is append-only, so drop the trigger first.
-- drop trigger if exists trg_block_provider_limits_audit_mutation on public.provider_limits_audit;
-- drop table if exists public.provider_limits_audit;
-- drop function if exists public.block_provider_limits_audit_mutation();
```

## Tested on a real Postgres

`tests/sql/provider-limits.local-pg.test.ts` runs this exact SQL on a scratch Postgres 16 (set `DIGR_TEST_PG`, or
`DIGER_TEST_PG`): non-admin and null admin refused, non-numbers / negatives / unknown keys / percent above 100 refused,
partial updates merge, a null ceiling clears it, a huge value (999999999999) works, every change writes an audit row with
old and new value, UPDATE and DELETE on the audit table are blocked, and the function is not executable by anon or
authenticated.
