# S1 live findings: the five social missions of 2026-11-01 (test account)

Task A of the brief: a READ-ONLY investigation of what ran when the owner's browser agent used the five social requests as the test account `iam.magdy+1@outlook.com` between 21:04 and 21:26 UTC (23:04 to 23:26 Cairo, UTC+2). Written against `main` = `92ad515` (#331).

Marks: **V** = I read the row or the line myself in this session. **V-R** = reported by another reader, not re-read (none are used below). **GUESS** = inference that no query or line proves. **NOT VERIFIED** = needs data this session cannot read (storage objects, the browser, the delivered files).

Safety: only `SELECT` through the read-only database tool; no write, no migration, no paid provider call, no flag change. Every query is listed at the end.

---

## 0. The answer in one paragraph

**All five missions ran the OLD pipeline** (V: `pipe_new = 0` in every mission's `mission_events`). The flags were `test` for the three social types (V: `agent_settings.redesign_flags`, written 21:02:42 UTC, before the first mission). The reason is one line of the worker: it decides whether an account is a test account with `isTestAccount({ id: mission.user_id })`, passing the **id only, never the e-mail** (V: `agent/src/runMission.ts:300` and `:418`). The classifier accepts a plus-alias e-mail (`iam.magdy+1@outlook.com`) only through the e-mail rule; by id it knows three hard-coded ids (V: `src/lib/server/testAccounts.ts`), and this user's id `b0d08be8-db61-4860-841e-fa963045557e` is not one of them (V: Q7). So `isTest` was `false`, the `test` flag was inactive, planning ran with no code-built request (so no stage has `built_by`, V: Q6), and execution took the old path. Every other symptom of the five files follows from that: the old content filters ran, "all comments" was never switched on, and the date window stayed in UTC.

---

## 1. Per mission: which path ran, and why

| Mission | Request | Created (UTC) | Flag read at start | `pipe_new` | `built_by` of every stage | Path | Why |
|---|---|---|---|---|---|---|---|
| R1 `msn_a254618740b9b9878126` | Facebook, Al Arabiya, AI, 2 posts, comments | 21:04:53 | `social_account`/`social_posts`/`social_comments` = test (V) | **0** (event 3134, 21:07:11) | none stored on `posts`, `comments` (V) | **OLD** | `isTest` false (id-only classifier) |
| R2 `msn_ee599cdbbde993073b15` | YouTube, Super Cup final, 2 videos, comments | 21:09:48 | same | **0** (3228, 21:14:18) | none stored; `videos` stage has no recipe at all (V) | **OLD** | same |
| R3 `msn_481a78e310d9e68fddce` | TikTok, Arabic AI, 2 videos, all comments | 21:15:53 | same | **0** (3273, 21:19:09) | none stored on `videos`, `comments`, `comments_replies` (V) | **OLD** | same |
| R4 `msn_3ec7bb6012a36a703180` | Instagram @alhadath, 2 posts, comments | 21:20:13 | same | **0** (3329, 21:22:36) | none stored on `posts`, `comments`, `comments_replies` (V) | **OLD** | same |
| R5 `msn_e3d679014c58168c3227` | X, 20 tweets, October 2026, with replies | 21:23:33 | same | **0** (3386, 21:25:52) | none stored on `tweets` (V) | **OLD** | same |

The two gates of the new path (V: `agent/src/redesign.ts`, `agent/src/tools.ts:98`): (1) the type's flag active for the account (`on`, or `test` AND test account), (2) every stage `engine.built_by === "code"`. Gate 2 can only be reached after gate 1, because the code-built request is written at planning only when `socialRedesignActive(ctx)` (V: `tools.ts:655`) and that needs `isTest`. Whether gate 2 would have passed once `isTest` is true is **NOT VERIFIED** (no mission has run with the flag truly active for a plus-alias account); the fix PR proves it with a replay.

Alternatives stored per stage: none (V: no stored `engine.alternatives` key in any stage of the five plans). Item 1.9 alternatives are also written only in the code-built mode.

---

## 2. Chosen tool, exact tool input, and counts per stage

Tool input = what the stored recipe and the recorded calls show (`mission_calls.params_digest`, secrets are never stored there). Counts come from the `result` and `progress` events (V).

### R1 Facebook (Al Arabiya, last 3 months, 2 posts, all comments and replies)

| Stage | Tool | Input sent (V) | Requested | Fetched | Accepted | Delivered | Removals |
|---|---|---|---|---|---|---|---|
| posts | `anyapi.facebook.user.posts` (first candidate `crawl4ai.facebook.user.posts` returned 0 rows twice at planning) | `{url: "https://www.facebook.com/AlArabiya"}`, cursor paging, **no topic, no date** | 2 | 33 (11 pages of 3) | 2 | 2 | **30 `no_term`** (old topic rule), 1 duplicate (V: event 3160) |
| comments | `scrapecreators.x.v1-facebook-post-comments` | `{url: <post link>}` then `{url: "facebook.com"}` twice | 10 planned | 0 | 0 | 0 | none (the reads failed) |
| replies | none (Facebook has no reply source the plan can feed) | n/a | n/a | n/a | n/a | n/a | n/a |

Period: the plan has no period filter on the posts stage and no date input was sent (V: stored params hold `url` only), so «آخر ٣ شهور» was not enforced by the tool or by a mark.

### R2 YouTube (Super Cup final, 2 videos, all comments)

| Stage | Tool | Input | Requested | Fetched | Delivered | Notes |
|---|---|---|---|---|---|---|
| videos | **no recipe** (`engine` is null, V). No video-listing call ran in the execution phase (V: Q20); the two videos are the planning samples carried by the model | n/a | 2 | 2 | 2 | planning searched `نهائي السوبر المصري الأهلي الزمالك`, then a Latin query, then two club channels' own searches (V) |
| comments | `crawl4ai.youtube.video.comments` | `{limit: 15/20/50, video: <id or watch link>}` | 20 planned | 17 over 3 reads (0, 8, 9; V) | 9 | one video gave 0 twice (id, then link), a spare gave 8, the planning-sample video gave 9 |

### R3 TikTok (2 Arabic videos about AI from Egypt, all comments and replies)

| Stage | Tool | Input | Requested | Fetched | Accepted | Delivered |
|---|---|---|---|---|---|---|
| videos | `anyapi.tiktok.search.videos` | `{query: "الذكاء الاصطناعي مصر"}` (country in the text, no `region`, no language, no date field) | 2 | 20 | 2 | 2 (7 excluded: 6 `filter_place`, 1 `no_term`, V: event 3297) |
| comments | `crawl4ai.tiktok.video.comments` | `{post: <id>, limit: 200}`; **`cursor_param` = null** (V) | 130 planned (65 per video) | 120 (video 1) + 11 (video 2) = 131 | 76 | 76 |
| replies | `anyapi.tiktok.comment_replies` | `{url: <video link>, commentId: <id>}`, 8 calls | 13 planned | 8 | 8 | 8 |

Plan promised 145 (130 + 13); delivered 86 (2 videos + 76 + 8). The reviewer's "73" for video 1 = 65 comments + 8 replies (V by arithmetic: 65 saved after video 1, event 3277).

### R4 Instagram (@alhadath, 2 posts, all comments and replies)

| Stage | Tool | Input | Requested | Fetched | Delivered |
|---|---|---|---|---|---|
| posts | `crawl4ai.instagram.user.posts` | `{username: "alhadath", limit: 5}` (the newest five) | 2 | 5 | 2 |
| comments | `tikhub.x.instagram-v2-fetch-post-comments` | `{code_or_url: <post link>}`, 2 calls | 8 planned | 5 (2 + 3) | 5 |
| replies | `anyapi.instagram.comment_replies` | not called | 2 planned | 0 | 0 |

Plan promised 12 (2 + 8 + 2); delivered 7. Planning sampled comments on post `DfNpR6wlzBA` (4 rows). The execution delivered posts `DfNqfB6iVOi` and `DfNpjoMibLg` (V: Q20). **The posts read at execution are not the posts the plan counted** (new posts appeared in the two minutes between planning at 21:20:34 and execution at 21:22:37).

### R5 X (20 Arabic tweets with «العاصمة الإدارية», October 2026, with replies)

| Stage | Tool | Input | Requested | Fetched | Accepted | Delivered |
|---|---|---|---|---|---|---|
| tweets | `anyapi.x.search.posts` | `{query: "\"العاصمة الإدارية\" lang:ar since:2026-10-01_00:00:00_UTC until:2026-11-01_00:00:00_UTC", queryType: "Latest", limit: 20}` (V: stored params), 2 pages | 20 | 40 | 20 | 20 |

Removals (V: event 3392): 5 duplicates, 5 `other_person` (the old namesake rule; the new raw mode removes neither a topic nor a namesake row).

---

## 3. Why the comments were not fetched

### 3.1 R1: no comments at all (cause: V for the mechanism, GUESS for the empty first read)

V: execution made exactly three comments calls (Q8). Read 1, the first post's link: HTTP 200, 0 rows. The engine then retried that parent through **a second binding: the post's link read as a bare domain**, which is `facebook.com` (V: `agent/src/engine/run.ts:164` adds a bare-domain binding when the binding's input name matches `WEBSITE_PARAM`, and `run.ts:265` lists `url` in that pattern; that rule was written for company websites). `facebook.com` is not a post: HTTP 500 «The URL (facebook.com) couldn't be parsed», twice (the first try and the one allowed retry). The parent counted as «failed» and was skipped (`run.ts:202-203`). The second post was **never read**: there is no call for it (V: Q8). GUESS: its own comment counter was 0 (the posts were minutes old, the reviewer saw 0 to 3 comments), and the rule «a parent that says it has no child is not read» (`run.ts:151`) skipped it; the "all comments" switch that would have made swaps possible was not on (3.2). The first read's empty answer for a post the platform shows with 3 comments is the source's own answer: NOT VERIFIED why (raw pages are in storage).

This is **not** pagination, not a per-parent cap, not a total cap, and not a stop rule: no comment page was ever returned.

### 3.2 R3: 73 of 171 (V)

Four causes, in order of effect:

1. **"All comments" was never switched on.** `withAllChildren` (item 1.10) runs only when `socialRedesignActive(ctx)` (V: `agent/src/tools.ts:685-687`). It did not run, so the stored comments stage has `all_children = null` (V: Q12) and the old rule applies: the stage total (130, the planner's own number) is split equally: `fair = ceil(130 / 2) = 65` per video (V: `run.ts:125`). Video 1 returned 120 rows in its one call and 65 were kept; the other 55 were paid for and kept out (V: events 3277, 3278: saved 65, then 76).
2. **The 130 was not computed from counters.** It is the model's number (per-parent cap stored as 500, V). The plan promised 145 rows without reading the videos' own counters.
3. **This tool has no way to page.** `crawl4ai.tiktok.video.comments` stores `cursor_param = null` (V: Q12): one call, `limit: 200`, returned 120 rows. Even with "all comments" on, this tool cannot reach row 121. Whether the catalog offers a pageable comments source for TikTok that the plan can use: NOT VERIFIED (item 1.8 discovers cursors from inputs; it did not run).
4. **The counter 171 probably counts replies too** (GUESS: the same observation is in `docs/HANDOFF.md` section G4: «the video's own counter counts replies»).

### 3.3 R2 and R4: shortfall from the choice of parents (V)

R2: planned 20 comments; delivered 9. One video returned 0 comments twice (V), the video with comments had 9. R4: planned 8 comments from the sampled post; the two posts actually read gave 2 and 3. Same cause as R1 and R3: **the promised count came from a sample, not from the counters of the parents that were delivered.**

---

## 4. R4: why the plan changed after it was shown

What the database proves (V):

| Time (UTC) | Event |
|---|---|
| 21:20:11 | the customer's message; the assistant message holds only `{agentMissionId}` (Q19) |
| 21:20:17 | event 3301 «بدأ الوكيل دراسة طلبك» |
| 21:20:34 to 21:20:47 | planning samples: posts (limit 5), comments of `DfNpR6wlzBA` (4 rows) |
| 21:21:16 | event 3325 `plan`: rows 12, stages 3, reserve 206, unit 16.667; the one and only `plan` event |
| 21:22:33 | event 3327 approval and hold (206 points) |

Between the plan event and the approval there is **no** edit event, no second plan event, no second `plan_ready` write that the event log can show. The stored final plan carries `minApplied: true`, `minChargePoints: 200`, `deliveredRows: 12`, `providerCostUsd: 0.00656`, ie the 200-point admin minimum was already part of the number the card read from the first moment the stored plan existed (V: Q14). The settings table holds no `mission_pricing` row, so the default minimum of 200 applied (V: Q15). The card reads its price only from that stored `plan_public.price` (V: `customerView.ts:155-176`).

**The "65 items / 50 points" display is not in the database** (not in `mission_events`, not in `messages`, not in `missions.plan` or `plan_public`). Therefore the first number and the moment it changed are **NOT VERIFIED**. Candidates from code, none proven:

- GUESS 1: the card showed an earlier state of the same mission written by a path that does not log an event: `plan_public` is rewritten by a customer edit on the plan editor (`edit_plan`, re-priced by code with `applyPlanEdits`) and by the question-options write at `tools.ts:592`. A browser click on the editor is not an event.
- GUESS 2: a client-side estimate (the calculator `missionEstimate.ts` uses a different rule and the default minimum) shown before the stored plan existed.

What is proven and is the real defect for the owner's rule: the plan's **count and price are computed from a sample and then rewritten by independent steps** (the code-built replies stage and the minimum are applied after the model's plan is first priced, `tools.ts:686-712`), so a number the customer saw can differ from the final one. Fix 3 of the PR makes the card appear only from the final stored plan and pins that with a test.

---

## 5. Why the five files have no Stage 1 mark columns

V: the mark columns are produced only for stages in `redesignStages` (V: `agent/src/redesign.ts`, passed to the engine only when non-empty, `runMission.ts:424`). With `pipe_new = 0` the set was empty. No marks, by design of the flag. It is the same single cause as section 0.

## 6. The other observed problems

| # | Observation | Finding | Mark |
|---|---|---|---|
| 5 | R1 and R4 picked the newest posts with 0 to 3 comments | R4: `limit: 5` on the account listing, newest first, then the first 2 (V). R1: the listing has no sort or topic input; the first two posts that passed the old `no_term` rule were taken (V). Selection by engagement does not exist in the code | V |
| 7 | R3 comments sheet «لغة التعليق» shows `un`, `ar`, `fa` | The source's own language code is written into the cell as it came. `customerResultColumns.ts:26` only labels the column; no value mapping exists for language cells (V by grep: no code maps a code to an Arabic word in the comments sheet) | V |
| 8 | typo «والقزار» | **Not in the repository** (grep of `src`, `agent`, `tests`, `docs`: zero) **and not in any stored plan, event or message** (Q21, Q22: zero rows). The code sentence is correct: «والقرار لك» (`src/lib/agentMission/platformNotes.ts:6`). If the reviewer saw the typo, it was written by the model or came from the transcription of the browser agent. The fix PR adds a guard test (and no code change was needed) | V (absence) |
| 9 | R5 tweet at 2026-11-01 00:14 Cairo | The recorded query ends at `until:2026-11-01_00:00:00_UTC` (V). 2026-11-01 00:14 Cairo (UTC+2: Egypt's summer time ended 2026-10-29) is 2026-10-31 22:14 UTC, inside a UTC boundary and outside a Cairo October. The boundary is UTC, not Cairo | V |
| 6 | R4 plan card 65 items / 50 points then 12 / 200 | section 4 | NOT VERIFIED |

---

## 7. Proposal for owner decision (NOT implemented): topic namesakes and "newest or most engaged"

No content filtering is implemented in the fix PR for these.

**R2 (the volleyball «masters» Super Cup instead of the football final).** Cause: the topic words «السوبر المصري» name both a football and a volleyball event; a search engine returns both. Proposal for the request builder (item 1.6 `understood` record): carry a `sport`/`topic_kind` field. The understood record is built from the words of the request («نهائي»، «الأهلي والزمالك» name football clubs), so the builder adds the sport word to the search text («كرة القدم») and, for a platform that allows it, the clubs' own channels as `account`. Stage 2 question card (item 2.3) when the record cannot decide: «أي رياضة تقصد؟» with the options «كرة القدم»، «كرة اليد»، «كرة السلة»، «كرة الطائرة»، «شيء آخر», only when the topic words are known to be shared (a small code list of such names, not a model guess). The plan card then states the sport it searched.

**R1 and R4 (the newest posts, 0 to 3 comments).** Cause: the account listing sorts by date and the count rule takes the first N. Proposal: the Stage 2 question card «أي المنشورات تريد؟» with the options «الأحدث»، «الأكثر تفاعلًا»، «الأكثر تعليقًا», shown when the request asks for comments and gives no preference. «الأكثر تعليقًا» is a code rule on the listing's own counters: read a larger page of the listing (priced by code into the reserve), keep the N parents with the largest comment counters, and the plan's promised count is the sum of THOSE counters. It never drops a delivered row; it only chooses the parents. When the listing is a single fixed page (the case of `limit: 5`) the plan card says how many posts the choice was made among. Default when the customer does not answer: the newest, as today, with the card stating the real comment counters of the chosen posts.

---

## 8. Every query run (read-only, `SELECT`)

Q1 columns of `missions`, `mission_events`, `mission_calls`, `agent_settings`, `profiles`, `credit_ledger` (information_schema). Q2 missions of the test account in 20:50 to 21:40 UTC on 2026-11-01. Q3 `agent_settings` key `redesign_flags`. Q4 non-progress events of R1 and R2. Q5 non-progress, non-telemetry events of R3, R4, R5. Q6 each stage's `engine` keys and `built_by` of the five plans. Q7 `profiles` of the two test e-mails and the hard-coded-id check. Q8 all `mission_calls` of R1. Q9 progress events of R1. Q10 execution `mission_calls` of R3. Q11 progress events of R3. Q12 stage fields (`planned_rows`, `per_parent_rows`, `all_children`, cursor, params, binding) of the five plans. Q13 events 3301 to 3340 of R4. Q14 R4's stored `plan.price`, `plan_public.price`, `plan_public.edit`. Q15 latest 12 `agent_settings` rows. Q16 R4 events of kinds question, answer, plan, edit, system. Q17 count of R4's non-call non-progress events. Q18 columns of `messages`. Q19 `messages` of the account in R4's window. Q20 `mission_calls` of R2, R4, R5. Q21 search of «والقزار» in `plan`, `plan_public`, `summary_ar`. Q22 search of «القزار» in `mission_events`, `messages`, `missions`.

Not verified (needs data the session cannot read): the raw pages (storage), the delivered files and the browser display, the platform's real counters, the reviewer's count of 171 and whether it includes replies, and the first number of R4's card.

---

## 9. Task B: what the fix PR changed (behind the same flags)

Every change below acts only for a mission of the new pipeline (a flag active for the account, in the redesigned mode), except fix 1, which is what makes the flag reach the right account. With every flag off the old output is unchanged (`tests/flags-off-byte-identical.test.ts` and the whole suite pin it). Each item is two commits: the failing test, then the change.

| # | Item | Red test | Change |
|---|---|---|---|
| 1 | The gate | `tests/s1-test-account-gate.test.ts` (the replay reproduces `built_by` undefined and `pipe_new = 0` for the plus-alias account) | `agent/src/redesign.ts` `accountIsTest(store, userId)` reads the account's e-mail through a new read-only `store.readUserEmail` (a `SELECT email FROM profiles`) and asks the classifier with id AND e-mail; an unreadable e-mail leaves the id rule, so a failure never switches the new pipeline on. A model-built recipe still never runs raw (`tests/redesign-stages.test.ts`, unchanged). The hard-coded id list was NOT extended. |
| 0 | COMPLETE COUNT (owner's top rule) | `tests/complete-count.test.ts` (18 tests: low-comment, high-comment, multi-page, uneven, drift, replacement parents, no-next-page world, a pin the listing lost) | `src/lib/agentMission/completeCount.ts`: the promised count of comments is computed by code from the real counters of the parents of the stage's own listing (sampled before the card), capped by the request per parent and by what one call of a source with no next page gives; when the first parents cannot supply the number asked, the other candidates of the same listing with larger counters take their place; the chosen parents are pinned (`parent_pins`), and the engine (`alignPinnedParents`) reads exactly them, so a post published between planning and execution cannot change the promise; each parent is read to its counter across pages (`all_children`, capped at the request per parent, no equal share); the card states the real number and any shortfall BEFORE approval. Wired in `agent/src/tools.ts` in place of the «all»-only estimate (`withAllChildren` and its tests are kept). |
| 3 | The card's price | `tests/final-price-card.test.ts` | `src/lib/agentMission/finalPrice.ts` `sealFinalPrice`: the card is stored once with the one pricing function's number over the final stages (admin minimum included, the settings the worker read for the mission), the same number approval recomputes; a drift is recorded as an internal event (`price_sealed`, counts only). |
| 4 | Language labels | `tests/language-labels.test.ts` | `languageLabel.ts`: codes become العربية / غير محددة / لغة أخرى in the cells of a new-pipeline file (`workbook.ts`); the old pipeline's cells are unchanged. |
| 5 | Cairo time | `tests/cairo-boundaries.test.ts` | `cairoTime.ts` (the zone's own rules, summer time included): the tool input writes Cairo day boundaries (operators `since:2026-09-30_21:00:00_UTC`, ISO and unix fields; a day-only source gets the UTC days that cover the range) and the mark «ضمن الفترة المطلوبة» reads Cairo days. Two existing assertions of `tests/tool-input-builder.test.ts` pinned UTC midnight and are marked `CHANGED`. |
| 6 | The typo | `tests/arabic-typo-guard.test.ts` (green from the start) | **No code line changed**: «والقزار» exists nowhere (section 6, item 8). The guard fails if it is ever written. |

### Added after the owner's review of the first PR head (same PR, red test first, then green)

| # | Item | Red test | Change |
|---|---|---|---|
| A | Pageable source first | `tests/pageable-source-first.test.ts` (5 tests: A has no next page and B pages: B is chosen, 182 promised and delivered; no pageable source: the shortfall is stated; an alternative that cannot page is not chosen; nothing is switched when A suffices) | `completeCount.ts` `promotePageable`: when the recipe's source cannot page far enough, the first alternative that pages and reads the same parents becomes the recipe (the old source stays as the next tool) BEFORE a shortfall is stated. `agent/src/engine/spec.ts`: child stages now store alternatives (other sampled sources of the same job, each with its own parent input). |
| B | Counters that include replies | `tests/counter-includes-replies.test.ts` (5 tests, a TikTok-like world: 100 = 70 + 30, 60 = 42 + 18) | `completeCount.ts`: the child source's own sampled page shows whether comments + their reply counters add up to the parent's counter (`basisOf` in `tools.ts`); when they do, the top-level promise uses the measured share (112, not 160); with a replies stage the plan promises the total of comments and replies (160 = 112 + 48) and the card states both parts; with only comments it says the counter includes replies. No evidence: the counter is used as it is. The replies stage is now created before the complete-count step so both share one basis. |
| C | Facebook comments | `tests/facebook-comments-reread.test.ts` (5 tests reproducing R1: first read 200 with 0 rows) | `agent/src/engine/run.ts`: a social platform's bare domain is never an input for a parent (redesigned stages only); a parent that gave nothing is read once more with its own post URL, then by the next suitable comments tool of the stage; every selected parent is read. |

A test of the date-dependent pinned digests (`tests/flags-off-byte-identical.test.ts`) failed on plain `origin/main` once the Cairo day changed (2026-11-02 00:21 Cairo); its clock is now pinned to 2026-11-01 (marked `CHANGED`), and the pinned digests reproduce unchanged.

### What is NOT proven by these tests (limits stated honestly)

- **Counters that include replies.** Handled by item B above, but the share of top-level comments is MEASURED on one sampled parent, so it is an estimate for the other parents: promised = delivered is proven in worlds where the share is uniform, not live. When the sample shows no evidence (no reply counters on the comment rows), the counter is used as it is, as before. A shortfall is still stated by the recorded counts at delivery (`finalize.ts` text, untouched).
- **The R3 source cannot page.** `crawl4ai.tiktok.video.comments` has no cursor. A pageable alternative is chosen (item A) only when the planner SAMPLED one (its mapping is proven on a real page); the code never invents a mapping for an unsampled source. When none was sampled the plan states the real limit before approval.
- **The R1 bare-domain re-read** is removed for redesigned stages (item C); the old pipeline keeps it (flags off = old behaviour). Why the second R1 post was never called is still a GUESS (its counter was probably 0, and a counter of 0 is never read); item C reads every parent whose counter is above 0.
- **R4's first card** (65 items / 50 points) is NOT VERIFIED (section 4); fix 3 removes the only paths by which a stored card could disagree with approval, it does not prove what the browser showed.
- **Not run live.** No paid provider call and no live mission was run by this session. The planning wiring in `agent/src/tools.ts` (candidates, the page cap and the counter basis read from the measured pages) and the plan-time derivation of child alternatives in `spec.ts` are covered by the type checker and by the pure and engine tests, not by an end-to-end replay.

---

# Live run of 2026-11-02 after #332 (merge `77e837d`): the TikTok comments-and-replies mission `msn_48f6c7c80eb7068f2a38`

Task A of the brief: a READ-ONLY investigation of one mission, the test account `iam.magdy+1@outlook.com`, request «هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود.», created 2026-11-02 05:42:54 UTC (07:42 Cairo), completed 05:48:41 UTC. Written against `main` = `77e837d`.

Marks: **V** = I read the row or the line myself in this session. **V-R** = reported by someone else or by an earlier section of this file, not re-read now. **GUESS** = inference that no query or line proves. **NOT VERIFIED** = needs data this session cannot read (the delivered file, storage objects, the platform's real counters, the browser).

Safety: only `SELECT` through the read-only database tool; no write, no migration, no paid provider call in Task A. Every query is listed at the end of this section.

## L0. The answer in six lines

1. **The planner ran the new code; execution did not.** Stages 1 and 2 were built by code (`engine.built_by = "code"`, `gaps`, `parent_pins`, `all_children` are stored, V: Q29, Q30) and the plan card carried the language gap line (V: Q28). Execution recorded **`pipe_new = 0`** (event 3431, V: Q25), so the OLD engine and the OLD workbook built the file. That is why the file has no language labels, no comment-language column, no period mark column (V by code: `agent/src/workbook.ts:367` labels only when `newPipeline`; the mark columns only for `redesignStages`, `runMission.ts:430`).
2. **Why execution fell back (V).** The ordering gate needs EVERY stage to have `engine.built_by === "code"` (`agent/src/redesign.ts:17`). Stage 3, the replies stage, is built by `withRepliesStages` (`src/lib/agentMission/replies.ts:274-279`), which writes an `engine` with no `built_by`. Stored: stage 3 `built_by` = null (V: Q29). So `redesignStagesOf` returned an empty set. The #332 account gate (`accountIsTest`) did work (planning was in the redesigned mode: flags `test`, V: Q32); the failure is the second gate, and every test of #332 used worlds where the replies stage did not exist or was not part of the gate.
3. **Why reading stopped at 20 per video (V for the mechanism, GUESS for the tool's real limit).** The stored recipe is `crawl4ai.tiktok.video.comments` with `params {limit: 20}`, `cursor_param = null`, `per_parent_rows = 20` (V: Q30). Execution made exactly ONE call per video with `{post: <id>, limit: 20}` (V: Q26, calls 5 and 6): rows 20 and 19. The `limit: 20` was the planner's own sample input (planning call 3 asked `limit: 20` and got 20 rows, V: Q26), and the plan's page cap (`pageCapOf`, `agent/src/tools.ts:739`) was MEASURED on that same call: «rows of the sampled page (20) < the parent's counter, so one call gives 20». The cap is circular: it measures the size the planner asked for. An earlier live run asked this tool for `limit: 200` and got 120 rows (V-R: section 3.2 of this file, mission R3), so 20 is not the tool's limit. Whether any page beyond the first exists is Task B.
4. **Where 280 comes from (V by arithmetic on stored numbers).** The replies stage was priced and counted BEFORE the complete-count step, from the model's own comments number: stored `measured_cost_per_row_usd` of stage 3 = 0.00064286 = 0.0009 USD x calls / 280, so calls = 200 = comments x 0.25 calls per comment, so the comments number at that moment was **800**; 800 x 0.35 (the sample's mean replies per comment: counters `[0,0,1,2,0,0,0,0,1,0,0,0,0,0,1,2,0,0,0,0]` = 7 over 20) = **280**. The complete-count step then cut the comments to 40 (2 x 20) and **did not re-derive the replies**: `withCompleteCount` (`completeCount.ts:164-168`) rewrites the replies stage only when the counter's reply share was measured (`share !== null`), and here it was null. So the replies promise is the sample's mean applied to a number of comments that no longer existed. With the real 40 comments it would have been about 14. The sample itself supports only 0.35 replies per comment, never 7.
5. **Why the completion text blamed «fewer comments» (V).** `runMission.ts:581` picks the short stage among stages with `s.replies_of === undefined`: replies stages are never the short stage (a rule of the replies PR: «fewer replies than estimated is never a shortfall»). The comments stage was 1 short (39 of 40, video 2 had 19 top-level comments), so the text says «بعض الفيديوهات عليها تعليقات أقل من العدد المطلوب لكل فيديو» (`finalize.ts:67-72`). The true gap was 322 promised vs 42 delivered, 279 of it replies that were promised and not delivered; the text states none of that.
6. **The delivered videos are not the planned ones (V).** The plan pinned `7701492215327034631` and `7702838399006362901` (V: Q30). Execution ran a NEW video search (call 4) and read `7701492215327034631` and `7702837860671507720` (V: Q26). The pins are honoured only by the redesigned engine (`alignPinnedParents`); the old engine ignored them.

## L1. Per stage: the path, the tool, the inputs, the rows

| Stage | Built by (V: Q29) | Tool (V: Q30) | Alternatives stored (V: Q29) | Planned | Path at execution |
|---|---|---|---|---|---|
| 1 videos | code | `tikhub.tiktok.search.videos` `{count: 2, region: "EG", keyword: "الذكاء الاصطناعي", sort_type: 2}`, `cursor_param = "offset"`, gap `language: no_field` | 0 | 2 | OLD (`pipe_new = 0`) |
| 2 comments | code | `crawl4ai.tiktok.video.comments` `{limit: 20}` + binding `post <- id`, **`cursor_param = null`**, `per_parent_rows = 20`, `all_children = true`, `parent_pins` = 2 ids | **0** | 40 | OLD |
| 3 replies | **null** | `anyapi.tiktok.comment_replies` `{}` + binding `commentId <- id`, `url <- link (grandparent)`, `cursor_param = "cursor"`, `per_parent_rows = 10`, replies_per_comment_expected 0.35 | 0 | **280** | OLD |

Why no alternatives: they are stored only for tools the planner SAMPLED (`agent/src/engine/spec.ts` child alternatives, #332 item A). The planner sampled one comments tool (`crawl4ai`, call 3) and no pageable TikTok comments tool. The catalog has pageable ones (V: local catalog `data/treg/treg_catalog_sellable.json`): `tikhub.tiktok.video.comments` and `tikhub.x.tiktok-app-v3-fetch-video-comments` (inputs `aweme_id`, `cursor`, `count`, 0.001), `anyapi.tiktok.video.comments` (`url`, `cursor`, 0.002), `scrapecreators.tiktok.video.comments` (`url`, `cursor`, 0.00188 per call), `justoneapi.tiktok.video.comments` (`awemeId`, `cursor`, 0.01476). The planner never sampled them; nothing in the code makes it (the planner chooses what to sample).

### Calls (V: Q26; secrets are never stored in `params_digest`)

| # | Phase | Tool | Input sent | HTTP | Rows | Cost USD |
|---|---|---|---|---|---|---|
| 1 | planning | `crawl4ai.tiktok.search.videos` | `{limit: 20, query: "الذكاء الاصطناعي مصر"}` | 200 | 11 | 0.000500 |
| 2 | planning | `tikhub.tiktok.search.videos` | `{count: 20, region: "EG", keyword, sort_type: 2}` | 200 | 10 | 0.001000 |
| 3 | planning | `crawl4ai.tiktok.video.comments` | `{post: "7673307869135031574", limit: 20}` | 200 | 20 | 0.000500 |
| 4 | execution | `tikhub.tiktok.search.videos` | `{count: 2, region: "EG", keyword, sort_type: 2}` | 200 | 10 | 0.001000 |
| 5 | execution | `crawl4ai.tiktok.video.comments` | `{post: "7701492215327034631", limit: 20}` | 200 | 20 | 0.000500 |
| 6 | execution | `crawl4ai.tiktok.video.comments` | `{post: "7702837860671507720", limit: 20}` | 200 | 19 | 0.000500 |
| 7 | execution | `anyapi.tiktok.comment_replies` | `{url: <video link>, commentId: "7702842256216376085"}` | 200 | 1 | 0.000600 |

Cursor and next-page values returned by the source: **not stored** (`mission_calls` keeps a digest of the input and the row count; the raw pages are in storage: NOT VERIFIED). There is no cursor in any recorded input, which is consistent with `cursor_param = null`. Replies were read for ONE comment only (call 7): the engine read replies for the comments that carried a reply counter; the sampled counters of the 20 comments of the planning video show 5 comments with replies (V: Q30). The comment ids of the executed videos were not sampled; how many of the 39 delivered comments carried a reply counter is NOT VERIFIED (storage).

Totals (V: Q27, Q25): promised 322 (2 + 40 + 280), price up to 1,141 points, reserve 1,312; delivered 42 (2 videos + 39 comments + 1 reply), charged 149; provider cost 0.0046 USD (planning 0.0020, execution 0.0026); the ledger rows were not read (money is out of scope here).

## L2. The promise, step by step

| Step | Number | Evidence |
|---|---|---|
| Model plan, comments stage | 800 (derived) | stage 3's stored cost per row (above); the model's own stored value was overwritten and no event keeps it: **GUESS** for the exact origin of 800 (a model number, such as 400 per video), V for its being 800 at the replies step |
| `withRepliesStages`, replies | ceil(800 x 0.35) = 280 | V: `replies.ts:265` calling `plannedRepliesFor` (`replies.ts:234`) |
| `withCompleteCount`, comments | 2 x min(counter, page cap 20) = 40, pinned, `all_children = true` | V: stored values; `completeCount.ts:86` |
| `withCompleteCount`, replies | unchanged: 280 | `repliesPlanned` is set only when `share !== null` (`completeCount.ts:157-168`); the basis check (`tools.ts:724-736`) needs the sampled page to add up to the parent's counter within 10%, a page of 20 against a counter of about 168 cannot: share = null (V by code; the counter value is NOT VERIFIED here) |
| Card text | «٤٠ تعليقًا بحسب العدّاد الفعلي» | V: Q28 note 3 is the `share === null` sentence. The card did not state the 280 replies as a number of its own; the price carried them (price `deliveredRows` 322) |

Which counters the promise used: the comments' 40 are `min(counter, 20)` per video: **the counter of video 1 (168 by the reviewer, NOT VERIFIED here) was cut to 20 by the page cap, which is the planner's own `limit: 20`** (see L0.3). The reviewer's 20 for video 2 is below the cap, so that video was complete (19 comments + 1 reply = 20).

## L3. What this means for the fix (inputs for Task C)

Proven by this section alone:
- **F-1** the replies stage must carry `built_by: "code"` (it is built by code) so the gate passes; a test must run the replay with a replies stage in the plan (the #332 gate tests had none).
- **F-2** the replies promise must be derived from the final comments count (and from the sample's evidence), after the complete-count step, never from the model's pre-count number; it must be the measured mean x the final comments, or nothing when the sample is silent.
- **F-3** the page cap must not be measured on a call whose size the planner chose; the real next-page mechanism has to be known per tool (Task B).
- **F-4** the completion text must name the stage that fell short by its rows including the replies, with the true reason.
- **F-5** the executed videos must be the pinned ones, or the plan must re-promise.

Not yet knowable without Task B: which tool pages and how, whether the counter includes replies, the real rows per call and per-call cost.

## L4. Task B status

**Skipped by the owner's instruction: no TREG key was obtained, requested or used; no paid call was made (0 calls, 0.00 USD).** No live fixtures exist for this run. The tests of Task C use what the catalog schemas state (`pagination`, `inputs`, `list_path`, `cursor_path`, `item_fields`, and the endpoint's own words: `crawl4ai.tiktok.video.comments`, «`limit` how many comments (default 50, at most 500; ...)») and the live numbers of the mission above (counters 168 and 20, the replies sample of 7 over 20 comments, the model's 800).

## L5. Every query run for this section (read-only `SELECT`)

Q23 columns of `missions`, `mission_events`, `mission_calls` (information_schema; a first query used a column that does not exist and failed). Q24 the mission of the test account created after 2026-11-02 05:00 UTC (one row: `msn_48f6c7c80eb7068f2a38`; one earlier attempt failed on a missing column). Q25 every non-progress event of the mission (one earlier attempt failed on a missing column). Q26 every `mission_calls` row of the mission. Q27 the mission row: status, points, costs, summary, error, files, request text. Q28 the plan without its stages (price, notes, assumptions). Q29 per stage: keys, engine keys, `built_by`, number of alternatives. Q30 per stage: tool, planned and expected rows, per-parent rows, `all_children`, pins, cursor, params, binding, gaps, replies fields, measured by. Q31 per stage: measured cost per row, per-parent rows, expected and planned rows, replies call price. Q32 `agent_settings` key `redesign_flags` (all three social flags `test`, written 2026-11-01 21:02:42 UTC).

Not verified: the delivered file (language cell `un`, the missing columns, the 168 and 20 counters), the raw pages and cursors in storage, the counters of the executed videos' comments, the exact model value before the replies step, the ledger.

## L6. Task C: the six fixes (one PR, behind the same flags, red test first, then green)

All six act only for a mission of the new pipeline (a flag active for the account, in the redesigned mode), except item 1's mark, which is inert unless a flag is on. Nothing in `price.ts`, `gateway.ts`, `jobPointsCap.ts`, `src/functions/**`, `supabase/**`, the ledger or `finalize.ts` changed; the only edit near money is the price INPUT of a stage (its cost per row), priced by the one pricing function as before.

| # | Fix | Test file | Code |
|---|---|---|---|
| 1 | The replies stage carries `built_by: "code"`, so a mission with replies passes the gate | `tests/s2-replies-stage-gate.test.ts` | `src/lib/agentMission/replies.ts` |
| 2 | After the complete-count step the replies are derived again from the sample's measured replies per comment over the FINAL comments (live: 280 became 14); the editor's own rule (`repliesEstimateFor`) | `tests/s2-replies-promise-final.test.ts` | `src/lib/agentMission/completeCount.ts` |
| 3 | The page cap is the tool's stated maximum from its schema (crawl4ai: 500), never the planner's sample size; the call asks for what the promise needs up to it | `tests/s2-real-page-cap.test.ts` | `src/lib/agentMission/pageLimit.ts`, `completeCount.ts`, `agent/src/tools.ts` |
| 4 | A catalog comments tool with a cursor is preferred (stored as the stage's tool, the replaced tool kept as the next tool), mapped by the code-written comment mapping, priced by its own call price; read page after page to the end | `tests/s2-comments-paging.test.ts` | `src/lib/agentMission/pageableComments.ts`, `completeCount.ts`, `agent/src/tools.ts`, `agent/src/engine/spec.ts` (alternatives carry their cost per row) |
| 5 | The completion text states the true reason for fewer replies, from the replies stage's recorded stop; the status rule is unchanged | `tests/s2-completion-text.test.ts` | `agent/src/repliesShortfall.ts`, `agent/src/runMission.ts` (text only) |
| 6 | The pinned videos' rows are stored on the plan and ingested at execution, with no new search | `tests/s2-pinned-videos.test.ts` | `completeCount.ts`, `plan.ts`, `agent/src/engine/run.ts` |
| all | The live case replayed end to end with the six fixes together | `tests/s2-live-replay.test.ts` | |

Changed existing test: `tests/pageable-source-first.test.ts`, one test, marked `CHANGED`: it pinned «when the first source can page far enough, it stays»; the owner's instruction (item 4) is that a pageable tool is preferred, so it now pins that, and a second test pins «no pageable tool exists: the first stays».

### Limits stated honestly
- **No live proof.** No paid call and no live mission was run. The pageable tool's page shape is the shape its catalog schema describes (`data.comments`, `data.cursor`); the code-written mapping reads that shape; a tool whose schema does not state an id and a text for its items (e.g. `scrapecreators.tiktok.video.comments` lists only part of its item fields) is not used. If a real page differs, the first parent that gives nothing is read again by the replaced tool (the existing retry through the stage's next tool, covered by a test).
- **Cost of preferring a cursor tool.** `tikhub.tiktok.video.comments` is 0.001 USD a page of 20 against 0.0005 for the whole 500-row call of crawl4ai: reading 188 comments is about 10 calls (0.01 USD) instead of 2 (0.001). The plan prices it by code from the tool that will be called; the reserve and the caps are unchanged.
- **crawl4ai's practical limit.** Its own description says TikTok shows a visitor «about 350 to 450 per post», below the 500 maximum: a video with more is promised up to 500 and may deliver fewer; the completion text then states a shortfall (the source gave no more).
- **The replies number is an estimate** (the sample's mean over the final comments). The new sentence says so when the source gives fewer.
- **Pins and edits.** The pinned rows are used only while the parent stage's planned count still equals the number of pinned rows; a customer edit of that count falls back to the search as before.
- **Not verified:** the real page size of `anyapi.tiktok.comment_replies`, whether the counter of the platform includes replies for a video with a measured share (the share path of #332 is unchanged), the Heroku worker running this code.
