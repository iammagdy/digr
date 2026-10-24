# Diger Platform Engineering Handoff & QA Status

This handoff document provides a clear, factual status of the Diger platform (`iammagdy/digr`) for engineering agents (Codex), developers, and the project owner.

---

## 00000. Facebook keyword comment quality (branch `claude/fb-comment-quality`, from main `7d0e54b`)

- The pleasantry rule of the Facebook keyword service (`isPureWellWish(text, { topic })` in `src/lib/server/commentQuality.ts`) is now a RATIO rule: normalised text (emoji, tatweel, spellings, stretched letters, glued formulas, repeated phrases), connecting words neutral, at least one strong marker, at least 75% of the other words pleasantry words and at most three others; any number, question, request, complaint/duty/opinion word or word of the topic keeps the comment. It replaced «every word on a list», which missed one extra word, a typo («دكتر»), «شاءالله» and a repeated phrase. Other services are untouched.
- The «why fewer rows» sentence now also says how many posts were approved, that a job reads only the posts the customer asked for, how many posts gave no delivered comment, and how many comments the source did not return (`keywordShortfallReasonAr`).
- No price, cap or money rule changed; fewer delivered rows means a smaller charge (`ceil(delivered x 12.925)`).

---

## 0000. Facebook keyword polish and visitor analytics (branch `claude/fb-polish-and-visitors`, from main `3a20c2f`)

- **Facebook keyword service** (`social-facebook-keyword-comments`, identity and wording in `src/lib/facebookKeywordService.ts`): customer files say «المنشور» (not «الفيديو»), carry a post number instead of the post's text and link in every comment row, a second sheet «المنشورات», and never the platform's own comment id. Other services keep their headers.
- **Live preview** had no moment with accepted rows on a small job (a chunk carries up to 50 rows and the step file is written at its end): the first chunk of a paged job now reads one post's share (`PAGED_FIRST_CHUNK_ROWS`). A chunk that ends inside a post no longer reads that post again (`pu` in the adapter state).
- **Comment quality**: pure well-wishes («بالتوفيق والنجاح الدائم») are left out before the charge for this service only (`isPureWellWish`); a job that delivers fewer comments says why from counted numbers (`keywordShortfallReasonAr`).
- **Visitor analytics**: beacon `src/lib/analytics` + `/api/analytics/collect`, admin tab `/admin/visitors`, overview card. SQL is a PROPOSAL (`docs/proposals/visitor-analytics/`, NOT APPLIED); until it is applied nothing is stored and the tab says so.

---

## 000. Status after PR #211 (2026-10-23, main = `d12b831`)

Written from git, the deployment API and the project's schema (read only). No secret appears here; where a setting matters only its NAME and where it lives are given.

### Merged PRs #200 to #211 (merge commit, first parent, second parent)

| PR | Merge SHA | Parents (main before, branch head) | What |
|---|---|---|---|
| #200 | `0b3922c` | `e4d8f4b`, `b18e6a8` | multi-provider contact chain |
| #201 | `ecb5636` | `a2c2367`, `c8e04ae` | company review batch |
| #202 | `e4d8f4b` | `ecb5636`, `c81acbd` | conference readiness |
| #203 | `ad87357` | `0b3922c`, `c33260f` | admin calls log |
| #204 | `b9d1215` | `ad87357`, `ada87ef` | wallet display fixes |
| #205 | `4a7493b` | `b9d1215`, `1ab6dfd` | social root-cause fixes |
| #206 | `cb766fe` | `4a7493b`, `b7accfd` | mega-fixes phase 1 |
| #207 | `38541d3` | `cb766fe`, `d44684e` | mega-fixes phase 2 (request understanding) |
| #208 | `a9da0d6` | `38541d3`, `5187905` | mega-fixes phase 3 (quality and text) |
| #209 | `5ed38ce3503a6573be1cfe62ccd6a3391f711cdf` | `a9da0d6`, `6674f6c` | phase 4: one ETA, live preview, e-mail wiring and admin e-mail check |
| #210 | `b0559ace66dca30812cd0f5e27238816cc1a3c33` | `5ed38ce`, `e3726ec` | phase 5: smart discovery, honest limits, balance verdict; job-cap-from-balance SQL proposal (NOT applied) |
| #211 | `d12b831aad19aebc34f4ad480854d783c56318f2` | `b0559ac`, `b5789ae` | the remaining failures of the customer browser test: TikTok basketball relevance, Facebook page link question, follow-up numbers and topic, price per record on every plan, hold wording, live preview column bug |

Short SHAs are the first seven characters of the merge commit in `git log --merges origin/main`. Rollback of any one merge: new branch from main, `git revert -m 1 <merge sha>`, open a PR; never push to main.

### Proven live (read from the deployment API or the live site)

