# Always-on driver for long missions: owner checklist (proposal, nothing here is applied)

**Phone-friendly.** Every step is one screen of the Supabase or Vercel dashboard, in order. Do not paste any secret in chat or in a file.
Time: about 10 minutes. Do it on **Thursday or Friday**, never on Saturday morning.

## What it is, in four lines

- A big mission runs as many small steps. Each step starts the next one itself, and an open page restarts a broken chain.
- With the page closed and a broken chain, nothing restarts it until the daily watchdog refunds the job. The driver fixes that: a database scheduler
  calls the app route `/api/cron/drive` and it asks the existing worker to run the next step of a job the customer already approved.
- It reserves, charges and releases **nothing**. Each step is claimed through `claim_job_chunk` (a 60-second lease plus the expected step), so two
  drivers, a driver and the job's own chain, or a driver and an open page never run the same step twice.
- **The app says «تقدر تقفل الصفحة» only when ALL of these are true:** `LONG_JOB_DRIVER` is `cron`, **and** the scheduler really called the driver
  in the last 3 minutes. If the scheduler stops, the sentence disappears by itself within 3 minutes and the plan says the page must stay open.

## Cost to know about

When no job is waiting the scheduler still calls the route about every other minute, as a heartbeat (so the app can prove the driver is alive).
That is about 700 short calls a day, roughly 40 minutes of the monthly Vercel CPU. **Turn the driver off after the event** (section 6).

## 1. Find the secret (1 minute)

1. Vercel → project `diger` → Settings → Environment Variables.
2. Open `CRON_SECRET` (it already exists; the daily watchdog uses it) and copy its value.

## 2. Store two secrets in the database vault (2 minutes)

1. Supabase → project of Diger → SQL Editor → New query.
2. Paste these two lines. Replace the first `...` with the value you copied. Press Run.

```sql
select vault.create_secret('...', 'diger-cron-secret');
select vault.create_secret('https://diger.tech', 'diger-app-base-url');
```

Run this once. If a name already exists the editor says so and nothing changes. (To correct a wrong value later:
`select vault.update_secret((select id from vault.secrets where name = 'diger-cron-secret'), '...');` with the real value in place of `...`.)

## 3. Create the scheduler (2 minutes)

1. SQL Editor → New query → paste the whole file `docs/proposals/08_pg_cron_driver.sql` → Run.
2. It turns on `pg_net` and `pg_cron` if needed, creates `drive_jobs_tick()` (the service role only) and schedules it every minute as
   `diger-drive-jobs`. Running it twice does not create a second schedule. It writes nothing except the schedule.

## 4. Verify before turning anything on (2 minutes)

In the SQL Editor, one query at a time (a job running or idle for a minute helps, but the heartbeat also works with none):

```sql
select jobname, schedule, active from cron.job where jobname = 'diger-drive-jobs';
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
select status_code, created from net._http_response order by created desc limit 5;
```

Expected, after about 3 minutes:

- query 1: one row with `active = true`;
- query 2: rows with `succeeded`;
- query 3: rows with status `200`. **`401` means the vault secret differs from `CRON_SECRET`**: fix it with the `update_secret` line in section 2.

If query 3 shows no rows after 3 minutes, check that both vault names exist: `select name from vault.secrets;`.

## 5. Turn it on, and see that it is on (3 minutes)

1. Vercel → Settings → Environment Variables → add `LONG_JOB_DRIVER` = `cron` (Production) → Redeploy.
2. Open `https://diger.tech/api/driver-status`. It must show `{"mode":"cron","configured":"cron"}`.
   `{"mode":"tab","configured":"cron"}` means the flag is on but no call arrived in the last 3 minutes: go back to section 4.
3. Open the admin page «لوحة المؤتمر», the box «المُشغّل الدائم للمهام الطويلة»: «المُشغّل الدائم يعمل» and «آخر نبضة قبل … ثانية» (under 3 minutes).
4. Start one small mission from a test account and check that the plan says the page can be closed; close the page; the job still finishes.

## 6. Turn it off (the moment you want to stop, 2 minutes)

1. Vercel → delete the variable `LONG_JOB_DRIVER` (or set it to `tab`) → redeploy. The app stops saying the page can be closed.
2. Supabase → SQL Editor → `select cron.unschedule('diger-drive-jobs');` : the scheduler stops.

Nothing else needs undoing; a running job goes back to being resumed by the open page. Even without step 1, the sentence disappears within 3 minutes
of the scheduler stopping.

## Safety review of the driver route (what it does on each call)

- `401` without the cron secret (timing-safe, the same check the worker uses); nothing is read before that.
- Writes **one row** (`settings_private`, key `driver_tick`, the time of the call); no money table, no ledger, no balance.
- Selects jobs `queued` or `running`, with no live lease, last touched between 15 seconds and 25 minutes ago, whose retry time has passed;
  oldest first; at most **5** per call; one step per job, in parallel, each bounded by a 50-second timeout (the worker's own deadline is 45 s;
  the function limit is 60 s).
- A job idle for more than 25 minutes is left to the daily watchdog, which refunds the whole reserve.
- Each call also sends, once per job, the «temporarily stopped, nothing beyond what was delivered will be charged» notice for jobs that made no
  progress for 10 minutes.
- A provider cap, a 402 or a 429 mid-job is handled by the worker as before: rows already delivered are settled once through
  `settle_job_atomic`, the rest of the reserve returns; with nothing delivered the whole reserve is released.
- What can go wrong: a wrong secret (401, the app says «keep the page open»), the scheduler off (same), a chunk that fails five times (the existing
  retry rule releases the reserve). Nothing here can charge twice or hold a reserve forever.

## Alternative: Vercel Pro cron

On the Vercel Pro plan a platform cron can call the same route every minute instead of the database: add to `vercel.json`
`{ "path": "/api/cron/drive", "schedule": "* * * * *" }` (Vercel sends `Authorization: Bearer $CRON_SECRET`, which the route accepts), then set
`LONG_JOB_DRIVER=cron`. This needs a plan change and a code change to `vercel.json` (an existing test pins one cron on the Hobby plan), so it is
not part of this proposal. The route, the heartbeat and the three-minute rule are the same either way.
