# Vercel Fluid Active CPU: findings and fixes (14 Nov 2026)

**Context.** Vercel blocked new deployments on 14 Nov 2026 (10:44 UTC) for excessive Fluid Active CPU. Support lifted the block and granted 3× limits for 30 days. The project is on Hobby, so this has to stay within the free allowance; there are no paid upgrades.

## What could be measured

- **Per-route CPU: not available.** It needs Observability Plus, a paid add-on (the API answers 402). Hobby keeps only one hour of runtime logs, and that hour showed none.
- **Customer traffic is small.** In the last 30 days, missions came from 2 accounts: 167 completed, 34 cancelled, 25 unserved, 17 failed, 2 `plan_ready`. Jobs: 277 completed, 86 failed. Most CPU therefore comes from work that runs all day whoever is online, not from customers.
- **Database scheduler (read-only check of `cron.job` and `net._http_response`):**

| Job | Schedule | What it calls |
|---|---|---|
| `diger-drive-jobs` | every minute | `drive_jobs_tick()` → `GET /api/cron/drive`, **unconditionally** |
| `diger-treg-pool-tick` | every minute | `treg_pool_tick()` → `GET /api/cron/treg-pool`, only when an alert is pending or the 10-minute health run is due |
| `diger-cron-cleanup` | daily | database only |

- **HTTP volume.** The 6 hours of responses kept by `pg_net` held 459 calls to Vercel, about 76 an hour: 312 answered 200, and 147 answered 402 during the block.
- **The every-minute drive call is unconditional in production.** The proposal file `docs/proposals/08_pg_cron_driver.sql` checks for due work first, but the function in the database does not. The every-minute call is deliberate: each tick writes `driver_heartbeat`, which lets the app say «تقدر تقفل الصفحة» (`driverMode.ts`, 3-minute window). It also resumes stale planning sessions and sends stalled-job notices.

## Likely causes, highest first

1. **Admin screens polling all day, including in background tabs.** None of these checked whether the tab was visible, so an admin tab left open kept invoking functions:
   - `/admin/agent` read the selected mission every 3 s, forever, even after the mission ended (about 28,800 calls a day). Each call reads the mission, up to 500 call rows, and reprices the plan.
   - `/admin/agent` also read its overview every 10 s.
   - The admin shell, on every admin page, read alerts every 60 s plus a **live** provider check (`?refresh=true`, which bypasses the 60 s cache).
   - `/admin/operations` every 15 s; the free re-run panel every 8 s while a re-run is active.
2. **The every-minute database driver.** 1,440 invocations a day, each with:
   - two heartbeat writes;
   - a jobs query;
   - the stall notifier;
   - a planning-session query.

   Each call is cheap, but it never stops.
3. **Customer-side polling, which is bounded already:**
   - mission cards poll every 2.5–8 s while visible and 12–20 s when hidden, and stop when the mission ends;
   - the requests page pauses when hidden;
   - the live sheet backs off to 30 s and stops when done.

   With two active accounts this is small today, but it grows with customers (see "Not changed" below).
4. **Middleware on static files.** The matcher sent `/site.webmanifest`, the `.xlsx` samples, `.ico` and web fonts through the middleware.

## Fixed in this PR (no business logic changed)

- **`src/lib/visiblePolling.ts`:** a timed refresh that asks only while the tab is visible. It asks once, immediately, when the tab becomes visible again, and the interval is unchanged otherwise. Used by:
  - `/admin/agent` (overview and detail);
  - the admin shell (alerts and provider status);
  - `/admin/operations`;
  - the free re-run panel.
- **`src/lib/agentMission/adminPolling.ts`:** an ended mission (exactly `MISSION_TERMINAL`) is refreshed in the admin console once a minute instead of every 3 s. The admin's own action still re-reads it at once.
- **Middleware matcher:** also skips `ico`, `woff`, `woff2` and `webmanifest` files, and spreadsheets **only** directly under the public `/samples/` folder. Every other path ending in `.xlsx`, every `/admin` and `/dashboard` path, and every page and API path still runs it. The tests compile the matcher with Next's own `getMiddlewareMatchers`.
- **Tests:** `tests/vercel-cpu-polling.test.ts`.

What each screen reads and shows, every route, every price, the ledger and the worker are unchanged.

## Not changed, proposals for the owner

1. **Driver tick (database change, needs approval).** Keep the every-minute heartbeat but make it in SQL:
   - `drive_jobs_tick()` writes `driver_heartbeat` itself;
   - it calls `/api/cron/drive` only when a job is due (the check already written in `08_pg_cron_driver.sql`), a planning session is stale, or a stall notice is due.

   This is a migration and changes when planning sessions and stall notices are picked up, so it needs its own review. Saves up to ~1,400 invocations a day.
2. **Customer polling, when traffic grows:**
   - pause mission-card polling in hidden tabs instead of slowing it, and slow down for missions waiting on the customer (`pollDelay.ts`; its tests pin today's numbers);
   - answer the live sheet's "unchanged" before downloading the snapshot;
   - run `/api/requests`' expiry passes at most once a minute per user.
3. **Measurement.** On Pro, Observability would show CPU per route. On Hobby, the only per-route signal is one hour of runtime logs.
