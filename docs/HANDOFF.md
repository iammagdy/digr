# Diger Platform Engineering Handoff & QA Status

This handoff document provides a clear, factual status of the Diger platform (`iammagdy/digr`) for engineering agents (Codex), developers, and the project owner.

---

## Replies in comments deliveries: comments AND their replies, one thread sheet (2026-11-01, after #326)

Base `main` = `357b0916ba721187956db768c8664e01cf883898` (#326). One branch, one commit per item (4), one PR. **No SQL, no migration, no Edge Function.** `finalize.ts`, `agent/src/gateway.ts`, `src/functions/**`, `supabase/**` are untouched; `price.ts` changes only `estimateModelCostUsd` (a price INPUT: a stage made by code adds no model planning or execution estimate) and one optional field of `StagePriceInput`; the charge formula, `settlementCharge`, the reserve margin and both caps (job 25,000 points; provider daily 0.80 USD) are unchanged. `delivered` for the settlement is still the rows of the file read back.

**Root cause (owner decision recorded in the older HANDOFF: child items are delivered RAW, researchers analyse FULL threads).** The audit's reference C had missed the replies, so no stage fetched them. Live G4 `msn_3da66037878465ffbfd5`: video `7699049713550593300` shows 25 in its own counter and delivered ONE comment (the comments source returns top-level comments; the rest of the counter are replies). The comment rows already carried `replies_count` (`reply_comment_total`), so nothing needed a new measuring call.

**Reply endpoints of the catalog, by platform** (computed from `data/treg/treg_catalog_sellable.json` by `replySourcesFor`: direct, synchronous, priced, same platform, every required input a comment id plus the video's id or link):

| Platform | Reply endpoints | Usable by the plan (cheapest first) |
|---|---|---|
| TikTok | 6 | `anyapi.tiktok.comment_replies` 0.0009, `tikhub.x.tiktok-web-fetch-post-comment-reply` 0.001, `tikhub.x.tiktok-app-v3-fetch-video-comment-replies` 0.001 (the routed `treg.tiktok.comment.replies` is not used: it bills a range) |
| Instagram | 5 | `tikhub.x.instagram-v1-fetch-comment-replies` 0.001, `anyapi.instagram.comment_replies` 0.0011, `tikhub.x.instagram-v2-fetch-comment-replies` 0.002 |
| Douyin | 3 | two TikHub endpoints 0.001, one dearer 0.01476 |
| Kuaishou | 2 | `tikhub.x.kuaishou-app-fetch-video-sub-comments` 0.001 |
| Bilibili, Zhihu, Xiaohongshu, WeChat Channels | 1 to 2 each | one or two (0.001 to 0.02214) |
| Facebook, YouTube, LinkedIn, Reddit, Weibo, WeChat MP | 1 to 5 each | **none the plan can feed**: they need a token only the comment's own page carries (`feedbackId` + `expansionToken`, `continuationToken`), a required cursor, or a comment link. Said on the card as «لا يتوفر لهذه المنصة مصدر نقرأ منه ردود التعليقات» |
| X, Threads | 0 | their «comments» ARE replies to the post: there is no nested endpoint |

**What changed, per item.**
1. **Reference and contract** (`docs/AUDIT-2026-11.md` section 1C, `taskContracts.ts`): comments tasks deliver the top-level comments AND replies; columns «نوع التعليق» («تعليق» / «رد») and, on a reply, «معرّف التعليق الأصلي»; the parent video's title and link on every row; the file states the source's own counter.
2. **Engine** (`replies.ts`, `engine/run.ts`, `tools.ts`): after the plan check, a code-built stage `<comments>_replies` is added under every comments stage that has a proven recipe, a reply source the plan can feed and a reply counter in the sampled comments (`replies_count`). The cheapest ranked source is used; its inputs are bound by the engine: the comment's id from the parent row, the video's id and link from the GRANDPARENT row (`parent_binding.also[].grand`). Each comment is read for its own counter up to a per-comment cap (`AGENT_REPLIES_PER_COMMENT_MAX` = 50) and its share of the approved total (`replyShares`: equal parts first, a small comment's unused part goes on); a comment with counter 0 is NEVER read; a comment is never replaced by a spare. Mapping code of a reply page is written by code (`buildReplyMapCode`; both provider shapes).
3. **Counting and price** (`repliesCard.ts`, `plan.ts`, `planEdit.ts`, `PlanEditor.tsx`, `runMission.ts`, `workbook.ts`): the customer's number counts the TOP-LEVEL comments; replies come in addition, priced by the same one rule (their provider cost is added, their rows are delivered rows), and the card says so in Arabic («العدد الذي طلبته يخص التعليقات الأساسية وحدها؛ ونضيف إليها ردودها بتقدير نحو ... ويدخل ذلك في السعر ... تقدر توقف الردود من «عدّل الخطة»»). The editor has one switch on the comments stage; the replies follow a change of the comments' number. A delivery is complete or partial by the top-level rows alone: fewer replies than estimated is never a shortfall; the notice tells a top-level shortfall as `planned = top-level planned + replies delivered`.
4. **Thread sheet and limits** (`workbook.ts`, `threadCounters.ts`, `methodology.ts`): the replies are rows of the comments' sheet, each right under its comment; the first sheet's row of the replies stage points to it; the methodology lists «عدّاد المصدر وما سُلّم» per video and puts the difference in «حدود هذا التسليم»: «عداد الفيديو ٢٥، سُلّم تعليق واحد و٢٣ ردًا؛ والفرق لم يعطِه المصدر».

**G4 price, replay in the live shape (fixture; expected cost, not a live run).** Without replies: 55 rows, unit 4.298, hold 272, max charge 237. With replies: 100 replies planned (2 a comment from the sample) at 0.0003 USD a row, 155 rows, unit 2.590, hold 462, max charge 402; the replay delivered 47 rows (5 videos, 9 comments, 33 replies) and charged 122. The model estimate is the same in both (the code-built stage adds none).

**Tests.** Base 8,043 passed, 57 skipped, 0 failed. Now 8,087 passed, 57 skipped, 0 failed. New files: `comments-replies-contract`, `reply-sources`, `comments-replies-g4-replay` (live shape), `comments-replies-price-card`, `comments-replies-thread`, helper `g4RepliesWorld`. **Zero lines of an existing test were removed or changed.**

**Decisions the code took that the owner may change** (all constants): per-comment cap 50; replies are added ONLY when the sampled comments carry a reply counter (never a blind paid read: without it the card says «المصدر لا يعطي عدد الردود»); the estimate of replies is the sample's mean over all the comments asked for.

**NOT PROVEN.** Live: the cheapest source `anyapi.tiktok.comment_replies` (its page size and whether it pages are not in the catalog; the fixture gives it a cursor); the real `replies_count` of the five live comments (the sample is one page of one video); that the video's own counter counts replies (the owner's reading; the file now shows both numbers side by side); how many replies the planner's mapping really carries on other platforms. No live run was made.

---

## PR 2 of the audit, «review to completion, honest price, faster plan» + the golden-run findings F1-F5 (2026-11-01)

Base `main` = `2e69f907d0d01b63a8d7325d30063781d63320b4` (#325). One branch, one commit per item, one PR. **No SQL, no migration, no Edge Function. `finalize.ts` has TEXT changes only (two closing sentences, no settlement line), `price.ts` changes only `estimateModelCostUsd` (a price INPUT; `chargeForDelivered`, `settlementCharge`, `priceMissionByCode`'s call of the rule are untouched), `agent/src/gateway.ts`, `src/functions/**`, `supabase/**` are untouched.** Caps unchanged (job 25,000 points; provider daily 0.80 USD).

**STEP 0, the two live golden missions of 2026-11-01 (TEST account, read-only SELECTs; times Cairo = UTC+2).**

| | G1 `msn_ecca2a0d074fef9f4456` (15:12) | G4 `msn_3da66037878465ffbfd5` (15:20) |
|---|---|---|
| request | 5 Egyptian electromechanical companies + decision makers | 5 TikTok videos, 10 comments each |
| plan / reserve / unit | 1,510 max, 1,737 held, 100.69 points | 200 max, 204 held, 3.636 points (the minimum) |
| delivered / charged | 13 of 15 / **1,310** (13/15 of 1,511) | 37 of 55 / **135** (37/55 of 200) |
| provider cost | 0.110766 USD (planning 0.005178, execution 0.105588) | 0.010700 USD (planning 0.0021, execution 0.0086) |
| model cost | 0.012398 USD (planning 0.011653, execution 0.000745: review 0.000577 + names) | 0.018338 USD (planning; execution 0) |
| **real cost** | **0.123164 USD** | **0.029038 USD** |
| charged / 550 / real cost | 2.3818 / 0.123164 = **19.3x** | 0.2455 / 0.029038 = **8.45x** |
| planning | 51.6 s, 8,924 output tokens | 125.3 s, 14,933 output tokens |
| share of the 0.80 USD daily cap | provider 13.8% (0.1108); all missions of that UTC day 0.2316 USD = 28.9% | provider 1.3% (0.0107) |
| ledger | `res_` -1737, `rel_` +1737, `chg_` -1310: balanced | `res_` -204, `rel_` +204, `chg_` -135: balanced |

**E-mail verifier calls (`mission_calls`, G1).** Companies' addresses: `tomba.companies.emails.list` 5 calls (3, 1, 10, 2, 10 rows, 0.0089 each) then the verifier per company: `contactout.people.email.verify` HTTP 429 (x3, 0 USD) then `millionverifier.people.email.verify` 200 (x3: 0.00178, 0.00178, 0.00000), and HTTP 200 (x2, 0 USD) for the other two = 5 verifier chains, 1 company «موثّق», 4 «غير موثّق». People's addresses: `dropleads.people.email.find` 8 calls (all HTTP 200, 1 row, 0.0000 USD; the plan's blitz and anyapi finders need a LinkedIn URL and were not called), 3 found, and `contactout.people.email.verify` 3 calls (HTTP 200, `ok`, 0.0000 USD): **the verifier WAS called**; the answer text is in storage (not readable by SQL), so the verdict word is NOT PROVEN; the catalog's own example answer of that verifier is `{"data":{"status":"accept_all"}}`, which the code reads as catch-all = «غير موثّق», and **the chain stopped at that first answer, the paid verifier next in the chain was never asked** (the root cause fixed in F3).

**F1 limits text** (`perParentLimits.ts`, `methodology.ts`). Cause: the sentence was written for companies and employees («موظفون», «شركة», «بقية الشركات») whatever the stage. Now the parent and child nouns are those of the stages' own titles (فيديو/تعليق/…): «٣ فيديوهات وُجدت فيها تعليقات أقل من العدد المطلوب، وزاد ٨ تعليقات عن العدد المعتمد في بقية الفيديوهات»; companies and people keep their words. Test `limits-task-nouns` (G4 replay).
**F2 video 7699049713550593300 (25 own comments, 1 delivered; 8 surplus).** From the per-page progress events of `msn_3da6…`: the comments were read page by page per video (cap 10): video 1 pages of 5 + 6 (5 kept, 1 surplus), **video 2: page 1 gave 1 comment, page 2 gave 0 (empty) so the stream ended with 1**, video 3 one page of 6, video 4 pages of 8 + 9 (2 kept, **7 surplus**), video 5 one page of 5. So 32 delivered, 8 surplus (1 + 7: a page's rows beyond the video's share are paid for and kept out, by design). Pagination and the cap worked as designed; **not a code bug found**. Likely cause (NOT PROVEN, raw pages in storage): the video's own count 25 includes replies and hidden comments, the source listed 1 top-level comment. **No fix**: the only code lever is replacing a video that delivers less than its share, and the recorded rule is «only a parent with NO child is replaced, nothing delivered is ever dropped» (`engine/run.ts`); changing it is an owner decision (proposed: replace a parent that delivers under half the share when a spare with a known count of at least the share exists; it drops that parent's comments).
**F3 e-mails «غير موثّق»** (`engine/contacts.ts` `emailStatusFor`). See Step 0: a catch-all or unknown answer now asks the NEXT verifier once more inside the step's priced cap; only «undeliverable» ends the chain; a later «deliverable» wins, a later catch-all stays «غير موثّق». A found address is still always written. The run now records what each verifier said as counts only (`ver_calls`, `ver_deliverable`, `ver_catch_all`, `ver_undeliverable`, `ver_unknown`, `ver_failed`, `ver_second_opinion`: an internal `call` event, no address, no provider) so the next run proves the verdicts. Test `email-second-opinion`.
**F4 HQ phone for 2 of 5** (`engine/contacts.ts`, `places.ts` `countryOfRequestText`). From the stored plan: the three sample rows of the companies source carry **no phone key** and the company step made a map search for **all five** companies, so the source's own phone was empty for all five (fill rate beyond the samples NOT PROVEN). Of the five searches: company 1 found by the third helper; company 5 found by the first; company 2 first helper empty and the second down (HTTP 503, twice: marked down), the third helper (`location` REQUIRED) not called; company 3 five places, none the company; company 4 five places none the company, third helper HTTP 502. «غير متوفر» was written only after a source answered. Fixes: (1) after a name search that finds no place that is the company, the same helper is asked once with the company's WEBSITE as the query (a place whose website is the company's domain is the company); (2) the country the customer's words name («مصرية» → EG, `countryOfRequestText`) is the company's country when its row says none, so a helper that needs a location is called. The rule «the place must be the company» is unchanged. Test `company-phone-recovery`. NOT PROVEN: the live yield.
**F5 titles and activity** (`titleLexicon.ts`, `namesAr.ts`, `workbook.ts`). Lexicon: «Business Owner», «Aftermarket Engineer», «Workforce Management», «Vendor Relationship Manager» and 25 more fields; an ACTIVITY lexicon of 60 common industries («Machinery Manufacturing» = «تصنيع الآلات»). What the lexicon misses (a title, an activity) goes in the SAME batched request that writes the names (tagged lines, each distinct text once), stored as cells `title_arabic` / `activity_arabic` and shown «العربية (English)» only when the answer is Arabic; a failed answer leaves the English. `NAMES_STEP_USD_PER_PERSON` 0.00003 -> 0.00007 (names + titles + activity share, 2x margin). Test `bilingual-titles-activity` (G1 replay: every title and activity cell matches «العربية (English)»).

**PR 2 item 1, review to completion** (`ingest.ts`, `review.ts`, `finalize.ts`, `constants.ts`). Found in code: (a) one ingest pass reviewed ONE slice (room x3 + 25) and left the rest waiting for a later round: it now goes slice after slice until the room is filled, every waiting item was reviewed, or a stop was recorded (the 40%-of-reserve ceiling is unchanged); (b) «بلغت حدّها المسموح» was said for ANY waiting item with no recorded stop at all: it is now said only for a recorded `budget` stop, a recorded `failed` stop says «تعذّر الوصول إليها», no recorded stop says only that the review did not complete; (c) a stop is logged with its cause (`review_stop <mission> reason=budget|failed spent= budget= ceiling= worst= calls= rows_reviewed= rows_left=` in the worker log). `AGENT_REVIEW_ROW_ESTIMATE_USD` 0.00004 -> 0.000018 (measured live 0.0000115 a row: 2 calls, 5,019 in / 150 out tokens, 50 rows). Why `msn_24d0…` said the limit was reached with 0.0000 recorded: NOT PROVEN (older code; the current code can only stop on `budget` when a call's worst case exceeds the ceiling, 0.145 USD for a 200-point hold, or on `failed`). Test `review-to-completion`.
**Item 2, price** (`price.ts` `estimateModelCostUsd`, `constants.ts`). Planning is priced by the plan's shape (0.008 base, +0.008 for each further stage: two stages 0.016, inside the live 0.0117-0.0211), the review by the measured per-row cost, the names/titles/activities per person. **G1 plan (the standard request): unit 100.58 -> 102.31 points, max charge 1,509 -> 1,535, hold 1,736 -> 1,765; expected provider 0.253 + model 0.026 USD; revenue / expected cost 10.00x. G4: unit 3.636, max 200, hold 204 (the minimum still sets it); expected 0.0102 + 0.026; ratio 10.06x.** NOT changed on purpose: the PROVIDER estimates. G1's real provider cost was 0.111 USD against 0.253 expected (the e-mail finders: the plan prices 0.106 USD of finder hits, the live run called one finder, dropleads, 8 times and was billed 0.0000 USD), so the live ratio stays about 19x until the owner decides to lower the finder estimates after more runs (n = 1 is not enough). Test `model-cost-priced-by-code`.
**Item 3, planning** (`plan.ts`, `taskContracts.ts` `knownColumnTitleAr`, `agent/prompts/system.md`, `tools.ts`). The model wrote three things the code holds: a title for every column, the sample rows, (since the engine) the mapping code. A column may now be given by its key alone when the contract or the field classes know its Arabic title (about 35 keys); `sample_rows` may be omitted: code takes the first rows of the cited `yield_from` output that match the stage's rule; the prompt says so. The lean call is under 70% of the characters of the full one (test). Targets (companies prompts at most 90 s, none above 240 s, at most 15,000 planning output tokens): **NOT PROVEN until the next live golden run** (live today: G1 51.6 s / 8,924 tokens, G4 125.3 s / 14,933 tokens; both already inside the token target).

**Tests.** Base `2e69f90` (clean worktree): 648 files (5 skipped) / 8,011 passed, 57 skipped, 0 failed. This branch: 655 files (5 skipped) / 8,043 passed, 57 skipped, 0 failed; `tsc --noEmit` clean (site and `agent/`); `npm run build` clean, zero client-bundle secrets. New test files (each red first): `limits-task-nouns`, `email-second-opinion`, `company-phone-recovery`, `bilingual-titles-activity`, `review-to-completion`, `model-cost-priced-by-code`, `plan-by-code-fields`. **Changed existing test lines: 24 removed lines in 6 files, each marked `CHANGED`:** the pinned prices that move with the new model estimate (`mission-7-plan`, `mission-10-replay`, `people-step-implied`: holds +8%, one-stage plans 0.004 USD cheaper, `agent-mission-run` and `agent-relevance-and-pricing` re-derive from the constants) and `company-columns-replay` (Suez gets one more map search, the website query).
Rollback: `git revert -m 1 <merge commit>`.

---

## PR 1 of the audit, «the reference as code» (2026-11-01): what was built and what the owner DECIDED

Base `main` = `a4d7f86f4f4aac77c5d1cf60267f6fa94c02ff0a` (#324, `docs/AUDIT-2026-11.md`, the accepted reference and fix plan). Four commits, one per part, one PR. **No SQL, no migration, no Edge Function; `finalize.ts` (settlement), the charge formula of `price.ts`, `gateway.ts` caps, `src/functions/**` and `supabase/**` are untouched.**

**Owner decisions (recorded as DECIDED in section 9 of the audit doc):** (1) a one-sheet companies file (PR 3) is charged for companies + people (15 for the standard request), PR 1 does not change the counting; (2) the provider daily cap stays 0.80 USD until the first live golden run measures the real cost; (3) names and titles as «العربية (English)»: titles by a code lexicon, names by ONE small batched model request per mission, its cost added to the price by code; (4) the minimum price of a post-delivery edit (PR 3) is 20 points.

**a. The reference as data** (`src/lib/agentMission/taskContracts.ts`, `fields.ts`, `plan.ts`). `TASK_CONTRACTS` holds, per task type (companies_people, companies, posts, comments, places), the columns of the file in order and who fills each (source, step, code); `OWNER_SHEET_HEADERS_AR` is the owner's hand-built sheet header by header. `fields.ts` has five new classes (phone, e-mail, address, review count, activity); a place's review count used to read as «views». `contractIssuesFor` refuses a plan whose company stage drops the sector, HQ phone, address or e-mail the source gave, or whose place stage drops the phone, address, rating or review count (stages of posts, comments and people are checked by the generic rule only). `withContractColumns` puts a company's and a decision maker's columns in the owner's order and under his titles; `bindCompanySteps` points the company steps at the columns the file has.

**b. The company's own e-mail and HQ phone** (`contactFinders.ts` `buildCompanySteps` / `mailboxListerSourcesOf` / `companyMailboxIn`, `engine/contacts.ts` `runCompanyStage`, `workbook.ts`). `contact_steps` now also holds steps with `level: "company"` (the people's steps have no level). E-mail: the cell the source gave, then the role mailboxes the PEOPLE source returned for the company (kept aside as not-a-person rows), then the mailbox listers in order; only a role mailbox on the company's own domain (info@ first); verified by the verifier chain, «موثّق» / «غير موثّق». HQ phone: the source's own value is kept (zero cost); only a company with none is looked up on a map search, once. «غير متوفر» is written only when a source ANSWERED and had nothing; a company every lookup of which failed, or that the budget did not reach, stays empty. The company steps run FIRST, before the people's. The people's company-phone fallback does not repeat the search the company step already made. Other role mailboxes found for a company stay in «إيميلات عامة للشركة» (never dropped). The price carries the steps by code (first lister + verifier, the map search): **the standard request went from unit 80.73 to 100.58 points, max charge 1,211 to 1,509, hold 1,393 to 1,736; expected provider cost 0.198 to 0.252 USD (24.8% to 31.5% of the 0.80 USD daily cap), computed worst case 57.4% to 65.1%.**

**c. The people's columns** (`workbook.ts` `layoutOf`, `titleLexicon.ts`, `namesAr.ts`, `perParentLimits.ts` `companiesWithoutDecisionMakers`, `runMission.ts`). Every sheet of a «companies and their decision makers» file starts with «م» (a running number of the rows of that sheet); the person sheet has «صانع قرار» («نعم» for a decision-maker title, «لا» otherwise) and a last «ملاحظات» column; a company whose delivered people hold no decision maker (or that has none) gets «لم نجد صناع قرار في هذه الشركة» on its own row and on its people's rows. A title is «العربية (English)» when the lexicon reads it (a title it cannot read stays English: nothing is guessed); a name is «العربية (English)» when the one request wrote its spelling (a failed or unusable answer leaves the English name). The request goes through the same `reviewCall` the review uses, after the people are final; its cost comes from the API's usage and is added to the mission's model cost (not a charge); the plan's price carries `NAMES_STEP_USD_PER_PERSON` (0.00003 USD) per person of a decision-makers stage.

**d. Comments** (`engine/run.ts`, `engine/spec.ts`). A parent whose own count field (comments, replies, reviews) is 0 is not read: a spare parent that has comments takes its place, as it does for a parent the source answered nothing for (`ownChildCount`). A child source that takes both the platform id and the link (the routed sources) is called with both in the same call (`parent_binding.also`); a measuring call that passed both used to leave the stage without a recipe.

**Not changed on purpose:** the review limit (PR 2), the planner's prompt and planning time (PR 2), the one-sheet layout and edit-after-delivery (PR 3), the counting of delivered items, the caps. **NOT PROVEN until the live golden run:** the fill rate of the source's phone and address for Egyptian companies, any lister answer for an Egyptian domain, the live cost of the company steps, the real Arabic spellings the model gives, the title lexicon's coverage of real titles.

---

## Post-merge facts of #321 and #322 (2026-11-01)

- **#321**: head `60a9541bde7adfdd165fa06ce458f902658a18e8` (preview `dpl_8cFhryX3hUCu18YVRxPMvJeKub8u` READY on it); merge `f2c7cff523f205ad49ea3b00b9104ac1c3536405`, parents `f53e73f85f486293851a46d2eafdc928016d0e32` and `60a9541bde7adfdd165fa06ce458f902658a18e8`; production `dpl_9Zzmm9ZduU7sjp2RaCAktdbcFoLA` READY on that SHA (aliased to diger.tech), about 3 minutes after the merge (10:25 UTC). 15 minutes after the merge (read-only SELECTs, 10:40 UTC): no mission was created or updated in the window and `credit_ledger` had 0 rows in it (nothing to balance); the TREG main key (number 5) `connected`, reason `ok`, balance 6.1797 USD (checked 10:37 UTC).
- **#322**: head `71f8c3ab96c00d84f2cf0382ef4510e98dd98e7b` (preview `dpl_3z34hUPFcX75cv2WpkBsr9GmxSft` READY on it); merge `52a9c077ecc20920268599ae988ede3ceb754533`, parents `f2c7cff523f205ad49ea3b00b9104ac1c3536405` and `71f8c3ab96c00d84f2cf0382ef4510e98dd98e7b`; production `dpl_6LU9fs3rD1AYoJ3pUgKWpgFG27aG` READY on that SHA (aliased to diger.tech), about 3 minutes after the merge (11:17 UTC). 15 minutes after the merge (read-only SELECTs, 11:33 UTC, 15m34s after it): no mission was created or updated in the window and `credit_ledger` had 0 rows in it (nothing to balance); the TREG main key (number 5) `connected`, reason `ok`, balance 6.1797 USD (checked by the pool health run at 11:32 UTC). Heroku: NOT CHECKED (no access from the session).
- **No live test of #322 has run yet**: the first mission after it is the proof of the new price (expected hold about 1,393 points and provider cost about 0.198 USD for the standard request) and of the depth reading.

---

## START HERE (2026-11-01, after #321): the owner opens the two limits (contact budgets and people depth)

`main` before it was `f2c7cff523f205ad49ea3b00b9104ac1c3536405` (#321). Four commits, one per item, one PR. **No SQL, no migration, no Edge Function.** The diff against main of `finalize.ts`, `runMission.ts`, `gateway.ts`, `price.ts`, `callBudget.ts`, `missionPricing.ts`, `src/functions/**`, `supabase/**` is EMPTY: no ledger, settlement, reserve rule, cap (`JOB_MAX_POINTS_CAP` 25,000; provider daily cap 0.80 USD) or pricing constant changed. What changed is what the plan PRICES (the cost inputs) and what the engine may SPEND inside the step's own cap.

**Owner decision (after the #321 report):** open both limits; customers see the price before approval and pay for real results; a higher price is fine.

**Measured data behind the new constants** (read-only SELECT on `mission_calls`, every phase, 2026-11-01; a hit = a call the provider BILLED for an answer, these finders bill a found value only): e-mail: blitz 9 hits in 42 calls (21%), quickenrich 0 in 14 (it answers «ok» for every call but gives a phone-only answer, free), anyapi 5 in 5, dropleads 1 in 1, others 0 to 1 in 1 to 4; phone: blitz 2 in 21 (10%), quickenrich 0 in 11, tomba 1 in 2, aiark 1 in 3. No e-mail verifier call has ever been made live (0). Stored in `src/lib/agentMission/finderStats.ts` with the query; the hit rate used is (hits + 0.5) / (calls + 1), an unmeasured finder takes the pooled rate of its kind (e-mail 16.5 / 73, phone 4.5 / 39).

**1. Budgets** (`contactFinders.ts`, `finderStats.ts`, `engine/contacts.ts`). Root cause: the price assumed one person in ten needs the dearer finder (`FALLBACK_MISS_SHARE` 0.1) and the cap WAS that price (0.0024024 x 8 = 0.0192 USD), so the first person's 0.011 USD hit used it up. Now: the step's PRICE (`per_person_usd`) is the expected cost of the chain from the measured hit rates (a hit is billed, a miss is free: `bill: success`), the verifier for the share of persons an address is found for, the company-phone search for the share no personal number is found for, the validator for every phone; its CAP (`max_person_usd`, new, optional: a stored plan without it keeps its old cap) is the WHOLE chain at full price for every person, so every delivered decision maker goes through every finder and the verifier. `FALLBACK_MISS_SHARE` and `EMAIL_FOUND_SHARE` are gone. The default count of people per company is now lowered for the price of the READING alone (the paid lookups and the depth are never cut to fit the old 600-point target).
**Chain ranking** (`contactFinders.ts`): finders are ranked by price over measured hit rate (the cost of a FOUND value), not over the HTTP success rate; and a finder dearer than `FALLBACK_FINDER_MAX_USD` 0.02 per call is not part of a chain (the live catalog has enrichlayer 0.1 USD on EVERY call and tomba phone 0.0445 a hit: measured with the catalog unfiltered by the data policy, enrichlayer in the phone chain made the standard request's hold 6,695 points instead of 1,393). Result for a customer (data policy applied): e-mail blitz, anyapi, dropleads (1 hit in 1 call: thin data) then a verifier (contactout free, millionverifier, dropleads); phone blitz, quickenrich, then the company's phone (map search) and a validator (hlrlookup). Tomba phone (0.0445) is out of the chain: a personal phone beyond blitz is NOT PROVEN worth it (tomba 1 hit in 2 calls); the company phone is the fallback.

**2. Depth** (`engine/run.ts`, `plan.ts`, `constants.ts`). Root cause: aviato gives 5 people a page and the engine read page 1 only, taking the top two of the page. Now a people stage that prefers decision makers (`pages_per_parent`, default `AGENT_PEOPLE_PAGES_DEFAULT` 3, max 10) reads up to that many pages for each company, stops early once enough decision makers (tier 0) were SEEN for it, and a decision maker read on a later page takes the place of a lower title accepted from an earlier page through the store's existing `swap` op (the company's delivered count does not change). The stage's total target no longer stops the reading of a company's later pages (the last company would have kept its page-1 people). The price carries every page: pages x one page's cost (`page_cost_usd`, the measuring call's cost) / people for each company (`depthCostPerRowUsd`), 0.0075 USD a person (before 0.001 a row). A plan stored before has no `pages_per_parent` and reads one page.

**3. Card and editor** (`plan.ts` `priceIncludesLinesAr`, `planEdit.ts`, `PlanEditor.tsx`). The card says in one plain sentence what the price includes (the deeper search, up to N pages for each company, and the e-mail and phone lookup for each person) and where to lower it; the editor has «عدد صفحات البحث لكل شركة» (1 to 10) beside the people for each company; the edit is validated (a whole number, only on a stage read in depth) and the plan is priced again by the same function.

**4. The standard request** «عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون» (live shapes: tomba companies 0.000178 USD per 50, aviato 0.005 USD a page of 5, the catalog's chains under a customer's data policy; `tests/standard-request-price.test.ts`): unit price **80.73 points** (before 24.81), the most that can be charged **1,211 points** for 15 items (before 373), hold **1,393** (before 429), 2 people for each company kept, expected provider cost **0.198 USD** (before the plan's estimate 0.0454): pages 0.075 + e-mail 0.106 + phone 0.017. Inside the job cap (25,000) by a wide margin. **Daily cap share: expected 24.8% of 0.80 USD; worst case** (every page read, every person through every finder and the verifier) **0.459 USD = 57%**, below the job's own call budget (1.013 USD for that hold); the gateway still refuses past the daily cap. Real cost of the #321 mission for comparison: 0.0392 provider + 0.0211 model USD for 373 points.

**Tests.** Base `f2c7cff`: 629 files / 7,930 passed, 57 skipped. This branch: 635 files / 7,959 passed, 57 skipped, 0 failed; `tsc --noEmit` clean (site and `agent/`); `npm run build` clean, zero client-bundle secrets. New: `contact-budget-measured`, `contact-chain-ranking`, `people-depth-replay`, `people-depth-price`, `people-depth-card-editor`, `standard-request-price`; each was red first. Changed existing test lines: 15 removed lines in 8 files, each with a `CHANGED` comment or a justified mechanical import: `contact-finder-step`, `contact-money-limits`, `email-verification-chain`, `phone-chain` (the price formula is the measured chain, not the guessed shares), `people-step-implied` (the pinned holds carry the depth; the 600-point target is read on the reading alone), `live-run-8-replay` (the fake provider's queue gets the second page of a company with fewer than two decision makers), `contact-benchmark-replay` (the name-only finder of the new chain is recognised as the same person).

**NOT PROVEN (the live test is still required).** The measured rates rest on 3 missions (a handful of calls for dropleads, tomba, aiark); that decision makers beyond page 1 exist for these sources (the page contents are in storage, not readable by SQL); the live yield of verifiers (none was ever called); how many pages a typical company really needs (priced at the full 3, stopping early costs less); the real provider cost of the next live standard request against 0.198 USD expected.
Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-11-01, after #320): the live test of 11:38 Cairo (e-mails 0 of 8, wrong company, titles, names, limits text, reason label)

`main` before it was `f53e73f85f486293851a46d2eafdc928016d0e32` (#320, docs only; parents `edb6f7fb14fc82dd773ca86806a4ed30d391b99c` and `1c97794cc972bcdb809eeff86b0237b22d8a6b93`). Six commits, one per item, one PR. **No SQL, no migration, no Edge Function.** The diff against main of `finalize.ts` is ONE added entry of the text map `REASON_TEXT_AR` (item 6); `price.ts`, `runMission.ts`, `gateway.ts`, `src/functions/**`, `supabase/**` and every ledger, settlement, cap (`JOB_MAX_POINTS_CAP` 25,000; provider daily cap 0.80 USD) and pricing constant are untouched.

**Evidence (read-only SELECTs, TEST account): mission `msn_7539ea17512cf58aa0e7`** (2026-11-01 09:36-09:40 UTC, plan price 373, reserve 429, delivered 13, charge 323). Calls: 55 (3 planning, 52 execution), provider cost **0.039201 USD** (planning 0.005178, execution 0.034023: `aviato.companies.employees` 5 x 0.005 = 0.025, `anyapi.linkedin.email.work.find` 1 x 0.011, maps searches 0.0023, `blitzapi.people.phone.find` 0.000495, companies source 0.000356); model cost 0.021056 USD (planning; execution 0.000000); total 0.060257 USD. The plan's own provider estimate was 0.045353 USD. The owner decides pricing; no constant was changed.

**The e-mail chain per person (8 people; from `mission_calls`, plan `contact_steps`, code):** for each of the 8 (in the engine's order: Mohamed Saied, Ahmed Elsayed, Michael Ayad, Mohamed Hassan, Mai Maher, Hassan Mohamed, Hendawy Fathy, Shahenda Elhoury): finder 1 `blitzapi.people.email.find` called, answer EMPTY (cost 0); finder 2 `quickenrich.people.email.find` called, `ok`, 1 row, cost 0.000000 (the catalog says a phone-only answer is free: no address); finder 3 `anyapi.linkedin.email.work.find` (0.011): called for the FIRST person only (call_0013, `ok`, 1 row, **0.011 billed = a hit**) and NOT called for the other seven: the step's priced cap is `per_person_usd` 0.0024024 x 8 = 0.019219 USD and the first hit spent 0.011 of it, so a second 0.011 call did not fit (arithmetic from the plan; the skip is not logged). **No verifier was called for anybody** (contactout, millionverifier, dropleads were in the plan; nothing reached them). Cell: empty for all 8; the engine's own count was «وُجد لـ ٠ من ٨». The previous run (`msn_4969…`, #318 code) had 4 hits at the first finder; this run's first finder missed all 8 (different people), so the regression is partly the data and partly the code below.

**Root causes and fixes.**
1. **E-mails** (`contactFinders.ts` `foundContactIn`, `engine/contacts.ts`): the extractor knew only keys named like `email` / `work_email`; a billed hit whose address sat under `address`, `emailAddress`, `professional_email`, `value` or a `mailto:` link produced no value, so the cell stayed empty and the 0.011 USD bought nothing. It now also reads any key with «mail» in its name and any value that IS an address (a masked value or `email: null` is still no value). A call that throws is a failed call (next finder or verifier), and a verifier failure, a 429 or a thrown error cannot remove a found address: the cells are always written with «غير موثّق» unless a verifier says deliverable. The free verifier answering 429 already fell through to the next ranked verifier (tested: 2 failures, then the next verifier answers). NOT PROVEN: the exact key of the live `anyapi` answer (raw pages are in storage, not readable by SQL); the shapes in the test are the ones the extractor missed. **Not changed on purpose:** the step cap that starved the third finder for people 2 to 8 (a price decision: `FALLBACK_MISS_SHARE` 0.1 assumed 1 in 10 people needs the dearer finder; here it was 8 of 8).
2. **Wrong company** (`companyIdentity.ts`, `engine/run.ts`): the people source answers `employees[].{companyName, person, positionList}`; the confirmation read only `experiences`/`positions`, so it had NO evidence and judged nobody («Hassan Mohamed», title «عامل», company «Ecologi», Beni Suef, was delivered under «365 Ecology»). Now `positionList` and the employee-level company are evidence, the row's own `company` cell is the fallback, and the current company must match by domain or by the normalised FULL name (`companyNameMatch`); a partial match («Ecology» in «365 Ecology») is accepted only in the same governorate; a combined company name («a \\ b») names the company by each part; a company «name» that is only a domain counts as the domain. One existing fixture line changed: `tests/mission-12-replay.test.ts` gave a slug («co-2») as the people's company name; it now gives the company's name.
3. **Decision makers** (`roles.ts`): «unclear» and «other» titles were one group in the page's order, so «عامل» and «محاسب» took places when the page held no manager. Four tiers now (decision maker, unreadable, other role, lowest: worker, accountant, intern, trainee, junior, driver...); a junior or intern with «manager» in the title is the lowest; the limits row says how many delivered people are not decision makers and in how many companies. NOT PROVEN: the source gives 5 people a page, so a decision maker beyond the first page is never seen (reading more pages costs money; not changed).
4. **Names** (`companyNames.ts` `tidyCompanyName`, `ingest.ts`): stray backslashes, quotes and leading/trailing separators are removed from company name columns and the company cell of people rows (the live name also fed the map query of the company-phone step).
5. **Limits text** (`agent/src/perParentLimits.ts`, `methodology.ts`): a child stage's shortfall is said from the recorded per-company counts («شركة واحدة لم يُعثر فيها على موظفين، وزاد ١٢ شخصًا عن العدد المعتمد في بقية الشركات»); the older stop-reason sentence stays when nothing per company explains it.
6. **Reason label** (`finalize.ts`, label only): `not_at_company` = «لا يعمل حاليًا في هذه الشركة (شركته الحالية غير الشركة المطلوبة)»; before, «سبب آخر».

**Tests.** Clean main: 623 files / 7,878 passed, 57 skipped. This branch: 629 files / 7,930 passed, 57 skipped, 0 failed; `tsc --noEmit` clean (site and `agent/`). New: `email-found-never-lost`, `person-company-strict`, `decision-makers-first-titles`, `company-name-tidy`, `limits-live-7539`, `not-at-company-reason-text`; each was red first. Changed existing test lines: 1 (above).
Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-11-01, after #319): the contact chain (right company, verified e-mail, company phone, priced and capped), plus the post-merge facts of #318

`main` before #319 was `17119153261e97767337eaa21f64c14d2a3f30df` (#318). **No SQL, no migration, no Edge Function.** The diff of `finalize.ts`, `price.ts`, `runMission.ts`, `gateway.ts`, `src/functions/**` and `supabase/**` against main is empty: no money function, ledger, settlement, cap (`JOB_MAX_POINTS_CAP` 25,000; provider daily cap 0.80 USD), markup, reserve rule or model string changed.

**Post-merge facts.**
- **#318**: merge `17119153261e97767337eaa21f64c14d2a3f30df`, parents `964bfd3a820b89cba8342eca3aa1e2510f84a621` and `58c5fcf4b9dc2429d8065c3a082c6f0a0551877e`; production `dpl_7gkHAMVMTFRz95LRhQPHxiNJHqFG` READY on that SHA. Its live test is `msn_4969a50fed8c45b37d8f` (A1, 2026-11-01 07:24 UTC, 15 delivered, charge 203 of reserve 234).
- **#319**: head `569767f131e872827c2971e3b8e1c6cb4f6d4a5f` (preview `dpl_8tMpKfjGs74NfUsj3KJUs2d5k5dK` READY on it); merge `edb6f7fb14fc82dd773ca86806a4ed30d391b99c`, parents `17119153261e97767337eaa21f64c14d2a3f30df` and `569767f131e872827c2971e3b8e1c6cb4f6d4a5f`; production `dpl_C4gj9edPB3FJw2Jd1b2MdeAtkZMu` READY on that SHA (aliased to diger.tech), about 3 minutes after the merge.
- 15 minutes after the merge (read-only SELECTs, 09:16 UTC): no mission was created or updated since the merge and `credit_ledger` has 0 rows in that window (nothing to balance). The TREG main key (number 5) was `connected`, reason `ok`, balance 6.2189 USD, last checked by the pool health run at 09:09:03 UTC (after the merge at about 09:01 UTC). Heroku: NOT CHECKED (no access from the session).

**What A1 showed (read-only evidence, `msn_4969…`).** The call log has `blitzapi.people.employee-finder` called with `company_linkedin_url=https://linkedin.com/company/mycompany` (call_0008) and quickenrich e-mail calls with `company_url=falconmisr.com` for people of that company (call_0016, call_0018): wrong-company people, a US number and an e-mail on another company's domain marked «موثّق», and «موثّق» with no verifier call.

**Fix (one commit per item).**
1. **People at the right company** (`companyIdentity.ts`, `engine/run.ts`, `ingest.ts`): a placeholder or generic company link is never the people key; the source's own `experiences[]` is read from the raw page and a person is delivered only if a CURRENT job (`job_is_current` true or no end date) names the company by domain or name; otherwise the person is kept with reason `not_at_company` (not delivered, not counted, not charged; the company's next people take the place). A person with no experience in the answer is not rejected. `not_at_company` has no dedicated Arabic text (generic «سبب آخر»): the text tables are in `finalize.ts`, which was left as on main on purpose.
2. **E-mail chain** (`emailVerification.ts`, `contactFinders.ts`, `engine/contacts.ts`, `ingest.ts`): finder, fallback finder, verifier; «موثّق» only when a verifier says deliverable (safe/valid, not catch-all); «غير موثّق»; «غير موثّق لهذه الشركة» when the domain differs from the company's (no verifier is paid for it); a found value is never dropped; ingest never writes «موثّق». Helpers are ranked and PRICED by what one call really costs (the general ranking divided a per-call price by the expected rows per call and under-priced per-call finders five-fold).
3. **Phones** (`phoneValidation.ts`, `places.ts`): personal phone first, else the company's phone (its own data, else ONE map search per company, accepted only when the place is the company) in the person row; new column «نوع الرقم» («شخصي» / «رقم الشركة»); every phone validated; a number of another country than the company's is «رقم من دولة أخرى»; «موثّق» only when validation passes.
4. **Price and limits**: `stagePriceInputs` adds the verifier, the company-phone search and the validator; the engine takes the people decision makers first, each with every step before the next, each step capped by its price x people, the job budget (40% of the reserve's value) ending everything.

**A1-style plan price (replay world, 5 companies, 10 people).** Before (#318 rule): provider 0.01123 USD, unit 13.33 points, reserve 211, full charge 200. After: 0.04282 USD, unit 23.77, reserve 410, full charge 357. The owner's benchmark spent 0.031389 USD for 10 people, so this assumes about 36% more. Two NAMED ASSUMPTIONS of mine (not measured) set it: `FALLBACK_MISS_SHARE` 0.1 and `EMAIL_FOUND_SHARE` 0.8 in `contactFinders.ts`.

**Report: ISSS «Oula, Michigan» for an Egypt search.** The companies stage reads `tomba.companies.search.reveal` with `location_country include EG`; city and governorate cells are copied verbatim from the source. The place rule fails a row whose place text names ANOTHER country, but only countries and cities of `places.ts` count, and neither «Michigan» nor «Oula» is there (the US entries are 14 cities); a row of a source that was asked for the place and shows no contradicting evidence passes (`placeVerdict … bySource`). Why the source returned a US company under an Egypt filter is NOT PROVEN (item rows are in storage, not readable by SQL; the plan carries 3 sample rows, none ISSS).

**Tests.** Clean main: 618 files / 7,804 tests passed, 57 skipped. #319: 623 files / 7,878 passed, 57 skipped, 0 failed; `tsc` clean (site and `agent/`), `npm run build` clean, zero client-bundle secrets. Changed existing test lines: 13 removed lines in `contact-enrichment-engine`, `contact-enrichment-replay`, `contact-finder-step`, `people-without-contact-replay`, each with a `CHANGED` comment.

**NOT PROVEN (the live test is still required for «done»).**
- `orbisearch.people.email.verify` (the owner's benchmark verifier, 0.00124 USD) is NOT in the catalog snapshot (3,276 endpoints, describe pass 2026-10-27), so the block list would refuse it. Ranking is catalog-driven and will pick it once the snapshot lists it (owner catalog update); today's first verifiers are `contactout` (free, HTTP 429 in the benchmark), `millionverifier` 0.00178, `dropleads` 0.0018.
- The live answer shapes of the verifier, the map search and `hlrlookup.people.phone.validate` (read from catalog examples and the brief, not from live calls).
- Person confirmation applies on the engine path; a mission carried out by the model (a plan with no proven recipe) is not confirmed.
- The price assumptions above; real yield of verified e-mails and company phones; the live TREG pool health after the merge beyond the 09:09 UTC reading.
- Rollback: `git revert -m 1 edb6f7fb14fc82dd773ca86806a4ed30d391b99c`.

---

## START HERE (2026-11-01, after #317): the finder steps (empty e-mail and phone cells for decision makers, diagnosed and fixed)

`main` before it was `964bfd3a820b89cba8342eca3aa1e2510f84a621` (#317). Four commits, one per item, plus test updates. **No SQL, no migration, no Edge Function.** No money function, ledger, settlement, cap (`JOB_MAX_POINTS_CAP` 25,000; provider daily cap 0.80 USD), markup, reserve rule or model string changed: the charge is still `ceil(delivered x unit)` of the count read back from the file, and the new step adds no row.

**Evidence (read-only SELECTs, TEST account).** The final live test is `msn_7a8b10f446e56bb66cc4` (A1, 2026-11-01 05:22-05:30 UTC, 15 delivered, 200 points) and `msn_020c92a0bc1cca3a54a7` (A2, 05:33-05:40 UTC, 9 delivered, 120 points): 200 + 120 = 320. (The brief's «19:30-19:45 Cairo» does not match any mission; these two are the only ones after #317.) The e-mail run is `msn_51bd…` (A1) and `msn_82a2…` (A2) of 2026-10-31 16:15-16:25 UTC.
- **a. Did the approved plan contain a finder step?** No, in both. `plan.stages` = companies + people (2 stages, event `plan` says `stages: 2`); the people stage maps `email: ''` and `phone: ''` (columns kind `work_email` / `phone`). Text that let the planner skip it: `agent/prompts/system.md` rule 6 («a verified value fills it, an unverified one leaves it empty», «A finder that was refused or not sampled is no reason to drop the contact column: keep it and say in one line of assumptions_ar … that the e-mail and phone cells are filled only if found during the approved job») and `contactSampling.ts` `contactSampleMessage` («Write in the plan … that the e-mail cells are filled only if found during the approved job»). A2's own assumption line: «مصدر الإيميل والتليفون لم يُختبر بعد، فتُملأ الخانات فقط إن وُجدت أثناء التنفيذ المعتمد». In A2 the planner's e-mail finder sample was REFUSED twice (`contact_sample:email_cheapest_first`, 05:34:08 and 05:34:10: it asked for `blitzapi.people.email.find` while the gateway's first-ranked finder was another); no phone finder was sampled.
- **b. Did the engine call a finder?** Nothing in the engine ever called one: no code path looked up a contact. In A1 the companies stage has no `engine` recipe (`engine: false`), so the MODEL carried the execution out; it improvised 12 `blitzapi.people.email.find` calls (input `person_linkedin_url`, 05:29:52-05:30:00: 11 empty, 1 hit `mina-naguib`, cost 0.000495) and one `blitzapi.people.phone.find` (1 row, cost 0.000000), plus one planning hit (`salah-elkomy`, 05:22:27). No hit reached the file: the item store only stores what the stage mapping gave (`email: ''`), and no step wrote a found value into a person's row. The exact rows of the file are not readable by SQL (NOT PROVEN beyond that). A2: `engine: false` on the people stage, 6 `employee-finder` calls (1 with rows, 5 empty), 0 finder calls in execution.
- **c. Inputs for the 14 people.** Every delivered person has the name and the professional page (`linkedin`), and every company has its web domain (A1: elarabygroup.com, fresh.com.eg, alumisr.com …). Cheapest-ranked e-mail finder from the catalog: `blitzapi.people.email.find` takes `person_linkedin_url` (0.000495 USD, a miss is free); next ranked `tomba.people.email.find` takes domain + full name (0.0089), `quickenrich.people.email.find` takes page or name + company; phone: `blitzapi.people.phone.find` (`person_linkedin_url`, 0.000495). Proven by the 13 live calls above made with exactly these inputs.
- **d. What the 2026-10-31 e-mail run did differently.** Its people stage was `tomba.companies.emails.list` (an e-mail LISTER by company domain, 0.0089 per call, personal addresses with names and positions), column `email: work_email` filled straight from the source rows. #316 (F1) removed the lister as a people source (8 of 9 rows had no name) and made every contact come from finders per person; nothing was added to run those finders, so e-mails vanished.

**Fix.**
1. **Planner / instructions** (`contactFinders.ts`, `plan.ts`, `tools.ts`, `prompts/system.md`, `contactSampling.ts`, `peopleCheck.ts`): `validateAndPricePlan` builds `plan.contact_steps` BY CODE for every delivered people stage of a request that asks for an e-mail or a phone (e-mail, then phone), finders ranked cheapest first (max 3); the contact column and a status column «حالة توثيق …» are added after the engine recipes are proven; prompt rule 6 and the sample-refusal text were rewritten (the sample cap limits sampling only). A note or a refused sample cannot remove the step.
2. **Engine** (`agent/src/engine/contacts.ts`, new item-store op `cells`, `ingest.ts`, `workbook.ts`, `runMission.ts`): after the stages (engine and model path) each delivered person is looked up: decision-maker titles first, up to three ranked finders per person and kind, e-mails first then phones, a miss goes to the next finder, the first value ends the person. Cells get the value and «موثّق» / «غير موثّق» (verified = passes the code check and the source does not say invalid; a masked value with stars is no value). Unverified values that look like an address or phone are now KEPT (ingest) with «غير موثّق»; before they were emptied. Limits: the step may not spend more than `per_person_usd x its people`, no call is made past the job call budget (40% of the reserve's value), the first `over_budget` / `daily_cap` refusal ends it, 5 minutes minimum wall time after the stages.
3. **Price** (`plan.ts` `stagePriceInputs`): the step's cost is added to the people stage's cost per row; the plan check, the approval's re-price and the editor all use it. A1 live shape (same stages, adding 0.000495 e-mail + 0.000495 phone per person): provider cost 0.0049678 -> 0.0148678 USD, rule unit 9.888 -> 13.518 points, full-delivery charge 200 (minimum charge) -> 203, reserve 200 -> 234.
4. **Header balance** (`src/lib/missionBalance.ts`, `AgentMissionCard.tsx`, `chat/page.tsx`): the card tells the page when its mission is over and the page refreshes the shared balance at once and 3 s later (before, only approval and focus refreshed it: 5,426 vs wallet 5,506).

**Tests.** New: `contact-finder-step`, `contact-enrichment-engine`, `contact-enrichment-replay` (A1 shape: before 10 people / 0 e-mails, after e-mails with both statuses, delivered and charge identical, spend within the execution budget), `contact-step-price`, `header-balance-after-settle`; each was red first (replay: 0 e-mails with the wiring removed). Existing tests changed on the owner's direction, each with a comment: `contact-sample-cap`, `contact-verification-planning`, `people-sources-plan` (planner no longer plans, samples or excuses the phone; prompt wording), `agent-tools-phase2` and `people-without-contact-replay` (an unverified address is kept with «غير موثّق» instead of being emptied).

**NOT PROVEN (the live test is still required for «done»):** a live planner with the new prompt; that the live finders return values for these 14 people (the calls of 2026-11-01 prove 3 hits in 14); the real yield of verified vs unverified; the finder chain on the live gateway (fake gateway only); the header refresh in a real browser (no jsdom: wiring and the timer helper are tested); why the companies stage had no engine recipe in A1.
Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-31 night, after #316): people with no verified contact are delivered (A1, A2), the text tells the truth, the A1 planning failure diagnosed

`main` before it was `1da16a75978287242f8c807c352e505c7b81fc3b` (#316). Commits for items 1 to 3, 5 and 6; item 4 is the diagnosis whose fix is item 5. **No SQL, no migration, no Edge Function.** No money function, price, cap (`JOB_MAX_POINTS_CAP` 25,000; provider daily cap 0.80 USD), markup, reserve rule or model string changed: the charge is still `ceil(delivered x unit)` of the count read back from the delivered file, and that count is now truer.

Evidence (read-only SELECTs, the TEST account, 2026-10-31 19:25-19:57 UTC = 21:25-21:57 Cairo): A1 `msn_e750c243cde78f598ad7` (first attempt `msn_1d3cd71605d5b9c80d53`), A2 `msn_6fe683c2f2be6ae9fdad`. Both approved plans' people stage has NO filter and no relevance rule (the filter kinds are a closed list: `FILTER_KINDS`); its columns carry `kind: work_email` / `kind: phone` and its mapping writes `email: ''` and `phone: ''`.

- **1. «لا بيانات تواصل موثّقة» was an ENGINE rule, not a planner filter** (`agent/src/items/ingest.ts`, the `no_verified_contact` line): every row of a contact source (`blitzapi.people.waterfall-icp` and `employee-finder` are `b2b_contact`, so `isContactSource` is true) whose marked e-mail/phone columns held no verified value was thrown away, whole. The source gives a name, a job title and the professional page and never a contact: A1 31 read, 31 excluded, 0 delivered; A2 41 read, 9 repeats, 32 excluded, 0 delivered. Now a row that carries a real person's name (`people.ts` `isNamedPerson`: a name column with letters, not an organisation or department name, not a role mailbox) is delivered with its unverified cells EMPTY; the rule stays only for rows that are not a named person (an e-mail finder's row with no verified address). The not_a_person rule, the role ranking (decision-maker titles first, `engine/run.ts`) and the per-company count are untouched.
- **2. Planner** (`contactQuestion.ts`, `tools.ts`, `plan.ts`, `runMission.ts`, `prompts/system.md`): A1's first attempt asked «الإيميلات والتليفونات المتحقق منها تظهر لعدد محدود…» although the customer had asked for the people; the customer chose «وما يتوفر من تواصلهم». By code: `ask_question` refuses a question about contacts being verified, limited or missing when the request already asks for people; the plan check refuses a sentence that makes a PERSON conditional on a verified contact (a sentence about the e-mail or phone CELL is fine); after that answer the planning prompt says to deliver every person with empty unverified cells. The prompt and the plan check's message no longer teach «a row with no verified value is not saved» for people.
- **3. Text** (`finalize.ts` `stageTruthBodyAr`, `methodology.ts`, `runMission.ts`): the limits row said «سُلّم ٠ من ١٠ لأن المصدر لم يعد يعطي نتائج أخرى لهذا الطلب» although the source gave the people; the closing sentence and the notice said «المراجعة الآلية بلغت حدّها المسموح» because ten SURPLUS companies of the other stage were counted as the people stage's waiting items (the sentence read the pending items of every stage). Now, when our own row rules left out what the source gave: «سُلّم ٣ من ١٠: وُجد ٣١ شخصًا، ولم يُسلَّم ٢٨: ٢٠ …؛ ٨ …» (repeats told apart: «وُجد ٣٢ شخصًا (بعد إزالة ٩ مكررًا)»), from the stage's own recorded counts. When the source really gave no more (everything it gave was delivered, or only what does not match the request was left out) the older sentence by the stop reason stays. The table says «بقي ١٠ دون مراجعة لأن العدد المطلوب اكتمل» for surplus nobody reviewed. Reason words: «لا اسم شخص فيه ولا بيانات تواصل موثّقة» and «لا يخص شخصًا بعينه (بريد عام أو اسم جهة أو بلا اسم)».
- **4. A1's first attempt «تعذّر تجهيز خطة… بسبب حد من جانبنا» (REPORT ONLY, not fixed)**. The limit that fired is the planning SOURCE-CALL budget (USD of source calls for planning), not time and not the model budget: `error = admin: planning_failed class=internal reason=planning_over_budget` is `classifyNoCardEnd` matching the one recorded `over_budget:planning` refusal (19:36:50, `anyapi.linkedin.company.people`), after three `stage_reserved:planning` refusals (19:32:54, 19:33:15, 19:33:28). Three planning model runs: 19:25:14-19:29:33 (ended with the question), 19:30:56-19:34:41 (answer given; ended with no plan, no question, no ending), and the one nudge (`AGENT_PLANNING_NUDGES_MAX` = 1) 19:34:41-19:37:09 (no plan). Per run the model cost was 0.0516, 0.0468 and 0.0331 USD against 0.30; the longest run was 4 min 19 s against a 20-minute wall; the turn limit (60) is not recorded (NOT PROVEN). The planning source spend was 0.0696 USD over 19 calls: 0.0555 (79.8%) on e-mail and phone FINDER samples (e-mail 0.0110, phone 0.0445: `tomba.people.phone.find` alone 0.0445), made at 19:25:45-19:26:34, before the question; 0.0089 on an e-mail lister (19:28:13); 0.0050 on people sources; 0.0002 on companies. The same split in the two missions that planned: A1 retry 0.0466 (finders 0.0378, 81%), A2 0.0293 (finders 0.0185, 63%). The offline value of the budget for this request is 0.10 USD (base, not scaled; child stage reserve 0.05); the logged value (`planning_budget …` in the Heroku log) was not available. Why this is NOT the send-back loop: PR #316's `PEOPLE_SEND_BACKS_MAX` (3 per run) answers a `propose_plan`, and no `propose_plan` answer is stored anywhere readable (no event, no call row), so a send-back cannot be proven or excluded; what the data prove is that the finder samples were made first, in the first 49 seconds, which is what #316's prompt rule 6 asks («sample at least two phone finders for a person of your people sample», «the e-mail of each person comes from an e-mail finder…»), and that the plan the model was building had FOUR stages (progress events «stages: 4»: companies, people, e-mails, phones), each needing its own sample. A contributing, older defect: the gateway's sample state (`sampledJobs`, per-source counts) lives in the gateway instance, so after the customer answered the question (a new `runPlanning`) the people stage looked unsampled again and its reserve was kept back. Item 2 removes the question in this scenario (the question started that reset). The fix that was left out of the first commits of this PR is item 5 below.
- **5. Contact-finder samples may not starve planning** (`src/lib/agentMission/contactSampling.ts`, `agent/src/gateway.ts`, `runMission.ts`, `prompts/system.md`, `peopleCheck.ts`; platform planning spend, never the customer's money): in the gateway, BEFORE the budget reservation (so a refused sample costs nothing), a call to an e-mail or phone FINDER (capability `people.email.find[.personal]`, `people.phone.find[.personal]`; a lister, a people source or a verifier is not one) is refused with `contact_sample` when (in this order) a finder of that kind was already called in the mission (one sample per kind; a call that was made counts whatever it gave), one call of it costs more than a quarter of the planning budget (`CONTACT_SAMPLE_SHARE` = 0.25; the plan then says the cells are filled only if found during the approved job), the finder samples already spent a quarter, or a cheaper ranked finder of that kind that fits inside the quarter exists (the answer names it). The gateway's sample state (sampled stages, sources per run, contact kinds and their cost) is now REBUILT from the mission's recorded calls (`priorCalls`), so the customer's answer to a question (a new `runPlanning`, a new gateway) no longer resets it: that reset is what made every later call «stage_reserved» (A1: 0.0696 USD already spent, the people and companies stages looked unsampled, 0.05 kept back). The prompt and the plan check ask for ONE finder sample per kind (they asked for two phone samples), and the plan check accepts a plan after one phone finder was tried or refused if it says honestly the phone cells are filled only if found. Test `tests/contact-sample-cap.test.ts`: the A1 second-run replay with the first run's call log was red (refused calls `stage_reserved, stage_reserved, over_budget`, planning failed) and is green (a valid plan; no `stage_reserved`); the gateway tests (phone 0.0445 refused against a 0.025 cap, cheapest first, one per kind, state rebuilt) were 5 of 5 red. No ledger, price, cap or provider-cap code touched.
- **6. What the A1 replay delivers** (`tests/people-delivery-evidence.test.ts`, counted from the delivered file): 10 people of 10 approved (two per company); 10 with a name, 10 with a job title, 10 with a professional page, 0 with an e-mail, 0 with a phone (the source gave none and nothing was verified, so the cells are empty); the file's table says read 31, left out 21 «زاد عن العدد المعتمد», delivered 10; the limits row says «لا قيود سُجّلت على هذا التسليم». The «سُلّم ٣ من ١٠: وُجد ٣١ شخصًا…» sentence is the text for the fixture of `tests/truthful-limits-text.test.ts`, people rows that REALLY are not people (organisation names, role mailboxes, nameless rows), made up to pin the wording; it is not the live A1 shape. A2 is covered at engine level (`people-without-contact-replay`, ingest and item store, not through a file): 41 read, 9 repeats, 32 distinct, 10 delivered of the approved 10, each with name, title and page, none with e-mail or phone.
- Suite: clean origin/main `1da16a7` = 608 files / 7,740 tests passed, 57 skipped; this branch = 613 files / 7,782 tests passed, 57 skipped, 0 failed (611 / 7,768 before item 5 and 6). `tsc --noEmit` clean, `npm run build` clean (zero client-bundle secrets). Changed existing tests: none (0 removed test lines: `git diff -U0 origin/main -- tests | grep '^-' | grep -v '^---'`). New: `tests/people-without-contact-replay.test.ts` (A1 and A2 shape, red 6 of 6 before), `tests/contact-verification-planning.test.ts`, `tests/truthful-limits-text.test.ts`.
- NOT PROVEN: a live planner following the new prompt, the question refusal and the one-finder-per-kind rule (fake models only); the live cheapest-ranked finder accepting the inputs the planner has (a finder that cannot be called with them is simply not sampled, and the plan says so); the exact rows of A1's and A2's files (storage is not readable by SQL); the live yield of e-mail and phone for people (the sources gave none in these runs); the logged planning budget and the turn count of the failed attempt.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-31, after #315): the live re-test findings F1-F4 (decision makers, zero-delivery reason, polling and computed dates, card unit)

`main` before it was `7f03a05d76d6256eca8b4955b28f0ded801eb82b` (#315). Four commits, one per finding. **No SQL, no migration, no Edge Function.** No money function, price, cap (`JOB_MAX_POINTS_CAP` 25,000; provider daily cap 0.80 USD), markup, reserve rule or model string changed: the charge is still `ceil(delivered x unit)` of the count read back from the delivered file, and that count is now truer.

- **F1 a person row must be a person** (`people.ts`, `ingest.ts`, `workbook.ts`, `runMission.ts`, `childSources.ts`, `peopleCheck.ts`, `tools.ts`, `roles.ts`, `methodology.ts`, `prompts/system.md`). Cause (A1 `msn_51bd…`, A2 `msn_82a2…`): the people stage's source was `tomba.companies.emails.list`, an e-mail LISTER that `PEOPLE_OF_COMPANY_CAPABILITIES` counted as a people source; 8 of 9 rows had no name, and nothing checked that a people row is a person, so the file's row count (the settlement's number) included them: 14 of 15 delivered = 187 points. Now: a row of a people stage with no person's name or with a role/generic mailbox (info, sales, cs, support, webmaster, customer_care, hr, contact, admin, ...) is excluded with reason `not_a_person`, kept with its address, shown as the column «إيميلات عامة للشركة» of the COMPANY sheet (a column, so no row: not counted, not charged); a mailbox lister is no longer a people source (`MAILBOX_LISTER_CAPABILITIES`), `people.search` finders, founders and organization contacts are; `propose_plan` sends a plan back (at most 3 times) when its people stage reads a lister while a people source gave rows or fewer than two people sources were tried, and when phones were asked for and no phone finder was sampled, a phone source gave a number and the plan has no phone column, the plan does not say honestly that none was found, or the companies' own page carries a company phone and the plan has no phone column; decision-maker titles (owner, founder, chairman, CEO and the chiefs, GM, directors, managers, heads) come first (`صناع القرار` is the manager role); «المنصات والمصادر المستخدمة» says what kind of source each stage read (`sourceLabelAr`), never a provider. Side effect to know: a company whose rows were all mailboxes is asked again through its next input (bare domain, name), within the same call budget.
- **F2** `zeroDeliveryReasonAr` (`finalize.ts`): the zero-delivery sentence is built from the recorded counts (account, period, language, place, replies, reposts, government, media, topic, mailboxes, contact), not a constant; the ending notice says «لم نجد ما يطابق» (cause `empty`).
- **F3** `missionPoller.ts`: the card's and the panel's loops had no limit on a read, so one read that never answered ended them (plan stored 16:46:35, approved 16:48:07, card unchanged until reload). `derivedRelativeDay` (`relativeDates.ts`): a source field computed as (read moment minus «6 years ago») is written as the approximate day with «تقريبًا». Planning really took 5 minutes with no event (65k output tokens).
- **F4** `itemNoun.ts`: «بوستات» is a noun; a page/account/channel after an unknown word is the source, not the unit.
- Changed existing tests: `mission-7-plan`, `people-step-implied`, `live-run-6-replay` (a mailbox lister was one of the «two people sources tried»), and `mission-7-plan`'s sort key (`effectiveUsd`).
- NOT PROVEN: a live planner following the new advice (fake models only); the exact rows of A1/A2's files (storage is not readable by SQL); why 7 of 12 EgyptAir posts were «another account»; what blocked the card's poll on 2026-10-31 (no client log); phones from any live source.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-31, after #314): the live browser run of the owner (key flag, failed job, missing decision makers, repeated failure text)

`main` before it was `e9b3b080d5efd2f4370ae4747c2631461d84c223` (#314). The read-only diagnosis with the raw evidence (timeline of key #5, the job's events, the ledger rows) is in the PR description. Five commits, one per item. No SQL applied: the only database change wanted is a PROPOSAL (`docs/proposals/treg-key-pool/08_*`, NOT APPLIED; the code does not depend on it). No money function, price, cap (`JOB_MAX_POINTS_CAP` is 25,000 in code and in the live `create_quote_atomic`; nothing here touches it), markup or model string changed.

- **1. A 402 is not a verdict on the key** (`tregKeyPool.ts`, `tregKeyCheck.ts`, `sourceRanking.ts`, `gateway.ts`): one endpoint answered 402 while the balance was 6.64 USD and the only key was flagged «الرصيد خلص» with an urgent e-mail. Now a 402 gets the same free identity and balance reads a 401/403 gets; a balance above the minimum is that endpoint's problem (no status, no alert, no failover; the call is traced `endpoint_payment_refused` and source health DEMOTES that source, never skips it); only a confirmed low balance marks the key, with `balance_low:<endpoint>` in the reason (60 characters). A successful BILLED data call (cost > 0 as TREG reported it, never a free endpoint or an estimate) clears an `out_of_balance`/`error` flag (not `revoked`), so it cannot flap against the health check. The admin check follows the same rule. **SQL 08 (NOT APPLIED)**: the failed MAIN key leaves no row in `treg_pool_events` (no successor, so nothing is logged and `main_failed` is not an allowed kind); 08 adds the kind and the log line. Every function it touches keeps `REVOKE ... FROM PUBLIC, anon, authenticated`.
- **2. A review that could not answer is OUR failure** (`runMission.ts`, `engine/run.ts`): 50 companies pending, six unusable review answers, nothing delivered, and the customer was told no source serves the request. Now: status `failed`, `missions.error` = `admin: review_failed pending=… unusable="…"`, an internal event, the existing internal-cause notice; one delayed (20 s) review retry per stage before settling at zero. The hold is released whole by the same path as any zero delivery.
- **3. Company rules in Arabic AND English** (`entities.ts`, `plan.ts`, `review.ts`): `companyRuleTerms` drops the request's frame words («قطاع», «معاهم», a nationality) and adds the sector's English words (new lexicon entries); `sectorWordsOf` ignores the people clause. The real review call forces a tool whose input is an array of exactly n 0/1 (plain text still read; one retry without the tool on HTTP 400).
- **4. The people of the companies are a step with no number** (`quantity.ts`, `plan.ts`, `planEdit.ts`, `PlanEditor.tsx`, `tools.ts`): default 2 per company, lowered by code (never the job cap, never a number the customer gave) while the hold is above 600 points; the card says it; the editor has a field for it; `contacts_note_ar` no longer drops the people (the «two sources really tried» rule applies); an over-budget refusal returns the cheapest people sources and says the search goes on.
- **5. Failure notices** (`notices.ts`): four wordings (ours, empty, no source, stopped), no sentence repeated between subject, heading and lead.
- NOT PROVEN: the body of the live 402 (not stored); why the model's review answers were unusable (`review_state.json` `lastUnusable`, not readable by SQL); the forced-tool review call against the live API (fake fetch only); the lexicon's coverage of sectors it does not list.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-31, after #313): INVOICE AGENT 2 (the assistant understands the owner's files, asks the right questions, looks like the customer chat)

`main` before it was `4690c444ca115e650e167d8b586e2239bbc2c1e7` (#313); its merge commit is the head of `main` after it. Everything (root cause of each wrong count with the old-code numbers, the rules, the conversation, clean prices, the display polish, changed tests, NOT PROVEN): `docs/ADMIN_INVOICES_AGENT_2.md`; screenshots at 380 px and the browser run: `docs/admin-invoices-agent-2/`. **No SQL.** No wallet, ledger, mission, price-engine, cap or agent-worker code touched. The owner's real files were never used: tests use SYNTHETIC files of their shapes (`tests/helpers/ownerShapeFixtures.ts`).

- **Why 201/605 and 36**: a merged TITLE row reads as the same text in every cell, so it was chosen as the header and the real header row was counted as data (+1 company, +1 manager per file); and a sheet the model did not map was skipped silently (it mapped one detail sheet of three). Now: merged cells hold their text once, a repeated-text row is a title, continuation rows belong to the company above, a company is one company across sheets and files (Arabic or English name), contacts are distinct per (company, name), departments are told apart by code, every sheet is looked at (matched by headers, or put to the owner). Truth on the shapes: electromechanical 200 / 601; petroleum 149 companies, 239 people, 32 departments, 151 repeats ignored.
- **The conversation** (code, no model after the files): one sentence, then one question at a time with chips (what to bill, departments, the total or his usual prices, the dollar rate, the client); the draft is shown before/after with the exact difference and waits for «تمام». A manager is ONE billable item (e-mails and phones are not billed separately); departments are a separate «جهة تواصل إدارية» line at price 0. A points / EGP target uses whole-points prices (shared per item type when that is as near, else per line, else the finest grid).
- **Look**: the customer chat's own bubbles, chips, file chips, typing dots and composer; full height on a phone, beside the live preview on a desktop.
- **Display**: unit columns show the decimals that make quantity x unit match every printed line; EGP = points x point value when both are shown (sent documents keep their frozen numbers); «ملخص القطاعات»; payment block off by default; export names «فاتورة INV-2026-0002.pdf» / «مسودة فاتورة»; new documents are EGP only.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-31, after #312): INVOICE AGENT 1 («مساعد الفواتير» + the live fixes)

`main` before it was `69941bfb678d5699ac5d2e950435bee72abb6556` (#312); its merge commit is the head of `main` after it. Everything (bug causes with evidence, the rules, the target-total rule, model and cost, deviations, changed tests, NOT PROVEN): `docs/ADMIN_INVOICES_AGENT.md`; screenshots at 380 px, the browser run and the exact masked payload: `docs/admin-invoices-agent/`. **No SQL.** No wallet, ledger, mission, price-engine, cap or agent-worker code touched.

- **Part A (live bugs)**: the builder's exchange-rate box vanished after the first digit typed (so «٥٠» became «٥.٠٠» and that was SAVED as his default rate); a price with more than 2 decimals of a CENT became 0 silently; the price unit was cents. Now: the rate box stays, with a live echo and a typo hint; prices are typed in dollars (up to 4 decimals) or in points per item (one toggle, default dollars, the rounding rule shown), a price that cannot be stored shows a red sentence and blocks «حفظ» and «إرسال»; «سنت» is no longer an input unit. Stored values are unchanged.
- **Part B (the chat)**: files and pictures in, a PROPOSAL out. Counting is done by code (the model only maps columns by letter from masked profiles; no raw cell ever reaches it); money actions show before/after totals and wait for «تمام»; the model can only emit a fixed list of 12 actions (no send, no pay, no save); «خلي الإجمالي ١٧ دولار» is solved by code (dollars hit exactly in most cases, points / EGP only on the whole-cent lattice, said honestly); pictures are «تقريبي» and never overwrite a number from a file; every step has «تراجع»; files are in memory only. `claude-haiku-5-5`, about $0.0003 to $0.0008 a call, 30 calls an hour per admin, 4,000 characters, 5 files, 10 MB each.
- Not done on purpose: `.xls` (no safe reader), a 10 MB upload through Vercel's 4.5 MB body limit (the screen stops above about 4 MB), storing the «hide the sector summary» option (would need SQL).
- Folder and component names say «chat» because `tests/invoice-ledger-isolation.test.ts` forbids imports containing «agent»; the route is `/api/admin/invoices/agent`.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-31, after #310): INVOICES SIMPLE 1 (the owner's feedback on the invoice builder)

`main` before it was `d65713b9c3443fb50e77a7d76e9f7bcb226612b3` (#310); the invoice builder it changes is #308 (`5a6c8ce`). Everything (the total bug with evidence, the one-screen builder, sectors, «بيان بيانات», the saved rate, the Claude helper with its model and cost, default prices, changed tests, NOT PROVEN): `docs/ADMIN_INVOICES_SIMPLE.md`.
**SQL part 06 (statement mode) is NOT applied**: `docs/proposals/admin-invoices/06_statement_mode.sql` (the owner applies it; the verify SELECT is now 23 rows). Invoices and quotes work without it; only creating a statement needs it.

- **«The total does not work»**: three causes: points/EGP with no rate left NO currency (an empty totals box), a quantity typed «1,200» counted as 0, and item types still at price 0 with no warning. Fixed, with tests that failed first.
- One screen, the real sheet always visible; sectors with four number boxes; prices from the item types; client optional; the extras behind «خيارات إضافية»; one saved exchange rate (settings), silent on every new document.
- «رتّبهالي» (admin only): `claude-haiku-5-5`, about $0.0003 a call, 2,000 characters, 20 calls an hour per admin; the model never sees or sets a price; any price/total field in its reply rejects the whole reply.
- No wallet, ledger, mission, price, cap or agent code touched. Issued documents are locked exactly as before.
- Rollback: `git revert -m 1 <merge commit>`; part 06 only through `06_statement_mode.rollback.sql` while no statement exists.

---

## START HERE (2026-10-31, after #309): ADMIN INVOICES 1 («الفواتير», admin only)

`main` before it was `609cf015c78d03faf13a41cd2d34dc1febff5be3` (#309); the merge commit is the head of `main` after it. Everything (money rule, examples, statuses, numbering, export, isolation, files, screenshots): `docs/ADMIN_INVOICES.md`.
**The SQL IS applied** (the owner ran parts 01 to 05 one at a time on 2026-10-31, after downloading `/admin/export`). His `98_verify_after_apply.sql` returned 18 rows, `ok = true` on every row; a read-only count afterwards found `invoice_settings` 1 row, `invoice_item_types` the 4 seeded names at price 0, and 0 rows in clients, documents, batches, lines, status events and counters. Steps, the verify SELECT and the rollback: `docs/proposals/admin-invoices/README.md`.

- Quotes and invoices for hand-made research work, PDF (print dialog) and PNG per page, A4, «صفحة ١ من ٣», Arabic-Indic digits, the Diger logo on every page. Usable at 380 px.
- Money is integers: unit price in hundredths of a cent, line = round_half_up once per line, points and EGP from a rate frozen at «مرسلة». After «مرسلة» the database locks the document; the status log is append-only with the admin id.
- **No wallet, ledger, mission, price, cap or agent code touched**; marking paid credits no points (test: `tests/invoice-ledger-isolation.test.ts`). RLS on, no policy, `service_role` read-only on the document tables.
- New dependency: `html-to-image` 1.11.13 (MIT), client-side PNG only. One existing test changed: `tests/admin-navigation.test.tsx` (one admin page added).
- Rollback: `git revert -m 1 <merge commit>`; `99_rollback.sql` only if the feature is abandoned (it deletes every document entered: download `/admin/export` first).

---

## START HERE (2026-10-31, after #309 and #308): «FILE OUTPUT 1» (the «المنهجية» section in the Excel, no CSV for customers)

`main` before it was `5a6c8ce5853a8d855dea13076fac44d7149fc87a` (#308 admin invoices, SQL NOT applied by this work); its merge commit is the head of `main` after it. No SQL, no ledger write, no change to pricing, settlement, reserve/charge/release, planning or provider calls, `finalize.ts` (`countWorkbookItems`, `countWorkbookSheets`), the worker's CSV writing or the Edge Functions.

- **THE RULE THAT SHAPED PART A: never add a sheet to a delivered workbook.** Settlement reads the file back with `countWorkbookSheets` (`agent/src/finalize.ts`): every sheet AFTER THE FIRST, minus its header row, is counted as delivered items. A «المنهجية» sheet placed last made a 50-item file count 62 (proved with the real functions, 2026-10-31), and a 40-of-50 delivery would have been charged for 52. So the methodology is a SECTION below the summary in the FIRST sheet «ملخص المهمة» (the one sheet the readers skip), built by code (`agent/src/methodology.ts`) from recorded facts: the customer's request (`mission.request_text`), the plan (stages, relevance, filters, quantity, unserved steps, unresolved sources), the item store's counts per stage (`missionFactsOf`: read, duplicates, accepted by rule or by the model, left out per reason, stop reason) and the delivered rows' dates (Cairo time). A fact that was not recorded says «غير مسجّل». The first sheet keeps its name (tests and the last-look pass look it up by it). `tests/methodology-section.test.ts` proves, with the real readers, that for 50 items and for 40 of 50 the counts and the sheet-to-stage mapping are identical with and without the section. The only change in `runMission.ts` is the argument of the `buildMissionFiles` call (the facts); the settlement lines are as they were.
- **Part B: a customer never sees or downloads a CSV.** The CSV is still produced and stored (worker, `publishResult`, settlement) exactly as before. Customer surfaces now offer the Excel: the mission card (`customerFilesOf`), «طلباتي» (`customerFormatsOf`), the results canvas, the files section, the activity terminal, the plan card chips and editor, the plan explanation, the landing page, the chat answer about files, the prompt, the legacy e-mail template, the text inside legacy generated files, and the API responses (`customerFileIds`: the CSV's id is never given). `/api/jobs/[id]/download` defaults to the Excel and gives a customer who asks for «csv» the Excel (only an admin can still get the CSV there); `/api/missions/[id]/file` does the same. An older request with a CSV and no Excel gets an Excel built from its CSV on download (`src/lib/server/excelFromCsv.ts`): it is rebuilt on every download, written to no database table and linked to no artifact row (`linkArtifactVersion` is skipped on purpose; the signed link is made from a copy kept in storage under `result.xlsx`, which the next download overwrites), and the CSV itself is untouched.
- **Chat**: «ملف المنهجية» in a conversation whose delivered job has no saved data (`jobHasSavedData`, the same rule as the offer) no longer points to the paid button (`methodologyNoDataAr`). The paid route and its price are unchanged.
- **NOT changed, on purpose** (see the PR): the Edge Function e-mail template `supabase/functions/send-email/templates.ts` still says «سي إس في» in the «job-done» e-mail (Edge Functions are out of scope); the terms text `legalText.ts` still names CSV; the exclusion-file UPLOAD still accepts a CSV (an input, not an output); «طلباتي» still reads `file_id_csv` from the customer's own `artifact_versions` row (to know that an older request has a file); the Excel label «جدول البيانات فقط» (A3) is as it was although a new file now holds a methodology section.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-31, after #307): the methodology purchase in the wallet, the offer, the estimate wording

`main` before it was `3526b092abe04d4cb965181bae94a9cbbaec3773` (#307); its merge commit is the head of `main` after it. Customer UI and wording only: no SQL, no ledger write, no change to `purchase_methodology_atomic`, the methodology route's charging, the price (10 points), settlement, reserve/charge/release, pricing or the engine.

- **The «3 jobs where charge > reserve»** (read-only evidence, 2026-10-31): each has a second `charge` row `chg_meth_<job id>` of 10 points, the owner-approved, customer-confirmed methodology add-on (`purchase_methodology_atomic`, written 10 minutes to 3 hours after settlement). The settlement charge (30, 9, 789) never exceeded the reserve in any of the 360 jobs with ledger rows; 3 methodology purchases exist (2026-10-15 to 2026-10-24, all legacy jobs).
- **Wallet**: the purchase is its own line («شراء المنهجية الرسمية للطلب: ١٠ نقاط», Cairo day and time); a job's delivery line sums only `res_`, `rel_`, `chg_<job id>` (30, 9, 789). Recognised by the exact id prefix `chg_meth_` (`isMethodologyChargeId`), never by the note. All lines still add up to `calculateBalance`.
- **Methodology offer**: it was drawn for every finished job with delivered items, also mission-era jobs, which keep no `data.json` (0 of 65) and would get «لم يتم خصم أي نقاط» (409) after the customer confirmed. It is now drawn only when the rows loaded from the saved data exist (`savedRows`); the route is unchanged. NOT PROVEN with a live call (none made). The chat answer «ملف المنهجية متاح من لوحة النتائج…» (`methodologyAnswerAr`) is not gated by this and can still point a mission-era customer to a button that is not there.
- **Calculator**: the price note, the over-limit notes and the form's maximum-volume message say the item's noun («٤٥٠٠ تغريدة») or «النتائج», never «سجل»; every figure is as it was (golden test).
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-31, after #306): wallet and public-page fixes from the browser tester

`main` before it was `24faf89f68d68d48e96e33ce3447bb22d10657c8` (#306); its merge commit is the head of `main` after it. Customer UI only: no SQL, ledger, settlement, engine, pricing or Edge Function change; the wallet route is unchanged (it only reads).

- **«Same wallet line twice»** was NOT a duplicate: the TEST account has two separate 50-tweet jobs (`job_quote_980be00…` 2026-10-30 22:45 UTC and `job_quote_435bc26…` 2026-10-31 07:25 UTC), each with one reserve, one release and one charge of 200 in `credit_ledger` (534 rows, 534 distinct ids, balance 7,754). Both are on 31 October in Cairo and read the same words, so they looked like one line twice. Each wallet line now shows day AND time (Cairo clock, `formatMomentCairo`).
- **Line does not expand**: not reproduced in Chromium (the native `<details>` opened and folded on every click, also after 40 s and a focus event); the cause in the tester's browser is NOT PROVEN. The native `<details>` came from a1c2a5f (2026-10-28), not from #305. The line is now a button with its own open state (`WalletJobToggle`, `aria-expanded`).
- **Public pages** no longer draw «تسجيل الدخول» before the session is read (the pages are built ahead of time, so the button was in the first HTML for everyone).
- **Calculator**: «لعدد ٥٠ تغريدة، بسعر … لكل ١٠٠ تغريدة» (the item's noun). **Excel sheet names** cut at a word boundary no longer end on «في / عن / من / على / إلى / مع / و / أو» (`wordBoundarySheetName` only; the settlement count reads sheets by position).
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-31, after #304): UI pass 1 (customer-facing screens only)

`main` before it was `50925ac553ab53c9c3d63778d4e810fa07e60918` (#304); its merge commit is the head of `main` after it. Per-item changes, measurements, the pages that had no header, every changed test with its reason, screenshots (`docs/ui-pass-1/`), what was not done and NOT PROVEN: `docs/UI_PASS_1.md`. No SQL written or applied; no Edge Function, price, cap, markup, minimum, model string, engine, planning, checking or settlement code changed; the wallet history route only reads.

- **Help**: «مركز المساعدة» → `/help`, «تواصل مع الدعم» → `/contact` (a `mailto:` did nothing without a mail app). **After «اعتمد»** the card shows a status line at once, then the running status with the «تقدر تقفل الصفحة» sentence on the page.
- **Start page**: one centred input and six chips; a chip opens a small form and sends nothing, «أرسل» builds the request from the fields (`src/lib/templateForms.ts`). **Plan card**: «هتستلم إيه», four fact cells, a prominent «اعتمد», details folded, no ISO dates, no cut sentences, near-duplicate points shown once. Planning steps in plain Arabic, no strikethrough.
- **«طلباتي»**: tab and footer from one number; «التفاصيل» opens `/dashboard/requests/<id>` at once (facts from the row, the rest after). **Wallet**: one line per job (older jobs with no mission row too), its points summed from the job's own `credit_ledger` rows (`jobLedgerTotals`, the balance's sign), `Server-Timing` on `/api/wallet/history`. **Calculator**: three choices, one result, the card's own time function. **Catalog**: platform groups with «تقدر تطلب…». **One layout** (`SiteFrame`) for every customer page. **Bell**: only a rejected top-up counts. Arabic-Indic digits in the touched messages.
- NOT PROVEN: where the wallet's ~10 s was spent (the queries take milliseconds; Hobby logs keep an hour); times were measured on a dev server with a simulated delay.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-30 night, after #303): fix mission 13 (tools the worker cannot use, provider links, TikTok comments, people coverage, denominator)

`main` before it was `acf38ddd1c83af92967f0dcd3177dc5ae2dbdebe` (#303); its merge commit is the head of `main` after it. Evidence, root causes, tests and NOT PROVEN: `docs/ENGINE_AND_ITEM_STORE.md` section 18. No SQL written or applied; no Edge Function, price, cap, markup, minimum or model string changed; settlement untouched.

- **Tools the worker cannot use**: the web search / scrape / parsers / people search need a Context.dev or Firecrawl key; the keys are stored (website) but the worker got none, so all 71 calls of 3 days were refused and the YouTube planner never reached the catalog. Each key is now resolved once per run; a tool with no key is not offered at all (tool list, `catalog_search`, `describe_endpoint`, plan, prompt). Why the worker gets no key: NOT PROVEN (check `PROVIDER_KEYS_ENCRYPTION_KEY` on the worker).
- **Provider links**: an address of a data provider (catalog provider or origin name; a record page `/company/<long id>` on a non-platform host; never the row's own website) is removed from every customer cell, an id made from one is a neutral `id_<hash>` the same in «المعرّف» and «معرّف الأصل», and the finished workbook and CSV are scanned again (`providerHosts.ts`).
- **TikTok comments**: the source gave 0, 0, 1, 0, 10 for five brand-new videos (HTTP 200); a parent with no child is replaced by a spare the search had checked and kept (`swap` op), most comments first. **People**: 404 for one company is that source's answer, not a stage failure (3 in a row used to end the stage: 21 of 43 companies were never asked); inputs are not asked twice, a provider address is never an input, a website is also tried as a bare domain.
- **Denominator**: short of the card = «X من (the card's total)»; a delivery that fills a lowered card keeps «من (the request)».
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-30 evening, after #302): fix mission 12 (named channels, Facebook video proof, companies, name cells)

`main` before it was `1b268a5de02443ea0e30336cb453b6646612a648` (#302); its merge commit is the head of `main` after it. Evidence, root causes, tests and NOT PROVEN: `docs/ENGINE_AND_ITEM_STORE.md` section 17. No SQL written or applied; no Edge Function, price, cap, markup, minimum or model string changed; settlement untouched.

- **YouTube named channels (no card, twice)**: not a #297/#298 rule: the planner called `finish(cannot_serve)` after one empty call and two unavailable web searches (the three earlier attempts were the TREG suspension of #300). For a request that names channels, accounts or pages, a give-up is now sent back until three catalog sources were really reached (the channel's own listing first), at most 3 times.
- **Facebook videos**: a card for videos from a post search carries a `media` filter built by code (enforced at ingest). When the sample proves no video the planner is sent back (max 3, no refusal) to the catalog's reels / video-field / post-detail sources; only after 3 were tried does the card say before approval that fewer may come.
- **Companies (40 of 148)**: a one-page per-call source is asked at its maximum limit (it was asked 50 of 100 for the same price); the model check that was cut at its own output limit (4 x 116 tokens) is asked again with room, then in halves; people are asked through the company's page, website and name; 147 vs 148 is the lowered target (49) added back in the customer's line.
- **Name cells**: direction marks removed from name columns in the workbook and the CSV. **Ledger**: the 200-point drop is the owner's own TikTok profile test (`job_quote_0a25ec81...`, minimum charge 200).
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-30, after #301): «طلباتي» (cancel, the pending block, tabs, paging, search)

`main` before it was `85ba607b15ba301e56a785f45e057bb333b8ea5d` (#301); its merge commit is the head of `main` after it. No SQL written or applied (no new status or column was needed); no Edge Function, price, cap, markup, minimum, model string or settlement code changed; no money function is called by anything new.

- **Cancel (live evidence, read-only)**: the tester's database log shows exactly 3 cancel requests that day (16:11:40, 16:11:47, 16:12:00 UTC), all on unanswered questions (`needs_input`), each a `GET` of the mission and a `PATCH` to `cancelled` (HTTP 204); the 3 rows are `cancelled` and were never touched again. No request for any of the 8 `plan_ready` rows ever reached the database (no read of the row, no `PATCH`); the list was read again at 16:12:01 and 16:12:20 and at 16:12:20 the tester sent a new chat message. So the cancel path **did persist every cancel that arrived**; why a click on a plan sent nothing is **NOT PROVEN** (Vercel's logs for that hour are past retention, and nothing records a browser click). One real defect was found and fixed: `cancelForCustomer` answered `ok` even when its update matched no row (a queued mission taken by the worker a moment before), i.e. «تم» without a change. It now reads the update back and answers 409. Also: a cancelled request was listed nowhere (it is not a job), so it simply vanished; it now shows under «فشلت أو أُلغيت».
- **Pending block** (`src/lib/requests/expiry.ts`): a question or plan waiting for the customer is kept 72 hours from creation and at most 5 (the newest); older ones, and the oldest beyond 5, become `cancelled` with `summary_ar` = «انتهت صلاحية الخطة» and `error` = `expired: …` (a status change; no money function, no ledger row). It runs while the customer's lists are read (`listOpenMissions`, `GET /api/requests`), never in the background; compare-and-set on the waiting statuses; idempotent.
- **The list is the server's** (`GET /api/requests?tab=&q=&offset=&limit=`, `src/lib/requests/buildIndex.ts`): tabs الكل / قيد التنفيذ / مكتملة / فشلت أو أُلغيت / حجز مؤقت مُحرَّر for the WHOLE page (jobs and requests that never became jobs; a mission that has a job is that job), counts equal what each tab lists (for the current search), 20 per page newest first, search over the request text (the mission's `request_text`; an older job: the title of its conversation) normalised for alef/ya/ta marbuta/diacritics/digits. The page reads the listed jobs for files and points as before. The tab is kept in the address as `#all|running|done|ended|refunded`.
- **Rows** are compact (one line of request text, date, state chip, delivered, points, Excel, «التفاصيل»); tabs wrap, nothing scrolls sideways. **CSV/PDF buttons are not offered** on «طلباتي» (`customerFormatsOf`, except to a request with no Excel at all: 0 of 164 artifact rows today). The CSV file is still produced and stored: `publishResult` returns its path as the job's result file (settlement records it) and `countCsvItems` reads it at close-out, so only the button is hidden.
- Tests: `tests/requests-page-replay.test.ts` (26). Existing tests unchanged; `tests/helpers/memoryDb.ts` gained `is` and `range` (the paged reads). Rollback: `git revert -m 1 <merge commit>`; the rows expired meanwhile stay `cancelled` (nothing was held).
- NOT PROVEN: why the tester's clicks on plans sent no request; the layout at 380 px in a real browser (built by construction: wrapping tabs, `truncate`, `min-w-0`; no browser run); more than 5,000 jobs or missions for one customer (the list reads 5,000); older jobs beyond the newest 2,000 messages are not found by the title search. **A tension in the brief**: «max 5 visible plus عرض الكل» and «more than 5 waiting: the oldest is expired» cannot both show a hidden row, because the rule keeps 5. Both are built (the block shows 5 and «عرض الكل (n)» appears only if more than 5 are ever returned); in practice the button never appears. If a longer visible-but-expandable list is wanted, raise `PENDING_MAX_WAITING` above the 5 shown.

---

## START HERE (2026-10-30, after #300): the TREG key pool was fooled (suspended organisation, exhausted key shown «متصل»)

Evidence (read-only SELECTs of `mission_calls`, `treg_pool_keys`, `treg_pool_calls`), the design of the fixes, tests and NOT PROVEN: `docs/proposals/treg-key-pool/README.md` («STEP 3 update»). The «حد من جانبنا» refusals of 2026-10-30 were NOT #298 or #300: key #2's organisation was suspended at TREG (24 data calls, 403 «org suspended», from 01:09:29 UTC) while its free identity read passed. No price, cap, markup, minimum or model string changed; settlement untouched; no Edge Function.

- **Admin key checker** («مزودو الخدمة» → TREG): paste a key → «افحص» runs identity, balance and ONE real data call (cheapest sellable endpoint, ~0.00015 USD, counted against the daily cap); «افحص الآن» does the same on each pool key and records it. 5 pasted checks / 20 pool checks per admin per hour, counted in `admin_audit_log`. The key is never stored, logged, echoed or put in a URL.
- **Pool**: an unreadable balance never writes `connected`; a key a call proved refused is not cleared by free reads; a 403 naming the account, or 3 consecutive 403s on 2+ endpoints within 2 minutes, fails over (main last); the table shows each key's last answered call.
- **SQL 07 is NOT applied** (`docs/proposals/treg-key-pool/07_*`): one read-only function; the table says «غير متاح» for «آخر طلب ناجح» until the owner applies it, nothing else depends on it.
- Rollback: `git revert -m 1 <merge commit>` (then, if 07 was applied, `07_treg_pool_call_health.rollback.sql`).

---

## START HERE (2026-10-30, after #299): the «عندك مهام مفتوحة» incident (one definition of «open»)

`main` before it was `ae59a477552bdd28f323cd5ea57aa6658d45f950`; its merge commit is the head of `main` after it. Evidence (raw rows), root cause, the 2,000-point arithmetic, tests and NOT PROVEN: `docs/ENGINE_AND_ITEM_STORE.md` section 16. No SQL written or applied; no Edge Function changed; no price, cap, markup or model string changed; settlement untouched.

- **Cause**: three `needs_input` missions (questions nobody answered, one per abandoned conversation) filled the limit of 3; «طلباتي» lists jobs, so it never showed them. Not a stuck planning mission, not a dead worker.
- **Fix**: `openMissions.ts` is the one definition used by the limiter AND the customer's list: only queued/planning-with-live-lease count; a question or plan waiting for the customer never blocks; a planning mission with no live lease for 10 minutes is ended as `failed` («من جانبنا», nothing held). The refusal names the blockers; «طلباتي» has a «مهام قيد الإعداد» block; a refused message no longer stays «planning».
- **Money**: the 2,000 points are ten completed missions of 200 points each (00:27-00:57 UTC on 2026-10-30), every hold released. No money row needs fixing.
- Also: `tests/source-ranking.test.ts` got a fixed clock (3 tests were failing on main by the date); `agent/node_modules` must be installed for the SDK type test.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-30, after #297): fix mission 11 (named channels, Facebook videos, company rows)

`main` before it was `24e428fadc8566d8dfc6b69b2624a754faa3a222` (#297); its merge commit is the head of `main` after it. Evidence, root causes, tests and NOT PROVEN: `docs/ENGINE_AND_ITEM_STORE.md` section 15. No SQL written or applied; no Edge Function changed; no price, cap, markup, minimum or model string changed; settlement code untouched.

- **YouTube named channels, 0 of 90**: the period filter left out all 16 videos because the source gives only «قبل ٤ أيام». Relative times are now an age range read from the moment of the read, accepted when the range overlaps the period, saved as an approximate day (`تقريبًا` in the cell, a sentence on the first sheet, a line on the card). The channels were never sampled by their own listing: the third search of one source is refused (`repeat_sample`), the catalog has `youtube.channel.videos` sources, and the named-source guidance sat in the EXECUTION part of the prompt. Now: a keyword plan for named sources no sample shows is refused while a listing exists and none was sampled; a listing is sampled once per named source; a stage with several named sources gets one recipe per source (each up to its share); an author is matched in every field that names it. The card promised 90 rows instead of 315: «على» is written «علي» once normalized, so the comments stage took the wrong per-parent number.
- **Facebook videos, «حد من جانبنا»**: no limit; the planner ended its run with no plan after two unavailable web searches (`no_plan(end)`). A run that ends with nothing while it holds real rows is now asked once more.
- **Companies**: a row whose own text contradicts the card (a law firm, a news site, a trade show, a head office abroad, a broken spreadsheet line as a name) goes to the model check; US and UK cities are evidence against an Egypt request; «Nasr City», «Down Town», «Zahraa El Maadi», «First New Cairo» are written in Arabic.
- Not done: exact dates from a details endpoint (no enrichment step in the engine); the shortfall sentence that blames the review for a shortfall of the people stage.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-29, after #296): fix mission 10 (social-media depth and correctness)

`main` before it was `77685e2fb3f0a0b02d1f0f85e31e183943f819c8` (#296); its merge commit is the head of `main` after it. Evidence, root causes, tests and NOT PROVEN: `docs/ENGINE_AND_ITEM_STORE.md` section 14. No SQL written or applied; no Edge Function changed; no price, cap, markup, minimum or model string changed; settlement code untouched.

- **YouTube named channels, 0 of 315**: the ACCOUNT filter (exact name equality) left out 18 of 18 videos; the topic check never ran. A named source is now matched by name (every word of it), the card names the sources, a named source no sample shows is told on the card, a stage naming several sources by one query gets no engine recipe, `finish` is refused while a named source has no item, and an item of a named source with no topic term goes to the model check, which judges the topic only, in the item's own language.
- **Time depth** (2000 tweets: 176): the source ends after about two thousand results, all of the last two days. A stage with a period filter is now walked back through date windows (the source's own `since:/until:` operators or start/end inputs from the catalog) before a shortfall is declared. 1,084 against 242: the yield the sample measured (0.3 against 1.0), nothing changed in the price.
- **«آخر ٢٠ تغريدة» from @AlAhly: NOT FIXED** (root cause in section 14: one call to the timeline source gave 4 recent + 16 sparse tweets; the data cannot tell a selection from a rare poster).
- **Tweet times**: not #296; the model's mapping cut `createdUtc` to a day. A recipe's cut (`.toISOString().slice(0,10)` and two more forms) is removed and proven on the measured page.
- **Facebook 4,383**: comments bought from a source 15 times dearer after one empty sample of the cheaper one on one reel; now a cheaper source that answered empty for one input is asked again with another item, and a planner that skips some cheaper sources by name must account for all.
- **Companies**: 781 of 842 left out by the place proof (a city of the country, or the source's own country filter, is now evidence); a name that is only a domain is replaced from another name field of the item; city cells in Arabic, fragments «غير مذكورة في المصدر»; a role-ranked people stage is titled «موظفو كل شركة».
- **Card examples** obey the plan's period (and the other enabled filters).
- Existing tests changed: `tests/engine-spec.test.ts`, `tests/source-ranking.test.ts` (justifications in section 14). A clock-dependent test (`tests/review-budget-up.test.ts`) fails after 21:00 UTC on main too.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-29, after #295): fix mission 9 (file correctness)

`main` before it was `8e98d5759c242a15c64520fc06ef6107ca39acd3` (#295); its merge commit is the head of `main` after it. Evidence, root causes, tests and NOT PROVEN: `docs/ENGINE_AND_ITEM_STORE.md` section 13. No SQL written or applied; no Edge Function changed; no price, cap or model string changed; settlement code untouched.

- **Live: «موقع الشركة» was the first company's website on every person**: the model's recorded mapping hard-codes the sample call's input (`website: 'orascom.com'`) and the engine runs it for every parent. `parentColumns.ts` repairs, before the file is written, every parent-describing child value that is another parent's (own parent's value, same style); admin-only flag `parent_column_fixed`.
- **«02:00» on start dates**: a date with no time stays a date (`yyyy-mm-dd`, no shift); real timestamps keep Cairo time. **Missing values are empty cells**, not `''`.
- **«ملفين» vs «الملفات ١»**: the closing note (the model's text) is corrected when shown (one Excel of N linked sheets); «طلباتي» asked for «the latest 100 artifact rows of the account» and lost this mission's row (104 rows): now by job, plus the mission's own files.
- One existing test changed: `tests/agent-files.test.ts` (an empty cell is `null`, not `""`; border and fill asserted too).
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-29, after #294): fix mission 8 (the children of a request are delivered)

`main` before it was `82938c7d38f75a5b7b8dfb6bfb1b4d1605c543d2` (#294); its merge commit is the head of `main` after it. Evidence, root cause, the arithmetic for both live plans, tests and NOT PROVEN: `docs/ENGINE_AND_ITEM_STORE.md` section 12. No SQL written or applied; no Edge Function changed; no price, cap or model string changed.

- **Live: 5 videos / 3 companies delivered, their comments / managers collected and not delivered, 200 charged.** #294 forced only the PARENT stage; the model's `deliver: false` on the child stage was believed. Now every stage whose noun the request asks for (the counted noun and every per-parent noun) is delivered by code (`requestedStageIndexes`), the plan check refuses a plan where one is intermediate or where the headline promises a count the file does not hold (`deliveryConsistencyIssues`), and the card total, the price's delivered rows and the delivered stages are one number.
- **Why #294's tests passed**: their fake model marked the comments `deliver: true`. `tests/live-run-8-replay.test.ts` uses a fake model that marks the child stage intermediate, as the real one did (it fails on main).
- **Managers**: a per-parent role noun («المديرين») ranks each company's people by the job title the source gives (`roles.ts`, engine `run.ts`), matching titles first, never excluding, never inventing a title; one card line says fewer matching people may come.
- Settlement unchanged. Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-29, after #293): fix mission 7 (per-parent numbers, named parents, government bodies, the people of a company)

`main` before it was `28bd5fd05fb78aadbfbf3a4c7d6b361e83ca5f8a` (#293); its merge commit is the head of `main` after it. Evidence, root causes 1-4, the settlement arithmetic, tests and NOT PROVEN: `docs/ENGINE_AND_ITEM_STORE.md` section 11. No SQL written or applied; no Edge Function changed; no price, cap or model string changed.

- **TikTok «هات ٥ فيديوهات ... ومن كل فيديو ١٠ تعليقات» gave 5 comments in all**: the model kept the videos as an intermediate stage, the quantity was bound to the only DELIVERED stage (the comments) and the per-parent override was skipped for the stage that held the quantity. Now the quantity binds to the stage whose title names the counted noun (delivered or not) and that stage is DELIVERED by code; the comments are parents x N. The per-parent parser (`quantity.ts`, `perEachOf`) reads every phrasing (من/مع/لكل/على/في/تحت/وجوه كل, «لكل واحد», «كل X فيه», the number before or after, digits, words) and no longer takes the parents' own number for a per-parent one.
- **The people of a company are servable**: `childSources.ts` lists the people sources of the catalog (they take a company's website, page link or name) and the company sources that feed them; a plan may call the step «unserved» only after two of them were really tried and gave no rows (`PlanLookup.childStepSources / endpointsCalled`); `catalog_search` ranks a company source that feeds a people source first for such a request.
- **Government bodies are excluded by evidence** (`government.ts`, filter kind `exclude_government`, built by code from «بدون جهات حكومية»): .gov/.mil/.edu/.ac suffixes and names are definite; «research institute / university / national» goes to the model check.
- **Place cells**: Arabic names («al qahirah» → «القاهرة»), never empty when the card promised the place (`placeCellsAr`).
- **Settlement**: ONE unit price for every delivered item of the job: charge = ceil(delivered x unit) (the card's price is ceil(target x unit)); arithmetic of the live Facebook mission in section 11.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-29, after #292): the six compound missions (fix mission 6)

`main` before it was `dfefa2989e06b004e35c2fa870558f2385cd87ed` (#292); its merge commit is the head of `main` after it. Evidence, root causes 1-7, tests and NOT PROVEN: `docs/ENGINE_AND_ITEM_STORE.md` section 10. No SQL written or applied; no Edge Function changed; no price, cap or model string changed.

- **The 1,000-tweet refusal was a DEPLOY of the worker, not a size limit** (the model's process ended with exit code 143 one minute after #292 was merged). A run cut short by a restart now goes back to the queue (planning: `queued`; execution: `approved` with what it saved), own counter, own limit. 1,000 and 5,000 tweets reach a card and are delivered in full (`tests/large-missions.test.ts`; they also passed on the code before).
- **Per-parent numbers are the customer's**: the child stage's target is parents x the number in the request (the card said «حتى ٧» for 5 x 10); every parent is read up to its share, in the source's order; a lower target is shared out equally.
- **The child rule on the card**: the language/topic sentences name the PARENTS only; a sentence that promises a language or topic for the children is refused; the shortfall reason of a child stage is «بعض الفيديوهات عليها تعليقات أقل من العدد المطلوب لكل فيديو» (never the language: the TikTok source itself gave 10, 6, 10, 10, 5).
- **No step dropped silently**: a step asked per parent that the plan cannot serve is shown on the card before approval («خطوة لم تُضَف إلى الخطة») with its reason (`unserved_steps`); the companies mission also failed because a country field holding «EG» was no place evidence, the sector words were garbled and English names never matched the Arabic sector word; fixed.
- **File names** always carry the subject (account / channel / topic / sector); **media-only posts** show «منشور بصورة أو فيديو دون نص» in the file.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-29, after #291): the admin panel reorganised (layout and navigation only)

`main` before it was `32fcd5c38cdde4e87c414b7b5cb2e07398c024a2` (#290); its merge commit is the head of `main` after it. Map, screenshots and details: `docs/admin-reorg/README.md`. No API, SQL, money, key-pool behaviour, worker, price or customer text changed; no admin address moved.

- **Menu**: 20 pages in six sections (`src/components/admin/nav.ts`; `ADMIN_PAGES` in `icons.tsx` unchanged). Only the open section is unfolded; every page has a one-line description and section chips under its title.
- **«مزودو الخدمة»**: four short views per provider (status and balance, keys, limits, call log), kept in the address `?p=<provider>&v=<view>`.
- **Key pool table**: no horizontal scroll at 1280 px, cards at 390 px (`.rtable` / `.rtable-wrap` in `globals.css`, a container query, also used by the call logs), number once, status badge, main key marked, one action visible and the rest in a small menu.
- Tests: `tests/admin-navigation.test.tsx`; two selectors moved from `AdminShell.tsx` to `nav.ts` (`tests/conference-dashboard.test.tsx`, `tests/phase4-failures-board.test.ts`).
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-29, after #289): the TREG key pool (many keys, one active, a fallback chain ending at the main key)

`main` before it was `51e5d3a1dfee5c5fcb32db7d22dcec9f3a7ede8c` (#289); its merge commit is the head of `main` after it. Design, SQL proposals, owner decisions D1 to D8, rollout checklist and NOT PROVEN: `docs/proposals/treg-key-pool/README.md`. SQL 01 to 04 were applied by the owner; **06 (`treg_pool_keys_for_check`) is a later addition and must be applied before the background health check works**. No money table or function, no price, cap, model string or customer text changed.

- **Rollout switch, OFF by default** (admin «مزودو الخدمة» → TREG → «مجمّع مفاتيح TREG»). OFF = exactly today: website store key then `TREG_TOKEN`; Heroku worker `TREG_TOKEN`. Turning it OFF restores that within about 3 seconds. `TREG_TOKEN` on Heroku is never touched; it is the worker's legacy and emergency source.
- **One shared module** (`src/lib/server/tregKeyPool.ts`) used by the website (resolver + `executeTregCall`) and the worker (gateway passes `legacyToken`). ON: the active pool key from a 3-second view of `treg_pool_runtime()`, so a switch is live on the next call; a running mission continues on the new key.
- **Failover**: 401/403 (verified with the free `/auth/me`) or 402 (not a price cap) on the active key → recorded (`treg_pool_record_failover`, compare-and-set) → next healthy key of the admin's chain, main always last → the call is retried once on it (at most 3 hops, the last on main) → admin e-mail through the outbox. Timeouts, 5xx, 429, 400/404/422 and price caps never switch.
- **Secrets**: keys AES-256-GCM encrypted in the app (AAD = the key's row id) with a key generated inside Supabase Vault (`diger-treg-pool-enc-key`, read via the service-role-only `treg_pool_enc_key()`); no Vercel/Heroku variable was added; the old key store and `PROVIDER_KEYS_ENCRYPTION_KEY` are untouched. Keys never reach a browser, a log, an error, an audit line or an e-mail.
- **Emergency**: pool/DB/Vault unreadable → the worker uses `TREG_TOKEN` (never a non-main key after a 30 s grace on the admin's own active key) and the admin is told (queued, sent when the DB is back; direct if `ADMIN_ALERT_EMAIL` is set on Heroku).
- **Health check**: pg_cron `diger-treg-pool-tick` → `/api/cron/treg-pool` (cron secret): sends waiting e-mails and, at most once per 10 minutes, checks every key with read-only identity and balance calls.
- **Call log per key**: `treg_pool_calls` (cost row → key number and label); calls log key filter, column and per-key spend; the export gets one extra column only when rows carry marks.
- Tests: `tests/treg-pool-*.test.ts*` (fake TREG, in-memory model of the SQL functions) + `tests/helpers/tregPoolKit.ts`. One existing test changed: `tests/provider-status.test.ts` (it passed four different random keys where it meant one key; the status cache is now per key).
- Rollback: switch OFF in the admin (seconds), then `git revert -m 1 <merge commit>`, then the rollback SQL files in reverse order (06, 04, 03, 02, 01).

---

## START HERE (2026-10-29, after #288): raw child items, place enforced, Facebook always reaches a card, scale (fix mission 5)

`main` before it was `90ca9010a4eafb17caaf538eecdee2ed971bdf4e` (#288); its merge commit is the head of `main` after it. Details, evidence, the scale table and NOT PROVEN: `docs/ENGINE_AND_ITEM_STORE.md` section 9. No SQL written or applied; no Edge Function changed; prices and settings untouched.

- **Child items are raw** (comments, replies, reviews, employees): no topic, language, place or text-dedup rule on them; only the same item id is one item; the card says so; relevance/language/place choose the parents and the top-level items.
- **Facebook**: planning budget scaled to the platform's cost by code (0.1254 for posts + comments, hard cap 0.20), the honest cost sentence on the card, two give-up attempts sent back; the quantity «٥ بوستات ... مع كل بوست ١٠ تعليقات» now counts the posts (it counted the comments).
- **Place/country** is enforced from mapped fields (country, city, address, website suffix, phone prefix); companies of a sector are checked by kind (exhibition / other trade go to the model check).
- **Scale**: page cap grows with the volume sold; `listCalls` reads every call (pages of 1,000); measurements in `tests/scale-engine-2000.test.ts`.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-29, late night): cheapest source first, source health, planning budget split (after #287)

`main` before it was `3349e3d3ae55b9872fcdd2ded2b7f5b195e2b8f4` (#287); its merge commit is the head of `main` after it. Details, the offline re-plan table and NOT PROVEN: `docs/ENGINE_AND_ITEM_STORE.md` section 8. No SQL written or applied; no Edge Function changed; prices and settings untouched.

- **Ranking by code** (`sourceRanking.ts`, `candidates.ts`): the sources that do the job, ranked by expected cost per delivered item (measured from `mission_calls`, the catalog otherwise); `catalog_search` returns that list; a pricier source of the same job needs `skip` {id: reason} or `why`; a third sample of one source stays refused.
- **Source health** (generic, no provider rules): configuration failures skip a source, input/validation failures demote (1) or skip (3) for 24 h until it gives rows again; admin list: `GET /api/admin/agent/sources` and the «صحة المصادر» panel.
- **Planning budget split**: 30% kept for the first sample of every stage not yet sampled (`stage_reserved`).
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-29, night): the five-mission live run (after #286)

`main` before it was `3a3e6b0709b4b8cebe163cb3ac0d2645345be31f` (#286); its merge commit is the head of `main` after it. Details, evidence and the companies price breakdown: `docs/ENGINE_AND_ITEM_STORE.md` section 7. No SQL written or applied; no Edge Function changed; prices untouched.

- **Four honest classes for a no-card end** (`refusal.ts`): needs a detail (one question with answers), unsupported, OUR planning failed (budget/limits/all sources failed: status `failed`, admin flag, «من جانبنا»), source truly empty (only after a real empty sample). The live Facebook request was our planning budget (three 5-post searches of one source), shown as «لم نجد ما يطابق» because a stored sentence with a digit is dropped; the planning now refuses a third sample of one source.
- **Parents tell the truth**: card «حتى ١٠ فيديوهات», tracker and summary sheet «قُرئ ١٠، ومنها ٦ لها نتائج»; counts from the item store; no «صف»/«سجل» in file notes.
- **One language rule**: the request's language is the default content language of every text stage (filter added by code, stated on the card, editable); shortfall says so.
- **Download name**: one function on every route; a place request names the file after the place.
- Open owner decision: the companies price (63 points per company, source `companyenrich` 0.0098 USD per company vs 0.00025 before): section 7 of the engine doc.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-29, evening): the delivered file of the live run (after #285)

Written after the live run `msn_169c911fd8a0a5c89cf1` (67 of 300, charge 45, hold released: the count/charge core was right and is untouched). `main` before it was `8f9b2acfc4811c7a0411f9b851edb034811c5f71` (#285); its merge commit is the head of `main` after it. Details and root causes 1-7: `docs/ENGINE_AND_ITEM_STORE.md` section 6. No SQL was written or applied; no Edge Function changed.

- **Namesakes:** a full name extended by more name words («محمد صلاح عبد الفتاح», «أبو عمر») is another person, excluded by rule; the plan lists the other meanings it found (`relevance.competing_meanings`); a row with the full name and no context word that looks like an advert or a list goes to the model check.
- **Repeats:** the same text with other emoji, hashtags, links or a leading «عاجل» is one item. **Replies:** a text that starts with `@handle` is a reply whatever the source's flag says.
- **One download name** (`missionDownloadName`) for the panel, «طلباتي» and the admin; **render-time guard** (`customerSafeText`) so no English or internal phrase reaches a customer in any state; release reasons are written in Arabic; **file notes** describe only the sheets and columns the file has.
- Rollback: `git revert -m 1 <merge commit>`. NOT PROVEN list: end of section 6 of the engine doc.

---

## START HERE (2026-10-29, later): the contract between the plan and the engine

Written by the session that diagnosed the two missions of 2026-10-29 (read-only) and fixed them. `main` before it was `a9c8666386e62e0e3f8b31b3b09195adf693126e` (#284); its merge commit is the head of `main` after it. Details and evidence: `docs/ENGINE_AND_ITEM_STORE.md` section 5. No SQL was written or applied; no Edge Function changed.

- **M1 was our failure, not memory:** the plan's mapping had no `id`, the engine rejected every item. Now the recipe proof requires an id (or a key code derives one from) and every column and filter field, the engine derives ids, and zero items stored from non-empty pages is an INTERNAL failure (hold released whole, admin flagged in `missions.error` and an `adm_source_rows` event, the customer told it was ours).
- **The quantity is set by code** from the customer's words (digits and number words); the model may go lower only with a reason shown on the card; one target everywhere; settlement against the approved target; below the request is `partial`, never «N من N».
- **Every card promise is a filter in code** (replies, reposts, language, period, account, place) and posts/comments with the same text are one item. A promise without its filter is refused at plan time.
- **«عدّل الطلب» edits the plan itself** (count, period, language, exclusions, columns), priced again by code; «اكتب الطلب من جديد» (cancel and retype) stays.
- **The card never goes deaf** (polls while waiting and working, reads on tab focus, says the end once); the worker writes a heartbeat history as object names under `_worker/heartbeat/` (no SQL).
- Rollback: `git revert -m 1 <merge commit>`. NOT PROVEN list: end of section 5 of the engine doc.

---

## START HERE (2026-10-29): the agent, the item store and the engine

Written by the session that fixed the lost-items defect (PR: «One item store, a code engine, settle from the file»; its merge commit is the head of `main` after it; before it `main` was `f6dfd3e30f5474c23eadbe7e177570db4e795663`, #283). Everything about the agent is in `agent/README.md`; this change is explained, with the raw evidence, in `docs/ENGINE_AND_ITEM_STORE.md`.

- Diger runs missions through a Claude agent (`agent/`, Heroku app `diger-agent`, auto-deploys from `main`, model `claude-haiku-5-5`, never change it). `AGENT_SERVES_CHAT = true`: every customer is served by it. Supabase `pfinlfaqwnytesedchik`: tables `missions`, `mission_events`, `mission_calls`, `agent_worker_heartbeat`, `agent_settings`; private bucket `agent-missions`.
- **The incident**: a mission showed 300 of 300, delivered and charged 192, and its file held 77 items. Cause: items were kept in one object that every save read, extended and overwrote, and Storage serves an overwritten object stale (up to 60 s). Fixed by ONE append-only item store of immutable objects, a code engine for plans whose stages have a proven recipe, a `finish` gate for the model path, and settlement from the read-back file.
- **Money text**: one line per mission everywhere (panel, «طلباتي», notification, e-mail, wallet): «خُصم ١٢٨ نقطة مقابل ١٩٢ تغريدة». The wallet groups a mission's ledger rows under it. The plan card: the price shown is the full-delivery price, fewer costs in proportion, nothing costs nothing.
- No SQL was written or applied. No e-mail template changed (the `job-update` template only receives other text), so no Edge Function deploy is waiting.
- The rules below ("Standing rules") still hold. Everything older in this file is history and may be stale.

---

## START HERE. Current state (main = `2d698d3`, 2026-10-25)

A fresh session can start from this section. Facts come from git, the Vercel deployment API and the owner's briefs; anything not verified in the repo or in a brief is marked **owner-reported**. No secrets or passwords are written here.

### Main and production

- `main` head: `2d698d3bac86266c4785797f7d6c55902c3da854` (merge of PR #251). Production deployment `dpl_81J9hF66CDRQRTdJptLKeRbScDpx`, READY on that SHA (one check, before this handoff PR).
- Merge rule: MERGE COMMITS only (never squash, never `--admin`, never force-push). Rollback of any PR: `git revert -m 1 <merge commit>`.

### Merged since the UI/UX audit (PR, merge commit)

| PR | Merge | What |
|---|---|---|
| #236 | `b772c7d` | live-check fixes |
| #237 | `510cf4e` | invalid contact values |
| #238 | `f8c0a52` | small fix batch 2 |
| #239 | `f8636f8` | send-email caller authorization |
| #240 | `7236994` | hero effect restored |
| #241 | `31abb74` | hero sentence |
| #242 | `72ae38a` | sidebar polish |
| #243 | `693739d` | admin export as ZIP |
| #244 | `b0c7ecd` | shared test-account classifier |
| #245 | `d440537` | InstaPay link and QR |
| #246 | `faf99e9` | InstaPay guard for a handle |
| #247 | `c3ce0a2` | top-up logic and owner alert e-mail |
| #248 | `8596019` | wallet and top-up visual redesign |
| #249 | `ac2a7d4` | e-mail fixes (send-email v3) |
| #250 | `edd114d` | one right-to-left base layout for all 8 e-mail templates (send-email v4) |
| #251 | `2d698d3` | rejection reason shown to the customer from their own notification `notif_<topupId>`; no SQL |

#251 detail: `reject_topup_atomic` stores only the status, so the reason is read from the customer's own notification row (RLS: own rows). A durable column is only a proposal: `docs/proposals/topup-reject-reason-column.md` is **NOT APPLIED** and nothing depends on it.

### Owner-applied production changes that are NOT in git

All applied by the owner by hand; the repo only has proposals or code that expects them.
- Supabase Auth rate limits back to defaults: e-mails 30/h, sign-ups and sign-ins 30 per 5 min, token verifications 30, refresh 150 (owner-reported).
- `send-email` Edge Function deployed as **version 4**, `verify_jwt=false`, files `index.ts`, `authorize.ts`, `templates.ts`, `resendHeaders.ts`. Caller key is checked by a real admin call (`authorize.ts`). Deployed through the Supabase connector and verified by a hash read-back. Edge Function deploys happen only on the owner's explicit go.
- Avatar SQL applied: `profiles.avatar_path` with a CHECK and a column grant; private bucket «avatars» (2 MB, jpeg/png/webp); four own-folder storage policies (owner-reported).
- Function `create_verify_fixture` dropped (verified: 0 rows). `docs/OWNER_SQL.md` section 5 is done.
- Manual backups through `/admin/export`, including the ZIP (owner-reported).
- Vercel variable `ADMIN_ALERT_EMAIL` set (owner-reported). The InstaPay details are real (owner-reported).

### Decisions (keep them)

- **No reset of test data.** There are real customers (two accounts, owner-reported) and the ledger is append-only. Test accounts stay and are told apart by the shared classifier: `@digr.local`, `iam.magdy@outlook.com`, `iam.magdy+*@outlook.com`, known test ids. The admin account is not a test account. `iam.magdy+1` keeps its balance.
- `docs/OWNER_SQL.md` **section 1 (reset) must NEVER be run**; section 6 (seed) is stale and must never be run.
- Anthropic monthly limit: 50 USD (owner-reported). An InstaPay link cannot carry an amount.
- Review sentence on the top-up page: «غالبًا يتم الاعتماد خلال ١٥ دقيقة، وبحد أقصى ٢٤ ساعة، وتصلك رسالة عند إضافة النقاط».

### Standing rules

- Merge commits only. A PR merges only when the preview is READY on the exact full head SHA, only the skipped Supabase Preview check is non-green, tests pass (skipped = 57) and main has not moved; a BUILDING preview waits for the owner's GO. One production status check after each merge.
- No SQL run by agents: SQL is a proposal under `docs/proposals/` marked NOT APPLIED, and the owner applies it by hand after review. No Edge Function deploy without the owner's explicit go, verified by hash read-back. No background timers. One Vercel check per report.
- Customer text: Arabic only, Arabic-Indic digits, «حجز مؤقت مُحرَّر» as the only released-hold form, no provider names, no USD, no internal ids.
- Money: append-only ledger; charge = ceil(delivered x unit price), never above the reserve; the 15% buffer applies to the reserve only; the LLM never decides money. Do not touch ledger, pricing or `approve_topup_atomic` without an explicit brief.

### NOT PROVEN / open

- A real-device mobile check by the owner (the 14-item list below).
- The Phase 1 to 4 NOT PROVEN lists below stay valid.
- E-mails were not tested in Gmail, Outlook desktop or Apple Mail dark modes; the full-completion e-mail and the admin alert were not seen after the unified layout; e-mail button destinations were not clicked.
- The welcome e-mail is sent by a database trigger and was not re-tested.
- The avatar object is not deleted when an account is deleted.
- Excel and screen company columns follow the screen; optional columns depend on the source.
- The generic executor for most catalog services is unproven.
- Large jobs need the page open (driver-mode tab).
- The refund sentence «لا يُعاد الرصيد عن سجل تم تسليمه» in `src/lib/legalText.ts` is an owner and legal decision.
- Older sections further down are history and may be stale: for example the `send-email` function is deployed now (version 4, see above), although an older section says it is not.
- Phase 4 below was written while its deployment was BUILDING; later merges were all followed by a READY production deployment (the latest is named above).

---

## 0000000000. UI/UX audit of diger.tech, phases 1 to 4 (2026-10-24 and 2026-10-25, main = `65c3c1d`)

One session, one branch and one draft PR per phase, each merged with a MERGE COMMIT after the owner's go. Written from git and the deployment API (read only). No SQL was written or run: nothing in this audit touched the database, and no price, cap or pricing-function value changed.

### The four phases (PR, head SHA, merge commit, production deployment)

| Phase | PR | Head SHA | Merge commit | Production deployment | What |
|---|---|---|---|---|---|
| 1 | #231 | `a5cbbb5979641834aa62b396ceee8a3123223e69` | `fcedf71d8be07a40886d9e471bd0bcd33f7904cd` | `dpl_CzcvaBcJt3FUamqYyyjeJfktoKMi` READY | Money and trust: plan edit and its saved summary, sector typos, skip handling, retry line, wallet, released-hold wording, requested/duplicate notes (audit points 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 18, 28 and the edit-mode buttons) |
| 2 | #232 | `42fb0f96ec6319dce4f35896ef4f0df2a5649868` | `511d65cde256bc3bfe1a3b8047825c3fd2dea85f` | `dpl_6c8ApVfn6T94vqwY5bmdZss1SvJ3` READY | Flow clarity: points 1, 8, 9, 15, 16, 17, 19 to 27, 29, 30 (cost form, company columns and phone, status vocabulary, plan card money lines, question card, starters, titles, redirects, bell badge, top-up texts, one closing instruction) |
| 3 | #233 | `a415edf656956f889565014019f7d3fe67c45ede` | `90157dd743b2009bc1e4247fe37987c01ab7d13e` | `dpl_5M8j8Fc6KLwBoavzFLWXKnnhYbWu` READY | Landing page rebuilt (one sentence, one box, one action, computed price strip, two merged sections, labelled sample, 4-question FAQ, one closing action) plus every refund-style sentence replaced by «حجز مؤقت مُحرَّر» |
| 4 | #234 | `96dd305a23408fc3462b6c927903fa699dd23df3` | `65c3c1da64d9d01c0b0b3c74c0f5c76dd6985587` | `dpl_4eR1UWwWNDAnJqDdf4T4qEgpuny9`: **BUILDING** at the only check made; confirm READY in the Vercel dashboard | Mobile audit without a browser (390 x 844), «حجز مؤقت مُحرَّر» as the ONLY customer-facing form, one phone format in the decision-makers workbook |

Rollback of any phase: `git revert -m 1 <merge commit>` (newest first if more than one).

Suite on the merge parents (skipped is always 57): after phase 2 418 files / 4513 passed; after phase 3 420 / 4539; after phase 4 422 / 4564. `npx tsc --noEmit -p .`, `npm run build` and the client-bundle secret scan were clean on every phase head.

### Rules the audit worked under (keep them)

- Customer text: Arabic only, Arabic-Indic digits, no emoji, no markdown symbols, no provider or model names, no USD, no internal ids.
- A released hold is ONLY «حجز مؤقت مُحرَّر». Banned in customer text: the verb «حُرّر الحجز المؤقت», «تحرير الحجز المؤقت», «ويُحرَّر الباقي», «استرداد», «إرجاع», «أُعيدت», «أعدنا», «وعادت … إلى رصيدك», «يُرد». The list is `BANNED_RELEASE_FORMS_AR` in `src/lib/walletText.ts`; old stored rows are read through `normalizeReleaseWording` (`src/lib/releaseWording.ts`) and `walletDisplayText`; `tests/audit-phase4-release-form.test.ts` scans `src` and the e-mail function for the verb forms. Exceptions the owner kept: `src/lib/legalText.ts`, the admin pages, the top-up wording, the account-deletion line.
- Money: append-only ledger, release first, idempotent, nothing spent before approval, charge = ceil(delivered unique matching units x unit price) never above the reserve, one shared pricing function (`estimateMission`), the model never states money.
- The approval sentence «لا يبدأ أي جمع ولا يُخصم أي رصيد قبل موافقتك» appears ONCE on the landing page (the hero); a test counts it.
- Two copies of the e-mail templates exist (`src/functions/shared/emailTemplates.ts` and `supabase/functions/send-email/templates.ts`); change both.

### NOT PROVEN (nothing here was seen in a real browser or on real data)

Phase 1 (what the tests do and do not cover):
- Every flow was driven through `ChatHandler.handleUserMessage` and component renders with an in-memory database and `renderToStaticMarkup`. None of it was seen in a browser.
- The duplicate-request lookup and the plan-change note read earlier quotes and jobs; they ran only against the in-memory test database, not Supabase.
- The retry flow was checked server side (period kept, no repeated question) in four phrasings guarded by tests; the real customer wording of a retry on the live site was not tried.

Phase 2:
- Everything that needs a real browser: layout, scroll, focus, the canvas opening on reopen, the RTL table.
- The real shape of delivered company rows. The shared company column list was built from code, not from live rows; the workbook keeps its fixed 11 columns, and fields the screen can show (description, headcount, founding year, presence statuses) are not in the workbook.
- The conversation title update and the duplicate lookup against live Supabase.
- `/terms` and `/privacy` redirects were checked in `next.config.mjs` only, not served live.

Phase 3:
- How the landing page looks in a browser (hero, price strip, FAQ, contrast).
- How the stored-notice normalizer reads real old rows (tested on the sentence shapes known from the code only).
- Pages other than the landing page were not re-audited for wording beyond a grep.

Phase 4:
- Everything in the real-device checklist below.
- The landing header cutoff («خدماتنا» hidden below 480px) is a width ESTIMATE, not a measurement.

### Real-device checklist (390 x 844 or a real phone)

1. iPhone Safari: with the keyboard open in the chat, whether the composer stays visible (`visualViewport` offset), whether the page jumps on focus, and whether the shell height settles after the keyboard closes.
2. iPhone with a notch or home indicator: the composer, the results sheet buttons and the bottom of the settings, top-up and requests pages against the safe areas, in portrait and landscape.
3. Android Chrome: the same keyboard test (`resizes-content`), and whether Escape or the back gesture closes the drawer.
4. The landing header at 360, 390 and 430px: no overflow, and sign-up and login both reachable.
5. The landing price strip, the hero form (box above the button, then side by side from 560px) and the single-column FAQ.
6. RTL reading in the real chat: the user bubble with a pasted long link, the plan card (price block, count line, edit and approve rows) and the revision card.
7. The results table on a phone: horizontal swipe, the hint, long company names, the left-to-right phone cell, and the live-preview table scroll in the activity panel.
8. The pricing and calculator tables, and the sample table on the landing page, with horizontal swipe.
9. The sidebar drawer: opening from the right, overlay tap, the account menu at the bottom, the notification panel width, scroll lock behind the drawer.
10. Touch targets by thumb: the buttons raised to 44px, the attachment-remove button (hit area only) and the terminal close button.
11. The wallet capacity cards (stacked below 480px) and the three-column stat rows on the requests page.
12. The terminal's 10 to 11px text for legibility, and the contrast of muted text in light and dark modes.
13. Arabic text rendering: font loading, line breaks in long Arabic sentences, and mixed Arabic and Latin cells (phone, handle).
14. Any admin page on a phone (not audited).

### Open owner decisions

1. **Top-up review time.** `TOPUP_REVIEW_TIME_AR` in `src/lib/topupConfig.ts` is `null` on purpose, so the top-up screen promises no duration. Set it to a time you can keep («خلال ساعة في أيام العمل»), or set `reviewTimeAr` in the public settings row `pricing` (it wins over the constant).
2. **Payment label and address.** The label above the address is `TOPUP_PAYMENT_LABEL_AR` («عنوان الدفع اللحظي · منصة ديجر»; override with `paymentLabelAr` in the same settings row). The ADDRESS under it is the value saved in the admin settings (`ipa`); if it is a personal handle, replace it there. The code cannot know.
3. **The refund sentence in the terms.** `src/lib/legalText.ts` (section «٣. النقاط واحتساب التكلفة») still says «بعد التسليم لا يُعاد الرصيد عن سجل تم تسليمه». It was left unchanged on purpose: it is legal text, so wording and any refund policy are the owner's call.

Smaller choices left open:
- The landing sample files carry no link, e-mail or domain: the comments sample has no link column, and the website and e-mail cells of the companies and decision-makers samples say «غير متاح». The alternative is a visibly fake address; the decision-makers sample no longer shows an example e-mail.
- The sidebar drawer and the chat history panel have no focus trap or `aria-modal`.
- Admin pages still use the verb form («تحرير حجز» in `AdminShell`, the admin recover route) and were not audited on mobile.
- Landing components no longer on the page (`Statements`, `Sheets`, `ProductLines`, `DemoConversations`) stay in `src/components/landing/Sections.tsx` only because existing tests render them.
- The mission templates (bracketed) stay in the dashboard's empty chat; the landing hero offers none.

---

## 000000000. Live-check fixes, batch 2 (branch `claude/live-fixes-batch-2`, from main `f10aacd`)

- «المنشورات فقط» on a Facebook topic: no comments plan, no default of 500, one honest sentence, nothing quoted or held (`FACEBOOK_POSTS_ONLY_UNAVAILABLE_AR`, `commentsAnsweredNo` in `src/lib/socialTasks.ts` and `src/lib/socialDiscoveryCard.ts`). The cause was the label «التعليقات المطلوبة» carrying the comment word; the intent now reads the answer, not the label.
- A tatweel («بـ») is stripped before topic tokens are read (`topicTokens`, `src/lib/socialTasks.ts`); «فقط»، «بس»، «بدون» are answer words, never topic.
- «أخرى» then a typed name: a served name continues; an unserved one gets `UNSUPPORTED_PLATFORM_AR` naming تيك توك، فيسبوك، يوتيوب، ومنصة X. A bare «أخرى» is not a name (`unsupportedPlatformAnswerAr`, `src/lib/socialDiscoveryCard.ts`).
- A Facebook page plan shows «الصفحة:» with the handle only (`pageHandleOf`, `src/lib/planMethodSteps.ts`; `planScopeRows`, `src/lib/quoteScopeGaps.ts`). Numbers unchanged.
- `normalizePhone` in `src/lib/multiProvider/policy.ts` drops the bracketed trunk zero («+20 (0)22…» → `+20225087419`). The other eleven forms match origin/main output.
- Tests: `tests/posts-only-answer.test.ts`, `tests/platform-other-typed.test.ts`, `tests/facebook-page-chip.test.ts`, `tests/phone-trunk-zero.test.ts`; changed `tests/platform-follow-up.test.ts` and `tests/phone-digits-kept.test.ts`.

---

## 00000000. Live-check fixes, batch 1 (branch `claude/live-fixes-batch-1`, from main `c4b5088`)

- «أخرى» on the platform question asks ONE free-text follow-up (`social_platform_other_required`); a name this service does not read gets one honest sentence (`UNSUPPORTED_PLATFORM_AR`), no plan, no hold. Snapchat is named by the platform detector but no service reads it, so the check runs before the platform-missing branch (`src/functions/shared/chatHandler.ts`, `src/lib/socialDiscoveryCard.ts`, `src/lib/consultantCopy.ts`).
- The data word «داتا» and «بيانات» are request wording, dropped from the topic (`TOPIC_NOISE`, `src/lib/socialTasks.ts`).
- A page plan's methodology says the posts are read from the page (`src/lib/planMethodSteps.ts`, used by `PlanQuoteCard.tsx`).
- The review sheet column is «العنوان كما ورد» (it holds addresses).
- The Facebook keyword card carries one sample line (text only).
- The admin stats read «completed» and `deliveredUnits` (`src/lib/server/adminJobEvents.ts`).
- TikTok and X customer files drop the source id column (`sourceIdHiddenFor`, `src/lib/server/normalizationPipeline.ts`).
- The shortfall sentence states the posts requested and read (`src/lib/server/zeroDeliveryDiagnostic.ts`).
- The wallet's «this month» starts at Cairo midnight, not the server's (`cairoMonthStartMs`, `src/lib/walletView.ts`).
- Findings not changed: company review rubric (`src/lib/server/companyRelevanceReview.ts`) and phone normalisers (no digit dropped; `policy.ts` adds a zero to «+20 (0)22…»).

---

## 0000000. Facebook topic request: no Page question, keyword plan (branch `claude/fb-topic-keyword-routing`, from main `b252666`)

- Evidence: the owner's tester (production, 24 Oct 2026) answered platform, comments, posts and comments per post, then was asked «فيسبوك: ما اسم الصفحة العامة أو رابطها؟» with the sentence «فيسبوك لا يتيح البحث بالموضوع». The explicit sentence went straight to the keyword card.
- Cause: `socialDiscoveryTrigger` (`src/lib/socialDiscoveryCard.ts`) asked for a page when no other verified Facebook service was in the list it was given. The fast plan path (`buildDeterministicPlanFromIntent`, fed the full catalog, which holds the verified `facebook-post-search`) and the discovery path (fed the enabled list, which in production lacks it) disagreed, so one request got the page question and the other did not.
- Fix: a Facebook request WITH a topic never asks for a page (the keyword service searches the topic). Only a request with NO topic asks for «الموضوع أو اسم الصفحة أو رابطها». The platform options now include «فيسبوك» (`src/lib/clarification.ts`, `src/lib/consultantCopy.ts`, `src/functions/shared/chatHandler.ts`). The outdated sentence is removed.
- Tests: `tests/facebook-topic-keyword-route.test.ts` (production-like enabled list), and the two phase5 assertions that pinned the page question for a topic request.

## 000000. Facebook topic report (branch `claude/intelligent-volta-hgqmy5`, from main `6832fa9`)

- New capability `facebook-topic-report` (one item per quote, unit = delivered comment, 3.025 points proposed; the owner decides): vetted public Pages browsed round-robin with a 20% per-publisher cap and an exact date window, comments never judged, posts placed on health axes by rules plus one model call per 50 ambiguous posts, an Excel (data only) and a separate Arabic methodology PDF. Design, tests and NOT PROVEN list: `docs/FACEBOOK_REPORT.md`; Pages the owner must review: `docs/FACEBOOK_REPORT_PAGES.md`; price arithmetic: `docs/proposals/facebook-topic-report/PRICING.md`. No SQL, no price/cap/ceiling changed. **Gated off** until a registry Page has `ownerReviewed: true` (`FACEBOOK_REPORT_ENABLED`).
- Period fix: «آخر ٣ شهور» was replaced by «آخر شهر» (shared per-item-phrase reader, number words) and a period's number could become the record count (`understandMission`); both fixed, with tests.

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
