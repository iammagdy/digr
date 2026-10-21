# Supabase free plan: limits, what the code does about them, and what the owner must check

Numbers from the owner's usage console (cycle 2026-10-12 to 2026-11-12): database 33 MB of 500 MB; egress 0.12 GB of 5 GB (peak day
37 MB); 4 monthly active users; Realtime concurrent peak 7 (limit 200); no automatic backups; shared CPU, 500 MB RAM, 60 direct and
200 pooler connections. Conference: 500 or more people, probably on one shared venue network, Saturday 2026-10-24.

## 1. Which limit is reached first on Saturday

| Order | Limit | Free-plan value | Saturday risk | Why |
|---|---|---|---|---|
| 1 | **Auth: sign-ups and sign-ins, per IP address** | 30 requests per 5 minutes per IP, bucket capacity 30 (a token bucket: 429 when it is empty) | **Certain, if the default is kept** | 500 people on one address: 6 a minute refill, so 500 sign-ups take about 78 minutes (section 4b) |
| 2 | Auth: confirmation e-mails | 2 per hour with the built-in sender; with a custom sender (Resend) the owner states the default is 30 new users per hour for the whole project, configurable | **Certain, if the default is kept and confirmation stays on** | every sign-up sends one e-mail: 500 e-mails at 30 an hour take about 17 hours (section 4b) |
| 3 | Auth: token endpoint (sign-in with password, token refresh), per IP | 150 requests per 5 minutes per IP | Medium | every sign-in and every expired-token refresh |
| 4 | Auth: confirmation clicks (`/verify`), per IP | 30 per 5 minutes per IP | High | every attendee taps the e-mail link once: 500 clicks at 6 a minute take about 78 minutes |
| 5 | Vercel Active CPU (Hobby) | 4 hours a month, about 3 h 25 m left | see `docs/CONFERENCE_READINESS.md` | not a Supabase limit, listed for order |
| 6 | Realtime connections | 200 | **Removed by this change** | before: 1 per open dashboard page (2 on the top-up page), 500 phones = 500 to 1000 |
| 7 | Database connections | 60 direct, 200 pooled | Low | the API (PostgREST) pools; the app uses the HTTP API, not direct connections |
| 8 | Egress | 5 GB | Low | estimated 0.2 to 1.2 GB for the day (section 5) |
| 9 | Database size / CPU / memory | 500 MB / shared / 500 MB | Low / Watch / Watch | 33 MB used; CPU and memory: look at Reports during the day (section 7) |

The sign-up bucket and the e-mail limit are the first walls. Everything else in the code is secondary until the owner raises them (section 4b).

> **Correction (2026-10-21).** An earlier version of this file said the plain `getUser` check (`/auth/v1/user`) is counted in the 30-per-5-minutes sign-up bucket and that a room would burn about six of them a minute. That is wrong for the purpose of the plan: the official Auth rate-limit page ties the limit on `/user` to the call that **changes the user's e-mail address**, so ordinary `getUser` calls are not in the sign-up/sign-in bucket. (When I read the page, `/user` sat in the general row without that qualifier, and the page also gives no default for a custom sender; the owner's reading is the one used here. Treat the exact wording as something to confirm on the dashboard's Rate Limits screen.) Reducing `getUser` calls is still worth doing for speed and for the server's own load, but it is **not** what stops a room from signing up, and `AUTH_LOCAL_CLAIMS` is not needed for that. It stays **off**; do not turn it on without the owner's approval (a token the service has already revoked is still accepted until it expires).

## 2. Realtime: every place a browser opened a live channel

Searched `src` for `.channel(`, `.subscribe(` and `postgres_changes`.