- Production `diger.tech` runs the merge of #211: deployment `dpl_3QH9XRcpiqi334rDL4F22M8wsiq9`, READY, built SHA `d12b831aad19aebc34f4ad480854d783c56318f2`.
- Without login: `/` 200 and `/login` 200 with no provider name in the HTML, `/api/jobs/x/preview` 401.
- The production `jobs` table has NO `template_slug`, `platform` or `capability_slug` column (project schema, read only). The live preview route selected them, so it never returned a row; fixed in #211.
- The ledger kinds are reserve, release, charge, topup, grant and goodwill; the wallet shows a release as «تحرير حجز مؤقت». Worker failure texts now say the same («حُرّر الحجز المؤقت كاملًا ولم يُخصم أي رصيد»), never a refund.

### NOT PROVEN (nothing below has been seen on real data or in the real browser)

- TikTok and Facebook results on live data. The basketball relevance fix (comments judged by their video), the video-level review and the Facebook link question are shown only by fixtures with a FAKE reviewer; no live paid call was made. The owner's 113-comments-0-delivered request has not been re-run.
- That a Facebook page named only by its display name never works at the source. The code now asks for the link or username first; it was not shown that the name path always returns nothing.
- A row appearing in the production live-preview panel after #211 (the column bug is proven and the new test fails before the fix; the panel itself was not watched).
- The «٢٩ دقيقة» countdown being constant: not reproduced. It is read from the quote's own expiry and the clock; a freshly written quote reads ٢٩ and each follow-up writes a new quote.
- The exact plan numbers of the live-model Facebook topic plan (513 points, 800 cut to 54): fake-model tests cannot build that plan. Only the deterministic parts were fixed (the topic no longer takes «بالتعليقات», the newest count wins, the price per record is on the plan).
- Firecrawl and Context.dev chain yield and price per contact: unmeasured.
- Authenticated production paths of #211 (plan card, the page-link card, worker messages): not exercised.

### Open problems

1. **TikTok and Facebook live results unproven** (see above).
2. **E-mail:** the `send-email` Edge Function is NOT deployed in production, and `RESEND_API_KEY` exists only in Vercel (the function reads its own Supabase secrets). Until both are done no e-mail goes out; the in-app notices work. Setup and the admin check: `docs/proposals/10_email_delivery_setup.md`.
3. **Driver mode is `tab`** (`LONG_JOB_DRIVER` unset): the chunks chain themselves and an open page resumes a broken chain; the customer is told «أبقِ الصفحة مفتوحة حتى تكتمل المهمة». The always-on driver is documented, not installed: `docs/proposals/08_long_job_driver_setup.md` and `08_pg_cron_driver.sql`.
4. **Per-job cap is 600 points** (`JOB_MAX_POINTS_CAP`, and a hard 600 inside `create_quote_atomic` and the two settle functions). The proposal to make it depend on the customer's balance is `docs/proposals/job-cap-balance/` (steps 01 to 05 with rollbacks) and is NOT APPLIED; applying it also needs a companion code change (see its README). The Facebook ceilings (60 page posts, 500 comments per job, 20 posts per page) are the service's own and are not changed by it.
5. **Firecrawl / Context.dev chain:** yield and price per contact are unproven.
6. **`MULTI_PROVIDER_ENABLED` is true on Production.** The chain can therefore take company-contact jobs today with unmeasured yield and price. Keep that in mind before any spend decision (switch is `src/lib/multiProvider/flag.ts`).
7. **Model-planned Facebook topic requests** still go through the live model; their numbers are not covered by fixtures (see NOT PROVEN).

### Exact next steps

1. Owner: re-run the TikTok request «٥٠ تعليق من فيديوهات تيك توك الأكثر انتشارًا عن كرة السلة في مصر» on the test account; read the activity lines (videos adopted, comments delivered) and the delivered count. If it is still 0, read the per-video decisions in the job events before changing the gate.
2. Owner: re-run «١٠ بوست من صفحة اليوم السابع» and answer the link question with the page's real link; check rows arrive and the live preview shows them while the job runs.
3. Owner (Supabase and Vercel settings, not code): deploy the `send-email` Edge Function, put the Resend key in Supabase secrets, then use the admin e-mail check. Keep the key out of the repository and of any message.
4. Decide the driver: either install the scheduler and set `LONG_JOB_DRIVER=cron`, or keep `tab` and keep the page guidance as is.
5. Decide the cap: choose `fixed` or `balance` and the ceiling, apply `job-cap-balance` steps 3 and 4 BEFORE the policy goes above 600, then 1, 2, 5 as its README orders them, then the companion code change. Not before the provider daily limit and the driver are decided.
6. Measure the Firecrawl / Context.dev chain with one small owner-approved paid test (fake provider in all automated tests) and decide `MULTI_PROVIDER_ENABLED` from the measured yield and price.
7. Process rules that cost time here: after every merge read the production deployment and compare its built SHA with the merge SHA; a removed-test-lines gate is a COUNT taken from `git diff -U0 origin/main -- tests | grep '^-' | grep -v '^---' | wc -l` on the head under review (a count stated from memory was wrong once: 29 said, 27 real); the Hobby plan allows 100 deployments per 24 hours, so push each branch as few times as possible.

