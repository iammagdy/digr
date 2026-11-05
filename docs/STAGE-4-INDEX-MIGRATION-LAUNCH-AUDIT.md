# STAGE 4: LAUNCH AUDIT OF THE ONE-OPEN-ADD-ON-PER-FILE INDEX MIGRATION (5 Nov 2026)

Migration: `supabase/migrations/20261104222136_one_open_addon_per_file.sql` (one `DO` pre-check block + one partial unique index + a comment). **NOT applied anywhere by this work.** Everything below ran on a **disposable local PostgreSQL 16.15** (unix socket, throwaway data directory, deleted afterwards) and on **production through read-only SELECTs only** (`list_migrations`, `information_schema`, `pg_indexes`, counts). No DDL or write was sent to Supabase, no secret was read, no customer data was returned (counts and column names only).

This is an independent re-verification (the earlier one: `docs/STAGE-4-ONE-OPEN-ADDON-INDEX-VERIFICATION.txt`). The schema is the real `public.missions` definition of `docs/proposals/agent-worker/01_agent_tables.sql` (all CHECKs, defaults, the foreign key to `auth.users`).

## 1. Result: PASS (every property below was observed, none assumed)

| # | Property | Observed |
|---|---|---|
| 1 | Applies to a table that already holds data (5 ordinary open missions, one with `plan` NULL, 8 ended add-ons, 1 open add-on) and changes no row | applied, no error, row count unchanged |
| 2 | Idempotent: a second run is safe | `DO` passes, `NOTICE: relation ... already exists, skipping`, no error |
| 3 | A second OPEN add-on of the same file is rejected (`plan_ready`, `approved`, `queued`: every open status), also when written by another user id | `unique_violation` (4 of 4) |
| 4 | Any number of ENDED add-ons (completed, failed, unserved, cancelled) of the same file | accepted (8 seeded + 5 more) |
| 5 | A different file may have its own open add-on | accepted |
| 6 | The slot frees when the open add-on ends, and the next request takes it; a further one is rejected again | accepted / accepted / rejected |
| 7 | Re-opening an ended add-on (`cancelled -> plan_ready`) while another is open | `unique_violation` |
| 8 | Ordinary missions are untouched: 50 more open ones, `plan` NULL (x3), `plan` with an `addon` key but no `of` (x2) | accepted (not indexed) |
| 9 | Updating the open row itself (any other column) is fine | accepted |
| 10 | The index does not replace the table's own CHECK: an unknown status | refused by `missions_status_check` |
| 11 | **Duplicates already present:** two files with more than one open add-on (one with two UNPAID rows + one started, one with two STARTED rows) | the migration **aborts with an exception** (`2 file(s) already have more than one open add-on row; repair them first ...`); afterwards: no index, rows unchanged (21), nothing deleted or updated |
| 12 | The repair (section 3) cancels only UNPAID duplicates and never a started row; the pair of two started rows still stops the migration (`1 file(s) ...`) until a person ends one; then the migration applies | confirmed in that order |
| 13 | **Concurrency:** two sessions insert an open add-on for the same file at the same moment | session A inserted and held its transaction 3 s; session B's insert **waited** until A committed and then failed with `duplicate key value violates unique constraint "missions_one_open_addon_per_file"`; exactly one row exists |

Method files (local only, not committed): schema, seed, `behave.sql` (15 cases, each classified "as expected" by a function that requires `unique_violation` for rejections and plain acceptance for allowed writes), `conc_a.sql` / `conc_b.sql`.

## 2. Lock and duration (400,000-row `missions` table, 40,000 add-on rows; local, no load)

| Method | Observed | Writers during the build |
|---|---|---|
| Plain `CREATE UNIQUE INDEX` (what the migration does; Supabase runs a migration inside a transaction) | build **~90 ms** | **blocked** (SHARE lock): a concurrent insert started 0.3 s in and returned only when the transaction committed. The block lasts the transaction (here 2 s because a sleep was added on purpose), i.e. in production about the build time plus the pre-check |
| `CREATE UNIQUE INDEX CONCURRENTLY` as its own statement | ~140 ms, index `valid = true` | not blocked |
| `CREATE UNIQUE INDEX CONCURRENTLY` inside a transaction block | `ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block` | n/a: **cannot be put in the migration file as it runs** |

The partial predicate indexes only add-on rows, so the build touches a tiny part of the table. Production today has **216** `missions` rows and **0** add-on rows, so the plain build would take milliseconds.

