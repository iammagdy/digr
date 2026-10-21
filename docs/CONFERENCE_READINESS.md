# Conference readiness (Saturday 2026-10-24, 500+ attendees, probably one shared network)

Written 2026-10-21. Code freeze: Friday 2026-10-23 evening. Everything here comes from the repository, the offline harness and the hosting and database APIs; **nothing in this document was measured on the live site**. What is not verified is listed in section 10.

## 1. The first things that will break (in order)

| # | What | Why it is first | Numbers | What fixes it |
|---|---|---|---|---|
| 1 | **Sign-ups and sign-ins from the venue address** (Supabase Auth, per IP address) | The sign-up and sign-in call leaves the visitor's phone, so the limit counts the venue's one address: a token bucket of 30 requests that refills at 6 a minute (the default is 30 per 5 minutes). The plain `getUser` check is **not** in this bucket (corrected 2026-10-21: the official page ties the limit on `/user` to e-mail-change calls) | 500 sign-ups at the default: (500 - 30) / 6 = about 78 minutes; at 500 per 5 minutes about 5 minutes | The owner raises the limits (section 7, `docs/SUPABASE_FREE_PLAN.md` section 4b); fallback: turn e-mail confirmation off for the day with the abuse controls; half the room signs up on mobile data |
| 2 | **Confirmation e-mails** | Every sign-up sends one; the project's hourly e-mail limit applies | built-in sender: 2 per hour; custom sender: the owner states a default of 30 new users per hour (not confirmed on the page I read): 500 e-mails take about 16.7 hours; at 1000 per hour 30 minutes | Custom sender (Resend, already upgraded) plus the hourly limit raised to 1000 (600 at the least); fallback: confirmation off for the day (`docs/SUPABASE_FREE_PLAN.md` section 4b); the invitation-code path; the owner confirms stuck accounts by hand |
| 3 | **The hosting plan's 100 deployments per day** (Hobby) | It stopped all builds on 2026-10-21 at about 09:03 UTC (`api-deployments-free-per-day`) | 100 deployments in 24 hours; the first slots return from about 11:44 UTC, then about one every few minutes | Fewer, larger pushes: each push of a branch with an open PR builds a preview, each merge builds production. Keep **at least 5 deployments free for Friday evening** (section 9) |
| 4 | The model-spend guard that reads the whole day on every chat turn | Cost per turn grows with the rows written today | 1 read up to 900 rows, 5 at 2 500, 12 at 10 000, and a 503 for everyone at 50 000 rows | Proposal ready, not applied: `docs/proposals/spend-cap-read-cache.md` (owner decision) |
| 5 | Hosting CPU (Active CPU) | The remaining 3 h 25 m | after this work, 500 visitors: 0.58 h (chat only), 0.82 h (25% missions), 1.55 h (everyone starts a mission), stress figures; under 2 h: stay on the plan | Edge-cached status routes, adaptive polling, `DEGRADED_MODE` (section 6) |
| 6 | The database's shared CPU and 500 MB of memory | Unknown until measured | a chat turn is 15 to 23 small queries; 500 people sending within one minute is about 8 000 queries a minute | Watch Reports during the day (section 7) |

Egress (0.2 to 1.2 GB against 5 GB), Realtime (now 0 connections against 200), database size (33 MB of 500 MB) and database connections are not at risk (`docs/SUPABASE_FREE_PLAN.md`).

## 2. What the platform sells, and what it answers «غير متاح»

The full matrix with examples is `docs/CAPABILITY_COVERAGE.md` (generated from the code and compared by a test). The 15 families:

| Status | Families |
|---|---|
| Supported | comments of a named video or post; top videos of named channels then their comments; companies then decision makers (e-mail and phone when the source has them) |
| Partly | brand monitoring (one platform per plan; a mixed request gets the priced part and a plain sentence about what is left out); analysis of delivered data (reshaping, sorting, filtering the delivered file for free; no statistics) |
| Not available, answered plainly with three things the platform can do, and logged in `/admin/requests` | news and newspaper articles, currency and gold price series, academic studies, competitor ads, places and app-store reviews, search results and keyword volumes, jobs and product prices, Telegram, Reddit and forums |
| Refused | private data (private messages, national numbers, passwords) |
| One specific question | a vague request («عايز بيانات»): exactly one question, never a plan or a guess |

