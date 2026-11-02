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

---

# Live run of 2026-11-02 09:25 Cairo (S3): `msn_a6dacebce7e7b7432aa1`, the owner's rule «all means all, the AI never judges»

Same test account and the exact request «هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود.» after #333 (merge `2526491`). Read-only SELECTs only (Q33 the account's missions after 06:30 UTC, Q34 non-progress events, Q35 per-stage fields, Q36 calls, Q37 plan notes, Q38 per-stage columns and measuring calls). Marks: V = read in this session; GUESS = inference.

## S3.1 What the database says (V)

| Question | Answer |
|---|---|
| `pipe_new` | **0** (event 3496, 07:27:59 UTC). The OLD pipeline ran the mission. |
| `built_by` per stage | stage 1 (videos, `tikhub.tiktok.search.videos`): **code**. Stage 2 (comments, `crawl4ai.tiktok.video.comments`): **no engine at all** (`has_engine = false`), so the stage had no recipe the engine could run. No replies stage. |
| Fallback reason | The gate needs every stage to have a recipe built by code; stage 2 had none, so the model carried out the mission (execution phase: 11,716 model output tokens, two comment calls `{post: <link>, limit: 500}` written by the model, no video call: the videos came from the planning sample). Why the recipe could not be proven: the code drops a stage's recipe silently when the model's mapping does not reproduce every row of the sampled page or no parent column matches the sampled input (`agent/src/engine/spec.ts`); the stored stage keeps neither the model's mapping nor the reason: **GUESS** for which of the two it was. |
| Why «استُبعد ٢ لأنه لا يخص طلبك» | Old-pipeline rule on the videos stage: the model's `relevance` (topic terms, `exclude_terms: CapCut`, `review: true`) ran; event 3501: 7 found, 2 duplicates, 5 examined, **2 excluded as `other_person`** (rule `full_name`). In the redesigned mode this rule does not run (raw mode, `ingest.ts`), but the plan could not even be made without it: `plan.ts` demanded a `relevance` rule for every text-search stage and refused a plan whose sample did not match it. |
| Why no replies | The replies stage is built only under a comments stage that has a recipe (`isCommentsStage`), and, even then, only when the sampled comments carry a reply counter above 0. Stage 2 had no recipe. |
| Why «من ٨٠٠ تعليق» and 802 | The model's own comments number (800, per video 500) was kept: the real-counters step (`withCompleteCount`) runs only on a stage with a recipe in the redesigned mode. Delivered 163 (2 + 161), charged 41, reserved 218. |

## S3.2 The fixes (one PR, behind the same flags, red test first)

1. **No relevance in the new pipeline** (`agent/src/tools.ts`, `plan.ts`): a social request in the redesigned mode drops the model's `relevance` and `yield_from`, and a text-search stage is accepted without them (`PlanLookup.noRelevance`). Duplicates by id remain the only removal. Test: `tests/s3-all-comments-e2e.test.ts` (videos whose captions carry none of the topic words are delivered).
2. **The replies stage is always in the plan when the request says «ردود»** (`replies.ts`: `wantsReplies`, `requested`, `all`): a sample with no counter or no reply no longer drops it; the estimate is the stated unknown (2 a comment) and follows the final comments; with «all» each comment is read up to the largest number per comment the job allows (50). A platform with no reply source still cannot have it. Test: `tests/s3-replies-requested.test.ts`.
3. **The comments stage always gets a recipe** (`pageableComments.ts` `commentsEngineByCode`, wired in `tools.ts`): when the model's mapping gives none, the recipe is written by code from the tool's own schema (the input that takes the video, the cursor, the code-written comment-page mapping) and PROVEN on the page the planner sampled before it is kept. With it the real-counters step and the replies step run, and the mission passes the gate. Tests: `tests/s3-code-built-comments.test.ts`, the end-to-end test.
4. **End to end, the exact request** (`tests/s3-all-comments-e2e.test.ts`, red first): `pipe_new = 1`, every stage `built_by: code`, replies stage present, no `chk_ex_*` exclusion, the two off-topic videos delivered, comments promised = the pinned videos' counters (132 + 66 = 198: 180 comments and 18 replies, not 800) and delivered = promised.

