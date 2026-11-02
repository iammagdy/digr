# ROOT CAUSE: why 15 social PRs (#330-#344) still end in a new defect every live round

Written 2026-11-02 against `main` = `50f374d` (merge of #344). Phase 1 of the brief: READ-ONLY research. Phase 2 (the one fix) is in the same PR and is described in section 5.

Marks: **V** = I ran the query or read the line in this session. **V-R** = taken from `docs/S1-LIVE-FINDINGS.md` (an earlier session read it; not re-read here). **GUESS** = inference. **NOT VERIFIED** = needs storage objects (raw pages, delivered files) or the browser, which a SELECT cannot read.

Safety: only `SELECT` through the read-only database tool; no write, no migration, no paid provider call, no flag change. Every query is listed in section 7.

---

## 0. The answer in six lines

1. **There is no request contract.** Nothing builds, once, from the customer's Arabic: platform, source, topic, country, language, period, count, comments, replies, and nothing checks the finished plan against it. The only code that demands a stage of the plan reads a NUMBER («٥ تعليقات لكل فيديو»), so «مع كل التعليقات والردود» demands nothing (proven below by running the parser on the exact requests). A plan with no comments stage, or no replies stage, is accepted and shown with its card (M1, M2, M7, M15, M18, M20: the 19:00 YouTube regression is M20).
2. **The plan is shaped by the model and rewritten by about ten ordered code passes and six bespoke send-back counters, with no final gate after the last one** (`agent/src/tools.ts:634-973`). Every live round added one more pass for one more symptom; the order of passes is where the stale numbers come from (M6 280, M9 300, M10 2,017, M13 620 against 342).
3. **The new pipeline falls back to the old one silently** when any stage is not built by code (`agent/src/redesign.ts:17-18`): 8 of the 20 missions ran the old pipeline, which judges content (M1, M3, M5, M7 removed rows as `no_term`, `filter_place`, `other_person`). The customer's card is the same either way.
4. **The listing tools read too little to choose from, and the contract has no sentence for that.** A Facebook page listing gives 3 rows a page and the planning guard allows 2 reads: the "two posts about AI in the last 3 months" were chosen from the 6 newest posts (M1, M17, M19); Instagram gave 12 (M15, M16).
5. **The promise is an estimate (sample or platform counter), the delivery is what the source exposes.** They differ in 14 of 20 missions.
6. **The tests describe invented worlds.** 717 entries under `tests/` (files and folders), two stored live fixtures (`tests/fixtures/live/`); each round's tests were green and the next live mission failed. No test has ever replayed a stored mission.

**One design fix** (section 5): a REQUEST CONTRACT built once by code, and a FINAL GATE that checks every plan against it before it is stored (a missing stage is sent back, then stated by code as a step not included; a condition no tool field carries is stated by code); the fallback reason is recorded; and a replay of every stored mission is a permanent test. Plus per-platform flags so each platform can be switched alone.

---

## 1. The 20 missions (test account `iam.magdy+1@outlook.com`, 2026-11-01 21:00 to 2026-11-02 19:30 Cairo)

Cairo = UTC+2 on these dates (Egypt's summer time ended 2026-10-29). Source of every number: Q3 (missions), Q6 (stages), Q7-Q9 (plan and result events, `pipe_new`), Q10 (calls). `pipe` = `pipe_new` of the mission's own telemetry event: 0 = old pipeline, 1 = new. `Plan` = rows of the final `plan` event (stages) = per stage. `Del` = the `result` event (delivered = per stage rows). Request texts are the stored `request_text` (Arabic, one line each, abbreviated here by request kind).

Request kinds: **FB** «هات منشورات عن الذكاء الاصطناعي من صفحة قناة العربية على فيسبوك آخر ٣ شهور، منشورين، مع كل التعليقات والردود» (platform Facebook, source the Al Arabiya page, topic AI, period 3 months, count 2 posts, comments all, replies all). **YT** «هات فيديوهين على يوتيوب عن نهائي السوبر المصري الأهلي والزمالك من القنوات الرسمية، مع كل التعليقات والردود» (YouTube, source official channels, topic the Super Cup final, count 2 videos, comments all, replies all). **TT** «هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود» (TikTok, topic AI, country Egypt, language Arabic, count 2 videos, comments all, replies all). **IG** «هات منشورين من حساب الحدث على إنستجرام (alhadath)، مع كل التعليقات والردود» (Instagram, source @alhadath, count 2 posts, comments all, replies all). **X** «هات ٢٠ تغريدة على X فيها "العاصمة الإدارية" بالعربي في شهر أكتوبر ٢٠٢٦، مع الردود» (X, topic, language Arabic, period October 2026, count 20, replies).

| # | Mission (Cairo) | Kind | pipe | Plan: stages and promise | Tools and calls (execution) | Delivered per sheet | Mismatches (request / plan / delivery) |
|---|---|---|---|---|---|---|---|
| M1 | `msn_a254618740b9b9878126` 11-01 23:04 | FB | 0 | 2 stages: posts 2, comments 10 = **12**; **no replies stage**; summary says «مع ردودها» | `anyapi.facebook.user.posts` 11 reads of 3 rows (33); comments `scrapecreators.x.v1-facebook-post-comments` 3 calls, 0 rows (200 empty, then 500) | posts 2, comments **0**; charged 34 | replies promised in words, no stage; comments 0 of 10; period «٣ شهور» in no tool input and no mark; 30 rows removed `no_term` by the old topic rule (V-R) |
| M2 | `msn_ee599cdbbde993073b15` 11-01 23:09 | YT | 0 | videos 2, comments 20 = **22**; no replies stage; summary says «وردودها» | videos: no recipe, the planning sample carried; comments `crawl4ai.youtube.video.comments` 4 calls, 17 rows | videos 2, comments **9** = 11 | comments 9 of 20 (promise from a sample); replies promised in words, no stage; one video gave 0 comments twice |
| M3 | `msn_481a78e310d9e68fddce` 11-01 23:15 | TT | 0 | videos 2, comments 130, replies 13 = **145** | `anyapi.tiktok.search.videos` `{query}` (country in the text, no `region`); comments `crawl4ai` 2 calls, 131 rows; replies 8 calls | 2 + 76 + 8 = **86** | 59 short; video 1 returned 120 rows and 65 were kept (equal share, `engine/run.ts:125` V-R), 55 paid for and not delivered; 7 videos removed by old place/topic rules; no country in the tool input |
| M4 | `msn_3ec7bb6012a36a703180` 11-01 23:20 | IG | 0 | posts 2, comments 8, replies 2 = **12** | `crawl4ai.instagram.user.posts` limit 5; comments `tikhub...v2-fetch-post-comments` 2 calls; replies: 0 calls | 2 + 5 + 0 = **7** | planned posts are not the executed posts (new posts in the two minutes between plan and approval, V-R); replies 0 of 2 |
| M5 | `msn_e3d679014c58168c3227` 11-01 23:23 | X | 0 | tweets **20** | `anyapi.x.search.posts`, 2 pages, 40 rows | **20** | count met; date bounds written at UTC midnight (a Cairo-October filter was not); 5 duplicates and 5 `other_person` removed by the old rule |
| M6 | `msn_48f6c7c80eb7068f2a38` 11-02 07:42 | TT | 0 | videos 2, comments 40, replies **280** = **322** | `tikhub.tiktok.search.videos`; comments `crawl4ai` `{limit: 20}` 2 calls (20, 19); replies 1 call | 2 + 39 + 1 = **42** | replies promise 280 was stale (800 comments x 0.35 estimated before the count was cut to 40); page size 20 was the planner's own sample; **ran the OLD pipeline: the replies stage had no `built_by`** (V-R, stage table Q6 shows `built` null) |
| M7 | `msn_a6dacebce7e7b7432aa1` 11-02 09:25 | TT | 0 | 2 stages: videos 2, comments 800 = **802**; **no replies stage** | comments written by the model (`{limit: 500}`), no recipe on stage 2 | 2 + 161 = **163** | replies asked, no stage, no gap line; 800 is the model's number; old pipeline excluded 2 videos as «لا يخص طلبك» (`other_person`) |
| M8 | `msn_7a35b44e35e6f3f1b8e9` 11-02 10:26 | TT | 1 | videos 2, comments 80, replies 20 = **102** | `anyapi.tiktok.search.videos` (no country input); comments `anyapi.tiktok.video.comments` 6 calls (80 rows); replies: 0 calls | 2 + 67 + 0 = **69** | both videos Iraqi (tool had no country field); replies 0 of 20 |
| M9 | `msn_c796a6ff13d79f7a973d` 11-02 11:32 | TT | 1 | videos 2, comments 6, replies **300** = **308** | `crawl4ai.tiktok.search.videos`; comments `tikhub...` 2 calls (3 rows); replies 3 calls | 2 + 3 = **5** | the platform counters of the videos were 5 and 1; 300 replies were an estimate added on top of the counters; card read «٥ من ٣٠٨» |
| M10 | `msn_6066498b5da3dd512595` 11-02 12:10 | TT | 1 | videos 2, comments 421, replies 71 = **494**; reserve 2,319 (max charge 2,017) | comments `tikhub.tiktok.video.comments` 9 calls (157 rows, ended at the first tool's end); replies 46 calls | 2 + 150 + 87 = **239**; charged 976 | promise 492 = counters, source gave 237; the replies stage priced a call for every comment (355 calls priced, 46 made): price 2,017 for a run that cost far less |
| M11 | `msn_5d849cbac96092de0287` 11-02 12:57 | TT | 1 | first 5,115 rows (reserve 8,343), edited to **362** (reserve 742): comments 200, replies 160 | `tikhub.tiktok.search.videos` region EG, most liked; comments 14 calls (259 rows); replies 52 calls | 2 + 200 + 145 = **347**; charged 619 (= ceil, V-R) | both videos English AI cartoons: a `region` input is a request, not a proof (V-R); replies 145 of 160 |
| M12 | `msn_5851abc92a1e6645a9cd` 11-02 13:35 | TT | 1 | first 2,253, edited to **369**: comments 300, replies 67 | `tikhub...search.videos`; comments `anyapi.tiktok.video.comments` 22 calls (436 rows, 300 kept); replies 67 calls | 2 + 300 + 67 = **369** | promise = delivered. Both videos were AI-generated stories, not videos ABOUT AI (topic meaning; V-R) |
| M13 | `msn_f22426e67810c2ce852e` 11-02 14:19 | TT | 1 | first 5,151, edited to **620**: comments 300, replies **318** | comments `tikhub...` 19 calls (375 rows, 300 kept); replies 25 calls | 2 + 300 + 40 = **342** | the customer view said 620 (the replies ESTIMATE stood as a promise), the notice and file said 342 |
| M14 | `msn_b060d3347ed7660f972e` 11-02 15:04 | X | 1 | tweets **20** | `anyapi.x.search.posts` 1 call (20 rows) | **20** | count met; one tweet at 00:14 Cairo on 11-01 (the model's own `until:` operator stood, UTC bound; V-R) |
| M15 | `msn_afe9bb0b436670e35a3c` 11-02 15:35 | IG | 0 | 2 stages: posts 2, comments 1 = **3**; **no replies stage** («not available» line was the model's) | `scrapecreators.instagram.user.posts` 1 read of 12; comments `anyapi.instagram.post.comments` 1 call (2 rows) | 2 + 1 = **3**; charged 200 (the minimum) | the two newest posts (minutes old, 0 comments); no replies stage although the catalog has Instagram reply tools (the stage title «التعليقات الرئيسية» was read as a people stage: V-R S11.2); sample table read «false» |
| M16 | `msn_e3e7632e2fb2d42f9c19` 11-02 17:31 | IG | 1 | posts 2, comments 10, replies 4 = **16** | `scrapecreators.instagram.user.posts` 1 read of 12; comments `anyapi...` 2 calls (13 rows); replies 13 calls (13 rows, 1 kept) | 2 + 13 + 1 = **16** | total equal; parts differ (comments 13 vs 10, replies 1 vs 4); both posts 20 minutes old (owner report) |
| M17 | `msn_6bb78c15d116268b0b9b` 11-02 17:36 | FB | 1 | posts 2, comments 6, replies 2 = **10** (counters 8) | listing `anyapi.facebook.user.posts` 2 reads of 3 rows (6); comments `scrapecreators.x.v1-facebook-post-comments` 3 calls (4 rows: 2 empty reads of the same input); replies 4 calls, 0 rows | 2 + 4 + 0 = **6**; charged 254; notice «٤ من ٨» | the two NEWEST of 6 listed posts, off topic; «٣ شهور» in no input; 4 of 8 |
| M18 | `msn_3594a5ab6311c8691f20` 11-02 17:39 | YT | 1 | 2 stages: videos 2, comments 200 = **202**; **no replies stage**; the card's own assumption says «مع ردود كل تعليق» | `crawl4ai.youtube.search.videos`, comments `crawl4ai.youtube.video.comments` 2 calls (53 rows) | 2 + 53 + 0 = **55** | the card promises replies in words with no stage and no gap line; 200 comments is an open estimate; video 2 from an unofficial channel about another cup (owner report) |
| M19 | `msn_96beb9f7a1d937a90cd0` 11-02 18:56 | FB | 1 | posts 2, comments 10, replies 4 = **16** (counters 14) | listing 2 reads (6 rows); comments `scrapecreators...` 2 calls (4 rows); replies `scrapecreators...comment-replies` 4 calls, 0 rows | 2 + 4 + 0 = **6**; charged 188; notice «٤ من ١٤» | same as M17 with another reply tool: 6 of 16 |
| M20 | `msn_adcfafabcdebc27ff803` 11-02 19:00 | YT | 1 | **1 stage** (videos 2) = **2**; **no comments stage, no replies stage**; the summary says «مع روابطها ومشاهداتها» | `crawl4ai.youtube.search.videos` 1 call (2 rows) | videos 2; charged **200** (the minimum) | **the regression of ~19:01**: the customer asked for all comments and replies, the model's plan dropped both after the one question, the plan was accepted with no refusal, no gap line, no stage, and approved |

Totals (V by arithmetic on the rows above): 20 missions; `pipe_new` 0 in **8** (M1-M7, M15), 1 in **12**; promise equal to delivery in **6** (M5, M12, M14, M15, M16 by total, M20 vacuously) and different in **14**.

The reserves, charges and ledger rows were not re-read for this document (money is out of scope); the stored `charged_points` agree with the result events.

---

## 2. The mismatches, classified

| Class | What it is | Missions |
|---|---|---|
| **A. An asked stage is absent from the plan and nothing says so** | replies (6), comments (1) | M1, M2, M7, M15, M18, M20 (M20: comments too) |
| **B. The promise differs from the delivery** | an estimate or a platform counter was promised as a number; the source gave less (or the estimate was stale) | M1, M2, M3, M4, M6, M7, M8, M9, M10, M11, M13, M17, M18, M19 |
| **C. An asked condition is carried by no tool field, no mark and no honest line** | period (M1, M17, M19, M5, M14), country (M3, M8, M11), topic meaning (M12, M17, M19), official source (M2, M18), recency of the chosen items (M15, M16, M17, M19) | 13 missions |
| **D. The old pipeline judged content** | rows removed by `no_term`, `filter_place`, `other_person` | M1, M3, M5, M7 (and the rest of M1-M7 by the same code) |
| **E. Rows paid for and not delivered** | equal share across parents | M3 (55 rows), M12 and M13 (the count cap, by design) |
| **F. Display disagrees with itself** | card says one number, notice another | M9 («٥ من ٣٠٨»), M13 (620 vs 342) |

---

## 3. The shared causes, each proved with mission ids and file:line

### Cause 1. There is no request contract; the only demanded stage comes from a number (class A, C)

- `src/lib/agentMission/plan.ts:365` reads what the customer asked PER PARENT with `perParentQuantities`; `plan.ts:650-674` refuses a plan that lacks such a step unless `unserved_steps` states why. `src/lib/agentMission/quantity.ts:230-238`: `perParentQuantities` keeps only a quantity with a number (`perEach` and a counted noun), or an implied people ask (`impliedPeopleAsk`, :251). **V (executed): for the five exact requests of the table, `perParentQuantities` returned `[]` for all four «مع كل التعليقات والردود» requests (FB, YT, TT, IG) and for the X request**, so the plan check demanded nothing. A plan without a comments stage (M20) or without a replies stage (M1, M2, M7, M15, M18) passes `validateAndPricePlan` and is stored at `agent/src/tools.ts:971-973`.
- The same sentence is parsed by about a dozen independent regexes, each deciding something else: `wantsReplies` (`replies.ts:247`: any «ردود»), `wantsAllChildren` (`allChildren.ts:13`: only «كل التعليقات»), `conditionsOfRequest` (`requestConditions.ts:17-28`), `engagedDefault`, `topicMeaningOf`, `wantsNewestOrDate`, `perParentQuantities`, the budget text in `runMission.ts`. `agent/src/tools.ts` re-concatenates `request_text + answer_text` 11 times and `runMission.ts` once (V: grep count 12). Nothing joins their answers into one object.
- `conditionsOfRequest` knows six classes and uses them only as ranking hints; it has no «comments», «source», «topic» class; it reads a count only from digits («فيديوهين» and «منشورين» are not counted) and an account only from `@` (V executed: `cond` for TT = `language, country, replies`; for IG = `replies` only, the account «حساب الحدث (alhadath)» is missed).
- The title-word habit of the same family: stage kind and per-parent matching by the WORDS of a stage title (`ownTitleWords`, `sameNounStem`, `plan.ts:361`, `plan.ts:651`); it made M15's «التعليقات الرئيسية» a people stage (V-R). Rule 9 of #342 stores the capability for the redesigned mode only.

### Cause 2. The plan is composed by the model and rewritten by ordered passes, with no gate after the last one (class B, F)

`agent/src/tools.ts` `propose_plan` handler (V: read in this session), in order: `validateAndPricePlan` (679) → people send-back (682-690) → derive recipes (699-717) → capability (719) → language column (721-726) → country send-back (729-739) → sort/query send-back (742-766) → account-page send-back (770-784) → comments recipe by code (787-804) → drop relevance (806) → contact columns (808) → contract columns (810-814) → replies stages (817-852) → complete count (855-930) → media send-back (934-949) → people-fallback line (951-956) → named-source send-back (959-970) → **store** (971-973). Six distinct send-back counters in `RunState` (`peopleSendBacks`, `countrySendBacks`, `sortSendBacks`, `accountPageSendBacks`, `mediaSendBacks`, `finishRefusals`; `tools.ts:101-115`), each added by one live round. Evidence that the ORDER is the defect: M6 (replies derived from the model's 800 comments before the count step cut comments to 40: 280), M9 (300 replies added after counters), M13 (a stage rewritten after an edit left 318 standing), M10 (replies priced before the sample said which comments have replies). Each was fixed by a new pass or a new field (`promise_total`, `replies_open`, `children_open`); none was caught by a check on the stored plan, because there is none: after line 971 the plan is final.

### Cause 3. A silent fallback to the old pipeline (class D, and the cause of M1-M7, M15 not showing the new rules)

`agent/src/redesign.ts:17-18`: `redesignStagesOf` returns the empty set (the old pipeline, byte for byte) when ANY stage's `engine.built_by` is not `"code"`; nothing is recorded about which stage or why, and the customer's card is the same. V: `pipe_new = 0` in M1-M7 and M15 (Q8, Q9). After the account gate was fixed (#332) the fallbacks continued for other reasons: M6 (replies stage with no `built_by`), M7 (comments stage with no recipe at all), M15 (a named-account listing stage never built by code). The old pipeline then removes rows by judgment (M1 `no_term` 30, M3 7, M5 10, M7 2), against the owner's rule. The only trace is the internal `pipe_new` counter.

### Cause 4. The listing tools read too little to choose from, and no sentence of the plan says so (class C)

V (Q10): the Facebook page listing `anyapi.facebook.user.posts` returned 3 rows a page and was read 2 times at planning in M1, M17, M19 (6 rows); the Instagram listing `scrapecreators.instagram.user.posts` returned 12 rows once (M15, M16). The planning guard that allows two reads of one source is in `agent/src/gateway.ts` (a forbidden file; not touched). Neither tool has a topic or a date input (V-R: `docs/S1-LIVE-FINDINGS.md` R4.1; the catalog profile), so «about AI», «last 3 months» and «most commented» are choices among the 6 or 12 newest, which are minutes old with 0 to 3 comments (M15, M16, M17, M19). Round 4 (#344) added the card sentences for this only when the request names a topic or period and only on its own code path; the condition is not checked end to end.

### Cause 5. The promise is an estimate; the delivery is what the source exposes (class B, E, F)

V: 14 of 20 missions promised a number that the source did not give. The numbers came from: the model (800 in M7, 130 in M3), a sample's mean (280 in M6, 300 in M9), a platform counter that counts replies and hidden items the source never lists (M10: 492 promised, 237 given after the last tool ended; M17/M19: counters 8 and 14, the same input read empty twice), or an edit that kept the estimate (M13: 620 shown, 342 delivered). The rule «promise = delivered» exists only in the owner's words; no code states, per stage, whether its number is a proven count or an open one.

### Cause 6. The tests describe invented worlds (why every round was green and the next live mission failed)

V: `tests/` holds 717 entries (files and folders); `tests/helpers` builds fake worlds per round (`benchWorld.ts`, `g4RepliesWorld.ts`, `g1World.ts`, `goldenWorld.ts`, ...); `tests/fixtures/live/` holds TWO stored live fixtures (M10 and M12 videos), used by 3 test files (V: grep). No test replays a stored mission through the current code. Each fix PR (#332-#344) proved its own symptom in a world built to show it; none could prove the absence of the next one (the S11 replies stage was in no world because «التعليقات الرئيسية» was nowhere; the M20 plan without a comments stage is not a world anyone built).

---

## 4. Why a per-platform patch can never end this

All 20 missions share five request shapes and fail the same classes A to F on different platforms. Fixing the symptom of one platform (S4 TikTok country, S10 X dates, S11 Instagram people-stage, Round 4 Facebook choice) moves the failure to the next platform or the next request wording, because the cause is the missing object (the contract) and the missing last gate, not a platform.

---

## 5. THE ONE DESIGN FIX

**5.1 The request contract (`src/lib/agentMission/requestContract.ts`, pure).** Built once, by code, from `request_text` and `answer_text`: `{platform, parent kind (posts|videos|tweets), count, source (named page/account/channel, or the official-channels kind), topic, country, language, period, comments (none|some|all), replies (none|some|all)}`. It reads the dual forms («فيديوهين»), the «كل» forms, an account in brackets, the source words after «صفحة / حساب / قناة / القنوات». Every call site that today re-parses the sentence reads this object instead (the 11 re-concatenations of `request_text + answer_text` in `tools.ts` become one `requestText`; no change of output with the flags off).

**5.2 The final gate (`checkPlanAgainstContract`, pure; called before the plan is stored, `tools.ts` after the last pass, and recorded as an internal event with counts only).** For every asked item the plan is one of: **carried** (a stage of the right capability exists; the tool input, a filter or a mark column carries the condition), **stated** (an honest Arabic line on the card, before approval, written by code), or **missing**. A missing STAGE (comments, replies) is sent back to the planner (at most two sends, with the catalog's tools for it), then written by code into `unserved_steps` («لم تُضَف إلى الخطة خطوة ...») so the card says it is not included and the customer chooses. A condition no tool field carries gets its code-written gap line; the plan is never stored with a missing item. This is the only place that knows what "the plan equals the request" means, for every platform.

**5.3 The silent fallback is recorded (`redesignStagesOf` returns the reason per stage), and the flags are per platform.** `redesign_flags` gains the keys `tiktok`, `x`, `instagram`, `facebook`, `youtube` (each defaulting to the existing type value `social_posts` / `social_account` / `social_comments`); rows in the admin toggle section with the same audit row; no SQL (one jsonb value of `agent_settings`).

**5.4 The replay is a permanent test.** `tests/replay-live-missions.test.ts` loads the 20 stored missions (`tests/fixtures/live/replay-missions.json`, built from the queries of section 7: request, stored stages, plan rows, delivered per stage, pipeline) and runs the contract and the gate over each stored plan. A new live mission is added to the fixture before its fix is written.

What is NOT claimed: the gate guarantees the plan says what it does not carry; it cannot make a source give more than it exposes. Cause 5 (the promise from a counter) is reduced by the gate's honest lines and by the existing `children_open` rule, not removed: a number is still a counter-based estimate where the source gives a counter. This document lists which stored missions allow the promise-equals-delivery check (section 6 of the PR report).

---

## 6. Not verified

The raw pages and the delivered files (storage); the platforms' own counters; the browser display of each card; why `scrapecreators.x.v1-facebook-post-comments` answered a post with comments as empty (M17, M19); whether a Facebook listing with more than 3 rows a page exists in the catalog beyond the sampled tool (the catalog was not re-read here); the ledger rows (money, out of scope).

## 7. Every query run (read-only `SELECT`; two failed on a missing column and were corrected)

Q1 columns of `missions`, `mission_events`, `mission_calls` (information_schema). Q2 a first mission list that used a column that does not exist (failed). Q3 missions of the test account created 2026-11-01 19:00 to 2026-11-02 17:30 UTC (id, Cairo time, status, reserved, charged, delivered units, request text). Q4 the keys of `plan` and the `files` column of one mission. Q5 the stage keys of one mission. Q6 per mission and stage: key, tool, planned rows, `engine.built_by`, `engine.all_children`, capability, number of pins, title. Q7 events of kinds plan, result, system, question, answer, edit, price_sealed for the five missions after 14:00 UTC. Q8 events of kinds plan, result, question and the `pipe_new` events for the missions before 14:00 UTC. Q9 `pipe_new` events of the five latest missions. Q10 `mission_calls` per mission, phase and tool (count, rows, status). Q11 the plan's summary, notes, assumptions, question and answer for M18 and M20. Q12 the events of M20.
