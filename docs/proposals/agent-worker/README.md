# Agent worker, phase A: missions, events, calls, heartbeat (PROPOSAL, **NOT APPLIED**)

Nothing in this folder has been run against Supabase. The owner applies it by hand, after review, in the order below. The code that uses these tables is `agent/` (the worker) and
`src/app/admin/agent/` with `src/app/api/admin/agent/` (the admin page «الوكيل»). Until the SQL is applied the page says so in Arabic and the worker cannot claim anything.

**No money table is touched.** Not `credit_ledger`, `jobs`, `topups`, `profiles`, `plans_quotes`, `provider_costs`, and no money function is created or changed. Money moves only through the
functions that already exist, called with the service role by the admin approve route and by the worker: `create_quote_atomic` and `accept_quote_atomic` (reserve), `claim_job_chunk`
(lock the job against the website's old driver), `complete_chunk` and `settle_job_atomic` (charge = ceil(delivered x unit price), never above the reserve, the rest released) or
`release_job_atomic` (nothing delivered: the whole hold comes back). Every call is recorded in `provider_costs` by the existing `reserve_provider_spend_atomic` / `commit_provider_spend(_v2)`.

| Step | File | What | Rollback |
|---|---|---|---|
| 0 | `00_verify_before_apply.sql` | READ ONLY: none of the objects exists, the roles and the six money functions are there, which cap `create_quote_atomic` holds | none |
| 1 | `01_agent_tables.sql` | `missions`, `mission_events`, `mission_calls`, `agent_worker_heartbeat`, `agent_settings`. RLS on. A customer reads only their own missions (16 safe columns) and their own missions' events; only the service role writes | `01_agent_tables.rollback.sql` |
| 2 | `02_agent_claim_function.sql` | `agent_claim_mission(worker, lease)`: atomic claim with `FOR UPDATE SKIP LOCKED`, takes over a dead worker's mission; service role only | `02_agent_claim_function.rollback.sql` |
| 3 | `03_agent_storage.sql` | private bucket `agent-missions` (raw pages, code outputs, saved rows, result files); no policy: service role only | `03_agent_storage.rollback.sql` |
| 4 | `04_verify_after_apply.sql` | READ ONLY: RLS on, the two policies, no write grant, no grant for anon, safe columns only, claim function service-role only, bucket private, money tables unchanged | none |
| - | `05_scratch_behavior_check.sql` | for a SCRATCH PostgreSQL only (never Supabase): customers see only their own rows, internal columns and tables are refused, anon reads nothing, atomic claim and takeover | none |

**Before step 1**: `docs/proposals/job-cap-25000/` should already be applied. Without it `create_quote_atomic` refuses a reserve above 600 points and a mission above that cannot be approved
(the admin page then says the quote could not be created). The job's `target_volume_max` is also limited to 5,000 rows by `accept_quote_atomic`, so a mission delivers at most 5,000 rows.

## What was verified, and how

All of it on a SCRATCH local PostgreSQL 16 (never Supabase): steps 1 to 3 apply, apply twice, roll back and re-apply; `00` and `04` return the expected rows; `05` passes; and the worker's
real approve and settle code was run against the REAL money function bodies from `supabase/migrations/` (with the 25,000 cap step applied): reserve 10,627 points for 1,800 planned rows,
1,234 delivered rows charged 6,335 = ceil(1,234 x 5.133334), 4,292 released, the balance and the ledger rows (`res_`, `rel_`, `chg_`) as expected, and a mission that delivers nothing gets its whole
hold back. That run found one bug (release_job_atomic refuses while the job's lease is held), fixed before this PR. Not verified: anything on the production Supabase project.
