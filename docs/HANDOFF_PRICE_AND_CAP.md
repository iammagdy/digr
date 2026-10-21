# Handoff: «Big missions: price and cap» (written 2026-10-21, for a new Claude session)

Read this first. It says what was asked, what is done, what was found, where work stopped, and what to do next. Nothing in it is applied to production.

## 1. Who and what
- Owner: Magdy (works from a phone; wants short reports, no stop-and-ask loops). Conference **Saturday 2026-10-24**, code freeze **Friday evening**.
- Mission («BIG MISSIONS: PRICE AND CAP»): raise the per-job cap from **600 to 5,000 points** (500 EGP) together with **per-record pricing**, because missions sold at about 4,000-4,500 points were blocked by the 600 cap.
- Repo `iammagdy/digr`, branch **`claude/price-and-cap`**, draft PR **#189** (https://github.com/iammagdy/digr/pull/189). Head `bf246dd` (docs, `[skip ci]`); the code last built on Vercel is `a33b382`.

## 2. Standing rules (do not break)
- **Nothing is merged or applied until the owner replies «G-MONEY approved».** PR #189 stays a draft until then.
- Merge commits only (never squash, `--admin`, rebase or force-push). Never touch old PRs #3-#11, #40, #41, #44, #69, #83, #85.
- **SELECT-only database access. The assistant never applies SQL or migrations.** No live provider or model calls. Never run anything against production.
- At most about 10 Vercel deployments a day (use `[skip ci]` in commit subjects; the ignore script `scripts/vercel-ignore.sh` honours it). No manual previews.
- Updating an existing test is allowed only if it pinned exactly the old behavior and the new assertion is equally strict; money tests changed must be listed in the PR body and the owner reviews them before merging.
- Customer text: Arabic only, Arabic-Indic digits, no emoji, no provider names, endpoint ids, USD, internal ids or technical errors. Estimates are labelled «تقديري» and computed by code. Model string `claude-haiku-5-5` never changes. Long-job driver stays in tab mode; never show «تقدر تقفل الصفحة» without proof (flag `LONG_JOB_DRIVER=cron` AND a driver tick in the last 3 minutes).
- No secrets printed or committed. Keep the Vercel and Supabase plans.
- Production Supabase project ref: `pfinlfaqwnytesedchik`. Vercel project `diger` (`prj_v7wrVudQg2M504BT2B3dvGzsnHh6`, team `team_BqtLnzbymztN1kQ7enwqVWAx`).

## 3. What was built (all on the branch, none applied)
- **Shared pricing:** `src/lib/jobPointsCap.ts` (one cap constant, 5,000), `src/lib/recordPricing.ts` (exact BigInt pricing: unit price = cost per record USD x 5,500 points, kept fractional; charge = ceil(delivered x unit); reserve = ceil(volume x unit x 1.15), never above the cap; `RECORD_COSTS` table marked MEASURED/ASSUMED), `src/lib/pointsFormat.ts` (prices shown per 100 records when fractional). Quote writer, calculator, services, pricing page, estimator and plan card all use the same function.
- **Gates:** confirmation tick above 600 points (approve disabled until ticked); plan refused when the balance does not cover the full reserve; provider start gate refuses plans not fitting the daily provider cap or the real provider balance.
- **Scale:** ceilings and rows per chunk as configuration (`src/lib/scaleConfig.ts`), duration range labelled «تقديري», driver heartbeat (`src/lib/server/driverTick.ts`, `/api/driver-status`, admin indicator), phone checklist `docs/proposals/08_long_job_driver_setup.md` and `08_pg_cron_driver.sql`.
- **SQL proposals (not in `supabase/migrations`):** `docs/proposals/job-cap-5000/` (option A constants, option B helper `job_points_cap()`, diffs, step apply files and exact rollback files; `functions/` and `functions-b/` hold the proposed bodies). Real production definitions saved in `docs/proposals/prod-definitions/`. Registry alignment: `docs/proposals/registry-alignment/apply.sql` and `rollback.sql`.
- **Replica:** `tests/helpers/replicaDb.ts`, `replicaMoney.ts`, `tests/replica/*`: a real local PostgreSQL 16 with the real production function bodies; property tests run at cap 600 and cap 5,000 (skip visibly with no Postgres).
- **Status of checks:** `tsc` clean; full suite 326 files / 3,302 tests passed, 0 failed; `npm run build` passes; preview deployment `dpl_HLiBNLZgzPVugLHwUodm4CFeaxsF` READY at SHA `a33b382`.