**Recommendation:** apply the migration file as it is (plain index), in a quiet minute, after the pre-check below. The write block is milliseconds at today's size. Use the `CONCURRENTLY` statement by hand (section 3, alternative) only if the table has grown by orders of magnitude. If a `CONCURRENTLY` build fails midway it leaves an INVALID index that must be dropped and rebuilt (`select indexrelid::regclass from pg_index where not indisvalid`).

## 3. Owner apply procedure (separate approval required; nothing here was run on production)

**Pre-check (read-only; expect zero rows):**
```sql
select plan->'addon'->>'of' as file_id, count(*) as open_rows, string_agg(id || ':' || status, ', ' order by id) as rows
from public.missions
where (plan->'addon'->>'of') is not null and status not in ('completed','failed','unserved','cancelled')
group by 1 having count(*) > 1 order by 1;
```
Also confirm: `select data_type from information_schema.columns where table_schema='public' and table_name='missions' and column_name='plan';` returns `jsonb`; `select count(*) from pg_indexes where indexname='missions_one_open_addon_per_file';` returns `0` before and `1` after.

**If the pre-check returns rows (not the case today):** repair UNPAID duplicates only, keeping a started row first, else the lowest id (tested locally; it never touches a started row):
```sql
with open_rows as (
  select id, status, job_id, approved_at, plan->'addon'->>'of' as file_id,
         row_number() over (partition by plan->'addon'->>'of'
                            order by (status <> 'plan_ready' or job_id is not null or approved_at is not null) desc, id asc) as rn
  from public.missions
  where (plan->'addon'->>'of') is not null and status not in ('completed','failed','unserved','cancelled'))
update public.missions m set status = 'cancelled', updated_at = now()
from open_rows o
where m.id = o.id and o.rn > 1 and m.status = 'plan_ready' and m.job_id is null and m.approved_at is null
returning m.id, o.file_id;
```
A file left with two started rows needs a person (check each job's money state first); the migration stays refused until then.

**Apply:** the migration file as is (it re-checks the same conditions and stops with an exception, changing nothing, if one fails).
**Alternative for a much larger table:** run the pre-check, then, as a stand-alone statement outside any transaction: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS missions_one_open_addon_per_file ON public.missions ((plan->'addon'->>'of')) WHERE (plan->'addon'->>'of') IS NOT NULL AND status NOT IN ('completed','failed','unserved','cancelled');` and then record the migration version.
**Verify:** index exists and `indisvalid`; `select count(*) from public.missions` unchanged; the pre-check still returns zero rows; one review request of a test account still works.
**Rollback (instant, no data change):** `DROP INDEX public.missions_one_open_addon_per_file;` (the application's own guard and `reconcileOpenAddons` keep working without it).

## 4. Production audit (READ-ONLY, 5 Nov 2026)

| Check | Result |
|---|---|
| Migration history (`list_migrations`) | 28 migrations, newest `20261017184147` (`settle_decision_maker_fields`); **`20261104222136` is NOT applied** |
| Index on `missions` | only `missions_pkey`, `missions_status_lease_idx`, `missions_user_idx`; **`missions_one_open_addon_per_file` absent** |
| Columns the index needs | `plan` is `jsonb`, `status` text, `id` text, `user_id` uuid, `job_id` text, `approved_at` timestamptz: all present |
| Counts (no row data) | `missions` 216; rows with a `plan.addon` key **0**; open add-on rows **0**; files with duplicate open add-ons **0** |

So the pre-condition checks would pass today and the index would be built over an empty set of add-on rows. Note: `missions` itself does not appear in the migration history (it was created outside `supabase/migrations`), which the migration tolerates (it only checks that the table and the `jsonb` column exist).

## 5. Risks and what is NOT verified

- Production was not written to; the index was never built there. The behaviour is proven on PostgreSQL 16.15 locally; the production engine version was not queried (Supabase runs a recent major version; partial and expression unique indexes are long-standing features).
- The key is the file id only (not the user): by design, one open add-on per delivered file, whoever wrote it (test 3). The application's creation protocol already refuses a second open request in the same way, so a customer sees the existing refusal sentence rather than a raw database error; the only path that would surface `23505` is a race the guard did not catch (test 13). How the creation code answers that raw error was not exercised against a real database here.
- The index closes one hole (two open add-ons after a database outage). It does not by itself make the approval route safe; see `docs/STAGE-4-APPROVAL-ROUTE.md`.
- Applying to production is a migration under `supabase/**`: **owner approval required**; this document authorizes nothing.