The live catalog (a read-only look at the production registry on 2026-10-21) holds companies, people, TikTok, YouTube and Facebook services. There is no news, price, web-reading or search service in it, so the dollar-news request stays «غير متاح» (honest) until the owner approves a named service with its price. The curated newspaper list, the numbered pick question («تقصد هذه المصادر (١، ٢، ٣، ٤) أم لديك مصادر معينة؟») and the news and price file standards are in the code and tested, switched off until a service can read the pages. A name the model suggests is marked «اقتراح» and checked against the list before any plan may use it.

The counts a customer writes are now read as written: «٥ آلاف», «٢ مليون», «ثلاثين», «5k» (before, «٥ آلاف» planned 5 and «ثلاثين تعليق» silently planned the default of 500, a 594-point hold). A request above what one job can carry is planned at what fits with the reason in one sentence.

## 3. The showcase missions that work (each with a template that only fills the input, and a worker test on a fake provider)

One request is capped at 600 points (unchanged by decision). The largest one request can hold:

| Mission | Template | Rows in one request | Tests |
|---|---|---|---|
| Companies then decision makers with e-mail and phone | `companies_decision_makers` | 173 companies, or 6 decision-maker records | `mission-templates`, `showcase-missions`, worker tests |
| Top videos of named TikTok channels, then their comments | `tiktok_channels_top_videos_comments` | 86 comments | `showcase-missions`, `social-mission`, `template-mission-channels` |
| Posts about an event on X with a date window | `event_monitoring_x` | 104 posts | `x-date-window`, `showcase-missions` |
| Posts of a named public Facebook page | `facebook_page_posts` | 47 posts | `showcase-missions` |
| Comments of a named YouTube video | `youtube_named_videos_comments` | 57 comments | `showcase-missions` |
| YouTube comments by topic | (a chat request) | 57 comments | `youtube-deep-comments`: judged videos first, deep reads, short or emoji-only or repeated comments dropped, Arabic first, date, video title and video link columns, an honest sentence when recent videos are scarce. **Not yet verified on live data**; the live result before the fix was 3 of 30 |
| A mission larger than 600 points | any | one request holds the largest size above; the plan says how much of the request fits and the rest is a separate request | `large-counts` |

Every template's default count above the cap is cut by the plan with the reason; the template never carries a price.

## 4. Measured numbers (offline harness; not live)

`tests/conference-load-harness.test.ts`, `tests/db-load-per-action.test.ts`, `tests/accept-quote-concurrency.test.ts`, `docs/capacity/*.json`.

