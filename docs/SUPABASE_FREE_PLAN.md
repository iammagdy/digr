# Supabase free plan: limits, what the code does about them, and what the owner must check

Numbers from the owner's usage console (cycle 2026-10-12 to 2026-11-12): database 33 MB of 500 MB; egress 0.12 GB of 5 GB (peak day
37 MB); 4 monthly active users; Realtime concurrent peak 7 (limit 200); no automatic backups; shared CPU, 500 MB RAM, 60 direct and
200 pooler connections. Conference: 500 or more people, probably on one shared venue network, Saturday 2026-10-24.

## 1. Which limit is reached first on Saturday

| Order | Limit | Free-plan value | Saturday risk | Why |
|---|---|---|---|---|
| 1 | **Auth: sign-ups and sign-ins, per IP address** (this bucket also counts `/auth/v1/user`) | 30 requests per 5 minutes per IP, bursts up to 30 | **Certain, if the default is kept** | 500 people on one address: at most 6 sign-ups or sign-ins a minute for the whole room (83 minutes for 500 sign-ups) |
| 2 | Auth: e-mail sending | 2 per hour with the built-in sender; with a custom sender (Resend) the hourly value is set in the dashboard | High if not raised | every sign-up sends a confirmation e-mail |
| 3 | Auth: token endpoint (sign-in with password, token refresh), per IP | 150 requests per 5 minutes per IP | Medium | every sign-in and every expired-token refresh |
| 4 | Auth: confirmation clicks (`/verify`), per IP | 30 per 5 minutes per IP | High | every attendee taps the e-mail link once |
| 5 | Vercel Active CPU (Hobby) | 4 hours a month, about 3 h 25 m left | see `docs/CONFERENCE_READINESS.md` | not a Supabase limit, listed for order |
| 6 | Realtime connections | 200 | **Removed by this change** | before: 1 per open dashboard page (2 on the top-up page), 500 phones = 500 to 1000 |
| 7 | Database connections | 60 direct, 200 pooled | Low | the API (PostgREST) pools; the app uses the HTTP API, not direct connections |
| 8 | Egress | 5 GB | Low | estimated 0.2 to 1.2 GB for the day (section 5) |
| 9 | Database size / CPU / memory | 500 MB / shared / 500 MB | Low / Watch / Watch | 33 MB used; CPU and memory: look at Reports during the day (section 7) |

The sign-up bucket is the first wall. Everything else in the code is secondary until the owner raises it (section 4).

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

| Step | Before | After |
|---|---|---|
| Landing page view | 2 `/user` calls (the server render and the browser) | 0 (the page is static; the browser reads the stored session) |
| Dashboard page load | 1 (middleware) + 1 (browser) | 1 (middleware) |
| Each API call with a bearer token (chat message, balance, job poll, plan edit, approve) | 2 (middleware + route) | 1 (route only) |
| Each API call with `AUTH_LOCAL_CLAIMS=on` and asymmetric signing keys | 2 | 0 (the token is verified locally with the cached public keys) |
| Typical session: 1 page load + 3 chat turns + balance + history | about 12 | 6 (flag off), about 1 (flag on) |
| Sign-up | `signUp` 1 (sign-up bucket) + confirmation click 1 (`/verify` bucket) + token 1 (token bucket) + `/user` on the verify page 1 | same, minus the extra `/user` calls above |

`AUTH_LOCAL_CLAIMS` is **off by default**. To turn it on the owner first checks Authentication > JWT Signing Keys: an asymmetric key
(ES256 or RS256) must be the current one. Then set `AUTH_LOCAL_CLAIMS=on` in Vercel and redeploy. Effect and trade-off: a token that the
service has already revoked (a deleted or banned account) is still accepted until it expires (one hour by default). With a shared
secret key the flag changes nothing (the library asks the service itself).

## 4. Sign-up from a shared venue address

| Question | Answer |
|---|---|
| Does our sign-up call Auth from the browser or from our server? | **From the browser** (`supabase.auth.signUp` and `signInWithPassword` in `src/hooks/useUser.tsx`). The limits count per visitor IP, and at the venue that is one IP for everyone. |
| What is limited by default? | Sign-ups, sign-ins, resend, recover, magic link and `/user`: 30 per 5 minutes per IP. Token endpoint (password sign-in, refresh): 150 per 5 minutes per IP. Confirmation click (`/verify`): 30 per 5 minutes per IP. E-mails: set per hour in the dashboard (2 per hour with the built-in sender). Same user: one confirmation e-mail per 60 seconds. |
| What should the owner raise? | Authentication > Rate Limits: sign-ups and sign-ins to at least 1000 per 5 minutes; token refresh to at least 1500 per 5 minutes; token verifications to at least 1000 per 5 minutes; e-mails per hour to at least 600 (500 attendees plus resends; this needs the custom Resend sender to be set under Authentication > SMTP). These are the exact screens in section 7. If the dashboard refuses a value on the free plan, the fallback plan below applies. |
| What does the customer see when a limit is hit? | Plain Arabic from `src/lib/authHelp.ts`: for the address limit «عدد كبير من المحاولات من نفس الشبكة الآن ... انتظر دقيقة ثم أعد المحاولة مرة واحدة»; for the e-mail limit «أُرسل عدد كبير من رسائل التأكيد في وقت واحد ... انتظر دقيقتين»; after 90 seconds without the e-mail a hint to check the junk folder; a resend button with cool-downs of 30, 60, 120 and 180 seconds and four sends at most; after that the page says to write to support for a manual confirmation. |
| Fallback on the day if sign-ups still fail at the venue | Ask half of the room to use mobile data instead of the venue Wi-Fi (different addresses); keep the invitation-code path (`/join/<code>`); the owner confirms stuck accounts by hand (Authentication > Users). |

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
| Authentication > Rate Limits | sign-ups and sign-ins, token refresh, token verifications, e-mails per hour | still at 30 / 150 / 30 / 2 or 30 per hour |
| Authentication > SMTP Settings | custom sender (Resend) enabled | built-in sender (2 e-mails per hour) |
| Authentication > JWT Signing Keys | current key type (asymmetric: ES256/RS256) | shared secret: leave `AUTH_LOCAL_CLAIMS` off |
| Authentication > Users | new sign-ups arriving, unconfirmed accounts | many unconfirmed after 10 minutes: e-mail limit |
| Reports > Database | CPU, memory, disk IO budget | CPU above 80% for 5 minutes, memory above 85% |
| Reports > API | requests per minute, 429 and 5xx counts | a rising 429 count |
| Reports > Auth | requests, errors, rate-limit errors | `over_request_rate_limit` rising |
| Settings > Usage (egress, Realtime, monthly active users) | egress, Realtime peak | Realtime peak above 20 means something still opens a channel |
| Our `/admin/conference` | sign-ups per minute, active chats, stalled jobs, provider balance | stalled jobs above 3, provider balance low |