---

## 00. Second session (new account, 2026-10-21 Wednesday): verification of #175 to #182 and the failed harness build

### Failed preview build of `claude/wip-e1-harness` (read from the deployment API, now fixed)

Deployment `dpl_7hzrxw7xEwrQq5Lz48J7Z6zj2hcg` (head `c50e2fd`) ended in ERROR at the type-check step of `next build`: `tests/helpers/loadHarness.ts:48:101 Type error: Expected 1 arguments, but got 2.` The wrapper `rpc: async (name, args) => base.client.rpc(name, args)` passed two arguments to the fake client's one-argument `rpc`. Fixed in PR `claude/e1-harness` (`rpc(name, ..._args)`). Next compiled successfully; only the test helper failed the type check, so production was never affected.

### Evidence for PRs #175 to #182 (git and the deployment API; suite = `npx vitest run` on the merge commit, skipped counts are always 27 tests / 3 files)

| PR | Merge SHA | Diff vs first parent | Suite after (files / tests) | Removed test lines | Production deployment (state, built SHA) |
|---|---|---|---|---|---|
| #175 | 8e5fb4d | 17 files, +664 -42 | 285 / 2839 passed (before, at 49ee886: 283 + 1 flaky file / 2816 passed, 1 failed) | 5, all pin replaced STEP 0 behavior with stricter assertions (link columns 120 to 60, comment columns, comments under 3 letters rejected) | `dpl_2BTsn8p34vL3JFzbt1PBGfBUJAkk` READY, 8e5fb4d |
| #176 | a301d7b | 21 files, +1650 -3 | 292 / 2964 passed (an earlier run showed 1 failure: the memory-timing test `result-assembly-scale`, which also failed once at 49ee886 under CPU load and passes alone) | 0 | `dpl_6wBZx8hjgcPXuoGmtAybxD3FPQ88` READY, a301d7b |
| #177 | c12de75 | 4 files, +164 -4 | 293 / 2973 | 2 (template list 4 to 7, stricter list) | `dpl_B9eDj4pee4pLsAawBUMfjuUkEvWa` READY, c12de75 |
| #178 | 18f8c23 | 19 files, +740 -37 | 295 / 3002 | 0 | `dpl_2snYqmDgbmsvfQA49YzvB3YsQwLh` READY, 18f8c23 |
| #180 | ae80409 | 7 files, +944 -3 | 296 / 3037 | 0 | `dpl_D11oukHn59KZRB9L2NUErnpYoTru` CANCELED (superseded by the next merge 3 seconds later) |
| #179 | f0724f0 | 1 file, +31 | 296 / 3037 | 0 | `dpl_ngkEDTNm3XYn5BqmfUsg6nVwXNXS` READY, f0724f0 (contains #173 to #180) |
| #181 | 9c49459 | 21 files, +356 -46 | 297 / 3048 | 14 (see flag) | `dpl_AdfR6ZJtxzK4WAXWb3WsvCwCMjhp` READY, 9c49459 |
| #182 | eadea2d | 1 file, +76 -24 | 297 / 3048 | 0 | `dpl_58Vyaig41FHTmHJfEoV5sH5sroZQ` READY, eadea2d (production at the start of this session) |

**FLAG for the owner (rule 3):** #181 edited `tests/usage-reads-beyond-1000.test.ts` (11 removed lines): the provider-spend sum test «the provider spend sums count every row», rewritten so the per-user daily cap reads only the user's own jobs and then only their cost rows (assertion: groups of 100 and 1 instead of 4 groups). It is a provider-spend read test, close to the «caps» money family. The new assertion is not weaker (it asserts the exact group sizes `[1, 100]`), but the owner should look at that one diff. The other removed lines: limiter sizes replaced by the named constant (`busy-mode`, `mission-estimate`), one mock extended (`wallet-arabic-and-demo-cta`).

### Production deployments per PR (Hobby: 100 per day)

Every push to a PR branch creates a preview deployment and every merge creates a production one. The API list shows 37 deployments created on 2026-10-21 (UTC) before this session started; push each branch as few times as possible.

### Merged by this session