| What | Number |
|---|---|
| 500 visitors, 3 messages each, through the real chat route (fake database with a 4 ms round trip, no model) | all 1500 turns answered (200); 16.7 queries per turn; 2.4 KB average answer, 4.7 KB largest; the process grew 198 MB for 1500 turns |
| One turn alone | greeting 15 queries and 29 sequential waits; a turn that builds a plan 23 queries and 43 waits; a turn that needs one question 15 queries and 17 waits. At a 20 ms round trip the waits are 0.6 s, 0.9 s and 0.3 s of waiting, not CPU |
| Database read per action | chat turn 1.4 KB (greeting) to 6.7 KB (plan); results view: one job read and one stored-file read (37 KB per 100 rows, 374 KB per 1000); a download rebuilds the file from the saved data each time (CSV 10 ms, Excel 34 ms, PDF 166 ms raw CPU at 100 rows) |
| The model-spend guard late in a busy day | 1, 5 and 12 reads per turn at 900, 2 500 and 10 000 rows |
| 20 approvals of the same quote at the same moment | exactly one reserve, one job, one start; the other 19 are told it was already started (409). The database function itself is a stand-in in this test: its real locks are SQL and unverified here |
| Per-instance state | The public limiters (`publicRateLimit`), the busy-state cache (15 s) and the conference dashboard cache are in the memory of one server instance, per address. Each instance counts alone, so the effective limits are higher than written, never lower; the limits were sized for one venue address in #181. Documented in the code, not shared |
| A real browser on the production build of the landing page (390 px wide, local server, no session) | 0 requests to `/api`, the database or the sign-in service; 0 WebSocket connections; no page error; the header shows «دخول» and «حساب جديد»; the QR path `/join/CONF26` lands on `/register?promo=CONF26` |
| Hosting CPU model | `docs/CPU_MODEL.md` (calibrated to the owner's 0.108 s average invocation): after this work 0.35 to 0.75 h (base) and 0.58 to 1.55 h (stress) for 500 visitors against 3.42 h left; before this work 1.57 to 1.96 h (base) and 2.31 to 3.27 h (stress). The status poll was about 85 function runs per visitor per 90 minutes and is now answered by the edge |
| Egress | 0.2 GB (chat only), 0.45 GB (25% missions), 1.2 GB (all missions) of 5 GB |

**Diagnostics that outlive the one-hour runtime log.** No new table was added. The day's history is in the tables the dashboard already reads: `messages` (every turn with its status), `jobs` and `job_events` (every request and what happened to it, in plain Arabic), `llm_usage` (every model call with its latency and cost), `credit_ledger`, `capability_requests` (what was asked and not served), `profiles` (sign-up times). Export them with `/admin/export` (five of them) or read them in the dashboard of the database. The per-turn stage timings of the chat route (`chat_stage_timings`) are console output only and are lost after an hour; persisting the slow ones (for example in `admin_audit_log`) is possible and is left as an owner decision because it would add rows to a table people read.

## 5. Part C: long jobs (audit of `src/app/api/worker/chunk`, `cron/*`, `jobs/[id]/nudge`, `lib/server/job*`)

| Question | Answer (code and tests) |
|---|---|
| Does a long job run in chunks? | Yes: one provider page set per worker call (the social chunk stops starting calls at 40 s, the route at 45 s of 60); 50 rows per chunk; a 100-row mission is 2 worker calls. `long-job-scale-harness` |
| Does it resume after a broken chain? | Yes, in three ways: the open page nudges a job that did not move (`/api/jobs/[id]/nudge`); the always-on driver (`/api/cron/drive`, only when `LONG_JOB_DRIVER=cron`); the daily watchdog. Two drivers never run one chunk twice (a lease and the expected step in `claim_job_chunk`). An instance that dies holding the lease is waited out and resumed: no record twice, charged once (tested) |
| Driver at the conference | **tab mode** (owner decision): a job moves while the customer's page is open; a customer who closes the page mid-mission waits until they return or until the daily watchdog (one run a day on the free plan). The customer is never told they can close the page. The required sentence says to keep the page open |
| Notices | start (accept-quote, for large jobs, with the driver-honest sentence), completion or partial completion (the worker), release (the worker), stall (the driver and the watchdog, so in tab mode the stall notice comes with the daily watchdog, not within 10 minutes). Each notice id is deterministic: sending twice is a no-op. At most 4 per job |
| Honest duration | a range («من دقيقة إلى ٤ دقائق») labelled تقديري, computed by code from the page count and measured chunk times (`mission-duration`) |
| Partial delivery | settled once for the delivered unique matching units only (charge = ceil(delivered x unit price), never above the reserve), the rest released; the source failing from the first call releases the whole reserve; a closed daily budget settles what was delivered (`long-job-scale-harness`, `accept-quote-concurrency`) |
| Defects found | none in money code. Non-money: the count reading and the topic leak (fixed, `large-counts`); the download route rebuilds the file on every click (by design, now in the CPU model); the daily watchdog is the only stall notice in tab mode (report, no change) |
| Needs money code | nothing found |

## 6. Switches the owner has (all default off, none touches money)

| Switch | Effect |
|---|---|
| `DEGRADED_MODE=on` | every page asks about 3 times less often and shows a calm Arabic banner |
| `DEGRADED_MODE=closed` | as `on`, and no NEW request starts («الخدمة مزدحمة جدًا الآن… لا يُخصم شيء»); chats, plans and running jobs continue |
| `AUTH_LOCAL_CLAIMS=on` | **stays OFF; do not turn it on without the owner's approval.** It would verify the signed token locally instead of asking the sign-in service on every call (only after the JWT signing keys page shows an asymmetric key); trade-off: a revoked token (a deleted or banned account) works until it expires (about an hour). It is not needed for sign-up capacity: the plain `getUser` check is not in the sign-up bucket |
| `MAX_CONCURRENT_JOBS_PER_USER` (default 3), `CHAT_MESSAGES_PER_MINUTE` (default 20) | per-account limits |

## 7. The owner's checklist (manual, before Saturday)

1. **Supabase > Authentication > Rate Limits:** sign-ups and sign-ins **500** per 5 minutes (250 is the least that fits 500 in 10 minutes); token verifications **500**; token refreshes and password sign-ins **1000**; e-mails per hour **1000** (600 at the least). The exact steps and the arithmetic are in `docs/SUPABASE_FREE_PLAN.md` section 4b. Screen to read: the values must have changed, not just the page.
2. **Authentication > SMTP Settings:** the custom sender (Resend) is on. Send one test sign-up from a phone on mobile data and read the e-mail's arrival time.
3. **Authentication > JWT Signing Keys:** note whether the current key is asymmetric (ES256 or RS256). Only then consider `AUTH_LOCAL_CLAIMS=on`.
4. **Provider account:** top up the balance and set the daily cap in the admin provider tab for the day. The busy mode closes the door by itself when the real balance or the daily allowance runs out; check `/admin/conference` shows the real balance.
5. **Free points per new user** (admin setting) and the invitation code printed on the QR (`/join/<code>`): sign up once from a clean phone browser with it.
6. **Anthropic:** a monthly spend alert and limit. The platform's own daily model-spend cap (50 dollars by the setting found in the handoff) needs your policy decision before 500 people use it.
7. **Supabase Reports** (open on a second screen during the event): Database (CPU above 80% for 5 minutes, memory above 85%), API (429 and 5xx rising), Auth (`over_request_rate_limit` rising); Settings > Usage: Realtime peak should be 0 (above 20 means something still opens a channel).
8. **Vercel > Usage:** Active CPU (hourly); if the day's total passes 2 hours before 14:00 set `DEGRADED_MODE=on`; at 3 hours set `closed`. Deployments: see section 9.
9. **Backups (the free database plan has none):** export the five tables from `/admin/export` Thursday evening, every three hours on Saturday, and after (`docs/SUPABASE_FREE_PLAN.md` section 6).
10. **After the first deployment of Friday, open `/api/busy-status` in a browser** and look at the response headers: `cache-control: public, s-maxage=15` and (on a second request) `x-vercel-cache: HIT`.
11. **To save deployments in the freeze** (optional): Vercel > Settings > Git > Ignored Build Step: `if [ "$VERCEL_ENV" = "production" ]; then exit 1; else exit 0; fi` skips every preview build (pull-request previews stop appearing) and keeps the production build of each merge. Remove it when the freeze ends.
12. The pressure test on a preview (`docs/PRESSURE_TEST_RUNBOOK.md`) is optional and must not be run in the last 24 hours (deployment quota).

## 8. Fallback plan for the day

| If | Do |
|---|---|
| Sign-ups fail at the venue (rate limited) | raise the same Rate Limits value again; or turn **Confirm email** off for the day (Authentication > Sign In / Providers > Email) with the controls of `docs/SUPABASE_FREE_PLAN.md` section 4b (promo maximum redemptions, small free points, daily caps, the in-code per-IP and per-device throttle), and turn it on again on Sunday; ask half of the room to use mobile data; use the invitation-code link; confirm stuck accounts by hand in Authentication > Users |
| Confirmation e-mails are late | the page already says so after 90 seconds and offers a resend with its own limit; confirm by hand |
| The provider balance or daily cap runs out | the busy mode shows the plain Arabic sentence by itself; chats and plans keep working; top up and the door opens within a minute |
| Active CPU climbs | `DEGRADED_MODE=on`, then `closed`; redeploying is not needed (an environment change needs one deployment: **keep that deployment free**) |
| The model provider is slow or down | the turn budget (38 s) ends a turn with the simplest next step; the owner can set `LLM_ENABLED=false` (the banner «الوضع المبسط» shows) |
| A job is stuck | the customer's open page nudges it; otherwise the daily watchdog releases or settles it; the money rules hold either way |
| Anything touching balances looks wrong | stop, export the five tables, do not edit the ledger by hand |

## 9. Friday evening checklist

1. Freeze code at the agreed hour; the last merge is made at least 3 hours before.
2. **Deployments:** read the production deployment (state READY and the built commit equal to `main`); the hosting plan allows 100 per day, so keep at least 5 free for an environment change on Saturday. If a merge produced no production deployment (it happened to #184, #185 and #186), create it from `main` at that commit.
3. Read `/admin/conference` once; run the sign-up path from a clean phone browser with the invitation code; run each showcase mission once with a small budget (the batch test in the final post).
4. Export the five tables (`/admin/export`) and keep the files off the laptop.
5. Confirm sections 7.1 to 7.6 are done, and that the provider balance and daily cap are set.
6. Write down the three numbers to read on Saturday morning: Active CPU used, the sign-ups per minute, the provider balance.

## 10. Not verified (needs the live site or a tester)

The real sign-in and e-mail limits and the effect of raising them; the edge cache of the three status routes; the sign-up path with the invitation code and a real e-mail; the busy banner and the degraded banner; the conference dashboard on production data; the adaptive polling in a real browser; the real provider on the YouTube, TikTok and X retests (the earlier live results: YouTube 3 of 30, TikTok 1 of 7); the dollar-news request on the plan card; a real mission's duration range against the real source; the pressure test (not run by design); the database function locks under real concurrency; the hosting CPU per invocation under real traffic.
