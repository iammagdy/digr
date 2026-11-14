# Stale verification jobs: findings and cleanup proposal (14 Nov 2026)

**Status: proposal only. Nothing in production was changed.** Every number below comes from a read-only query on 14 Nov 2026. The cleanup in §5 may be performed only by an authorized agent, and only after the owner's explicit approval.

## 1. The nine jobs

| Job id (suffix after `vrun_<ms>_<uuid>_`) | Status | `reserved_credits` | Lease | Made by |
|---|---|---|---|---|
| `1791822303290…_claim_parallel` | running | 10 | expired 12 Oct 16:26 | `scripts/verify/verify-chunk-claim.ts` |
| `1791824648388…_claim_parallel` | running | 10 | expired 12 Oct 17:05 | same |
| `1791822376744…_missing_reserve` | queued | 8 | none | `scripts/verify/verify-release-job.ts` |
| `1791824673798…_missing_reserve` | queued | 8 | none | same |
| `1791822376744…_zero_reserve` | queued | 0 | none | same |
| `1791824673798…_zero_reserve` | queued | 0 | none | same |
| `1791822576226…_spend_first` | queued | 0 | none | `scripts/verify/verify-spend-cap.ts` |
| `1791822576226…_spend_parallel_a` | queued | 0 | none | same |
| `1791822576226…_spend_parallel_b` | queued | 0 | none | same |

**What all nine have in common:**
- Endpoint `tiktok-profile`, created 12 Oct 2026 between 16:25 and 17:05 UTC, last updated then.
- `charged_credits` 0, `delivered_units` 0, `accumulated_cost_usd` 0, `attempt_count` 0, no `result_file_id`, no `error_message`.
- No `job_events` rows and no storage objects.

**Not customer work:**
- **The owner, user `00000000-0000-0000-0000-000000000001`:**
  - its e-mail domain is `digr.local`;
  - it has no `created_at` and never signed in;
  - it has no missions.
- **The ids** match the fixture rule of `create_verify_fixture`: `^vrun_[0-9]{13}_[0-9a-f-]{36}_[a-z0-9_]+$`, restricted to this user (migrations `20261012162201`, `20261012172501`).
- **No other account** has a queued or running job: `other_open_jobs = 0`.
- **The fixture rows** were created by the verification scripts through `create_verify_fixture`, which writes the job row directly. The scripts never put them through the job engine.
- **All test jobs.** This user has 62 `vrun_` jobs in total: 45 failed, 6 completed, 2 refused, and these 9 still open.

## 2. The two `provider_costs` rows ($0.60)

| id | job | provider | units | cost_usd | is_estimate |
|---|---|---|---|---|---|
| 3 | `…_spend_first` | treg | 45 | 0.45 | false |
| 4 | `…_spend_parallel_b` | treg | 15 | 0.15 | false |

- **What wrote them.** `verify-spend-cap.ts`, run with `--i-know-this-uses-budget`, tested the daily provider cap. It called:
  - `reserve_provider_spend_atomic` with estimates 0.50, 0.20 and 0.20 (one of the parallel pair was refused by the cap, as intended);
  - `commit_provider_spend` with **hard-coded** "actual" costs of 0.45 and 0.15.
- **No provider was called.** The script makes no HTTP request: it has no `fetch` and uses no TREG token. These rows are entries in the **internal daily-cap accounting**, not a bill from TREG.
- **What they affected.** They counted toward 12 Oct's daily cap total. That day has 12 TREG rows totalling $0.64; the other $0.04 is not from these jobs. They have no effect on any other day.
- **They are not charges to anyone.** No customer was debited for them (see §3), and `jobs.accumulated_cost_usd` is 0 because no worker ever ran the jobs.
- **They stay.** `provider_costs.job_id` references `jobs.id` with `ON DELETE RESTRICT`, so the jobs cannot be deleted while these rows exist. The rows are also the audit trail of the cap test. The cleanup below deletes nothing.

## 3. The 36 "reserved" credits are not holds

