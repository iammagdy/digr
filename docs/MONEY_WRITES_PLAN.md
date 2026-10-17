# Money-table direct writes: audit and replacement plan

Scope: every code path that writes to `plans_quotes`, `jobs`, `topups`, `provider_costs`, `credit_ledger` or `profiles`
without going through an approved SQL function. This file is a plan only. No money path was rewritten in this task
and no migration was applied.

How it was produced: a scripted scan of `src/`, `scripts/` and `supabase/` for `.from("<table>")` chains containing
`insert/update/upsert/delete`, `tables.createRow/updateRow/deleteRow` calls with `tableId: "<table>"` (including the
constants `CREDIT_LEDGER_*`, `JOBS_COLLECTION` and similar), then an import-graph walk from every Next.js route, page and
layout to mark which files are reachable by the live app. Reachable means "the file is imported by live code"; the
"Called by live code?" column says whether the writing function itself is called from the live app (checked by searching
for the function name).

## Approved functions that exist in the database (read-only query result)

Query: `select proname, args, security_definer, roles with EXECUTE (anon/authenticated/service_role) from pg_proc in schema public`.

| Function | Arguments | Security definer | Roles with EXECUTE |
|---|---|---|---|
| `accept_quote_atomic` | `p_quote_id text, p_user_id uuid, p_expected_quote_hash text` | yes | service_role |
| `approve_topup_atomic` | `p_topup_id text, p_confirmed_amount_egp numeric` | yes | service_role |
| `claim_job_chunk` | `p_job_id text, p_expected_step integer, p_lease_seconds integer` | yes | service_role |
| `commit_provider_spend` | `p_cost_id bigint, p_actual_cost_usd numeric, p_units integer` | yes | service_role |
| `complete_chunk` | `p_job_id text, p_expected_step integer, p_new_cursor text, p_new_delivered_units integer, p_cost_usd numeric` | yes | service_role |
| `purchase_methodology_atomic` | `p_user_id uuid, p_job_id text, p_amount numeric, p_note text` | yes | service_role |
| `record_chunk_failure` | `p_job_id text, p_error_message text` | yes | service_role |
| `release_job_atomic` | `p_job_id text, p_error_message text` and `(…, p_force boolean)` | yes | service_role |
| `reserve_credits_atomic` | `p_user_id uuid, p_job_id text, p_amount numeric, p_note text` | yes | service_role |
| `reserve_provider_spend_atomic` | `p_job_id text, p_provider text, p_estimated_cost_usd numeric, p_daily_cap_usd numeric` | yes | service_role |
| `settle_job_atomic` | `p_job_id text, p_points_cap numeric, p_result_file_id text` | yes | service_role |

All eleven approved functions exist and are executable by `service_role` only (none by `anon` or `authenticated`).
Other public functions seen: `block_ledger_mutation` / `block_ledger_truncate` (the append-only guard),
`create_verify_fixture`, `handle_new_user`, `is_admin`, `rls_auto_enable`.

## Direct writes found in `src/`

"Live" = reachable from a Next.js route/page. "Legacy" = only the old Appwrite-style functions in `src/functions/*/src/main.ts`
(listed in `appwrite.json`) and their helpers; not reachable from the Next.js app.

