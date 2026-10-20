# Always-on driver for long missions: owner setup (proposal, nothing here is applied)

**Why.** A big mission runs as many small steps (one provider page each). Today each step starts the next one itself, and an open page
restarts a broken chain. With the page closed and a broken chain, nothing restarts it until the daily watchdog refunds the job.
The driver is a small route, `/api/cron/drive`, that a database scheduler calls once a minute to restart broken chains.

**What it can and cannot do.** It only asks the existing worker to run the next step of a job the customer already approved.
It reserves, charges and releases nothing. The worker still takes each step through `claim_job_chunk` (a 60-second lease plus the
expected step), so two drivers, a driver and the job's own chain, or a driver and an open page never run the same step twice.
Reserve, settle and release stay in their existing functions. The platform's own cron stays the daily watchdog (Hobby plan), and
`vercel.json` is not changed.

**Until you finish these steps nobody is told "you can close the page".** That sentence appears only when the environment variable
`LONG_JOB_DRIVER` is `cron` (step 4). The default is `tab`.

## Steps (about 5 minutes, can be done on a phone)

You need the Supabase dashboard (project of Diger) and the Vercel dashboard. Do not paste any secret in chat.

1. **Find the secret.** Vercel → project `diger` → Settings → Environment Variables → `CRON_SECRET` (it already exists; the daily
   watchdog uses it). Copy its value.
2. **Store two secrets in the database vault.** Supabase → SQL Editor → New query → paste these two lines, replacing the first
   `...` with the value from step 1, then press Run:

   ```sql
   select vault.create_secret('...', 'diger-cron-secret');
   select vault.create_secret('https://diger.tech', 'diger-app-base-url');
   ```

   Run this once. If a name already exists, the editor says so and nothing changes.
3. **Create the scheduler.** New query → paste the whole file `docs/proposals/08_pg_cron_driver.sql` → Run. It enables `pg_net` and
   `pg_cron` if they are not on yet, creates the function `drive_jobs_tick()` (callable only by the service role) and schedules it
   every minute under the name `diger-drive-jobs`. Running it twice does not create a second schedule.
4. **Turn the mode on, only after the check below passes.** Vercel → Settings → Environment Variables → add `LONG_JOB_DRIVER` with
   the value `cron` (Production) → redeploy. From then on the plan screen and the notices say the page can be closed.

## Check that it works (before step 4)

In the SQL editor, with a job running or idle for a minute, run:

```sql
select jobname, schedule, active from cron.job where jobname = 'diger-drive-jobs';
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
select status_code, created from net._http_response order by created desc limit 5;
```

Expected: the first query shows `active = true`; the second shows `succeeded`; the third shows `200` while jobs are waiting (no row at
all when nothing is waiting: the tick skips the call). A `401` means the vault secret differs from `CRON_SECRET`: correct it with
`select vault.update_secret((select id from vault.secrets where name = 'diger-cron-secret'), '...');` (put the real value in place of `...`; never paste it in chat).
You can also open `https://diger.tech/api/driver-status`: it answers `{"mode":"tab"}` before step 4 and `{"mode":"cron"}` after.

## Turn it off

1. Vercel → delete the variable `LONG_JOB_DRIVER` (or set it to `tab`) → redeploy: the app stops promising that the page can be closed.
2. Supabase → SQL Editor → `select cron.unschedule('diger-drive-jobs');` : the scheduler stops. Nothing else needs to be undone, and a
   running job simply goes back to being resumed by the open page.

## Alternative: Vercel Pro cron

On the Vercel Pro plan a platform cron can call the same route every minute instead of the database: add to `vercel.json`
`{ "path": "/api/cron/drive", "schedule": "* * * * *" }` (Vercel sends `Authorization: Bearer $CRON_SECRET`, which the route
accepts), then set `LONG_JOB_DRIVER=cron`. This needs a plan change and a code change to `vercel.json` (an existing test pins one
cron on the Hobby plan), so it is not part of this proposal. The route is the same either way.

## What the route does on each call (for review)

- `401` without the cron secret (timing-safe, the same check the worker uses).
- Selects jobs that are `queued` or `running`, with no live lease, last touched between 15 seconds and 25 minutes ago, whose retry
  time has passed; oldest first; at most **5** per call; one step per job, in parallel, each bounded by a 50-second timeout (the
  worker's own deadline is 45 seconds; the function limit is 60).
- A job idle for more than 25 minutes is left to the daily watchdog, which refunds the whole reserve.
- Each call also sends, once per job, the "temporarily stopped, nothing beyond what was delivered will be charged" notice for jobs
  that made no progress for 10 minutes.
- A provider cap, a 402 or a 429 mid-job is handled by the worker as before: rows already delivered are settled once through
  `settle_job_atomic`, the rest of the reserve returns; with nothing delivered the whole reserve is released.