| PR | Merge SHA | What | Production deployment |
|---|---|---|---|
| #183 | ce03b7e | harness (type error fixed), concurrent-approval tests, this evidence | `dpl_FwLsqE9GVtRkVu8BvAdxRz1tKm5B` READY, built ce03b7e |
| #184 | 7cdd847 | Supabase free plan: no Realtime, fewer sign-in calls, static landing page, admin backup export, `docs/SUPABASE_FREE_PLAN.md` | none appeared by itself; created by hand: `dpl_GjHSHmJrbARfEk44RAPzrA77AfVp` READY, built 7cdd847, aliased to diger.tech (this is what is LIVE) |
| #185 | 615b002 | CPU model (`docs/CPU_MODEL.md`), degraded mode (`DEGRADED_MODE`), edge-cached status routes, balance focus throttle | **none**: the hosting plan's 100 deployments per day ran out (see below) |
| #186 | 3c36c84 | measured database/storage/CPU per action; counts written in words or with a magnitude word; quantity words out of the topic | **none** (same) |
| #187 | (this PR) | fake provider for a preview, staged pressure scripts and runbook, `docs/CONFERENCE_READINESS.md` | **none** (same) |

**The hosting plan stopped all deployments on 2026-10-21 at about 09:03 UTC:** `api-deployments-free-per-day` (Hobby: 100 per rolling 24 hours). Previews of #185 (once, by hand, before the limit), #186 and #187 were not built, and no production deployment exists for 615b002, 3c36c84 or the merge of #187. **Production (diger.tech) runs `7cdd847`** (it has #184 but not the edge cache, the degraded switch, the count fixes or the CPU model). The first slots return from about 11:44 UTC on 2026-10-21 and then about one every few minutes. Next step for the next account: when `create_deployment` succeeds, create ONE production deployment from `main` and read it to READY with the built SHA; do not push anything else before that.

**Process note:** a merge whose tree is identical to a branch head Vercel already built (the branch had merged `main` and `main` had not moved) got NO production deployment. After every merge read `list_deployments` (target production) and compare the built SHA with the merge SHA; if it is missing, create the deployment from `main` at that SHA.

### Status of every item (checked by reading the code and running the tests; nothing here is verified on the live site)