| File:line | Table | Operation | Called by live code? | Replace with |
|---|---|---|---|---|
| `src/app/api/topup/submit/route.ts:199` | topups | write (insert) | live | New `submit_topup_atomic` (validates reference uniqueness, inserts one `pending` row). Not in the approved list; proposal below. |
| `src/app/api/admin/topups/approve/route.ts:97` | topups | write (update status approved) | live | `approve_topup_atomic` (also writes the `top_` ledger row). The route today calls `applyTopup` then updates the status in a second statement, which is not atomic. |
| `src/app/api/admin/topups/approve/route.ts:160` | topups | write (update status rejected) | live | New `reject_topup_atomic` (status change only, no ledger row). |
| `src/lib/supabase/ledger.ts:261` (`applyTopup`) | credit_ledger | write (insert `top_`) | live, only from the approve route above | `approve_topup_atomic` |
| `src/lib/supabase/ledger.ts:118` (`releaseCredits`) | credit_ledger | write (insert `rel_`) | called only by `releaseReservation` / `completeJobWithRelFirst` in the same file, which have no live callers | `release_job_atomic` |
| `src/lib/supabase/ledger.ts:181` (`chargeCredits`) | credit_ledger | write (insert `chg_`) | no live caller | `settle_job_atomic` |
| `src/functions/shared/ledger.ts:100,127,184,268` (`reserveCredits`, `releaseCredits`, `chargeCredits`, `applyTopup`) | credit_ledger | write (createRow) | legacy (helpers of the Appwrite job-worker / create-job / approve-topup functions) | `reserve_credits_atomic`, `release_job_atomic`, `settle_job_atomic`, `approve_topup_atomic` |
| `src/functions/shared/multiStepWorker.ts:379,412,454,527,686,713,806,868,896,1060,1156` | jobs | write (updateRow) | legacy (`executeMultiStepJob` has no caller in `src/app`; the live worker is `src/app/api/worker/chunk/route.ts`, which uses `claim_job_chunk`, `complete_chunk`, `record_chunk_failure`, `settle_job_atomic`, `release_job_atomic`) | Remove the legacy executor; if kept, route through `claim_job_chunk` / `complete_chunk` / `record_chunk_failure` / `settle_job_atomic` / `release_job_atomic`. |
| `src/functions/shared/planManager.ts:816,825` (`createAndSaveManagedQuote`, Supabase branch) | plans_quotes | write (update status expired, insert quote) | live (chat handler and `/api/chat/edit-plan`) | New `create_quote_atomic` (supersede earlier `quoted` rows of the user, insert the new quote with its hash, in one transaction). Quote creation has no approved function today; `accept_quote_atomic` only covers acceptance. |
| `src/functions/shared/planManager.ts:848,862` (same function, `tables.createRow` branch) | plans_quotes | write | tests/legacy branch only (the live client has `.from`) | Delete the branch with the legacy client. |
| `src/functions/shared/providerCosts.ts:43` (`logProviderCost`, Supabase branch) | provider_costs | write (insert) | live: `chatHandler.ts:2847` logs the model's token cost (`provider: "llm"`) | Provider job spend is already reserved and committed through `reserve_provider_spend_atomic` / `commit_provider_spend`. Model cost needs a narrow `log_llm_cost` insert-only function (new). |
| `src/functions/shared/providerCosts.ts:54` (`createRow` branch) | provider_costs | write | legacy (called from `multiStepWorker`) | Delete with the legacy executor. |
| `src/functions/shared/quoteAccept.ts:185,197` | plans_quotes, jobs | write | no live caller (the live route uses `src/lib/supabase/quoteAccept.ts`, which calls `accept_quote_atomic`) | Delete; `accept_quote_atomic` already covers it. |
| `src/lib/supabase/quotes.ts:51` (`createQuoteRecord`) | plans_quotes | write (insert) | no live caller | Delete or replace with `create_quote_atomic`. |
| `src/app/api/account/delete/route.ts:50` | profiles | write (`deletion_scheduled_for`) | live | New `schedule_account_deletion(p_user_id)`; touches one non-money column. |
| `src/app/api/account/delete/cancel/route.ts:62` | profiles | write (clear `deletion_scheduled_for`) | live | New `cancel_account_deletion(p_user_id)`. |
| `src/app/api/cron/watchdog/route.ts:145` | profiles | write (anonymize email/name/phone) | live (cron) | New `anonymize_deleted_profile(p_user_id)`. The balance is not touched. |
| `src/app/api/onboarding/route.ts:69` | profiles | write (`updated_at` only) | live | Remove the statement; it changes nothing but a timestamp. |
| `src/functions/approve-topup/src/main.ts:74,109` | topups | write | legacy | `approve_topup_atomic` / `reject_topup_atomic` |
| `src/functions/submit-topup/src/main.ts:188` | topups | write | legacy | `submit_topup_atomic` |
| `src/functions/create-job/src/main.ts:131` | jobs | write (createRow) | legacy | `accept_quote_atomic` (creates the job and the reserve together) |
| `src/functions/on-user-create/src/main.ts:40` | profiles | write (createRow) | legacy (profiles are created by the `handle_new_user` trigger) | Delete. |
| `src/functions/request-account-deletion/src/main.ts:36` | profiles | write | legacy | `schedule_account_deletion` |
| `src/functions/purge-deleted-accounts/src/main.ts:58` | profiles | write (deleteRow) | legacy; profiles must never be hard-deleted (foreign keys to the ledger) | Delete the function; the watchdog anonymization above replaces it. |