- `reserved_credits` totals 36: 10 + 10 + 8 + 8. The fixtures **wrote these values directly into the job rows**.
- **No ledger rows.** `credit_ledger` has no row for any of the nine: no `res_`, `rel_` or `chg_` id, and no `job_id` reference. Nothing was ever debited.
- **The balance comes from the ledger only.** `calculateBalance` (`src/lib/supabase/ledger.ts`) sums `credit_ledger.delta` for the user, so these numbers have never reduced anyone's balance. The test user's ledger sum is 1,957 points (173 rows).
- **The `missing_reserve` fixtures were built this way on purpose:** "positive reserve amount but `res_` row intentionally absent" (`verify-release-job.ts`). They exist to prove that `release_job_atomic` refuses to release a reserve that was never taken.

## 4. Why they never finish, and why the scheduler keeps retrying

1. **The canonical path refuses them, by design.**
   - `release_job_atomic` (the production definition was read) raises for all nine:
     - `reserved_credits <= 0`: "invalid reserved_credits" (5 jobs);
     - no `res_<job>` ledger row: "Reserve record … does not exist" (4 jobs).
   - That refusal is correct: a release would credit 36 points that were never debited.
   - The daily watchdog (`/api/cron/watchdog`) tries `release_job_atomic(force)` on them every day and logs "Watchdog failed to release job …" each time.
2. **The stall notifier retries every minute.**
   - `notifyStalledJobs` runs inside `/api/cron/drive`, which pg_cron `diger-drive-jobs` calls every minute.
   - It selects up to 20 queued or running jobs idle for more than 10 minutes. These nine are always first, ordered by `updated_at`.
   - For each one it counts the existing notices (HEAD) and then inserts `notif_stalled_<job>`. The primary key refuses the insert (409), because the notices were sent once on 21 Oct.
   - **Result:** 18 requests a tick, about 1,080 an hour (measured in the Supabase API logs: `stall_notices` ≈ 1,075–1,099 an hour), about 26,000 a day. No duplicate notice and no e-mail is sent.
3. **The drive itself does not touch them.** Its dispatch query only considers jobs updated within the last 25 minutes.

## 5. The smallest safe cleanup (run by an authorized agent, only after explicit owner approval)

**Operation.** On exactly these nine rows it changes three columns and nothing else:
- `status`: `queued`/`running` → `failed`;
- `lease_until`: → `NULL` (the two `claim_parallel` rows hold leases that expired on 12 Oct; the other seven are already `NULL`);
- `error_message`: `NULL` → a fixed explanation.

Nothing is deleted, no ledger row is written and no RPC is called. It stops without changing anything if any of the nine holds an **active** lease (`lease_until` in the future).
- `updated_at` is deliberately left unchanged, so the admin Operations panel does not report "9 jobs failed in the last 24 hours (points returned)", which would be false: no points move.
- The `chk_jobs_status` constraint allows `failed`.

```sql
-- Run once, by an authorized agent, ONLY after the owner's explicit approval (Supabase SQL editor or an approved write connection). All or nothing.
DO $$
DECLARE
  v_ids text[] := ARRAY[
    'vrun_1791822303290_4e3e2b5b-4019-4c4d-a9b8-dd1e3a150b36_claim_parallel',
    'vrun_1791822376744_eadb2eba-2155-4ce0-82bb-dccb395ecdd5_missing_reserve',
    'vrun_1791822376744_eadb2eba-2155-4ce0-82bb-dccb395ecdd5_zero_reserve',
    'vrun_1791822576226_68f79cc0-aedf-4f28-b2a4-f1928c857c3b_spend_first',
    'vrun_1791822576226_68f79cc0-aedf-4f28-b2a4-f1928c857c3b_spend_parallel_a',
    'vrun_1791822576226_68f79cc0-aedf-4f28-b2a4-f1928c857c3b_spend_parallel_b',
    'vrun_1791824648388_acee99b7-f36e-44f9-91cb-1a6e26ed274b_claim_parallel',
    'vrun_1791824673798_de465176-1e8f-4181-aae3-8f7a6b451ab1_missing_reserve',
    'vrun_1791824673798_de465176-1e8f-4181-aae3-8f7a6b451ab1_zero_reserve'
  ];
  v_count int;
BEGIN
  -- every guard must hold, or nothing changes
  IF EXISTS (SELECT 1 FROM public.jobs WHERE id = ANY (v_ids) AND lease_until IS NOT NULL AND lease_until > now()) THEN
    RAISE EXCEPTION 'an active lease is held on one of these jobs: stop';
  END IF;
  IF EXISTS (SELECT 1 FROM public.credit_ledger WHERE job_id = ANY (v_ids)
             OR id = ANY (SELECT p || i FROM unnest(v_ids) i, unnest(ARRAY['res_','rel_','chg_']) p)) THEN
    RAISE EXCEPTION 'ledger rows exist for these jobs: stop';
  END IF;

  UPDATE public.jobs
     SET status = 'failed',
         lease_until = NULL,
         error_message = 'Verification fixture (12 Oct 2026) closed by an owner-approved cleanup; no credits were reserved, charged or released.'
   WHERE id = ANY (v_ids)
     AND user_id = '00000000-0000-0000-0000-000000000001'
     AND status IN ('queued', 'running')
     AND COALESCE(charged_credits, 0) = 0
     AND COALESCE(delivered_units, 0) = 0
     AND result_file_id IS NULL
     AND (lease_until IS NULL OR lease_until <= now())
     AND updated_at < '2026-10-13T00:00:00Z';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count <> 9 THEN
    RAISE EXCEPTION 'expected 9 rows, would change %: rolled back', v_count;
  END IF;
END $$;
```

