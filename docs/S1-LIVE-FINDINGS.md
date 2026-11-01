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