## Direct writes found in `scripts/` (developer scripts, not deployed)

These use the service key to create or delete fixtures. Deleting ledger rows fails against the append-only trigger, so
the cleanup parts of these scripts cannot work on a real database and must never be pointed at production.

| File | Tables written |
|---|---|
| `scripts/capture-all-screenshots.ts` | profiles, credit_ledger |
| `scripts/capture-phase-b2.ts` | profiles, credit_ledger |
| `scripts/cleanup-all.ts` | jobs, credit_ledger, topups, profiles |
| `scripts/eval-real-model.ts` | profiles (raw SQL update) |
| `scripts/generate-existing-job-files.ts` | jobs |
| `scripts/test-e2e-topup.ts` | credit_ledger, topups, profiles |
| `scripts/test-p1-chathandler.ts` | plans_quotes |
| `scripts/test-p1-permissions.ts` | plans_quotes |
| `scripts/test-permissions.ts` | jobs, credit_ledger, topups |
| `scripts/test-phase2-5.ts` | credit_ledger, topups, profiles |
| `scripts/test-phase3.ts` | credit_ledger, jobs, profiles |

Recommended: move fixture creation behind the existing `create_verify_fixture` function (service_role only) and drop the
delete-from-ledger steps.

## Reads (no change needed)

Read-only access exists in 7 files for `profiles`, 7 for `topups`, 21 for `jobs`, 10 for `plans_quotes`, 3 for
`provider_costs` and 7 for `credit_ledger` (route handlers, dashboards, admin pages). The methodology route
(`src/app/api/jobs/[id]/methodology/route.ts`) reads `credit_ledger` and charges only through `purchase_methodology_atomic`.

## Proposed new functions (migration files only; not applied)

All new functions must be `SECURITY DEFINER`, `SET search_path = public`, with
`REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role;`.

1. `create_quote_atomic(p_user_id uuid, p_quote_id text, p_quote_hash text, p_items jsonb, p_total_points numeric, p_output_formats text[], p_expires_at timestamptz)`: expire the user's earlier `quoted` rows, insert the new one.
2. `submit_topup_atomic(p_user_id uuid, p_topup_id text, p_amount_egp numeric, p_reference text, p_sender_name text, p_sender_phone text, p_receipt_file_id text)`.
3. `reject_topup_atomic(p_topup_id text, p_reason text)`.
4. `log_llm_cost(p_user_id uuid, p_cost_usd numeric, p_units integer)`: insert-only into `provider_costs`.
5. `schedule_account_deletion`, `cancel_account_deletion`, `anonymize_deleted_profile`: one profile column group each.

## Suggested order

1. Admin top-up approval to `approve_topup_atomic` (money, live, non-atomic today).
2. Quote creation to `create_quote_atomic` (live, every plan).
3. Delete the legacy Appwrite functions and their helpers after confirming none is deployed (removes about 25 of the sites above).
4. Top-up submit/reject, LLM cost log, account-deletion functions.
5. Fixture scripts.