Limits: a world of fakes (the catalog's schemas, not a live source); if no counter is known for any candidate video the plan still keeps the model's number and says so (unchanged from #333); a comments stage whose tool's required inputs are not the video's still has no recipe.

---

# Live test of 2026-11-02 10:26 Cairo after #334 (S4): `msn_7a35b44e35e6f3f1b8e9`

Read-only SELECTs (Q39 the account's missions after 07:45 UTC, Q40 its calls, Q41 per-stage fields, Q42 non-progress events, Q43 plan notes, Q44 progress events). The new pipeline ran end to end (`pipe_new = 1`, every stage `built_by: code`); delivered 69 (2 videos, 67 comments, 0 replies), charged 203.

| Question | Cause (V unless marked) |
|---|---|
| Both videos from Iraq | The planner's first search (`crawl4ai`) timed out (503); it then sampled only `anyapi.tiktok.search.videos`, which has NO country input (stage gap `country: no_field`, card line «لا يسمح بتحديد البلد»). The catalog has searches of the same capability with a country input (`tikhub.tiktok.search.videos`: `region`); the rule D7 («a tool that can express the condition wins, even if dearer») existed only in `docs/REDESIGN.md`: no code compared tools by the customer's country, so it depended on the model sampling the right one (the earlier 09:25 mission did, this one did not). |
| 0 replies (20 planned) | No call of the replies tool was made at all (the call list holds only the comments calls, no reply call; no progress event of stage 3). The engine reads a comment's replies only when the comment's own counter says it has some (`ownChildCount`), and shares the replies by those counters. The plan's estimate (20) came from the PLANNING sample, read through `crawl4ai` (counters on 20 of 100 comments); the delivered comments were read through the promoted tool `anyapi.tiktok.video.comments` (#333's preference for a cursor). **GUESS:** every delivered comment carried the counter 0 (its stored value is in storage, not readable by SQL), so no comment was eligible. A source's counter is not the truth; the replies tool is. |
| Comments sheet without the language | The model's comments columns had no language column and the `anyapi` comments page has no language field (its item fields: author, createdUtc, id, likes, replies, text); the new-pipeline language labels (#332) apply only to a language column that exists. |

## S4 fixes (one PR, red test first, same flags): `tests/s4-live-fixes.test.ts` with the exact request
1. **D7 in code** (`src/lib/agentMission/conditionTools.ts`, `agent/src/tools.ts`): a plan whose search tool has no country input while the customer named a country is sent back (at most twice) naming the catalog's tools that take it (cheapest first, price not a reason); the planner samples one with Egypt and proposes again. Test: the first plan on `anyapi` is refused naming `tikhub.tiktok.search.videos`/`region`; the accepted plan's tool has `region = EG`.
2. **Replies for every comment** (`engine/run.ts`, `replies.ts`, `plan.ts` `replies_read_all`): when the request asked for replies and no delivered comment says it has any, every comment is read for its replies (each up to the cap per comment; the stage still stops at the approved number); priced as at least one call a comment. Test: a comments page whose counter is 0 everywhere, 9 replies exist: 90 reply calls, 9 delivered.
3. **The comment language** (`workbook.ts`, `languageLabel.ts` `languageOfTextAr`, `tools.ts`): a code-built comments (and replies) sheet has «لغة التعليق»; the source's code is labelled in Arabic (a source that says it cannot tell keeps «غير محددة»), else (an empty cell) the text's script decides by code: العربية / لغة أخرى / غير محددة. A mark; nothing is removed.

Limits: the D7 send-back depends on the planner sampling the named tool after the refusal (bounded; after two refusals the plan stands and says it cannot name the country, as before); the blind replies reading costs one call (0.0009 USD) per comment, priced in the plan; the script-based language is a code rule, not a model, and is the fallback only.

---

# Live test of 2026-11-02 11:33 Cairo after #335 (S5): the promise rule and the default choice of videos

Owner report (the stored mission was not re-read for this section): the videos' counters were 5 and 1 (6 in all); the plan promised 308 (300 replies estimated on top); 5 were delivered; the card read «تم تسليم ٥ عناصر من ٣٠٨»; the price followed the promise and kept jumping. Cause (V by code): since #333 the replies stage was estimated from the sample's mean replies per comment over the final COMMENTS and added on top of the counters (`completeCount.ts`, S2 item 2 and S3 item 2: 300 replies for a video pair whose counters were 6), and the videos were the first of the search's newest-first page.

**Owner decisions (2026-11-02), implemented behind the same flags (red test first: `tests/s5-promise-and-engaged.test.ts`, the exact request):**
1. **The promise.** A video's comment counter counts comments AND replies together. With «all comments and replies» the promise for comments + replies on the chosen videos is the sum of their counters, never more; no reply estimate is added on top. The sample's measured replies per comment (a silent sample: a stated quarter, `AGENT_REPLIES_UNKNOWN_SHARE`) only SPLITS that total between the two stages. For comments only, never more than the counters. The price is computed from the promise (2 videos + the counters). Both stages may be read up to the total (`promise_total`, applied by `withPromiseCaps` for the engine and the file), so a wrong split costs neither a comment nor a reply; the delivery is told against the total (`reportedPlan`), so the card, the notice and the completion text never show a number above the counters. A customer edit clears `promise_total` (the customer's numbers rule).
2. **The default choice of videos for a comments request is the most engaged**, unless the customer asks for the newest or gives a date (`engaged.ts`). The search tool's sort field when it has the «most liked» order (the closest the search tools give to «most engaged»: `sortOptionsOf` reads it from the enumeration or the note, e.g. `sort_type` 1): a plan sampled in another explicit order (the live test sampled the newest) is sent back, at most twice, to sample in that order, and the stage's request carries it. Then, among the results, the highest comment counters are taken first (`mostEngaged` in `withCompleteCount`): an ORDER, nothing is removed for its content.

**CHANGED tests (marked in the files):** `tests/s2-replies-promise-final.test.ts`, `tests/s2-live-replay.test.ts` and one assertion of `tests/s3-replies-requested.test.ts` pinned «the replies estimated on top of the counters»; they now pin comments + replies = the counters. The S4 world samples the search in the most-liked order from the start.

Limits: the highest counters are taken among the results of the one sampled page (a larger page is the planner's choice); «most liked» is a proxy for «most commented» where a tool offers no other order; with the sample silent, the split of the total (a quarter replies) is a stated default, not a measurement; the total is capped by the counters even when the source would give more.

---

# Live test of 2026-11-02 ~12:23 Cairo after #336 (S6): `msn_6066498b5da3dd512595`

Read-only SELECTs (Q45 the account's missions of the day with price fields and stages, Q46 this mission's calls, Q47 its events, Q48 its plan price, Q49 its stages). New pipeline (`pipe_new = 1`, every stage `built_by: code`); delivered 239 (2 videos, 150 comments, 87 replies), charged 976; reserve 2,319. The pages are in storage (not readable by SQL): the fixture `tests/fixtures/live/msn_6066498b-live.json` keeps the stored STRUCTURE (rows per call, the cursor chain, the duplicates the saves show), not the page text.

## S6.1 Why comment reading stopped at 139 and 11 (V from the stored calls and progress events; the source's own has-more value is not stored: GUESS for it)
| Video | Counter | Tool | Calls | Rows per call | Cursors sent | Saved | Stop |
|---|---|---|---|---|---|---|---|
| V1 (`…652`) | 329 | `tikhub.tiktok.video.comments` | 8 | 19, 20, 20, 20, 20, 20, 20, **7** | none, 20, 40, 60, 80, 100, 120, 140 | 139 (146 rows; 7 repeated ids, 4 on page 4 and 3 on page 6) | **source end**: the 8th page held 7 rows (a short page) and no 9th call was made |
| V2 (`…976`) | 163 | the same | 1 | **11** | none | 11 | **source end**: one short page, no second call |
Not a page cap (the stage's page limit is far above 8), not a time cap (the 9 calls took 14 s of a 25-minute job limit), not the reserve (execution provider cost 0.0366 USD against a hold of 2,319 points), not barren pages (every page added rows or only repeated ids). The counter of the platform (329 and 163) counts comments, replies and nested items; the source gave 150 comments and 87 replies (the replies tool was called for each comment that has a counter: 46 calls). The promise (492 = the counters) was never reachable from this first tool. **The engine stopped at that first tool's end**: a parent whose first tool ended short of its supply was only re-read when it had given NOTHING (S1 item C); the stage's next tool (the sampled `crawl4ai`, which gives up to 500 comments in one call) was stored and never asked.

## S6.2 The price of this plan (V: Q48, Q49) and why today's TikTok plans were 200, 300, 294, 1,141, 2,017
Rule (`price.ts`, unchanged): total cost = provider estimate + model estimate (0.026 USD: planning 0.008 + 0.008 a further stage + the review share); max charge = total x 5,500 points a USD (the 10x markup), with a minimum of 200; unit price = max charge / planned rows; hold = max charge + about 15%; charged = delivered x unit.
| Mission (Cairo) | Planned rows (videos / comments / replies) | Provider estimate | Total | Max charge | Note |
|---|---|---|---|---|---|
| 07:42 | 2 / 40 / 280 | 0.1813 | 0.2073 | **1,141** | the 280 replies were a stale estimate (S2 item 2) |
| 09:25 | 2 / 800 / none | 0.0084 | 0.0344 | **200** | 189 points, the 200 minimum applied |
| 10:26 | 2 / 80 / 20 | 0.0285 | 0.0545 | **300** | |
| 11:32 | 2 / 6 / 300 | 0.0273 | 0.0533 | **294** | 300 replies estimated on top (S5) |
| 12:10 (this one) | 2 / 421 / 71 | 0.3406 | 0.3666 | **2,017** (hold 2,319) | **the replies stage priced a call for EVERY comment**: 355 calls x 0.0009 = 0.3195 USD, 0.0045 USD a reply; only 46 reply calls were made (the real provider cost of the run was 0.0386 USD, model 0.0628 USD) |
The figure 201 is not in the day's missions of the account (the minimum plan is 200; its hold was 218). The jumps come from the replies stage: its price follows the estimated calls, and S4 priced a call a comment for every plan that asked for replies, even when the sample showed which comments have them.

## S6.3 The fixes (one PR, behind the same flags; red test first: `tests/s6-live-fixture.test.ts`, the world built from the stored facts)
1. **Keep reading until the promised count or the real end** (`agent/src/engine/run.ts`): a parent whose first tool ended before its supply is read by the stage's next tools too, from the start (an id already stored is ignored), until its supply is reached or every tool has ended. The end is real only then. Cost: on platforms whose counter includes replies the supply is never reached, so the next tool is always read (the sampled `crawl4ai`: one call a video, 0.0005 USD).
2. **The completion text says the real numbers** (`agent/src/repliesShortfall.ts`, `runMission.ts`): when every tool ended short of the promise: «لم يكتمل العدد المطلوب لأن المصدر انتهى قبل بلوغ عدّاد المنصة؛ سُلّم ٢٣٧ من ٤٩٢ تعليقًا وردًا، فعدّاد المنصة يشمل عناصر لا يعرضها المصدر»; a budget, time or failure stop keeps its own sentence.
3. **The comment language column** (`languageLabel.ts` `textColumnKeyOf`, `tools.ts`, `workbook.ts`, `replies.ts`): the live plan called the text column «comments», so the S4 rule (which looked for a column keyed `text`) never added the language column and the file's fallback never found the text; the text column is now found by key or Arabic title, and the reply mapping reads a column keyed `comments` too (the replies' text was empty).
4. **The price of the replies** (`replies.ts`): a call a comment is priced only when the sample supports no counter (a blind read); with counters in the sample only the comments that have replies are priced.

Changed existing test (marked `CHANGED`): `tests/s2-live-replay.test.ts` asserted that the sampled next tool is never called; it is now called when the first tool ends before the counter.

Limits: the page text of this mission is in storage, so the fixture reproduces its structure, not its content; whether `crawl4ai` (or any next tool) gives more comments than `tikhub` for these two videos is not known (the tests cover both outcomes: it gives more, or it gives nothing and the text states the real numbers); a platform counter that includes removed or nested items can still never be reached, and the text says so.

---

# Live test of 2026-11-02 ~13:06 Cairo after #337 (S7): `msn_5d849cbac96092de0287`, country and language first; the editor's «all»; the money check

Read-only SELECTs (Q50 the account's missions after 10:30 UTC, Q51 `credit_ledger` columns, Q52 the job's ledger rows, Q53 the charge arithmetic on the stored values, Q54 events, Q55 stages, Q56 the planning search calls, Q57 the source of `settle_job_atomic`: only whether it contains `ceil` or `floor`). The request was edited from the full plan (5,115 rows, reserve 8,343 points) to 100 comments per video (362 rows, reserve 742) before approval; delivered 347 (2 videos, 200 comments, 145 replies), charged 619.

## S7.1 The money check (V): the charge is ceil(delivered x unit price), never above the reserve; floor was NOT used
| Item | Stored value |
|---|---|
| ledger rows of the job (`job_quote_7b0fcf7da38ded03444287a305102574`) | `res_…` **-742** (13:06:37), `chg_…` **-619** and `rel_…` **+742** (both 13:08:36): net -619, balanced |
| stored unit price (mission and plan) | 1.781966 points a row |
| delivered | 347 |
| exact product | 347 x 1.781966 = **618.342202** |
| ceil / floor / round | **619** / 618 / 618 |
| charged | **619 = ceil** (floor would be 618, not 619) |
| reserve / max charge of the plan | 742 / 646: 619 is below both |
The code says the same: `chargeForDelivered` (`src/lib/agentMission/price.ts:100-105`) is the exact integer ceil of (unit in micro-points x delivered) / 1,000,000, `settlementCharge` caps it at the reserve and the job cap, and the stored function `settle_job_atomic` contains `ceil` and no `floor`. The tester's «620 instead of 619» cannot be reproduced from the stored values: 348 rows would be 621, 347 rows with a display-rounded unit (1.782) is 618.35, which also rounds up to 619. No money file was touched.

## S7.2 Why both videos were English AI cartoons (V for the calls and the plan, GUESS for the page content, which is in storage)
The plan was built on `tikhub.tiktok.search.videos` with `region: EG`, `sort_type: 1` (the most-liked order that S5 asks for); the card had no country line because the tool HAS a region input (no gap). The two planning samples were `sort_type` 2 (newest) then 1 (most liked); the videos came from the most-liked sample, whose results (counters 3,553 and 1,560) were global English videos: **a region input is a request to the source, not a proof that every result is from that country, and in the most-liked order it was not honoured**. The place and language filters of the card were marks only (raw delivery) and the choice of videos looked at counters alone.

## S7.3 Fixes (one PR, behind the same flags; red test first: `tests/s7-country-first.test.ts`, the exact request)
1. **The customer's country and language come first** (`customerConditions.ts`, `completeCount.ts`, `agent/src/tools.ts`): the videos are chosen among the RESULTS THAT MATCH the country (place evidence in the row's own fields: none is never a match) and the language (the source's own, else the script of the caption: code, never a model); the matching come first, ordered by comment counter, then the others fill any missing place. An order, never a filter: nothing is removed. Every sampled page of the search is a listing the videos may be chosen from (the planning budget allows two samples of one source: the most-liked sample may hold English videos while the first holds Egyptian ones). The card says how they were chosen («اخترنا الأعلى تعليقًا من بين النتائج المطابقة لبلدك ولغتك») and, when fewer matched than needed, how many. A tool without the country field is never chosen for its sort.
2. **The plan editor**: the comments per video can be «كل» (the videos' real counters: comments + replies = their sum again, the price recomputed and shown before approval) or any number up to the largest real counter (the cap of 100 contradicted «all comments»); the refusal names the real number (`planEdit.ts`, `PlanEditor.tsx`).

Limits: matching depends on the evidence the source's rows carry (a source that gives neither a country field nor a language leaves every row unmatched: the order falls back to the counters and the card says how many matched); when no sampled page holds a matching video, the highest-commented results are delivered and the card says so before approval (the customer may edit or cancel). Whether `region` is honoured in the most-liked order of other tools is unknown.

---

# Live test of 2026-11-02 ~13:35 Cairo after #338 (S8): `msn_5851abc92a1e6645a9cd`, what «عن الذكاء الاصطناعي» means

Read-only SELECTs (Q58 the account's missions after 10:50 UTC, Q59 the planning search calls, Q60 the videos stage with its pinned and sample rows, Q61 the plan's notes). First complete delivery (369 of 369: 300 comments, 67 replies, Egypt and Arabic correct, charge 530); but both videos were AI-generated drama stories (`#قصص_بالذكاء_الاصطناعي`, «في بيتنا قطه», «أسماء عايشه في عذاب»), not videos ABOUT artificial intelligence.

## S8.1 Cause (V from the stored plan and calls)
The search words were the bare topic (`keyword: «الذكاء الاصطناعي»`, `region: EG`, `sort_type` 1): TikTok matches the word in hashtags too, and the stories carry `#قصص_بالذكاء_الاصطناعي`, `#حدوتة_AI`, `#AIStory`. The videos were then chosen by the highest comment counters (1,167 and 1,084), which are the viral stories (S5 and S7 look only at the counters, the country and the language). Nothing in the code distinguished «about» from «made with».

## S8.2 The owner's decision, in code (one PR, same flags, red test first; `tests/s8-topic-meaning.test.ts`, the stored videos as fixture `tests/fixtures/live/msn_5851abc9-videos.json`: 4 real rows and 2 synthetic explainers, marked)
- **Request understanding, not filtering** (`src/lib/agentMission/topicMeaning.ts`): «عن X» / «حول» / «بخصوص» / «في X» means ABOUT; «معمول / مصنوع / مولّد بـ X» means MADE WITH; a request that names the technology with neither («هات فيديوهين تيك توك الذكاء الاصطناعي ...») is AMBIGUOUS. The exact request is «about».
- **The query carries the meaning**: for «about» the search words are the topic with explainer and news wording («الذكاء الاصطناعي شرح وأخبار»), written by the code-built request into the tool's query field; a plan sampled with other words is sent back (one second sample, together with the most-liked order: the planning budget allows two samples of one source). An exclusion of made-with markers at the query level is written only by a search with query operators (the TikTok searches have none: nothing is invented).
- **Choosing the videos** (`completeCount.ts`): after the country and the language, videos whose own text discusses the topic (outside hashtags and outside any made-with phrase) come before videos where the topic is a plain hashtag, and before videos where it appears only inside a made-with marker (`#قصص_بالذكاء_الاصطناعي`, `#AIStory`, `#حدوتة_AI`), then the comment counters. This chooses which videos to read: no delivered row is removed and no comment is filtered. For «made with» the order is the other way round. The card says the videos were chosen for talking about the topic, or that none of the read results does (the most commented are then delivered, the customer may edit or cancel).
- **The question card** (`runMission.ts`): for an ambiguous request, before any source is read: «تقصد فيديوهات بتتكلم عن الذكاء الاصطناعي، ولا فيديوهات معمولة بيه؟» with two ready answers; the answer is read with the request and decides the meaning.

Limits: the topics are the technologies a video can be made with (the AI family); other topics keep today's behaviour. The meaning words are a fixed list of Arabic phrases (a different dialect phrasing may read as ambiguous and be asked). If no sampled result discusses the topic, the highest-commented results are delivered and the card says so. The planner (a model) must write the asked query in its second sample; if it does not within the two samples the plan stands and the order alone prefers the videos that discuss the topic.

---

# Live test of 2026-11-02 ~14:19 Cairo after #339 (S9): the replies promise after an edit to 150 comments per video

Data was right (2 videos about AI, Egypt, Arabic; 300 of 300 comments; the reply counters of the 300 comments sum to 40; 40 replies delivered). Only the numbers disagreed: the customer view said «تم تسليم ٣٤٢ من ٦٢٠» while the file summary said «٣٤٢ من ٣٤٢». (V from the owner's report; no new SELECT was needed.)

## S9.1 Cause (V from the code)
Any plan edit clears `promise_total` (S5), so the replies stage fell back to the sample's ESTIMATE (318 in the live plan) in `planned_rows`, and that number stood as a promise: the customer view reads the stored plan (`plan_public`, card total 2 + 300 + 318 = 620), while the notice and the file summary tell the replies against what was delivered (342). Same defect when the request itself names a number of comments per video below the counters (`completeCount.ts`, the «a number was asked» branch).

## S9.2 Fix (one PR, same flags, red test first: `tests/s9-open-replies.test.ts`, the live mission's numbers as the world)
- A replies stage whose comments are fewer than the counters of the chosen videos is **open** (`replies_open`, set by code in `planEdit.ts` and `completeCount.ts`): the card says «كل الردود على التعليقات المختارة» with no number and is not in the card's total; the estimate stays in `planned_rows` only as the maximum the price is made from.
- After the delivery (`runMission.ts`, `repliesCard.ts` `withRepliesJudged`) the replies are judged against the reply counters of the DELIVERED comments (each up to the replies read per comment; never below what came): the stored customer plan is rewritten with that number, so the notice, the card and the file summary show the same numbers (300 comments, counters 40, 40 delivered: «تم تسليم ٣٤٢ من ٣٤٢»). Money is untouched: the charge is settled on the rows delivered; the `target` test still uses the priced estimate.
Limits: no live proof (no paid calls); a comment whose counter says 0 but has replies is delivered (blind reading) and raises the judged number to what came, never above.

---

# Live test of 2026-11-02 ~15:04 Cairo after #340 (S10): `msn_b060d3347ed7660f972e`, the X query's date boundaries

Request: «هات ٢٠ تغريدة على X فيها "العاصمة الإدارية" بالعربي في شهر أكتوبر ٢٠٢٦، مع الردود.» 20 of 20, all Arabic, marks present, money correct. One tweet was 2026-11-01 00:14 Cairo (22:14 UTC on the 31st), marked «ضمن الفترة المطلوبة: لا».

## S10.1 Cause (V: read-only SELECT of the stored plan, `anyapi.x.search.posts`, `built_by: code`)
The stored query was `"العاصمة الإدارية" lang:ar since:2026-10-01 until:2026-10-31`: the model's OWN operators (day only, UTC midnight), not code's. `buildToolInput` (#332) wrote the Cairo stamps only when the query had no `since:`/`until:` of its own (`addOperator` skips an operator that is present); #332's test used a query without any. A second place used UTC midnight for the period: the engine's walk back through date windows (`periodOf` took the first day at UTC midnight, `windowParams` wrote UTC days).

## S10.2 Fix (one PR, same flags, red test first: `tests/s10-cairo-x-query.test.ts`)
- `toolInput.ts`: the customer's period replaces the query's own `since:`/`until:` (each only when code writes it): `since:2026-09-30_21:00:00_UTC until:2026-10-31_22:00:00_UTC` for October 2026 (Egypt's summer time ended 2026-10-29, so the end is UTC+2; the start is UTC+3). Both X search tools (`anyapi.x.search.posts`, `crawl4ai.x.search.posts`).
- `agent/src/engine/run.ts` + `dateWindow.ts`: the period is read in Cairo days (first moment, first moment after the last day); a walk-back window never starts before or ends after them (query operators and ISO inputs get exact stamps; day-only sources get the covering UTC days, never a day past the last covering one); `firstWindowEndDay` reads the end day of a stamp.

## S10.3 Audit of the tools that take date fields (V from the catalog through `toolProfile`, 198 endpoints)
| How the tool takes dates | Tools (social) | State |
|---|---|---|
| Query operators `since:`/`until:` | X search (`anyapi.x.search.posts`, `crawl4ai.x.search.posts`), Weibo advanced search | X: FIXED here. Weibo advanced search has operators in its profile only |
| Range inputs, ISO / unix / day | X official (`x.x.search-posts-*`), YouTube (`publishedAfter`), Threads, Facebook posts and ads, LinkedIn ads, TikTok ads, Douyin | already Cairo-converted by `toolInput` (#332), and they overwrite what the model wrote; a day-only source gets the UTC days that cover the Cairo range |
| Range inputs whose format the catalog does not state | Reddit (`after`), Instagram (`after`/`before`), Telegram, LinkedIn company/user posts | NOT written (an honest gap on the card; the mark states membership) |
| Presets (`datePosted`, `date_posted`, `timeframe`) | TikTok search, Instagram hashtag, LinkedIn posts, Reddit search | rolling windows, cannot hold a Cairo day boundary; the mark states membership |
| Walk back through date windows | every source with a documented window (X, YouTube activities, Facebook, LinkedIn ads…) | FIXED here (Cairo bounds) |
| Legacy pipeline (flags off): `withXDateOperators` (`src/lib/xSearchWindow.ts`) | X topic search in the old social worker | NOT changed: it writes UTC days, `since:2026-09-01 until:2026-10-01`; four tests pin it, and the flags-off behaviour stays byte for byte |
Limits: no live proof (no paid calls); the source's own reading of the stamps (UTC, `until` exclusive) is the catalog's documented form, not observed.

---

# Live test of 2026-11-02 ~15:36 Cairo after #341 (S11): `msn_afe9bb0b436670e35a3c`, Instagram account posts

Request: «هات منشورين من حساب الحدث على إنستجرام (alhadath)، مع كل التعليقات والردود.» Delivered 3 items (2 posts, 1 comment), charged the 200-point minimum, replies stated as not available, the sample table showed «false» and Western digits.

## S11.1 The banner «هذه المحادثة تُدار حاليًا بواسطة فريق الدعم فقط…» (read-only; nothing weakened)
Not produced by anything in this app. Checked (V): the text is in no source file, no migration and no seed; `conversations.status` is `active` for all 609 rows; no column of any public table is a pause, hold, lock, suspend, flag, risk, takeover or support state (only `invoice_documents.locked_at`); the settings keys are `redesign_flags`, `pricing`, `provider_limits`, `providers`, `support` (contact data), none a guard; no chat message of the last 6 hours carries the text; the mission's events hold no refusal (only system, call, progress, plan, result). The app's own chat guards are a burst limit of 20 user messages a minute (429), a global daily spend cap (503, «المساعد مشغول الآن، حاول بعد قليل.») and a conversation token cap (413): the test account sent 8 messages in 3 hours, and none of the three texts matches the banner. So there is no rule, threshold or state in the app to clear, and nothing for the admin side to reset. Runtime logs of the moment are gone (Vercel Hobby keeps 1 hour). GUESS: the banner comes from a layer outside the app (a browser extension, an embedded support widget or the platform around the chat); if it appears again, its page source (the element and its origin) is what identifies it.

## S11.2 Causes of the weak delivery (V from the stored plan and calls)
1. The comments stage was titled «التعليقات الرئيسية على المنشورين». `isPeopleStage` read «الرئيسية» (main) as the people stem «رئيس» (chief), so for this plan: no replies stage (the card's «replies not available» was the model's own line), no complete count, no most-engaged choice, no pinned posts. `isPeopleNoun` now treats «رئيسي/رئيسية/رئيسيين» as the adjective.
2. A stage that reads ONE named account's listing (`sources`, `source_listing`) was never built by code, so a mission with it never ran the new pipeline and pinned posts were ignored. It is now built by code (several named sources keep the model's request).
3. The page sampled held 12 posts, the newest two minutes old (0 comments each). The default (most engaged) now applies to account posts: the plan is sent back once to read the next page of the listing (the planning budget allows two samples of one source), then the most commented of the recent posts are pinned; their title and the card no longer say «the newest».
4. Instagram replies: the catalog HAS comment-replies tools (`anyapi.instagram.comment_replies` takes the comment id and the post link, 0.0011 USD a call; `tikhub.x.instagram-v2-fetch-comment-replies`, `tikhub.x.instagram-v3-get-comment-replies`, `justoneapi.x.instagram-get-comment-replies-v1` need a media id the plan cannot give). The first is used when replies are asked; the comments source gives no reply counter, so replies are read comment by comment (priced by calls, as for any source with no counter).
5. The customer's sample table of a redesigned plan (stages built by code): `true/false` are «نعم/لا», numbers are written in Arabic-Indic digits (`formatSampleValueAr`, idempotent). The old pipeline's table keeps its text byte for byte (flags off; `formatSampleCell` is unchanged). Shared code changed for both pipelines: `isPeopleNoun` (the adjective «main» is not a chief) and the card lines the plan contradicts (`assumptionLinesOf`, only when a replies stage or a most-engaged choice is in the plan).
The 200-point charge is the pricing rule's minimum (price.ts untouched): 3 items cost less than it.
Limits: no live proof (no paid calls); the most commented is chosen among at most two pages (24 posts), not the whole account.

---

# Consolidation (one PR, same flags, red tests first): the nine rules over every platform and every request type

Owner order after #342: no more per-platform fixes. The nine general rules the live tests taught are applied to EVERY social request type (search posts, account posts, comments, replies) on EVERY platform (TikTok, Instagram, Facebook, YouTube, X), and each of the five first benchmark requests of `docs/benchmarks/antigravity-10.md` has an end-to-end test with its exact Arabic text (`tests/benchmark-antigravity-1-5.test.ts`: promise == delivered, the rules asserted).

## C.1 The table: rule x platform x request type
Each cell is **applied** (✔ and the test file that proves it; `tests/consolidation-matrix.test.ts` checks that the file and the test title exist) or **not possible** (✖ and the catalog evidence, computed from the catalog snapshot by the same function that generated this table; it is not typed by hand). A cell for a request type the rule does not concern is not in the table (R1 concerns comments and replies; R2 to R5 posts of a search or an account; R6 replies; R7 comments; R8 and R9 all four).
<!-- consolidation-matrix:start -->
**الخلايا: 100؛ مطبَّقة: 76؛ غير ممكنة (بدليل الكتالوج): 24.**

| القاعدة | المنصة | بحث | حساب | تعليقات | ردود |
|---|---|---|---|---|---|
| R1 الوعد = عدّادات المنشورات المختارة (تعليقات وردود معًا)، لا تقدير | tiktok | — | — | ✔ benchmark-antigravity-1-5 | ✔ benchmark-antigravity-1-5 |
| R1 الوعد = عدّادات المنشورات المختارة (تعليقات وردود معًا)، لا تقدير | instagram | — | — | ✔ benchmark-antigravity-1-5 | ✔ benchmark-antigravity-1-5 |
| R1 الوعد = عدّادات المنشورات المختارة (تعليقات وردود معًا)، لا تقدير | facebook | — | — | ✔ benchmark-antigravity-1-5 | ✔ benchmark-antigravity-1-5 |
| R1 الوعد = عدّادات المنشورات المختارة (تعليقات وردود معًا)، لا تقدير | youtube | — | — | ✖ 0 of 8 search and 0 of 5 account listing tools give a comment counter field, so no number  | ✖ 0 of 8 search and 0 of 5 account listing tools give a comment counter field, so no number  |
| R1 الوعد = عدّادات المنشورات المختارة (تعليقات وردود معًا)، لا تقدير | x | — | — | ✔ consolidation-rules | ✖ the catalog has no x.comment.replies tool (0 of 122 x endpoints) |
| R2 الاختيار الافتراضي = الأكثر تعليقًا (بحثًا وحسابًا) | tiktok | ✔ benchmark-antigravity-1-5 | ✔ consolidation-rules | — | — |
| R2 الاختيار الافتراضي = الأكثر تعليقًا (بحثًا وحسابًا) | instagram | ✔ consolidation-rules | ✔ benchmark-antigravity-1-5 | — | — |
| R2 الاختيار الافتراضي = الأكثر تعليقًا (بحثًا وحسابًا) | facebook | ✔ consolidation-rules | ✔ consolidation-rules | — | — |
| R2 الاختيار الافتراضي = الأكثر تعليقًا (بحثًا وحسابًا) | youtube | ✖ 0 of 8 tools give a comment counter: no comment count to order by; the tool's own order st | ✖ 0 of 5 tools give a comment counter: no comment count to order by; the tool's own order st | — | — |
| R2 الاختيار الافتراضي = الأكثر تعليقًا (بحثًا وحسابًا) | x | ✔ consolidation-rules | ✔ consolidation-rules | — | — |
| R3 بلد العميل ولغته أولًا؛ الترتيب بالتفاعل داخل المطابق فقط | tiktok | ✔ benchmark-antigravity-1-5 | ✔ consolidation-rules | — | — |
| R3 بلد العميل ولغته أولًا؛ الترتيب بالتفاعل داخل المطابق فقط | instagram | ✖ 0 of 4 tools have a country or language input: the card states the gap and the file marks  | ✖ 0 of 8 tools have a country or language input: the card states the gap and the file marks  | — | — |
| R3 بلد العميل ولغته أولًا؛ الترتيب بالتفاعل داخل المطابق فقط | facebook | ✖ 0 of 1 tools have a country or language input: the card states the gap and the file marks  | ✖ 0 of 5 tools have a country or language input: the card states the gap and the file marks  | — | — |
| R3 بلد العميل ولغته أولًا؛ الترتيب بالتفاعل داخل المطابق فقط | youtube | ✔ consolidation-rules | ✔ consolidation-rules | — | — |
| R3 بلد العميل ولغته أولًا؛ الترتيب بالتفاعل داخل المطابق فقط | x | ✔ benchmark-antigravity-1-5 | ✖ 0 of 7 tools have a country or language input: the card states the gap and the file marks  | — | — |
| R4 معنى الموضوع (عن / معمول بـ / ملتبس) لأي موضوع | tiktok | ✔ benchmark-antigravity-1-5 | ✖ 0 of 8 tools have a query field (an account's listing has no search words): the meaning or | — | — |
| R4 معنى الموضوع (عن / معمول بـ / ملتبس) لأي موضوع | instagram | ✔ consolidation-rules | ✖ 0 of 8 tools have a query field (an account's listing has no search words): the meaning or | — | — |
| R4 معنى الموضوع (عن / معمول بـ / ملتبس) لأي موضوع | facebook | ✔ consolidation-rules | ✖ 0 of 5 tools have a query field (an account's listing has no search words): the meaning or | — | — |
| R4 معنى الموضوع (عن / معمول بـ / ملتبس) لأي موضوع | youtube | ✔ consolidation-rules | ✖ 0 of 5 tools have a query field (an account's listing has no search words): the meaning or | — | — |
| R4 معنى الموضوع (عن / معمول بـ / ملتبس) لأي موضوع | x | ✔ consolidation-rules | ✖ 0 of 7 tools have a query field (an account's listing has no search words): the meaning or | — | — |
| R5 حدود يوم القاهرة في كل أداة تأخذ تواريخ | tiktok | ✖ 0 of 5 tools take a calendar date range (1 take only a rolling preset): a Cairo day bounda | ✖ 0 of 8 tools take a calendar date range (0 take only a rolling preset): a Cairo day bounda | — | — |
| R5 حدود يوم القاهرة في كل أداة تأخذ تواريخ | instagram | ✖ 0 of 4 tools take a calendar date range (1 take only a rolling preset): a Cairo day bounda | ✖ 0 of 8 tools take a calendar date range (0 take only a rolling preset): a Cairo day bounda | — | — |
| R5 حدود يوم القاهرة في كل أداة تأخذ تواريخ | facebook | ✔ consolidation-rules | ✖ 0 of 5 tools take a calendar date range (0 take only a rolling preset): a Cairo day bounda | — | — |
| R5 حدود يوم القاهرة في كل أداة تأخذ تواريخ | youtube | ✔ consolidation-rules | ✖ 0 of 5 tools take a calendar date range (0 take only a rolling preset): a Cairo day bounda | — | — |
| R5 حدود يوم القاهرة في كل أداة تأخذ تواريخ | x | ✔ benchmark-antigravity-1-5 | ✔ consolidation-rules | — | — |
| R6 أداة الردود في كتالوج المنصة؛ الردود لتعليق عدّاده > ٠ | tiktok | — | — | — | ✔ benchmark-antigravity-1-5 |
| R6 أداة الردود في كتالوج المنصة؛ الردود لتعليق عدّاده > ٠ | instagram | — | — | — | ✔ benchmark-antigravity-1-5 |
| R6 أداة الردود في كتالوج المنصة؛ الردود لتعليق عدّاده > ٠ | facebook | — | — | — | ✔ benchmark-antigravity-1-5 |
| R6 أداة الردود في كتالوج المنصة؛ الردود لتعليق عدّاده > ٠ | youtube | — | — | — | ✔ benchmark-antigravity-1-5 |
| R6 أداة الردود في كتالوج المنصة؛ الردود لتعليق عدّاده > ٠ | x | — | — | — | ✖ no x.comment.replies capability in the catalog; the replies to a post ARE its comments (x. |
| R7 الأداة التالية عند انتهاء الأولى قبل الوعد | tiktok | — | — | ✔ s6-live-fixture | — |
| R7 الأداة التالية عند انتهاء الأولى قبل الوعد | instagram | — | — | ✔ s6-live-fixture | — |
| R7 الأداة التالية عند انتهاء الأولى قبل الوعد | facebook | — | — | ✔ s6-live-fixture | — |
| R7 الأداة التالية عند انتهاء الأولى قبل الوعد | youtube | — | — | ✔ s6-live-fixture | — |
| R7 الأداة التالية عند انتهاء الأولى قبل الوعد | x | — | — | ✔ s6-live-fixture | — |
| R8 قيم بالعربي فقط (لا true/false ولا رموز لغة) | tiktok | ✔ benchmark-antigravity-1-5 | ✔ consolidation-rules | ✔ benchmark-antigravity-1-5 | ✔ benchmark-antigravity-1-5 |
| R8 قيم بالعربي فقط (لا true/false ولا رموز لغة) | instagram | ✔ consolidation-rules | ✔ benchmark-antigravity-1-5 | ✔ benchmark-antigravity-1-5 | ✔ benchmark-antigravity-1-5 |
| R8 قيم بالعربي فقط (لا true/false ولا رموز لغة) | facebook | ✔ consolidation-rules | ✔ benchmark-antigravity-1-5 | ✔ benchmark-antigravity-1-5 | ✔ benchmark-antigravity-1-5 |
| R8 قيم بالعربي فقط (لا true/false ولا رموز لغة) | youtube | ✔ benchmark-antigravity-1-5 | ✔ consolidation-rules | ✔ benchmark-antigravity-1-5 | ✔ benchmark-antigravity-1-5 |
| R8 قيم بالعربي فقط (لا true/false ولا رموز لغة) | x | ✔ benchmark-antigravity-1-5 | ✔ consolidation-rules | ✔ consolidation-rules | ✖ no replies sheet exists for x (no replies capability) |
| R9 نوع المرحلة من بنيتها لا من كلمات عنوانها | tiktok | ✔ consolidation-rules | ✔ consolidation-rules | ✔ consolidation-rules | ✔ consolidation-rules |
| R9 نوع المرحلة من بنيتها لا من كلمات عنوانها | instagram | ✔ consolidation-rules | ✔ consolidation-rules | ✔ consolidation-rules | ✔ consolidation-rules |
| R9 نوع المرحلة من بنيتها لا من كلمات عنوانها | facebook | ✔ consolidation-rules | ✔ consolidation-rules | ✔ consolidation-rules | ✔ consolidation-rules |
| R9 نوع المرحلة من بنيتها لا من كلمات عنوانها | youtube | ✔ consolidation-rules | ✔ consolidation-rules | ✔ consolidation-rules | ✔ consolidation-rules |
| R9 نوع المرحلة من بنيتها لا من كلمات عنوانها | x | ✔ consolidation-rules | ✔ consolidation-rules | ✔ consolidation-rules | ✖ no x tool for replies in the catalog |
<!-- consolidation-matrix:end -->

The 24 cells that are not possible are the catalog's own limits, stated by the computed evidence in each cell: YouTube has no search or account tool that gives a comment counter (the promise there is open, never an estimate); Instagram, Facebook and X-account listings have no country or language input; account listings have no query field; TikTok, Instagram search and every account listing take no calendar date range; X has no comment-replies tool (a tweet's replies ARE its comments, `x.post.comments`). Cells proved by a benchmark are proved end to end for that platform and request type; every other applied cell is proved by the test of the same rule over that platform's own catalog tools (the code is platform-agnostic, the tools are not).

## C.2 What running the rules over every platform found (V: the red tests)
1. **Rule 9, stage type from structure** (`people.ts` `stageKindByCapability`, `entities.ts`, `plan.ts` `capability`, `agent/src/tools.ts`): the catalog capability of the stage's tool is stored on the stage in the redesigned mode; a social capability is never a people or a company stage, a people capability always is, whatever the title says. Plans with no stored capability (the old pipeline, old plans) keep the title rule, byte for byte.
2. **Rule 6, replies on Facebook and YouTube** (`replies.ts` `rowTokens`, `tokenOverlayCode`, `plan.ts` `carry_keys`, `ingest.ts`): both platforms HAVE replies tools (`anyapi.facebook.comment_replies`: `feedbackId` + `expansionToken`; the YouTube ones: the comment's reply continuation token); the old comment «Facebook and YouTube have none» was stale. The tokens are fields of the comment's own row: the comments mapping keeps them (a second pass by comment id, proven on the sampled page), the stored row carries them beside the columns and never in the file. Test `tests/reply-sources.test.ts` changed accordingly (marked CHANGED).
3. **Rule 1, no counter means no promised number** (`completeCount.ts`, `repliesCard.ts`, `customerView.ts`, `engine/run.ts`, `runMission.ts`): when the customer asked for ALL the comments and the parents' source gives no comment counter (YouTube, Facebook account lists), the comments stage is open (`children_open`): the card says «كل التعليقات على العناصر المختارة» with no number, the estimate stays as the price's maximum (the charge never goes above the reserve), every parent is read to the source's end, and after the delivery the promise is what the source gave when it ended (a stop for budget or time keeps the estimate, so a shortfall stays visible). Test `tests/complete-count.test.ts` changed accordingly (marked CHANGED).
4. **Rule 4, the meaning of ANY topic** (`topicMeaning.ts` `topicMeaningFromModel`, `agent/src/tools.ts`, `agent/prompts/system.md`): `propose_plan` carries `topic_meaning` written by the planner from the customer's words (relation about / made_with / ambiguous / none, the topic, the search query, the made-with markers); code checks that the topic is the customer's own phrase and the query holds it, writes the query into the tool's query field, orders the videos by it (an order, never a filter) and turns an ambiguous reading into the question card before any plan. The fixed word list (the AI family) is only the fallback when the model gave none.
5. **Rule 5, dates** (`toolProfile.ts`, `toolInput.ts`, `engine/spec.ts`): an input whose own note says it is a paging cursor (Instagram `after` / `before`) is no longer read as a date input (it made the tool look date-capable); a customer who asked for the newest or gave a date gets the tool's «latest» order (X: `queryType` = `Latest`, as the benchmark's reference request says).
6. **Rule 3, several countries** (`toolInput.ts`): a tool whose country input takes ONE country gets the first, and the card now states that it does not enforce the set («مصر أو المنطقة العربية»).
7. **Rule 8, language codes** (`customerDates.ts`, `plan.ts`): a language code in the sample table of a code-built plan is written as the file writes it (العربية / لغة أخرى / غير محددة).
8. **Built by code** (`engine/spec.ts`): several named sources that ONE search page showed (the official channels of the benchmark's YouTube request) share one entry, so the stage is one search built by code like any other; before, the whole mission ran on the old path.

## C.3 The five benchmark tests (`tests/benchmark-antigravity-1-5.test.ts`, exact Arabic text, worlds in `tests/helpers/benchWorld.ts`)
1. Facebook: replies by `anyapi.facebook.comment_replies` through the comment tokens, read only for comments with a counter above zero; the period given means the source order, not the most commented; 11 = the counters of the two chosen posts, delivered.
2. YouTube: one search built by code for two official channels, replies by the token tools, the open comment promise, delivered.
3. TikTok: the tool with the country field wins, Egypt written and the set stated as not enforced, the most commented among the matching, the query «about», replies only where counters say, 99 = 66 + 33 delivered.
4. Instagram: the most commented of two pages of the account, the catalog's replies tool, delivered.
5. X: the Cairo-day query for October (until 2026-10-31 22:00 UTC), `queryType` Latest, the replies kept and marked, 20 of 20.

## C.4 Limits (stated honestly)
- No live proof (no paid calls): every shape is the catalog schema's; the page shape of the Facebook and YouTube replies tools is NOT in the catalog (no list path, no item fields): the replies mapping reads the common list names and is unproven on a live page.
- The counter tool: a listing tool without a comment counter (Facebook `anyapi`, every YouTube listing) is not replaced by a counter-bearing one of the same capability; the plan is open (item 3) instead of sending the planner to another tool.
- The topic's meaning depends on the planner filling `topic_meaning`; with none, only the AI family is read by the word list.
- A comments source with no reply counter is read for replies once per comment (priced), as before; the rule «only counters above zero» holds where counters exist.
- Rule 7 is proved end to end on TikTok only; the other platforms use the same engine over their own catalog tools. A replies stage has one source: the next replies source is not read.

---

# Round 4: live round after #343 (merge f38519e), 2026-11-02 ~17:30-17:45 Cairo: a named page, account or channel with a topic or a period

Owner report: Instagram @alhadath complete (14 of 14) but both posts were 20 minutes old; YouTube Super Cup 53 of 53 but video 2 from a non-official channel about another cup; Facebook Al Arabiya «about AI, last 3 months»: both posts off topic (the two newest), comments 4 of 8, replies 0, notice «تم تسليم ٦ من ١٠».

## R4.1 Why Facebook delivered 4 of 8 comments and 0 replies (V: read-only SELECTs of `msn_6bb78c15d116268b0b9b`: plan, calls, events, storage object sizes)
| Fact | Stored value |
|---|---|
| posts | `anyapi.facebook.user.posts` read twice at planning (3 rows a page, no topic and no date input), the two NEWEST pinned (2 rows) |
| comments promise | 6 comments + 2 replies = 8, the platform counters of the two pinned posts (`promise_total` 8); the 2 replies were the stated unknown share: the sample's comment had `replies_count` 0 |
| comments reads | execution call 7 and 8: the SAME input `…/AlArabiya/posts/pfbid…`, both EMPTY (a 113-byte answer), then call 9 (`…/reel/2959614737717915/`): 4 comments |
| next tool | none: the stage had 0 alternatives. The catalog's other Facebook comments tools cannot be fed or mapped: `justoneapi.x.facebook-get-post-comments-v1` has no list path in the catalog, `brightdata.x.facebook-comments` is a dataset call, `treg.facebook.post.comments` is routed |
| replies | 4 calls of `anyapi.facebook.comment_replies` (one per comment: blind read, the sample had no reply counter above 0), all EMPTY: 0 delivered |
So 4 of 8 is ONE pinned post whose comments the only tool answered empty (V) while the platform counter promised some; the counter includes items the source does not show (GUESS: hidden or removed comments, or the `/posts/pfbid` link form the tool does not resolve). The 0 replies are consistent with the sample (every sampled comment said 0, V); the two promised replies were the stated estimate inside the counters total. The notice told the real numbers.

## R4.2 Fixes (one PR, same flags, red tests first: `tests/round4-named-topic-choice.test.ts`, the exact Arabic requests of benchmarks 1, 2 and 4)
1. **The choice of the posts or videos to read** (`completeCount.ts`, `agent/src/tools.ts`): the ones from the sources the customer NAMED first, then the ones matching the customer's country and language, then the ones whose own text discusses the topic (the topic-meaning rule), then the highest comment counters. It chooses which items to read; nothing delivered is removed. It applies with or without the engaged default, with or without counters (YouTube gives none: the chosen videos are pinned), and to every platform.
2. **More of the listing is read** (`agent/src/tools.ts`): the S11 one-more-read send-back now also applies when the request names a topic or a period and the listing tool has no query or date input (a page's posts). The planning guard allows two reads of one source (`gateway.ts`, not touched): the stated limit is two reads of the listing; a tool's page size has no stated maximum in the catalog for the Instagram and Facebook listing tools, so it is not lifted.
3. **The card says it with the real numbers**: how many of the items read come from the named sources («وجدنا ١ فقط من ٣ نتيجة من المصادر التي سمّيتها»), how many talk about the topic («قرأنا ٦ نتيجة، ووجدنا ٢ منها تتحدث عن الموضوع»), that what was read does not reach the start of the requested period (with the oldest date read), and, for the engaged default on a named account, how short a time the posts read cover («تغطي آخر ٤ ساعات فقط»).
4. **A pinned parent that gives nothing is replaced** (`completeCount.ts` `spare_rows`, `engine/run.ts`): the next two candidates wait beside the pinned parents; a stage that reads all the comments of pinned parents replaces a parent that gave no child from any tool by one of them, so the promise (the counters) is still delivered instead of 4 of 8.

## R4.3 Limits (stated honestly)
- No live proof (no paid calls). The two-read limit of the planning guard means a fast-posting account whose last 24 posts cover a few hours still yields posts of those hours; the card now says so and the customer can ask for a period or a date (the period then goes to the tool's own date input where it has one).
- The topic ordering uses the planner's `topic_meaning` (any topic) or the AI word list; a request whose topic the planner did not read only gets the named-source and counters order.
- A swapped-in spare has its own counter: after delivery the card is judged on what was delivered, as before.
