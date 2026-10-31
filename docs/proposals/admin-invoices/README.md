# Admin invoices: the SQL (NOT APPLIED — the owner runs it)

The agent that wrote this **did not apply any SQL** and made no database write. The only database call it made was one read-only `SELECT` on the
live project to check that no object named `invoice*` already exists (none did).

## Before you start

1. **Download `/admin/export` first** («تنزيل الكل (ZIP)»). The free Supabase plan has no backups. (The new invoice tables are not in it yet: they do not exist.)
2. Everything below is **additive**: nothing existing is altered, and no object here touches `credit_ledger`, balances, missions, reserves or charges.

## Apply, one part at a time (Supabase → SQL editor → paste → Run)

| Part | What it does |
|---|---|
| `01_catalog_clients_settings.sql` | 3 tables: seller text, item types (4 seeded names at price 0), saved clients |
| `02_documents.sql` | 5 tables: number counters, documents, batches, lines, status log. All money is integers |
| `03_numbering_and_guards.sql` | the numbering trigger, the lock after «مرسلة», the allowed status changes, no deletes, an append-only log |
| `04_functions.sql` | 5 functions; the app writes documents ONLY through the three public ones |
| `05_security_rls_privileges.sql` | RLS on, no policy, all privileges taken from `anon` / `authenticated`, `service_role` read-only on the document tables |

Each part can be run again safely (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`). The same SQL is in one piece in
`supabase/migrations/20261031120000_admin_invoices.sql` (a test checks that the five parts and that file are identical).

## Check it: ONE read-only SELECT

Run `98_verify_after_apply.sql`. Expected: **8 rows** (one per `invoice_*` table) and on every row
`rls_on = true`, `policies = 0`, `anon_any_privilege = false`, `authenticated_any_privilege = false`, `customer_callable_functions = false`, `functions_present = 10`;
`direct_write_by_service_role = true` only for `invoice_settings`, `invoice_item_types`, `invoice_clients`; `item_types_seeded = 4` the first time.

## Roll back

`99_rollback.sql` drops every invoice object. **It deletes every quote and invoice entered**, so download `/admin/export` (it now has an invoice group) first.

## What was and was not tested

`sql-check/run.mjs` ran all five parts (twice), the verify SELECT and the rollback against a throwaway embedded Postgres (PGlite, not Supabase): 76 checks,
including the lock triggers, the privileges of `anon`, `authenticated` and `service_role`, numbering and rounding. It found one real mistake (a draft could not be voided), fixed in
`02_documents.sql`. **Not proven**: the same behaviour on the owner's Supabase project itself: that is what the verify SELECT is for.