| Where | Connections per visitor (before) | Now |
|---|---|---|
| `src/hooks/useNotifications.ts` (the notifications panel, mounted in the app shell of every signed-in page) | 1 | 0: an incremental poll (`created_at` newer than the newest shown), every 30 s with ±20% jitter, growing to 2 minutes while nothing arrives, none while the tab is hidden, the full list again when the tab comes back |
| `src/app/dashboard/topup/page.tsx` (status of a top-up request) | 1 more, only on that page | 0: while a request is waiting, one small status question every 20 s (growing to 90 s), the full list only when a status changed |
| anything else (job status, balance, admin pages) | 0 (job status was moved to polling in PR #97; the admin dashboards poll) | 0 |

So one visitor opened 1 connection (2 on the top-up page); 500 visitors would have opened 500 to 1000 against a limit of 200.
A test (`tests/supabase-free-plan-limits.test.ts`) fails if any file under `src` opens a channel again.

## 3. How many calls to the sign-in service one visit makes

The browser creates its Supabase client with the public key, so sign-up and sign-in calls leave the **visitor's** device (counted per
visitor IP: at the venue, one IP). Calls from the server (middleware, API routes) leave Vercel (counted per Vercel egress address).
The plain `getUser` check is **not** in the sign-up/sign-in bucket (see the correction in section 1); the table below counts the calls for
speed and server load, not for the sign-up wall.

| Step | Before | After |
|---|---|---|
| Landing page view | 2 `/user` calls (the server render and the browser) | 0 (the page is static; the browser reads the stored session) |
| Dashboard page load | 1 (middleware) + 1 (browser) | 1 (middleware) |
| Each API call with a bearer token (chat message, balance, job poll, plan edit, approve) | 2 (middleware + route) | 1 (route only) |
| Each API call with `AUTH_LOCAL_CLAIMS=on` and asymmetric signing keys | 2 | 0 (the token is verified locally with the cached public keys) |
| Typical session: 1 page load + 3 chat turns + balance + history | about 12 | 6 (flag off), about 1 (flag on) |
| Sign-up (browser calls, counted per visitor IP) | `signUp` 1 (sign-up bucket) + confirmation click 1 (`/verify` bucket) + token 1 (token bucket) | unchanged: these three are the real limits (section 4) |

`AUTH_LOCAL_CLAIMS` is **off by default**. To turn it on the owner first checks Authentication > JWT Signing Keys: an asymmetric key
(ES256 or RS256) must be the current one. Then set `AUTH_LOCAL_CLAIMS=on` in Vercel and redeploy. Effect and trade-off: a token that the
service has already revoked (a deleted or banned account) is still accepted until it expires (one hour by default). With a shared
secret key the flag changes nothing (the library asks the service itself).

## 4. Sign-up from a shared venue address: the real limits

Our sign-up and sign-in call the Auth service **from the visitor's browser** (`supabase.auth.signUp` and `signInWithPassword` in `src/hooks/useUser.tsx`), so every limit that is "per IP" counts the venue's one address for all 500 people.

| Limit (Authentication > Rate Limits) | Default | What it counts | Our call |
|---|---|---|---|
| Sign-ups and sign-ins, per IP | 30 requests per 5 minutes, token bucket with capacity 30 (the 31st request in the burst gets a 429; the bucket then refills at 6 a minute) | `signUp`, `signInWithPassword` (as the page lists them), resend, recover, magic link | the sign-up and sign-in forms |
| Confirmation e-mails sent | with the built-in sender 2 per hour; with a custom sender (Resend, set under Authentication > SMTP) the owner states a default of 30 new users per hour for the whole project, configurable in the same screen. The page I read gave no default for the custom sender, so check the value shown on the screen | one e-mail per sign-up (and per resend) | every sign-up while confirmation is on |
| Verification of confirmation links (`/verify`), per IP | 30 per 5 minutes | every tap on the link in the e-mail | every attendee, once |
| Token refresh and password sign-in (`/token`), per IP | 150 per 5 minutes, burst 30 | the first token after confirmation, every refresh of an expired token (hourly) | every signed-in phone |
| Same user, one confirmation e-mail | one per 60 seconds | resend | the resend button waits 30, 60, 120, 180 seconds |