**Before: run it, keep the output.**

```sql
SELECT id, status, reserved_credits, charged_credits, delivered_units, lease_until, updated_at
  FROM public.jobs WHERE id LIKE 'vrun\_%' AND status IN ('queued','running') ORDER BY id;          -- expect the 9 rows above
SELECT count(*) FROM public.jobs WHERE status IN ('queued','running')
   AND user_id <> '00000000-0000-0000-0000-000000000001';                                      -- expect 0
SELECT coalesce(sum(delta),0), count(*) FROM public.credit_ledger
 WHERE user_id = '00000000-0000-0000-0000-000000000001';                                       -- expect 1957, 173
SELECT count(*), sum(cost_usd) FROM public.provider_costs WHERE job_id LIKE 'vrun\_%';         -- record (2 rows, 0.60 for the nine)
SELECT count(*) FROM public.notifications WHERE user_id = '00000000-0000-0000-0000-000000000001';  -- record (13)
```

**After: expect exactly these changes.**

```sql
SELECT count(*) FROM public.jobs WHERE status IN ('queued','running');                         -- 0
SELECT id, status, lease_until, updated_at, error_message FROM public.jobs
 WHERE id LIKE 'vrun\_17918%' AND error_message LIKE 'Verification fixture%';                   -- the 9, failed, updated_at unchanged
SELECT coalesce(sum(delta),0), count(*) FROM public.credit_ledger
 WHERE user_id = '00000000-0000-0000-0000-000000000001';                                       -- still 1957, 173 (ledger untouched)
SELECT count(*), sum(cost_usd) FROM public.provider_costs WHERE job_id LIKE 'vrun\_%';         -- unchanged
SELECT count(*) FROM public.notifications WHERE user_id = '00000000-0000-0000-0000-000000000001';  -- unchanged (13)
```

The next minute's tick should show no more notification requests. In the Supabase logs, `/rest/v1/notifications` should drop to about 0 an hour from about 1,080.

**Rollback.** The old values are in the "Before" output. A rollback sets `status` back (7 `queued`, 2 `running`) and restores the two expired `lease_until` values and a NULL `error_message`. Nothing else was touched.

**Risks:**
- **The updated rows are only these nine.** Every guard has to match, or nothing changes:
  - the id list and the user;
  - the status, zero charge, zero delivery and no file;
  - no active lease and the October date;
  - a count of exactly 9.
- **No money or schema changes:** no ledger row, no balance change, no provider call, no migration, no schedule change.
- **What changes for the test user:** its history shows nine more failed jobs. They are only visible to that synthetic account.
- **Later watchdog runs skip them,** because they are no longer queued or running.

## 6. Requests that disappear

| Where | Today | After the cleanup | After the code fix alone (PR) |
|---|---|---|---|
| Stall notifier, per minute | 1 jobs read + 9 HEAD + 9 refused inserts = **19** | **1** (jobs read, nothing stalled) | **2** (jobs read + one batch check) |
| Per day | ≈ 27,400 | ≈ 1,440 | ≈ 2,880 |
| Watchdog, daily | 9 refused `release_job_atomic` calls + 9 error logs | 0 | 9 (unchanged) |

- **Measured:** the ≈ 1,080 requests an hour today (Supabase API logs).
- **Estimated:** the "after" columns, which follow from the code paths.

The code fix (batch check in `notifyStalledJobs`) also protects against any future job that stays stalled.