| Item | Status |
|---|---|
| P1 conference survival (sign-up path, rate-limit and late-e-mail screens, busy mode, per-user chat and job limits, conference dashboard) | DONE-MERGED (#178, #180, #181) |
| P2 CPU and invocation reduction | DONE-MERGED (#181, #184, #185, #186); the three status routes and the deployed code of #185 and later are NOT yet live (deployment quota) |
| P3 honest understanding for any request | DONE-MERGED (#176); fixed and tested further in #186 (counts in words, topic words). The capped discovery search for unnamed source sets is not built: no service in the live catalog can read news pages, so the pick question uses the curated list only |
| P4 showcase missions | DONE-MERGED (#177): four templates plus three more, each with fake-provider worker tests |
| P5 news and price sources | audited: the live catalog has no news, price or web-reading service, so the answer stays an honest «غير متاح» (in code and tested); nothing sold |
| P6 STEP 0 YouTube topic comments | DONE-MERGED (#175), unverified on live data |
| P7 offline 500-visitor harness | DONE-MERGED (#183, #186) |
| Part E2 pressure scripts and runbook | this PR (#187): `scripts/pressure/`, `docs/PRESSURE_TEST_RUNBOOK.md`, a guarded fake provider for a preview; never run |
| Part C long-job audit | DONE, in `docs/CONFERENCE_READINESS.md` section 5 (no money defect found) |
| Part D dashboard, busy mode, sign-up path | DONE-MERGED (#178, #180) |
| Part F `docs/CONFERENCE_READINESS.md` | this PR (#187) |
| Free-plan work (Realtime, auth calls, egress, backups, limits) | DONE-MERGED (#184), measured per action in #186 |

### Findings of this session

1. **The model-spend guard reads the whole day on every chat turn** (`checkGlobalDailySpendCap`, 1 request up to 900 rows, 5 at 2500, 12 at 10 000 and a fail-closed 503 at 50 000). Measured in `tests/conference-load-harness.test.ts`. Fixed with the owner's explicit authorization: the READ of the day's sum is cached 45 s per instance plus the instance's own spend since the read; cap, limits, prices and the enforcement rule are unchanged (`src/functions/shared/rateLimits.ts`, `tests/daily-spend-read-cache.test.ts`; `docs/proposals/spend-cap-read-cache.md`).
2. **Corrected 2026-10-21:** the plain `getUser` check (`/auth/v1/user`) is NOT in the sign-up/sign-in bucket (the official page ties that limit to e-mail-change calls; an earlier version of these docs said otherwise and was wrong). The real walls for a shared venue IP are the sign-up and sign-in bucket (30, refill 6 a minute: 500 sign-ups = about 78 minutes), the confirmation e-mails (stated default 30 an hour: about 16.7 hours for 500), the `/verify` clicks and the token refresh. Values, steps and the confirmation-off fallback with abuse controls: `docs/SUPABASE_FREE_PLAN.md` section 4b. `AUTH_LOCAL_CLAIMS` stays OFF.
3. **A count written in words or with a magnitude word was ignored or misread** (fixed in the PR after #185): «٥ آلاف» read as 5, «٢ مليون» as 2, «خمسين ألف» as 1050, and the plan's own reader accepted digits only, so «ثلاثين تعليق» fell to the default of 500 (a 594-point hold the customer never asked for) with the sentence «لأنك لم تحدد عددًا». The words also leaked into the search topic («آلاف كرة القدم», «خمسين كرة القدم»), so the provider was asked a wrong query. Now: counts read as asked up to 100 000, the plan says how much of a very large request fits, and quantity words stay out of the topic. `tests/large-counts.test.ts`.
4. **Every download rebuilds the file from the saved data** (Excel and PDF are CPU work on each click; by design, so a stored file is never stale). Measured in `docs/CPU_MODEL.md`; the model now charges it.
5. Concurrency: 20 simultaneous approvals of one quote reserve once (`tests/accept-quote-concurrency.test.ts`; the database function itself is a stand-in, real locks are SQL and unverified).

---

## 0. Conference-readiness session (2026-10-21, Wednesday): FINAL HANDOFF to the next account

Conference: Saturday 2026-10-24, 500+ attendees on one venue network. Code freeze Friday evening. The owner is on a phone: no stop-and-ask loops, small PRs, merge commits only.

### (a) Merged to main in this session (merge commits)

| PR | Merge SHA | What |
|---|---|---|
| #173 | d35a3ad | capacity gate uses the provider's real balance (fresh reading, fallback to the estimate) |
| #174 | 49ee886 | admin provider tab shows the connected account e-mail (admin-only) |
| #175 | 8e5fb4d | STEP 0: YouTube/TikTok topic comments: 20-video discovery, videos judged before comments are read, deep resumable reads, Arabic first, date/video/language columns |
| #176 | a301d7b | Part A: coverage matrix (15 families), structured understanding, newspapers pick question, news/price output standards, unserved-requests log + `/admin/requests`, `docs/CAPABILITY_COVERAGE.md` |
| #177 | c12de75 | Part B: three new showcase templates + fake-provider worker tests |
| #178 | 18f8c23 | Part D: busy mode, sign-up path (`/join`, invitation code, welcome balance, rate-limit and late-e-mail screens, resend limits) |
| #180 | ae80409 | Part D: read-only conference dashboard `/admin/conference` |
| #179 | f0724f0 | earlier handoff text |
| #181 | 9c49459 | P1/P2: adaptive jittered polling, public paths skip the sign-in call, wallet history newest-500 in one query, per-user spend read, per-user daily cap shapes the plan, public limiters sized for one venue IP, per-account concurrent-job limit (3) before the reserve; suite 297 files, 3048 passed / 27 skipped, tsc clean, build OK, preview READY |

**Production (last one read from the API):** `dpl_ngkEDTNm3XYn5BqmfUsg6nVwXNXS`, state READY (2026-10-21 about 07:28 UTC), built SHA `f0724f0a41e25835620cc612470da62a9b79473d` (contains #173 to #180). The production builds of #181 (`9c49459`) and of this handoff PR were started after that reading: READ THEM FIRST (`list_deployments`, target production, then `get_deployment` for state and built SHA) and confirm READY.

### (b) Branches not on main

| Branch | Head | Contains | Missing |
|---|---|---|---|
| `claude/wip-e1-harness` (SUPERSEDED by PR `claude/e1-harness`, type error fixed) | c50e2fd | `tests/helpers/loadHarness.ts` (latency-counting fake DB) and `tests/conference-load-harness.test.ts` (500 visitors through the real `/api/chat` route, 3 messages each, no model) | first run printed per-turn stage timings (about 12 awaits per turn, auth 11 ms, rate limit 15 ms, writes about 140 ms with 4 ms fake round trips); the results were not read to the end, assertions not tuned, numbers not recorded; silence console JSON from `chat_stage_timings`; no concurrency/idempotency section yet; not on main |
| `claude/wip-load-and-limits` | 72dd425 | superseded by merged #181 | delete or ignore |
| `claude/money-bundles-and-pricing` | 3ed699d | parked by the owner | NEVER touch |

### (c) Status of every item

| Item | Status |
|---|---|
| STEP 0 (YouTube deep reads, quality filter, columns, honest plan) | DONE-MERGED (#175) |
| Part A (A1 to A6) | DONE-MERGED (#176) |
| Part B (showcase missions) | DONE-MERGED (#177) |
| Part C (long-mission audit) | NOT STARTED as a written audit (the long-job machinery was built and tested in earlier missions; no new defect found or fixed in this session) |
| Part D (dashboard, busy mode, sign-up path, rate-limit screens) | DONE-MERGED (#178, #180) |
| P1 sign-up path, rate-limit/slow-e-mail screens, busy mode | DONE-MERGED (#178) |
| P1 per-user chat limit | already existed (20 per minute, database counted); unchanged |
| P1 per-user concurrent-job limit | DONE-MERGED (#181) |
| P1 conference dashboard | DONE-MERGED (#180) |
| P2 CPU/invocation reduction (polling, middleware, history, spend reads) | DONE-MERGED (#181) |
| Part E1 offline harness | WRITTEN-NOT-MERGED (WIP branch, unfinished) |
| Part E2 pressure-test scripts + runbook | NOT STARTED |
| Part F `docs/CONFERENCE_READINESS.md` + report | NOT STARTED |
| Final "READY FOR LIVE VERIFICATION" post + ONE batch test | NOT STARTED |

### (d) Exact next step, in priority order

1. Read the production deployments of `9c49459` (#181) and of the handoff merge: state READY and built SHA from the API.
2. Finish E1 on `claude/wip-e1-harness`: mock or silence the `chat_stage_timings` console output (it floods), read the results (`HARNESS_OUT=<file> npx vitest run tests/conference-load-harness.test.ts`), tune bounds, add a concurrency section: the same quote approved 20 times at once through `accept-quote` must reserve once (use the stand-in functions in `tests/helpers/scaleHarness.ts`), and document per-instance state (`publicRateLimit.ts`, `busyState.ts` 15 s cache, `conferenceCache.ts`). Open a PR, merge.
3. E2: `scripts/pressure/` (50/100/250/500 virtual visitors against a PREVIEW URL with a fake-provider flag and a separate test database; never production, never run by the agent) and `docs/PRESSURE_TEST_RUNBOOK.md` with exactly what the owner must create (a second Supabase project, preview env values by name, a test provider flag). SQL index ideas only as files under `docs/proposals/`, never applied.
4. `docs/CONFERENCE_READINESS.md` (Part F): coverage results (`docs/CAPABILITY_COVERAGE.md`), working showcase list (Part B), harness numbers and the first bottleneck, the owner's manual list (g), the fallback plan for the day, the Friday checklist. Include the Part C audit (chunks, resume, notifications, duration range, partial settlement): read `src/app/api/worker/chunk/route.ts` and `src/lib/server/longJob*.ts`.
5. Final post: "READY FOR LIVE VERIFICATION" with SHA, deployment id, READY time, evidence of every PR, NOT VERIFIED, and ONE batch test (each showcase mission once within a small budget; YouTube 30 comments football last month quote at most 300; TikTok 30 comments football in Egypt last month at most 220; X 30 posts about Egypt vs Morocco window 2026-06-11 to 2026-07-19 at most 200; the dollar-news request; six other scenario-matrix requests asked and not approved; the sign-up path from a clean browser).

### Standing rules (do not break)

Feature branches from clean `origin/main`; merge commits only (no squash, no `--admin`, no rebase, no force-push); evidence block after each PR (PR number, merge SHA, `git diff --stat`, suite before/after with skipped counts, `git diff origin/main -- tests | grep '^-' | grep -v '^---'`, tsc, build, Vercel deployment READY with the built SHA from the API). SELECT-only database access; no migrations; no live provider or model calls by the agent; Customer text in Arabic only, Arabic-Indic digits, no emoji, no provider names or USD. `rm -rf .next/types` before `tsc` after switching branches.

### (e) Risks and NOT VERIFIED

- Public limiters and the busy-state cache are per server instance (memory), per IP; the venue shares one IP (limits raised in #181, documented in code).
- The sign-in service's own limits (confirmation e-mails per hour, sign-ups per IP) are outside the code: owner list (g).
- A job is capped at 600 points: about 57 YouTube comments, 86 TikTok comments, 104 X posts per request; templates promising more are cut by the plan with a plain sentence.
- News, prices, ads, maps, search, jobs and forums are answered as «not available» and logged (no approved service).
- NOT VERIFIED live: the real balance read on the deployed plan path; the YouTube recency parameters and video-level review on real data; the deep read on a live source; TikTok video-level relevance; the X completion notification; the busy banner and invitation-code redeem with a real account and real e-mail; the conference dashboard on production data; the adaptive polling in a real browser; the concurrent-job 429 in production; all of Part E's pressure test.

### (f) Decisions already taken by the owner

Keep the current Vercel and Supabase plans; Resend already upgraded; NO changes to money, price, cap or provider-limit code (prices, unit costs, `JOB_MAX_POINTS_CAP`, `settle_job_atomic`, `release_job_atomic`, `approve_topup_atomic`, reserve/ledger code, bonuses, referrals, any SQL, the model string); the parked branch `claude/money-bundles-and-pricing` stays untouched; old PRs #3 to #11, #40, #41, #44, #69, #83, #85 stay untouched. If a test is about money: stop and report, never edit it.

### (g) What the owner must do manually before Saturday

1. Supabase Auth: raise the per-hour e-mail and sign-up rate limits for the venue (all attendees share one IP); confirm the e-mail sender is the upgraded Resend one.
2. Provider account: top up the balance and set the daily cap (admin tab) for the day; the busy mode closes the door by itself when the real balance or the daily allowance runs out.
3. Free points per new user: decide the welcome amount (admin setting) and the invitation code to print on the QR (`/join/<code>`).
4. Anthropic: set a monthly spend alert/limit.
5. Optional env: `MAX_CONCURRENT_JOBS_PER_USER` (default 3), `CHAT_MESSAGES_PER_MINUTE` (default 20).
6. For the pressure test (run by the owner, on a PREVIEW only): create a separate Supabase test project and give its values to Vercel preview env (names in the runbook when written); never use production.
7. Friday evening: freeze code; read `/admin/conference` once; run the sign-up path once from a clean phone browser.

---

## 1. System Architecture & Core Stack

- **Framework**: Next.js 15.5 (App Router, React 19, Tailwind CSS v4) hosted on Vercel.
- **Database & Auth**: Supabase PostgreSQL (Project `pfinlfaqwnytesedchik`), using Row-Level Security (RLS) and atomic RPC functions for all balance/financial operations.
- **AI & Planning**: Anthropic Claude Haiku 3.5 (`claude-3-5-haiku-20241022`) via `@anthropic-ai/sdk`, with structured fallback plans.
- **Data Catalog & Ingestion**: TREG catalog integration for B2B company discovery, social data, and profile endpoints.
- **Deliverables**: Excel (.xlsx) generated via `exceljs`, CSV (UTF-8 BOM), and PDF methodology reports via `pdfkit`.

---

## 2. What Works (Verified Subsystems)

1. **Authentication & Session Security**:
   - Supabase Auth integration via `@supabase/ssr` cookies and JWT bearer headers.
   - Non-admin test account login and role separation verified.
   - Zero client bundle secrets validated via `scripts/check-client-bundle-secrets.ts`.
2. **Financial Guardrails & Append-Only Ledger**:
   - `credit_ledger` alterations strictly mediated by deterministic IDs (`res_<jobId>`, `rel_<jobId>`, `chg_<jobId>`, `top_<topupId>`).
   - Reserve-first hold and release-first completion order (`rel_` +reserve, followed by `chg_` -actual).
   - Zero charge for missing records or non-matching results.
3. **Arabic-First Interface & UX Invariants**:
   - Native RTL layout with Arabic typography and formatting.
   - Activity panel appears only when an active or completed job exists and remains absent on fresh chats.
   - Sidebar collapse and responsive navigation work across desktop and mobile (tested at 390x844).
   - Session reset via "+ سؤال بحثي جديد" clears active job state and session storage without reopening stale jobs.
4. **Artifact Downloads**:
   - PDF, Excel, and CSV download routes verify user authorization and generate time-limited signed URLs (`/api/jobs/[id]/download`).
   - Direct download links link reliably to stored deliverables in the Supabase `results` bucket.

---

## 3. Known Open Issues & UNVERIFIED Items (For Codex / QA)

The following items are explicitly marked as **OPEN** or **UNVERIFIED** and require further testing, owner decision, or remediation:

1. **[OPEN - UNVERIFIED] 50-Company Autonomous Worker Progression**:
   - A 50-company job finishing entirely on its own through the worker/cron path with zero client-side pushing or manual intervention remains unproven under full production isolation.
2. **[OPEN] Plan Proposal Latency (12–16 Seconds)**:
   - Initial plan card generation in chat takes between 12 and 16 seconds (target is under 10 seconds). Root cause includes sequential upstream capability lookup, schema reflection, and multi-turn Claude prompt reasoning.
3. **[OPEN] Excel Executive Summary Sheet vs Data-Only Requirement**:
   - The generated Excel workbook currently includes an executive summary sheet (`الملخص التنفيذي ومؤشرات السوق`) in addition to the data sheets (`دليل الشركات المعتمد` and `بيانات الشركات للتصفية`). The owner has stated a preference for data-only workbooks; this sheet must either be removed or formally approved.
4. **[OPEN - UNVERIFIED] Plan Edit Industry Filter Persistence in Database**:
   - While client-side form state and quote recalculation show the edited industry, end-to-end database proof that subsequent worker execution applies the modified industry filter in SQL/TREG params remains unverified.
5. **[OPEN] Decision-Makers Work Email Unavailability**:
   - B2B decision-maker queries deliver names, titles, and LinkedIn URLs, but work emails are consistently unavailable from the current upstream provider endpoint. The plan card now includes an explicit disclaimer before approval, but upstream email enrichment remains unavailable.
6. **[OPEN] Database Cleanup Plan Correction**:
   - Helper SQL cleanup scripts generated during chat sessions were flawed and must **NOT** be used. The only authoritative, transaction-safe reset script is documented in [`docs/OWNER_SQL.md`](file:///d:/Digr/docs/OWNER_SQL.md) and must be executed exclusively by the owner.
7. **[OPEN] Unexplained `settings_private` Write for 0.80 USD Provider Cap**:
   - The origin and historical write of the `0.80 USD` provider daily cap in `settings_private` requires owner verification against real budget constraints.
8. **[OPEN] LLM Daily Spend Cap (50 USD) Policy Decision**:
   - The LLM daily spend cap is currently configured at 50 USD in `settings_private` and enforced at runtime. This limit requires an explicit business policy decision by the owner prior to public scaling.

---

## 4. How the Worker & Cron Execution Path Runs

1. **Job Initialization**:
   - Customer approves a quote via `POST /api/chat/accept-quote`.
   - `accept_quote_atomic` holds reserved credits in `credit_ledger` and inserts a `queued` job into `jobs`.
   - `accept-quote` triggers the first chunk via `dispatchWorkerChunk` calling `POST /api/worker/chunk`.
2. **Chunk Execution & Self-Chaining**:
   - `/api/worker/chunk` claims an execution lease on the job, queries the data provider, filters/deduplicates records, and saves partials to Supabase Storage.
   - If more records are required, the chunk self-chains by firing an asynchronous `POST` to `/api/worker/chunk` for `step + 1`.
3. **Client Polling & Nudge Route**:
   - While the user has the chat or requests page open, `/dashboard/chat` and `/dashboard/requests` periodically check active job status.
   - If a lease has stalled or expired without completion, the client triggers `POST /api/jobs/[id]/nudge` to safely re-dispatch the next worker chunk.
4. **Watchdog Cron**:
   - Vercel daily cron triggers `GET /api/cron/watchdog`.
   - Stale running jobs past timeout are identified, compensating releases (`rel_<jobId>`) are checked, and stuck holds are released safely.

---

## 5. How to Run Tests & Verification

All automated tests and validation scripts run locally with:

```bash
# 1. Run all unit and integration test suites (Vitest)
npm run test

# 2. Verify TypeScript types across the entire project
npx tsc --noEmit

# 3. Build Next.js production bundles and check for client secret leaks
npm run build

# 4. Standalone client bundle secret scan
npm run check:secrets
```

---

## 6. Recorded Test Top-Ups Note for Owner

All balance top-ups performed on the test account (`iam.magdy@outlook.com`, UID `47693c59-89f1-405d-bec1-e72271517870`) are recorded below for pre-launch ledger cleanup per [`docs/OWNER_SQL.md`](file:///d:/Digr/docs/OWNER_SQL.md):

| Topup ID | Amount (EGP) | Points (Delta) | Reference | Ledger ID |
| :--- | :---: | :---: | :--- | :--- |
| `top_req_1792156256768` | 25 | +250 | `REF_1792156256769` | `top_top_req_1792156256768` |
| `topup_6ac474bae339871ce7473c18` | 20 | +200 | `TEST_REF_1792164072210` | `top_topup_6ac474bae339871ce7473c18` |

---

## 7. Operational Rules & Security Invariants

- **Zero Direct Writes to Money Tables**: Never run ad-hoc SQL `INSERT`/`UPDATE` statements against `credit_ledger`, `jobs`, `topups`, or `profiles`. All balance mutations must use approved database functions.
- **Never Print Secrets**: Passwords, API keys, tokens, and database credentials must remain in environment variables and never be logged, committed, or typed into reports.
- **No Unchecked Merges**: Merges to `main` must use pull requests with passing CI checks. Never use `--admin` merge overrides.

### Added in the follow-up PR (2026-10-21)

- Deployment discipline: `vercel.json` `ignoreCommand` runs `scripts/vercel-ignore.sh` (`tests/vercel-ignore-command.test.ts`): production always builds; a preview whose commit message contains `[skip ci]` or `[skip deploy]` is skipped. Vercel has no built-in commit-message marker; this is the documented Ignored Build Step. WIP branches are pushed once with the marker in the head commit.
- Free-point grant throttle in our own code (`src/lib/server/grantThrottle.ts`, `tests/grant-throttle.test.ts`): per IP 900 an hour, per device cookie 5 a day (env `PROMO_GRANTS_PER_IP_PER_HOUR`, `PROMO_GRANTS_PER_DEVICE_PER_DAY`); no money value changed.
- Tests for the owner's items: fake provider cannot be on in production and never reaches the live database (`tests/fake-provider-production-refusal.test.ts`, `tests/fake-provider-mode.test.ts`); `/admin/export` admin-only for every verb, no secrets, absent from customer surfaces (`tests/admin-export-access.test.ts`, `tests/admin-export.test.ts`).
- Sign-up arithmetic and the confirmation-off fallback: `docs/SUPABASE_FREE_PLAN.md` section 4b.