Not a wall: the plain `getUser` check (see the correction in section 1).

What the customer sees when a limit is hit: plain Arabic from `src/lib/authHelp.ts`; for the address limit «عدد كبير من المحاولات من نفس الشبكة الآن ... انتظر دقيقة ثم أعد المحاولة مرة واحدة»; for the e-mail limit «أُرسل عدد كبير من رسائل التأكيد في وقت واحد ... انتظر دقيقتين»; after 90 seconds without the e-mail a hint to check the junk folder; a resend button with cool-downs of 30, 60, 120 and 180 seconds and four sends at most; after that the page says to write to support for a manual confirmation.

## 4b. How long 500 sign-ups take, and what to set

Arithmetic (token bucket: capacity 30, refill = value / 300 seconds; time for N requests = (N - 30) / refill):

| Setting (requests per 5 minutes) | Refill | 500 sign-ups (or 500 confirmation clicks) |
|---|---|---|
| 30 (default) | 6 a minute | (500 - 30) / 6 = **about 78 minutes** |
| 150 | 30 a minute | about 16 minutes |
| 250 | 50 a minute | about 9 minutes |
| 500 | 100 a minute | about 5 minutes |
| 1000 | 200 a minute | about 2.5 minutes |

| E-mails per hour | Time to send 500 confirmation e-mails |
|---|---|
| 30 (the stated custom-sender default) | 500 / 30 = **about 16.7 hours** (the day is over before the last one arrives) |
| 100 | 5 hours |
| 300 | 100 minutes |
| 600 | 50 minutes |
| 1000 | 30 minutes |
| 3000 | 10 minutes |

Reading it:

- **With confirmation on, at the defaults, the e-mail limit is the first wall** (16.7 hours), then the sign-up bucket (78 minutes), then the confirmation clicks (another 78 minutes, overlapping).
- **With confirmation off, only the sign-up bucket remains** (no e-mail, no `/verify` click, and the sign-up answers with a session, so no extra token call): 78 minutes at the default, 5 minutes at 500, 2.5 minutes at 1000.
- Not everybody signs up in the same ten minutes. A realistic arrival is half the room in the first half hour. The values below fit 500 in about 10 minutes at the peak, with margin.

Values that fit (the owner sets them; none of them touches points, prices or caps):

| Screen | Set to | Why |
|---|---|---|
| Authentication > Rate Limits: sign-ups and sign-ins | **500** per 5 minutes (250 is the minimum that fits 500 in 10 minutes) | 500 sign-ups in about 5 minutes |
| Authentication > Rate Limits: token verifications | **500** per 5 minutes | the confirmation taps |
| Authentication > Rate Limits: token refreshes and sign-ins with a password | **1000** per 5 minutes | the first token and the hourly refresh for 500 phones |
| Authentication > Rate Limits: e-mails sent per hour | **1000** (600 at the least; 3000 if everybody signs up in 10 minutes) | needs the custom sender (Authentication > SMTP) with the Resend plan that was upgraded |

The owner's exact steps:

1. Supabase dashboard > project `pfinlfaqwnytesedchik` > **Authentication** > **SMTP Settings**: confirm "Enable custom SMTP" is on and the sender is the Resend one. (If it is off, the 2-per-hour limit applies and nothing below helps.)
2. **Authentication** > **Rate Limits**: write the four values of the table above, save each one. Write down the old values first (so they can be put back).
3. Look at the screen again: each value must show as saved. If the screen refuses a value on the free plan, take the highest it accepts and use the fallback below for the rest.
4. Before Saturday, from one phone on mobile data, sign up once with a new address and confirm that the e-mail arrives within a minute. Do this on Friday, not on Saturday morning.
5. During the day: **Authentication** > **Users** shows new users; **Reports** > Auth shows 429 counts. A 429 is the signal that a limit is reached; raise the same value again or use the fallback.

