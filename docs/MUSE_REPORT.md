# Verification pass on the discovery stage: final report

Date: 2026-10-17. Scope: Phase 1 (code, tests, build, database evidence) and Phase 2 (live browser scenarios a to i).
Nothing in this report was claimed from memory: every PASS names its kind of evidence, and everything that was not
run says NOT RUN with the reason. No credential, token or secret value was read, printed, written or committed.

## 1. Commit, pull request, deployment

| Item | Value |
|---|---|
| Base | `codex/discovery-stage-fixes` (PR #79), true head `1e11ded88f3e63ce4cdfdee9727484667c17ed60`. `64abfb2` is an earlier commit of the same branch (an ancestor); `1e11ded` is the head. |
| Base deployment | `dpl_pwwupeaDz2dnHcHN79FtMNe2p7Yb`, state READY, `githubCommitSha` equals `1e11ded88f3e63ce4cdfdee9727484667c17ed60`. |
| This work | branch `claude/zealous-carson-sdg9x4`, draft PR [iammagdy/digr#80](https://github.com/iammagdy/digr/pull/80), stacked on #79 (base branch is the Codex branch, not `main`). `main` was not touched, nothing was merged, no force push. |
| Last code commit | `d3daf797619aa1c9213fe9cf3f118e2b555bf719`, Vercel deployment `dpl_SPnSd5iw17jCVghku32xkh593voe` (state at the time of writing: BUILDING; the state of the final commit is stated in the closing message). Earlier commits of this branch were all READY (for example `dpl_Abtk8cDtMPZBJgw7imenJSNz4C9Y` for `2026262`, `dpl_4QT8jbUXUuGawv8nJ9A1ryqmqm75` for `b635a49`). |
| Preview access | The Preview is behind Vercel deployment protection: a request to the Preview URL answers HTTP 302 with a redirect to `vercel.com/sso-api` (headers only were read). A headless browser cannot open it without a bypass link or protection turned off. |

## 2. Test counts

| | Files | Tests | Passed | Failed |
|---|---|---|---|---|
| Before (head `1e11ded`, run here) | 111 | 902 | 861 | 41 |
| Same suite on `main` (run here, for attribution) | n/a | 890 | 863 | 27 |
| After (this branch) | 124 | 1034 | 1034 | 0 |

Codex's note said 860 passed and 41 failed (901 tests); the same suite run here gives 902 tests, 861 passed, 41 failed
(one more test counted). 27 of the 41 already failed on `main`; 14 were new in PR #79.
`npx tsc --noEmit` is clean. `npm run build` passes and the client bundle scan reports zero secrets (85 files).
No test is skipped or marked todo. Every assertion count was compared per modified test file: three files have fewer
assertions because the sheets they checked no longer exist by owner decision D4 (see the note under the table).

### The 41 failures, one by one

C = the code was wrong and was fixed. T = the test asserted behavior replaced by an owner decision and was updated.

| # | Test (file) | Decision | Why |
|---|---|---|---|
| 1 | claude-decides (a) complete Arabic wedding request plans immediately | C | The social discovery gate asked for a period although the request gave dates, and re-asked a stated platform. Detection moved to one helper (`src/lib/socialDiscovery.ts`); the period is no longer a required input (it never changes cost). |
| 2 | claude-decides (e) step timings returned in turnStats | C | Replies that end before a model call (greeting, required-input question) returned no stats. They now return stats and the `[chat:turn]` log line. |
| 3 | customer-journey Scenario 4 (Facebook comments on a named page) | C | Same gate: the topic was the page name, not matched by the old preposition regex. |
| 4 | handoff-regressions: relative date window | T | The test used TikTok, whose approved entry is a one-account profile lookup that correctly carries no date filter. Moved to a keyword-search capability (X). |
| 5 | handoff-regressions: calculator does not advertise decision makers | C and T | PR #79 emptied the blocklist, which re-exposed the unreliable legacy people endpoint (and the live registry has it enabled). The block is restored. The test now asserts the verified `professional-people-search` is offered (D3) and the legacy duplicate is not. |
| 6 | latency-logging (a) logs modelCalls | C and T | Stats and log restored for the greeting path; expectation changed from 1 model call to 0 because greetings are answered by server code (D2, speed). |
| 7 | open-assistant multi-platform | C | "من فيسبوك" was not recognized as a platform by the discovery regex; now uses the shared platform detector. |
| 8-10 | tiktok-profile-endpoint-config (3 tests, "fails closed on unknown cost") | C | PR #79 added the decision-maker service inside the registry loader, so the loader no longer returned what the registry says. It is now a separate wrapper (`getEnabledCapabilitiesWithCoreServices`) that adds the service only when the registry has no row for it, respects a disabled row (kill switch) and adds nothing when the registry is unreadable. The loader is pure again. |
| 11-12 | two-phase greeting (a), (b) | T | Owner decision D2: a missing name is asked once ("ما الاسم الذي تفضّل أن أناديك به؟"). Added a test that greets by the real profile name. |
| 13 | two-phase (f) default volume 500 | T | A silent 500-record default would put an unrequested quote of hundreds of points in front of the customer. The code default is a 10-record sample, shown and editable on the plan card. |
| 14 | two-phase (j) clarification answers produce a quote | C | Same discovery gate as 1. |
| 15-16 | chat-e2e-workflow 7 and 8 (6-sheet company Excel) | T | D4: Excel is data only; the company workbook is one data sheet. |
| 17 | claude-brain-phase-b "minimum order of 50 points" | T | No minimum order exists in the pricing rule. The test now checks the unrounded legacy formula and the production per-unit rounding (1 unit at 0.0001 USD is 1 point, reserve 2). |
| 18 | company-email-column | T | Ported to the live generator; the dead presence column was replaced by a per-field verification status (D3), with the values "متحقق / لم يتوفر تأكيد / غير صالح / غير متاح". |
| 19-21 | company-report-scope-and-fields (3 tests) | T and C | Ported to the live generator. Source branches are now a linked sheet in the live workbook (code added). The summary and distribution sheets are excluded by D4 and asserted absent. |
| 22 | conversational-artifact-revisions (RTL on all sheets) | T | D4: one sheet. Still asserts RTL on every sheet and the deduplicated row count. |
| 23-28 | generic-executor-phase-c (6 tests) | T | The adapter now reads the live endpoint schema first (a catalog GET, not a billed call). The mocks now answer it and no longer count it as a page or an attempt. |
| 29 | legal-customer-copy (terms wording) | C | Terms wording changed to the requested sentence: "نبذل أقصى جهد للتحقق، ونوضح حالة التحقق لكل خانة، ولا نضمن حداثة كل معلومة". |
| 30 | normalization-pipeline end to end | T and C | The default source label is "مصادر متاحة" (D4 and Arabic-only) instead of an English brand with "public data". |
| 31 | offline-acceptance Scenario B | T | Data-only Excel; methodology labels matched to the current Arabic text. |
| 32-34 | p1-arabic-requests (2) and p1-llm-trust-boundary (1) | T | Refusal wording is "المصادر المتاحة", not "البيانات العامة" (D4). |
| 35-36 | redesign-guardrails and release-integration (methodology alert) | T | The browser alert was replaced by an in-page confirmation. The tests now assert there is no `alert(` and the message uses the server-reported charge. |
| 37-41 | research-deliverables (5 tests) | T | D4: no dashboard, quality or codebook sheets. Re-pointed to the data sheet (formula guard, Arabic headers) and to the methodology text (requested count unavailable, delivered and removed counts). |

Assertion count note: `chat-e2e-workflow` (-2), `company-report-scope-and-fields` (-2) and `research-deliverables` (-5) have
fewer assertions. They covered sheets that D4 removes from Excel: the executive summary, the analysis and distribution
counters (industry and city counts), the codebook rows and the key/value quality rows. Each was replaced by an
assertion that the sheet is absent and, where the fact still exists, by an assertion on the methodology text. Whether
the company distribution counts should appear in the methodology PDF is an owner decision (item 7 of section 6).

## 3. Phase 1 items

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | True head and its deployment | PASS | `1e11ded`, `dpl_pwwupeaDz2dnHcHN79FtMNe2p7Yb` READY (Vercel API). |
| 2 | Install, tests, build, tsc, the 41 failures | PASS | Section 2. |
| 3a | Manual `rel_` instruction removed from the stuck-job report | PASS (automated test) | `reportStuckJobsReadOnly` now tells the operator not to write ledger rows by hand and to use the watchdog (`release_job_atomic`); test asserts the old wording is gone. |
| 3b | Table of every direct money-table write | PASS (static scan plus import graph) | `docs/MONEY_WRITES_PLAN.md`: 82 write sites in 239 table accesses; live vs legacy vs script classification; the 11 approved functions exist and are `service_role` only (raw query in the appendix). Nothing was rewritten. |
| 4 | Retry reuses collected rows and fetches only the deficit | PASS (automated tests, mocked storage and database; NOT RUN live) | `src/lib/server/retryReuse.ts` and the worker. See section 4. 18 tests. |
| 5a | Egypt default removed | PASS (automated tests) | Three leftovers found and removed: plan validation injected `Egypt` into an empty company query; the intent default was "مصر والشرق الأوسط"; the model prompt offered Egypt as a suggestion. 5 tests. |
| 5b | Structured industry vs free keywords | PASS (automated tests) | Structured taxonomy is primary and keywords are a fallback only when no taxonomy exists, because the provider combines both with AND. The planner and the provider path had two different industry detectors (the provider one had no entry for electricity); there is now one. A Latin substring test (`it`) misread "United", "Italy" and "technical" as information technology; fixed. Provider request bodies are in section 5. |
| 5c | Arabic number words never asked again, never overridden | PASS (automated tests) | New compound parser: خمس، عشرة، عشرين، مية، ميتين، ألف, plus مئة وخمسين (150), ألف وخمسمية (1500), واحد وخمسين (51). A year is no longer read as a count. 22 tests through the discovery gate and the handler. |
| 5d | Post-approval message | PASS (static and automated) | Exact sentence is one shared constant; the page uses it. |
| 5e | Stale active job after «سؤال بحثي جديد» | PASS (static tests only; browser behavior NOT RUN) | The reset handler clears job, rows, resume hints and URL. A real race was found and fixed: a late reply for the old job could paint its rows into the new screen or merge into a different job. Replies for any job other than the one on screen are now dropped. |
| 5f | Requests list polling and one status source | PASS (automated tests) | One resolver (`src/lib/jobs/requestStatus.ts`) is used by the list and the activity panel: «مكتمل» only when the requested volume was delivered, otherwise «مكتمل جزئياً» with requested vs delivered. Failed or cancelled runs are always refunded runs: the list used to label a failed run «مكتمل جزئياً» and say the charge is limited to delivered rows, while the database shows 86 failed jobs with 0 charged. The list now refreshes every 16 s even with nothing running. |
| 5g | English city names in Arabic in Excel | PASS (automated tests) | Eleven city names with underscores in their key (Port Said, Nasr City, Sheikh Zayed, Sharm El Sheikh, Al Ahsa, Khamis Mushait, San Francisco, Cape Town and others) never matched; "New Cairo" was read as Cairo; "Oman" the country could be read as Amman. Fixed. Unknown English cities show «غير متاح» instead of Latin text. |
| 5h | Distinct provider-failure path | PASS (worker-level tests with a mocked database; NOT RUN live) | Failed or invalid provider response: full release through `release_job_atomic` with the provider's Arabic reason. Valid empty answer: «لم يُعثر على أي بيانات مطابقة…». Rows arrived but none matched: «استلمنا ٣ سجلاً … لم يطابق أيٌّ منها نطاق طلبك…». None settles. |
| 5i | Relevance for "contracting" | PASS (automated tests) | Energy, electronics, machinery and mechanical labels go to the review sheet instead of being excluded; they match when the row itself shows contracting or MEP activity; only furniture, wood, interior design, real estate and rows whose own text describes oil and gas operations are excluded. For other sectors (electricity, food and so on) a row whose own industry label names the sector is delivered. Before this, every row of those sectors was sent to review and nothing could be delivered. |
| 5j | Activity events | PASS (worker-level tests) | One plain Arabic line per page with the new count and the running total, duplicates removed and skip reasons; every event line of a finished run is free of Latin letters and digits and of provider or technical words (two lines contained "Excel و PDF و CSV" and Latin digits; fixed). The duplicates counter in the panel could not read Arabic digits; fixed. Start line: the server writes none; the page writes one local line. |
| 5k | ETA from measured durations | PASS (automated tests) | `remaining batches x median(measured batch seconds)`; no measured batch gives no estimate. The formula's assumption is stated in the code. Real durations from the database are in section 5. |
| 5l | Plan-card latency | PARTIAL: causes found with real measurements; effect of the fixes NOT RUN | Section 5. |
| 6a | Helper scripts and credential-bearing files | PASS (scan, names only) | Section 7. |
| 6b | Caps | PASS (code and read-only query) | Section 7. |
| 6c | Purchase-methodology flow | PASS (code review) | Section 7. |
| 7 | Commit, push, draft PR, deployment | PASS for the code commits; see section 1 for the last one | PR #80. |

Also fixed while verifying (not on the list, all with tests):
- A hardcoded name «مجدي» in the model prompt (D2). The name now comes only from the account profile; the account name wins over the top-up sender name; the welcome screen no longer shows the e-mail prefix as a name.
- The name flow (D2): asked once, the reply is stored through the customer's own session, acknowledged with the balance and no model turn. The old "already asked" check searched for a word the question never contained and would have asked every time.
- Decision makers (D3): a request for "5 شركات كهروميكانيكية مع صناع القرار" was turned into a refusal by the platform check, because the word "شركات" was read as a request for the company database; it now produces a people plan. «صناع القرار» now counts as naming the roles. Offline plan card: section 5. The plan states the contact fields with the owner wording and a billing note.
- Phone numbers and account handles are no longer delivered with a leading apostrophe (Excel and CSV); anything that could be a formula still is escaped.
- Arabic-only customer text: platform labels no longer carry Latin names in parentheses, remaining "البيانات العامة" in plan notes became «المصادر المتاحة», plan messages use Arabic-Indic digits, the methodology message no longer says "PDF".
- Prompt caching: the long fixed rules are now a cacheable block and the per-turn context a second block; cached tokens are priced (reads 0.1x, writes 1.25x) and counted, so the daily cap sees real spend.
- The prompt told the model to default to 500 records and to the last 30 days, and to build a dashboard and codebook workbook; aligned with the owner decisions.

## 4. Retry reuse: how it works and what it costs

Partial rows are stored at `partials/<jobId>/step_<n>.json` (the bucket is `partials`, the key starts with the job id, not the user id; ownership is checked from the database instead).

1. The retry button sends a fixed request (`RETRY_SAME_PLAN_MESSAGE`). The server finds the latest quote of the conversation and its job; if that job failed within 24 hours and the new plan searches for exactly the same thing (same capability and same parameters apart from paging), it adds a marker `retryOfJobId` to the plan item. The marker is part of the plan hash and is never sent to the provider. The plan card says how many rows are reused.
2. The customer approves a new quote through the existing path (`accept_quote_atomic` reserves the points). The price covers the full requested count, and the customer is charged `ceil(delivered rows x unit price)` by `settle_job_atomic` as always, so reused rows that are in the file are charged like any delivered row. The provider is called only for the deficit (and not at all when the reused rows already cover the target); provider spend is reserved only for those calls.
3. At the first chunk the worker validates from the database that the earlier job belongs to the same user, is failed, is recent and has the same search signature, copies its rows into `partials/<newJobId>/seed.json`, counts them as delivered, removes repeats, and writes a plain Arabic event. After settlement the seed and the earlier step files are removed.

No new SQL and no new money path. Limits: 24-hour freshness; a corrupt step file stops the reuse at that file; if validation fails the job simply runs in full.

## 5. Evidence from the database and offline server runs

### Real measured durations (read-only queries, raw output in the appendix)

- Completed single-chunk jobs: 5.6 s to 9.3 s total for company search of 5 to 20 rows; 7.6 s to 27.3 s for TikTok video search of 5 rows.
- Multi-chunk completed jobs: 100 rows in 10 chunks took 150.6 s (15.1 s per chunk); 50 rows in 5 chunks took 151.8 s (30.4 s per chunk).
- Model turn that produces a plan card (`llm_usage`, 168 turns, 2026-10-13 to 2026-10-17): average 7413 ms, median 6341 ms, 90th percentile 11492 ms, maximum 18513 ms; average input 17622 tokens and output 458 tokens. A clarification turn: average 5690 ms. A greeting or general answer: average 3464 ms (now zero model time).
- Hobby keeps one hour of runtime logs, so the per-step server breakdown could not be read; the Vercel log query for the last 55 minutes returned no matching lines.

Where the plan-card time goes: the single model turn is the largest part (about 6 to 7 s), driven by a prompt of about 17.6k input tokens. Changes made: greetings and required-input questions use no model turn; the fixed rules are cacheable; the registry check added for the decision-maker service is cached for a minute. Not changed: streaming (the card needs the whole structured answer), the catalog loop, parallelizing database reads. The effect of caching on real latency is NOT RUN; measure it after merge with the `llm_usage` query in the appendix.

### Offline plan cards (the same server code, with the in-memory catalog and no live model; not the Preview)

| Request | Result | Provider request body built from the plan (no secrets) |
|---|---|---|
| b: عايز خمس شركات في مجال الكهرباء في مصر | plan, 5 records, unit 3 points, expected 15, hold 18, xlsx | `{"query":{"location":{"include":["Egypt"]},"industry":{"include":["Electrical/Electronic Manufacturing","Utilities"]}},"pagination":{"size":5}}` |
| b without a country | asks only «ما الدولة التي تريد البحث عن الشركات فيها؟» (no count question) | none |
| c: five contracting companies in Egypt | plan, 5, unit 3, expected 15, hold 18 | `{"query":{"location":{"include":["Egypt"]},"industry":{"include":["Construction"]}},"pagination":{"size":5}}` |
| d: ten IT companies in Saudi Arabia | plan, 10, unit 3, expected 30, hold 35 | `{"query":{"location":{"include":["Saudi Arabia"]},"industry":{"include":["Information Technology & Services","Computer Software","Internet"]}},"pagination":{"size":10}}` |
| e1: three rocket companies in Liechtenstein | plan, 3, expected 9, hold 11, country Liechtenstein | `{"query":{"location":{"include":["Liechtenstein"]},"industry":{"include":["Aviation & Aerospace","Defense & Space"]}},"pagination":{"size":3}}` |
| e2: five software companies in Germany | plan, 5, expected 15, hold 18, country Germany | `{"query":{"location":{"include":["Germany"]},"industry":{"include":["Information Technology & Services","Computer Software","Internet"]}},"pagination":{"size":5}}` |
| f: 5 electromechanical companies with decision makers, emails and phones, Egypt | plan (not a refusal), people search, 5 records, unit 83 points, expected 415, hold 478; the plan states the contact fields and the billing note | people request `{"q": "...", "limit": 5, "country": "EG", "keywords": ["electromechanical","MEP contracting","electrical contracting"]}` with both contact fields required |
| a: account data for @unicef on TikTok | plan, 1 record, 6 points, no country, xlsx | account lookup |

The previous provider request for the same company searches also carried free keywords next to the structured industry; the provider combines them with AND, which is a likely cause of the empty Saudi IT result. It is now structured industry only. The cause of the earlier live empty result is not confirmed (the live request was not re-run).

Decision makers cost 83 points per person (0.015 USD x 55 x 10 / 0.10 = 82.5, rounded up per unit), so the tiny-job exception (at most 5 records and at most 20 points) cannot apply to scenario f.

## 6. Phase 2 scenarios a to i

Phase 2 was not run. Reasons, in order: (1) `DIGER_TEST_EMAIL` and `DIGER_TEST_PASSWORD` are not set in this environment (checked by name only); (2) the Preview is behind Vercel deployment protection (HTTP 302 to the Vercel login) and no bypass link was provided. No job was approved, so provider spend caused by this work is zero.

| Scenario | Result | What exists instead |
|---|---|---|
| a. TikTok starter fill-only, placeholder blocked, real handle gives an account plan | NOT RUN (browser) | Static: the starter only fills the input; the page and the server both reject an unresolved placeholder; the offline plan card for a real handle is in section 5. |
| b. «عايز خمس شركات في مجال الكهرباء» | NOT RUN (browser) | Offline: no count question, plan shows 5 (section 5, 22 number-word tests). |
| c. Five contracting companies in Egypt | NOT RUN (plan card in browser; execution WAITING OWNER APPROVAL) | Offline plan card and provider body (section 5). |
| d. Ten IT companies in Saudi Arabia | NOT RUN (browser; execution WAITING OWNER APPROVAL) | Offline plan card and provider body (section 5). No empty live result was seen in this pass. |
| e. Rockets in Liechtenstein, software in Germany | NOT RUN (browser) | Offline: the country on the plan, no default (section 5). |
| f. Decision makers | NOT RUN (browser; execution WAITING OWNER APPROVAL) | Offline plan card with the contact wording (section 5). The real share of rows with a work email and a phone, and their verification status, is unknown: no job ran. |
| g. Greeting, new research, 3 minutes, edit repricing, expired quote | NOT RUN (browser) | Greeting by name and the one-time name question: automated tests; stale-job guards: static tests; expired quote: existing automated test of the approval state. Latency as the customer sees it: not measured. |
| h. Long job completion by cron or worker | NOT RUN (no job approved) | Past evidence from the database (section 5): chunk durations, and the failed-job statistics in the appendix. |
| i. Download and open Excel and PDF; 390x844 table | NOT RUN (browser) | Automated tests open generated workbooks: data only, frozen header, filters, Arabic city names, no apostrophes in phone cells, Arabic methodology text with Arabic-Indic digits and the verification summary. The real PDF and the mobile table were not seen. |

## 7. Hygiene

- Scripts: 70 files under `scripts/` plus 13 under `scripts/verify/`. None is a package script. `run-tiny-live-preview.ts` and `verify-spend-cap.ts` spend real provider budget and were not run; `verify-worker-dry-run.ts`, `eval-real-model.ts` and `update-capability-registry.ts` also call live services.
- Files with a hardcoded password literal (names only): `scripts/test-phase3.ts`, `scripts/test-permissions.ts`, `scripts/test-e2e-topup.ts`, `scripts/test-p1-permissions.ts`, `scripts/test-phase2-5.ts`. Files with hardcoded personal e-mail addresses: `scripts/cleanup-all.ts`, `scripts/e2e-live-browser-acceptance.ts`, `scripts/live-additional-scenarios.ts`, `scripts/acceptance-round3-live.ts`. `scripts/cleanup-all.ts` also names the admin account. No script reads `DIGER_TEST_EMAIL` or `DIGER_TEST_PASSWORD`. All `sk-ant-` strings in tests are obvious mocks. Recommended: move fixtures to environment variables and delete the cleanup script.
- Several scripts delete rows from `credit_ledger`; the append-only trigger makes that fail, so those cleanups cannot work on a real database and must never be pointed at production.
- Caps (code default, database value from `settings_private` key `pricing`, read-only): job cap 600 points (code 600, database 600); provider daily cap 0.80 USD (code 0.80, database 0.8); LLM daily cap 50 USD (code 50, database 50). A runtime environment override was not read (reading the environment list could print values), so the effective values are the same unless an override exists.
- Spend today (UTC), read-only: provider calls 0.0073 USD of the 0.80 cap (13 rows), model 0.5166 USD of 50. Remaining provider budget today is about 0.7927 USD.
- Purchase-methodology flow (code review): requires an in-page confirmation (`confirmed: true`), only after the job completed; renders the PDF, stores it and signs the link before any charge; charges through `purchase_methodology_atomic`; any failure before the charge removes the file and charges nothing; a repeat request does not charge twice (`chg_meth_<jobId>`); no alert. Notes: the 10-point price is a constant in two places (route and dialog), and an admin calling the route for another user's job would be charged on the admin's own balance.

## 8. What the owner must do next

1. Review draft PR #80 (it is stacked on #79); do not merge to `main` until the Phase 2 scenarios have been run.
2. To run Phase 2: set `DIGER_TEST_EMAIL` and `DIGER_TEST_PASSWORD` as environment secrets of this environment, and either turn off deployment protection for the Preview or give a bypass link; then run the task again from Phase 2.
3. Decide the decision-maker wording. The plan says «البريد المهني يُعرض إذا كان متاحاً ومؤكداً في المصادر المتاحة» (your sentence), but the code delivers an email that has no confirmation with the status «لم يتوفر تأكيد». Either keep delivering unconfirmed emails and change the sentence, or show only confirmed emails.
4. Approve one real job yourself on the Preview to measure what the model could not: a small company search (5 records is about 18 points held) for scenarios c or d; the decision-maker job costs 415 points for 5 people (83 per person).
5. Check the real provider cost per person for decision makers. Each person can trigger an email lookup and a phone lookup (up to 0.005 USD each) on top of the 0.015 USD search, so the worst case is 0.025 USD against the 0.015 USD the price is built on.
6. Optional: apply `supabase/migrations/20261017150000_register_professional_people_search.sql` (registers the decision-maker service in the registry with its price and switches the legacy people entry off). The code works without it.
7. Decide whether the company distribution counts (by industry and city) should be in the methodology PDF, since they left the Excel file.
8. Plan the money-path work in `docs/MONEY_WRITES_PLAN.md`, starting with admin top-up approval (it still writes the ledger and the top-up status in two statements) and quote creation.
9. Investigate one production job that collected 20 of 20 rows and then failed with "Cannot settle job … while active chunk" (raw row in the appendix); retry reuse now recovers such a job at zero provider cost, but the cause is open.
10. Set the Anthropic monthly spending cap in the Anthropic console (not possible from here). Model spend was 0.52 to 1.58 USD per day over the last four days.
11. Change the passwords of the test fixtures in the five scripts named above if they are real accounts.

## 9. Unverified or risky, stated plainly

- Nothing was run against the live Preview or with a real provider call. Everything about live behavior (latency as the customer sees it, empty results, contact yield, verification rates, files, the mobile table, timing of retry reuse) is unverified.
- The retry-reuse tests use a mocked database and storage; the matching of the earlier job and its files was not exercised against real storage.
- Prompt caching changes the request shape sent to the model; the automated tests check the shape and the cost arithmetic, but a live call was not made.
- The relevance rules decide what is charged. The new rule that delivers a row whose own industry label names the sector is a judgment: the label comes from the source and is not verified.
- Requiring both a work email and a phone for decision-maker rows (already in PR #79) means rows lacking either are dropped before billing; the yield may be low and each dropped row still cost provider calls. Unmeasured.
- Industry detection uses substring matching in Arabic for several sectors (for example «بناء» also appears inside «بناءً على»); only the Latin cases were fixed.
- The old multi-sheet Excel code was deleted as dead code (about 700 lines); a search of the repository found no caller outside the tests that were updated.
- The offline plan cards use a fake model; a real model may word the plan differently, while the discovery gate, parameters and prices come from server code.
- Money writes outside the approved functions remain in the code (listed in `docs/MONEY_WRITES_PLAN.md`); none was changed in this task.

## Appendix: raw read-only query output (copied)

Approved functions (query on `pg_proc`, schema `public`; columns: name, arguments, security definer, roles with EXECUTE among anon/authenticated/service_role):

```
accept_quote_atomic(p_quote_id text, p_user_id uuid, p_expected_quote_hash text)  true  service_role
approve_topup_atomic(p_topup_id text, p_confirmed_amount_egp numeric)  true  service_role
claim_job_chunk(p_job_id text, p_expected_step integer, p_lease_seconds integer)  true  service_role
commit_provider_spend(p_cost_id bigint, p_actual_cost_usd numeric, p_units integer)  true  service_role
complete_chunk(p_job_id text, p_expected_step integer, p_new_cursor text, p_new_delivered_units integer, p_cost_usd numeric)  true  service_role
purchase_methodology_atomic(p_user_id uuid, p_job_id text, p_amount numeric, p_note text)  true  service_role
record_chunk_failure(p_job_id text, p_error_message text)  true  service_role
release_job_atomic(p_job_id text, p_error_message text)  true  service_role
release_job_atomic(p_job_id text, p_error_message text, p_force boolean)  true  service_role
reserve_credits_atomic(p_user_id uuid, p_job_id text, p_amount numeric, p_note text)  true  service_role
reserve_provider_spend_atomic(p_job_id text, p_provider text, p_estimated_cost_usd numeric, p_daily_cap_usd numeric)  true  service_role
settle_job_atomic(p_job_id text, p_points_cap numeric, p_result_file_id text)  true  service_role
```

Capability registry (slug, enabled, unit_cost_usd, unit_price_credits): `icypeas-companies-search` true 0.00038 3; `icypeas-people-search` true 0.00038 3; `tiktok-profile` true (no cost) 6; all other rows disabled. There is no row for `professional-people-search`.

Jobs by status (raw): failed 86 (0 charged, 8 with delivered_units > 0, 3 under target); completed 54 (52 charged, 52 with delivered units, 6 under target); queued 7; running 2; refused 2.

A failed job with all rows collected (raw): status failed, delivered_units 20, target_volume_max 20, charged_credits 0, reserved_credits 69, has_result_file false, error "Cannot settle job job_quote_a5fb246b5d8095a3413f20fc68a5467c while active chunk ...".

Completed jobs under target (raw): delivered 4 of 5 charged 12 of 18; 1 of 5 charged 3; 2 of 5 charged 6; 8 of 20 charged 16 of 25.

Model turns by reason (`llm_usage`, model claude-haiku-5-5): propose_plan n=168 avg_ms 7413 p50 6341 p90 11492.2 max 18513 avg_in 17622 avg_out 458 usd 2.6762; ask_clarification n=34 avg_ms 5690 p50 3692.5 p90 10437.4; answer_question n=33 avg_ms 3464 p50 2952 p90 5364.8; refuse n=9 avg_ms 4236; suggest_alternative n=7 avg_ms 11798; search_catalog n=4 avg_ms 11851.

Completed multi-chunk jobs (raw): `job_quote_1183d761...` step 10, delivered 100 of 100, total_s 150.6, s_per_chunk 15.1; `job_quote_bd385c5f...` step 5, delivered 50 of 50, total_s 151.8, s_per_chunk 30.4. Single-chunk completed jobs: total_s between 5.6 and 9.3 for company search and 7.6 to 27.3 for TikTok video search.

Pricing settings (key `pricing`): jobMaxPointsCap 600, providerDailySpendCapUsd 0.8, llmDailySpendCapUsd 50, usdToEgp 55, markup 10, minMarginThreshold 0.2.

Spend by day (UTC, `provider_costs`): 2026-10-17 llm 32 rows 0.51659 USD; treg 13 rows 0.00730 USD (24 units). 2026-10-16 llm 97 rows 1.54239; treg 26 rows 0.09500. 2026-10-15 llm 106 rows 1.57685; treg 49 rows 0.10574. 2026-10-14 llm 13 rows 0.16253.