## 4. Key facts found in production (SELECT only)
- Cap 600 is hard-coded in `create_quote_atomic` and `settle_people_job_atomic`; `settle_job_atomic` takes it as a parameter; `accept_quote_atomic` has a separate 5,000-record ceiling (the proposal raises it to 100,000). `jobs.unit_price` is numeric, so fractional prices work; no trigger blocks a reserve above 600.
- Stale data (code overrides it, no customer effect): `settings_private.pricing.jobMaxPointsCap` = 600; registry rows with old prices (YouTube 9, TikTok 6, Facebook comments 11, Facebook posts 11, companies 3). The live provider daily limit is `provider_limits.dailyUsd` = **0.9 USD** (wins over `pricing.providerDailySpendCapUsd` 0.8).
- Effective per-job record ceilings: X 37,113; YouTube/TikTok comments 15,810; Facebook comments 4,204; **Facebook posts 60**; **companies 500**. The most one job can charge is about 4,347 points (5,000 / 1.15); a 4,500-point mission needs a cap of at least 5,175 (use 5,200).
- **The preview deployment uses the production database and live provider token** (same Supabase env vars; no `PRESSURE_FAKE_PROVIDER`; the fake-provider gate refuses on the production ref; the fake source serves only TikTok). Never run a job on the preview.

## 5. The open problem: margin (decision needed from the owner)
Details: `docs/proposals/job-cap-5000/all-in-cost-and-margins.md`.
- Provider-only margin is 5x-15x everywhere (TikTok comments at 30 records 2.6x).
- The automatic row review costs about 0.0047 USD per call of 25 rows; the review budget (`socialReviewCapUsd` = 0.0006 USD x target) exceeds the revenue of an X record (0.000213 USD). If every row is reviewed, X is at about 1x and comments about 2x; with one planning call (0.0155 USD) every small X/comments job is under 3x. The share of rows actually reviewed is unmeasured.
- Options (not implemented, all keep charge = ceil(delivered x unit)): **Option 3 (recommended)** cap the review budget at 20% of the job's revenue; Option 1 higher unit prices (X 0.3453 / YouTube 0.3927 / TikTok 0.3762 for 3x with every row reviewed); Option 2 minimum plan volume per capability.

## 6. Where work stopped
The four pre-approval checks (test-strength audit, all-in cost, registry/stale data, build proof) are done and reported. The last report ended with **"G-MONEY READY FOR DECISION"** and a recommendation **not to approve yet**. The assistant is waiting for the owner. Still needed from the owner: (a) the decision on the review-cost options, (b) the cap: 5,000 or 5,200, (c) the provider test budget (0.1 USD covers only the first six tester jobs; about 0.35 USD covers all eight).

## 7. What to do next
1. Wait for the owner's decision; do not merge or apply anything before «G-MONEY approved».
2. If Option 3 is chosen: implement it (change `socialReviewCapUsd` to also take the job's revenue) with tests, push with `[skip ci]`, and update PR #189.
3. If the cap changes to 5,200: change the one constant in `src/lib/jobPointsCap.ts` and regenerate the SQL proposal with `scripts/proposals/buildJobCapProposal.ts` (`NEW_CAP`), then re-run the replica tests.
4. After «G-MONEY approved»: the owner applies the four SQL steps in order (`option-a/step1` settle_people, `step2` settle_job, `step3` accept_quote, `step4` create_quote last), verifying each with a read-only `pg_get_functiondef` query; rollback files in reverse order. Then merge the train with a merge commit, confirm the production deployment is READY and the built SHA from the Vercel API, then run the tester batch (`docs/proposals/job-cap-5000/tester-batch.md`) only after the owner says the SQL is applied. Registry alignment SQL runs after the deploy.
5. Run the tester batch (jobs 1-8) and copy price, duration range, real duration, charge, delivered counts and provider cost per job; then stop.

## 8. Where things are
- Tests changed with old/new lines: `docs/proposals/job-cap-5000/money-tests-changed.md`; strength audit: `test-assertion-audit.md`.
- 4,000-post X replica run (quote 469 charge / 539 reserve, ledger reserve -539, charge -469, release +539): `x4000-replica-run.json`, test `tests/x-4000-replica-run.test.ts` (set `X4000_REPORT_PATH`).
- Earlier-session transcript, if needed: `/root/.claude/projects/-home-user-digr/7ac30090-d7fe-57f2-9339-5e40988e696f.jsonl`.