**Fallback: turn e-mail confirmation off for the conference day** (if the e-mail limit cannot be raised or e-mails arrive late): Authentication > Sign In / Providers > **Email** > turn **"Confirm email"** off, save. New accounts then get a session at once. After the event, turn it on again (a short entry in the runbook list: do it Sunday). With it off, anybody can create accounts with addresses they do not own, so the abuse controls below are what limits the cost. All of them already exist and none changes a money value:

| Control | Where | What it does |
|---|---|---|
| Promo code with a **maximum number of redemptions** | admin page «الأكواد الترويجية», `max_redemptions`, one redemption per account, enforced in SQL | the free points of the day cannot be claimed more times than the owner decided; the owner sets the points and the maximum |
| Small free points | the same code's value, set by the owner | the cost of one fake account is small and bounded |
| Per-user daily provider cap | the existing per-user daily provider limit (admin page «مزودو الخدمة») | one account cannot spend more than the daily cap, however many requests it sends |
| Per-IP and per-device sign-up throttle **in our own code** | `src/lib/server/grantThrottle.ts` on `/api/wallet/redeem` (tested in `tests/grant-throttle.test.ts`): at most 900 free-point grants per IP per hour and 5 per device cookie per day by default (`PROMO_GRANTS_PER_IP_PER_HOUR`, `PROMO_GRANTS_PER_DEVICE_PER_DAY` in Vercel to change) | the venue's one IP is not blocked (900 an hour is above the room), while a script or one phone that creates account after account stops after 5 grants; the answer is plain Arabic and the account is created, only the free points wait |
| Daily model-spend ceiling | the existing global daily spend cap (not changed) | the day's total model cost cannot pass the ceiling whatever the number of accounts |

The throttle lives in memory of each server instance: it is a brake against careless repetition, not a perfect fence. The promo maximum in SQL is the hard limit.

Other fallbacks on the day: ask half of the room to use mobile data instead of the venue Wi-Fi (different addresses); keep the invitation-code path (`/join/<code>`); the owner confirms stuck accounts by hand (Authentication > Users).

## 5. Egress estimate for 500 visitors (against 5 GB)

Assumptions (all counted as bytes leaving the database, auth and storage services, including the server-side reads of the API routes):
session of 90 minutes; the dashboard load reads about 18 KB (profile, 20 conversations, public settings, one count, 30 notifications,
sign-in answers); the notification check 0.6 KB every 75 s on average; the menu badge count 0.5 KB every 30 s; a chat turn 50 KB of
server-side reads (about 17 queries); a mission followed for 20 minutes polls the job every 5 s (2 KB for the row and 3 KB for the
events); a results view reads the stored data file (0.5 MB) and one download is a file of about 0.3 MB.

| Scenario | Chat only | 25% start a mission and download one file | 100% start a mission and download one file |
|---|---|---|---|
| Per visitor | about 0.44 MB | about 0.9 MB | about 2.4 MB |
| 500 visitors | **about 0.2 GB** | **about 0.45 GB** | **about 1.2 GB** |
| Share of 5 GB | 4% | 9% | 23% |

(Computed by `scripts/capacity/egressModel.ts`, checked in `tests/egress-model.test.ts`, which also shows that doubling every payload or asking twice as often stays under 5 GB.) So egress is not the limit: no
compression or download limit is needed. The one read that grows without bound is the model-spend guard (section 6 of
`docs/HANDOFF.md`, proposal `docs/proposals/spend-cap-read-cache.md`): at 10 000 usage rows a day each chat turn would read about
240 KB, which is still under the budget but wasteful.


## 5b. Measured per action (harness: `tests/db-load-per-action.test.ts`, `docs/capacity/db-load.json`)

Real routes, in-memory database that counts every query, row and byte; the history of a fresh account is empty, so a long conversation reads a little more. Bytes are JSON size.

