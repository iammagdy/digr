# Admin invoices: the SQL (applied by the owner on 2026-10-31; verify: 18 rows, ok = true)

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

## Part 06: «بيان بيانات» (data statement), added by INVOICES SIMPLE 1

Parts 01 to 05 are applied. **`06_statement_mode.sql` is NOT APPLIED**: a small delta, run once in the SQL editor after downloading `/admin/export`. It lets a document be a data statement (sectors and counts, no money):
the document type may also be `statement` (documents and number counters), a table CHECK says a statement carries no money, numbering gets `STM-2026-0001`, only an invoice can be marked paid, and a statement line must have price 0.
It only replaces three functions (`invoice_assign_number`, `invoice__replace_children`, `invoice_set_status`, same owner, same fixed `search_path`, privileges re-asserted) and changes three constraints; no row is touched and no table is dropped.
The same SQL in one file: `supabase/migrations/20261031150000_admin_invoices_statement.sql`. Undo (only while no statement exists): `06_statement_mode.rollback.sql`, then run 03 and 04 again.

## Check it: ONE read-only SELECT

Run `98_verify_after_apply.sql` (one statement, one result set). Expected after parts 01 to 06: **23 rows** (5 `check` rows for part 06, 10 functions, 8 tables) and **`ok = true` on every row**. (After parts 01 to 05 only, the 18 table and function rows are `ok` and the 5 `check` rows say `false`: that is the proof the query sees whether part 06 is applied.) `ok` is computed by the query from these rules:

- **tables**: `rls_on = true`, `policies = 0`, no privilege at all for `anon`, `authenticated` and `public`; `service_role_can_write_or_execute = true` only for `invoice_settings`, `invoice_item_types`, `invoice_clients`.
- **functions** (one row each): no EXECUTE for `anon`, `authenticated` or `public`; `search_path_fixed = true` on all 10; `security_definer = true` only for `invoice_create_document`, `invoice_save_draft`, `invoice_set_status`; and only those three are executable by `service_role`.

Why the explicit revokes matter: on this project a function created in `public` is executable by `anon`, `authenticated` and `service_role` by default (`pg_default_acl`), and by PUBLIC in Postgres itself. Part 05 removes all of that.

## Roll back

`99_rollback.sql` drops every invoice object. **It deletes every quote and invoice entered**, so download `/admin/export` (it now has an invoice group) first.

## What was and was not tested

`sql-check/run.mjs` ran parts 01 to 05 (twice) and then 06, the verify SELECT and the rollbacks against a throwaway embedded Postgres (PGlite, not Supabase), applied by a non-superuser owner with the live default privileges: 158 checks,
including the lock triggers, a call of every one of the 10 functions as `anon` and as `authenticated` (all permission denied), the privileges of `service_role`, numbering and rounding, and that the verify SELECT turns `ok = false` when any rule is broken on purpose. It found one real mistake (a draft could not be voided), fixed in
`02_documents.sql`. **Not proven**: the same behaviour on the owner's Supabase project itself: that is what the verify SELECT is for.