| Action | Queries | Rows read | Database KB | Stored-file reads KB | Stored-file writes KB | Response KB |
|---|---|---|---|---|---|---|
| A chat turn: greeting | 15 | 7 | 1.4 | 0 | 0 | 0.8 |
| A chat turn that builds a plan | 23 | 15 | 6.7 | 0 | 0 | 3.4 |
| Results view, 100 rows | 2 | 1 | 0.3 | 37.3 | 0 | 33.5 |
| Results view, 1000 rows | 2 | 1 | 0.3 | 373.7 | 0 | 315.4 |
| Download CSV (built again from the saved data), 100 rows | 5 | 2 | 0.5 | 37.3 | 23.9 | file via signed link |
| Download Excel, 100 rows | 5 | 2 | 0.5 | 37.3 | 13.8 | file via signed link |
| Download PDF, 100 rows | 5 | 2 | 0.5 | 37.3 | 25.8 | file via signed link |

Reading it: a chat turn is 15 to 23 small queries (1 to 7 KB), run partly in parallel; the heavy bytes are the stored data file (37 KB per 100 rows) read by the results view and again by every download, which also writes the rebuilt file. Nothing here is an N+1 pattern (the results view is one job read and one file read at any size). A 1000-row results view sends about 315 KB to the browser (compressed by the platform on the wire). The egress model above assumes 50 KB per chat turn, about ten times what is measured, on purpose.

## 6. Backups: there are none on the free plan

The new admin page «نسخة احتياطية» (`/admin/export`, route `/api/admin/export`) copies five tables to files on the admin's device:
`credit_ledger`, `topups`, `jobs`, `plans_quotes`, `profiles`. It only reads (SELECT, pages of 1000 rows, oldest first), is
unavailable to anyone who is not an admin (403), leaves out any column that looks like a secret or a token, and writes nothing, not
even an audit row. CSV opens in Excel (UTF-8 with a byte-order mark); JSON carries the row count and the expected count so a short
export is visible.

Runbook for the owner:

1. Thursday evening, before the freeze: sign in as admin, open «نسخة احتياطية», press «تنزيل الجداول الخمسة (CSV)». Five files download. Keep them off the laptop too (cloud drive or a second device).
2. Saturday: repeat every three hours (set a phone alarm), and once right after the last session. The page shows the time of the last download per table.
3. Check the file: open `credit_ledger` and look at the last rows; for JSON, `rowCount` equals `expectedCount`.
4. Sunday: one more export, then decide whether to move the project to a plan with backups.

A restore is not part of this page (it would write). The files are for reading and for the support staff if a balance is ever questioned.

## 7. The owner's screens and the danger values (Saturday)

| Screen | Look at | Danger |
|---|---|---|
| Authentication > Rate Limits | sign-ups and sign-ins, token refresh, token verifications, e-mails per hour | still at 30 / 150 / 30 per 5 minutes or 2 or 30 e-mails per hour (section 4b) |
| Authentication > SMTP Settings | custom sender (Resend) enabled | built-in sender (2 e-mails per hour) |
| Authentication > JWT Signing Keys | current key type (asymmetric: ES256/RS256) | shared secret: leave `AUTH_LOCAL_CLAIMS` off |
| Authentication > Users | new sign-ups arriving, unconfirmed accounts | many unconfirmed after 10 minutes: e-mail limit |
| Reports > Database | CPU, memory, disk IO budget | CPU above 80% for 5 minutes, memory above 85% |
| Reports > API | requests per minute, 429 and 5xx counts | a rising 429 count |
| Reports > Auth | requests, errors, rate-limit errors | `over_request_rate_limit` rising |
| Settings > Usage (egress, Realtime, monthly active users) | egress, Realtime peak | Realtime peak above 20 means something still opens a channel |
| Our `/admin/conference` | sign-ups per minute, active chats, stalled jobs, provider balance | stalled jobs above 3, provider balance low |
