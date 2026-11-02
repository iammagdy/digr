# FOUNDATION PLAN: one design that ends the per-platform patch loop

Written 2026-11-02 against `main` = `0268fec` (merge of #345). **Planning only.** No runtime code, no SQL write, no migration, no flag change, no paid provider call, no merge. The only file this PR adds is this one.

Marks: **V** = I read the line, row or catalog entry myself in this session. **V-R** = reported by an earlier document or session (`docs/ROOT-CAUSE.md`, `docs/S1-LIVE-FINDINGS.md`, `docs/REDESIGN-PLAN.md`, `docs/AUDIT-2026-11.md`, `docs/HANDOFF.md`), not re-read here. **GUESS** = inference no line or row proves. **NOT VERIFIED** = needs data this session cannot read.

Every database query of this session is listed in section 9 (read-only `SELECT` only; none failed).

---

## 0. The answer in ten lines

1. Every live failure since #330 has the same shape: **the model composes the plan from a few pages it chose to sample, and about fifteen code passes then repair it**. #345 added a final check, but the check accepts a plan that *states* a gap even when the catalog has a tool that *carries* the condition (V, section 1.5). That is exactly the Facebook failure.
2. **Tool choice never sees the topic.** The ranking runs inside the model's `catalog_search`; the pool is "tools with the same catalog capability as the first hits", and coverage counts only date, language, country, account, sort, replies (V). There is no topic class, `rankByCoverage` is never called by product code (V), and D7's "prefer a tool that can" is enforced only for the country (V).
3. **The catalog is better than what the pipeline uses.** Facebook has two post searches with keyword + start/end date (`justoneapi.x.facebook-search-post-v1`, `anyapi.facebook.search_posts`); the second has no catalog capability, so it is never in the pool (V). In M17 the planner *did* sample the first one with `startDate 2026-08-02 / endDate 2026-11-02`, then planned the 3-rows-a-page listing, and the card said «المصدر المختار لا يسمح بتحديد الفترة الزمنية» (V, queries Q6 and Q7).
4. **Selection happens at planning, over at most two sampled pages per source** (`GATEWAY_MAX_SAMPLES_PER_SOURCE = 2`, protected file, V). With a 3-row listing that is 6 posts. No later pass can choose well from 6.
5. **I could not read the stored raw pages.** The objects exist (sizes V); SQL reads only their metadata; I have no Storage read tool; the admin file route serves only `result.xlsx/.csv` (V). Section 2 says exactly what is missing and the smallest way to get it.
6. **The foundation (section 3)**: (F1) one ASK record built once and used by everything; (F2) a TOOL CARD per usable endpoint, verified on real stored responses; (F3) a PLAN COMPILER in code that builds parents → comments → replies from the Ask and the cards in one pass (no model-written stages, no send-backs); (F4) a candidate POOL read by code with an exposure check before the card; (F5) a TYPED PROMISE (exact / counter / open, never an estimate); (F6) no fallback to the old pipeline for a flagged platform; (F7) every acceptance test replays real stored responses.
7. With F1-F7, a new platform problem becomes a **card or fixture change (data)**, not a new pass (code). That is the stopping rule for the loop.
8. **Remaining work: 7 PRs.** Stage 1 needs three (real pages in; the foundation; Facebook/Instagram/YouTube cards), then one each for Stages 2, 3, 4, and the money PR. Four need the strong model (foundation, Stage 3, Stage 4, money).
9. Eleven owner decisions are in section 7; the four that block Stage 1 are: where real fixtures may live (**the repo is public**, V), planning pool depth against the protected two-sample cap, the exposure check, and allowing unverified cards for test-account missions only.
10. Not verified: the content of every raw page, the Heroku and Vercel deploy state, whether the free YouTube detail tool is connected on our TREG account, why the M17 planner dropped the search tool (section 8).

---

## 1. What I verified about the current system

### 1.1 The pipeline, end to end (social request, flag `test`, test account)

| Step | Where | What happens | Mark |
|---|---|---|---|
| Chat turn | `src/lib/agentMission/constants.ts:18` `AGENT_SERVES_CHAT = true` | every research turn creates a mission for the worker | V-R (REDESIGN-PLAN F8) |
| Worker picks the mission | `agent/src/runMission.ts` | reads flags (`redesign_flags`, per-platform keys since #345), `accountIsTest` (id + e-mail, `agent/src/redesign.ts:41`) | V |
| Planning (model) | `agent/src/tools.ts` tools `catalog_search`, `describe_endpoint`, `treg_call`, `run_code`, `ask_question`, `propose_plan` | the model searches the catalog with its own words, samples tools (paid calls, ours), writes mapping code, and proposes 1-4 stages | V |
| Sample cap | `agent/src/gateway.ts:40` `GATEWAY_MAX_SAMPLES_PER_SOURCE = 2` | at most two planning reads of one source (protected file) | V |
| `propose_plan` | `agent/src/tools.ts:625-990` | about fifteen ordered passes and six send-back counters (table 1.4), then the #345 gate, then `store.updateMission(plan)` (`tools.ts:985-987`) | V |
| Price and card | site, `price.ts`, `finalPrice.ts` | priced once by code from the stored plan | V-R |
| Approval | ledger reserve | nothing spent from the customer before this | V-R |
| Execution path | `agent/src/redesign.ts:11` `redesignStagesOf` | new engine only if the type/platform flag is active AND every stage `engine.built_by === "code"`; otherwise the OLD pipeline for the whole mission (`fallback_stage` is now recorded, `redesign.ts:25`) | V |
| Engine | `agent/src/engine/run.ts`, `spec.ts` | reads pinned parents (`parent_pins`), pages by cursor, spares (#344), replies through comment tokens | V-R |
| Ingest and file | `agent/src/items/ingest.ts`, `workbook.ts`, `finalize.ts` | raw mode: id dedupe and count cap only; marks; settlement from the read-back file | V-R |

### 1.2 Where the request is built

- **What the customer asked** is read by about a dozen regexes (`wantsReplies`, `wantsAllChildren`, `engagedDefault`, `wantsNewestOrDate`, `conditionsOfRequest`, `perParentQuantities`, `topicMeaningOf`, `topicMeaningFromModel`) and since #345 also by `buildRequestContract` (`src/lib/agentMission/requestContract.ts:87`). The contract is used **only by the final gate**; the passes above it still read the regexes (V: `tools.ts:639, 697-703, 825, 869`).
- The contract's `period`, `country`, `language` are booleans; `topic` and `source.text` are raw strings (V: `requestContract.ts:13-26`). No dates, no resolved account, no order.
- **What the provider receives** is the model's sampled call, frozen as the stage recipe, then rewritten by code where `codeBuild` applies (`tools.ts:703` passes `engaged`, `newest`, `topicQuery`); the X query gets Cairo-day `since:/until:` (#341) (V for the call site, V-R for the inner rules).

### 1.3 How tools are chosen (V)

1. The model calls `catalog_search` with its own words (`tools.ts:350-353`).
2. `rankedCandidates` (`src/lib/agentMission/candidates.ts:29-38`) builds the pool as **the tools with the same catalog `capability` as the first matching seeds** (`sameCapability`), ranked by expected cost per item.
3. In redesigned mode the pool is re-sorted by coverage of `conditionsOfRequest(...)` (`tools.ts:375-390`). The classes are `date, language, country, account, count, sort, replies` (`src/lib/agentMission/toolProfile.ts:151-152`). **There is no topic class**: a page listing "covers" `account`, a keyword search with dates covers `date`; they tie, and price breaks the tie for the 0.002 USD listing.
4. `rankByCoverage` exists (`sourceRanking.ts:248`) but is called **only by tests** (V: grep).
5. The model then chooses what to sample and what to plan. Code can only send the plan back.
6. **Capability `None` in the catalog** (V, `data/treg/treg_catalog_sellable.json`): 22 Facebook, 50 Instagram and 47 YouTube endpoints, among them `anyapi.facebook.search_posts`, `anyapi.facebook.post_comments`, `anyapi.facebook.comment_replies`, `anyapi.youtube.search`, `anyapi.youtube.video_comments`, `anyapi.youtube.channel_videos`, `anyapi.youtube.comment_replies`, `anyapi.instagram.comment_replies`. They can never join a `sameCapability` pool. (The replies code reaches some of them by its own list, `replies.ts`, V-R.)

Usage proves it (V, Q8, all missions ever): `anyapi.instagram.user.posts` 0 calls; `youtube.youtube.video.detail` 0 calls; `anyapi.youtube.*` 0 calls; `anyapi.facebook.search_posts` 1 planning call (failed).

### 1.4 The patch passes and send-backs inside `propose_plan` (V: `agent/src/tools.ts`, comment markers)

| Line | Pass | Added for | Kind |
|---|---|---|---|
| 682 | `validateAndPricePlan` | base | check |
| 684-694 | people and phones send-back (`PEOPLE_SEND_BACKS_MAX = 3`, `:130`) | companies | send-back |
| 695-720 | derive recipes from the model's samples (`deriveEngineSpecsChecked`) | engine | rewrite |
| 696-700 | engaged default, topic meaning, topic query | S5, S8 | rewrite input |
| 721-722 | store capability (Rule 9) | S11 | rewrite |
| 723-729 | comment-language column | S4 | rewrite |
| 730-742 | **country send-back** (`COUNTRY_SEND_BACKS_MAX = 2`, `:132`) | S4 | send-back |
| 743-769 | **sort / query send-back** (`SORT_SEND_BACKS_MAX = 2`, `:133`) | S5, S8 | send-back |
| 770-787 | **account one-more-page send-back** (`ACCOUNT_PAGE_SEND_BACKS_MAX = 1`, `:135`) | S11, Round 4 | send-back |
| 788-807 | comments recipe written by code when the model's is missing | S3 | rewrite |
| 808-809 | relevance removed | S3 | rewrite |
| 810-817 | contact columns, reference columns | audit PR 1 | rewrite |
| 818-855 | **replies stage** (`withRepliesStages`) | #327, S2, S3, S4 | add stage |
| 856-933 | **complete count** (`withCompleteCount`: candidates, counter basis, page cap, named, matches, pageable alternative) | S1, S2, S6, S7, Round 4 | rewrite promise |
| 935-952 | **media send-back** (`MEDIA_SEND_BACKS_MAX = 3`, `:127`) | earlier rounds | send-back |
| 953-959 | people fallback line | companies | rewrite card |
| 960-972 | **named-source send-back** (shares `finishRefusals`) | earlier rounds | send-back |
| 974-984 | **#345 final gate** (`CONTRACT_SEND_BACKS_MAX = 2`) | #345 | check / send-back |
| 985-987 | store the plan | | |

Six send-back counters (people, country, sort, account page, media, named source) plus the contract counter are fields of `RunState` (`tools.ts:76-117`, V). Each was added by one live round.

### 1.5 What #345's gate does and does not do (V: `src/lib/agentMission/requestContract.ts:200-286`, `tools.ts:974-984`)

**Does:**
- Runs after the last pass, in redesigned mode only.
- Demands a comments stage when comments were asked (send-back up to 2, naming the catalog's comments tools), then writes «not included» lines for a missing comments or replies stage.
- Writes an honest line for a period, country, language, source or topic that no input field carries.
- Records counts (`contract_carried / stated / missing`) as an internal event.

**Does not:**
- **Prefer a tool that carries over a line that states.** An item is accepted as `stated` when the plan's notes already carry the gap line (`statedBy`, `requestContract.ts:188`). M17 and M19 both carried «لا يسمح بتحديد الفترة الزمنية» while the catalog has two Facebook searches with date inputs. D7 is not enforced by the gate.
- **Check the source honestly.** `source` counts as carried when any input key looks like an account or a URL (`KEY_RE.account` includes `url`, `page`), so a page listing always "carries" the named page (V `:161`, `carriedBy` `:166`).
- **Check the topic honestly.** `topic` is carried when 60% of its tokens appear in any string input (V `:174`); a listing without a query gets the topic line, and that passes.
- Check the promise: nothing compares the promised number with the counters of the chosen items, or with what a source exposes.
- Choose tools, page counts, or parents. It runs after every choice is made.
- Run with the flag off, or on companies.
- Remove any pass. #345 kept all of table 1.4 (V-R: `ROOT-CAUSE.md` section 8, "Kept, and why").

### 1.6 When selection happens (V)

The posts or videos to read are chosen in `withCompleteCount` at planning, from `candidatesOf` (`tools.ts:871-891`): **only the rows of the parent source's pages the planner sampled**. The gateway allows two samples of one source (`gateway.ts:40`). Execution then reads exactly the pinned parents (V-R `alignPinnedParents`). So the choice is made among at most two pages: 6 Facebook posts (3 a page, V: 30 calls, 2.9-3.0 rows a call, Q8), 12 or 24 Instagram posts, 15-20 YouTube search results.

---

## 2. Real data: can I read the stored raw pages of the 20 missions?

### 2.1 No. What exists and what is missing.

- **Exists (V, Q2-Q4):** bucket `agent-missions` (private), 8,687 objects in `storage.objects`. Per mission: `raw/call_NNNN.json` (one per provider call), `out/*.json`, `rows/<stage>.json` (what was delivered), `result/result.xlsx/.csv`, `planning_state.json`, `run_state.json`. Example, M17 `msn_6bb78c15d116268b0b9b`: 13 raw pages of 714, 5,200, 7,899, **66,738**, **21,812**, 5,847, 113, 113, 7,802, 294, 294, 294, 294 bytes; calls 4 and 5 are the two Facebook keyword-and-date searches.
- **Missing:** the bytes. SQL reads only object metadata; the content lives in Storage, not in Postgres. This session has a read-only SQL tool, no Storage download tool, no service key (and must not ask for one), no Heroku access. The admin route `src/app/api/admin/agent/[id]/file/route.ts:14` accepts only `result.xlsx` or `result.csv`. The worker reads raw pages itself (`store.getFile(mission.id, "raw/…")`, `tools.ts:798`), so the credentials exist only on Heroku and Vercel.
- **Smallest way to get them (PR 1):** an admin-only "download the raw pages of these missions as one ZIP" action in the existing admin agent page, using the server's existing Storage client. The owner clicks it once and gives the ZIP to the PR 2 session. No secret changes hands.

### 2.2 What the call log and object sizes already prove (V, Q4, Q6, Q8; cost = observed per call, except where the tool was never billed: catalog price)

| Platform | Tool | Calls (all missions) | Rows a call | Empty / failed | Cost a call (USD) | What it means |
|---|---|---|---|---|---|---|
| Facebook | `anyapi.facebook.user.posts` (page listing, cursor) | 30 | **2.9-3.0** | 0 / 1 | 0.0012 | 3 posts a page; M1 read 11 pages = 33 posts |
| Facebook | `crawl4ai.facebook.user.posts` | 11 | 0 | **11 / 0** | 0 (free when empty) | dead without a session |
| Facebook | `scrapecreators.x.v1-facebook-profile-posts` | 3 | 1.0 | 0 / 1 | 0.00188 | its own summary: «limited to 3 posts per page» |
| Facebook | `justoneapi.x.facebook-search-post-v1` (keyword, startDate, endDate, cursor) | 22 | **5.1** | 0 / 2 refused | **0.02952** | the only working keyword+date post search; 0.531 USD spent at planning over 8 missions; never paged with a cursor |
| Facebook | `anyapi.facebook.search_posts` (query, dates, location, limit ≤ 20) | 1 | 0 | 0 / 1 | 0.06606 | capability None; failed once (refused) |
| Facebook | `scrapecreators.x.v1-facebook-post-comments` | 38 | 5.9-8.2 | 6 / 2 | 0.00188 (billed even empty) | empty twice on the same `/posts/pfbid…` link (M17), 500 on a bare domain (M1) |
| Facebook | `anyapi.facebook.comment_replies`, `scrapecreators.x.v1-facebook-post-comment-replies` | 4 + 4 | 0 | **8 / 0** | 0.0012 / 0.00188 | every Facebook reply read was empty (M17, M19); raw page 294 bytes each |
| Instagram | `scrapecreators.instagram.user.posts` | 3 | **12** | 0 | 0.00188 | one page of 12; catalog `pagination` is empty although `next_max_id` is an input |
| Instagram | `crawl4ai.instagram.user.posts` | 9 | 6.8-7.3 | 0 / 2 (503 timeout) | 0.0009 | 12 latest without a session (its summary) |
| Instagram | `anyapi.instagram.post.comments` | 8 | 2.0-5.0 | 0 / 1 | 0.0008-0.00144 | no reply counter in its fields |
| Instagram | `anyapi.instagram.comment_replies` | 13 | **1.0** | 0 | 0.0011 | M16: one blind read per comment |
| Instagram | `crawl4ai.instagram.post.comments` | 2 | 0 | 0 / 2 (`session is required`) | 0 | unusable |
| Instagram | `tikhub.x.instagram-v3-get-comment-replies` | 2 | 0 | 2 / 0 | 0.008 | empty |
| YouTube | `crawl4ai.youtube.search.videos` | 24 | 11.5-15.5 | 0 / 4 | 0.0009 | no channel filter, no comment counter |
| YouTube | `crawl4ai.youtube.video.comments` (limit ≤ 500, no cursor) | 35 | 14.9-17.8 | 7 / 0 | 0.0009 | one video gave 0 twice (M2) |
| YouTube | `tikhub.x.youtube-web-search-channel` (search inside a channel) | 9 | **29.5-29.8** | 1 / 2 | 0.001 | the official-channel route M2 used; catalog has no list path |
| YouTube | `tikhub.youtube.channel.videos` (channel id, continuation) | 3 | 30 | 0 / 1 | 0.001 | 30 a page |
| YouTube | `tikhub.youtube.video.comments` (continuation, reply token) | 9 | 1.0-3.3 | 0 / 2 | 0.001 | carries `reply_continuation_token` (catalog fields) |

### 2.3 What only the raw pages can answer (NOT VERIFIED until PR 1)

For Facebook: whether `justoneapi` search rows carry the page as `author` (id, name, URL) so the named page can be recognised; the date format of `timestamp`; whether `comments_count` counts replies; whether `comments_id` feeds a comments tool; why the comments tool answered 113 bytes for the `pfbid` link; whether the reply tools' 294-byte answers are "no replies" or an error. For Instagram: whether a `scrapecreators` page carries `next_max_id`; the reply counter of `scrapecreators.instagram.post.comments`. For YouTube: the shape of `tikhub.x.youtube-web-search-channel` pages (list path, channel id per row, published time); whether crawl4ai's `replies` field is a count. For all: page size against counters, and how often a counter exceeds what the source exposes.

---

## 3. The foundation

### 3.1 Seven changes, one shape

**F1. The ASK (one record, built once, read by everything).** Extend #345's contract into `Ask`: platform; parent kind; count; source `{kind: named | official | none, text, resolved: handle / page URL / channel ids}`; topic `{text, relation: about | made_with | ambiguous}`; period `{from, to}` as Cairo instants; country; language; order `{most_commented (default) | newest}`; comments and replies `{none | n | all}`. Built by code from the request and the answer. The model's only planning job for social becomes **filling the fields code cannot read** (an ambiguous topic relation, which channels are "official") through one structured tool, and code checks every value against the customer's words. An ambiguous value becomes a question card (≤ 3, Stage 2). Every regex of 1.2 is replaced by a read of the Ask.

**F2. TOOL CARDS (what each endpoint really does, verified on real pages).** One small record per usable endpoint, in `src/lib/agentMission/toolCards/` (data, not code): role (`facebook.search.posts`, `instagram.user.posts`, …, independent of the catalog's capability, so capability-`None` tools become usable), inputs that carry each Ask condition (query, start/end date and format, account, sort, cursor), page size observed, list path, id / text / date / author / counter fields, reply-token fields, cost. A card is **verified** when a stored real response of that endpoint maps with it (every row an id; counters and cursor where the card says). Mapping code is generated from the card, never written by the model. Card status: `verified`, `catalog_only` (test accounts only, decision 7.4), `broken` (observed failing: e.g. `crawl4ai.facebook.user.posts` 11 of 11 empty).

**F3. THE PLAN COMPILER (code, one pass, replaces model-composed stages and every send-back).** `compilePlan(ask, cards, pool) → stages`. The stage shape comes from the Ask: parents → comments (if asked) → replies (if asked and a reply card exists). Tool choice for each stage, in this order:
1. A card with the right role whose inputs carry **every** condition of the Ask that a tool can carry (topic and period count as conditions; a search tool with topic and date beats a listing tool without them, whatever the price; D7).
2. Among equals: the one that carries the named source in an input; then pageable; then a counter field; then expected cost.
3. A condition no card can carry becomes, by code, either a **choice among read items** (the named source, the topic relation, the country: choosing, not filtering) or a **mark column**, and the card says so before approval. Never a silent drop.
Inputs are written by code from the card (`toolInput.ts` already does this for dates and countries). The model never writes stages, mappings, page sizes, or queries.

**F4. THE POOL, read by code at planning, and the EXPOSURE CHECK.** The compiled parent stage is read by code (not by model samples) to a depth that the card and the Ask decide: until the period's start is reached, the listing ends, or the depth limit is hit (decision 7.2: the protected two-sample cap). The parents are chosen in the owner's order (named source → country and language → own text about the topic → most commented, or newest when asked) among **all pool rows**, and N spares are kept. If the parent card has no counter and a counter card exists (YouTube: `youtube.youtube.video.detail`, 50 ids a call, free), the counters of the pool are read in one call. **Exposure check** (decision 7.3): before the card is shown, the first comments page of every chosen parent is read; a parent whose page is empty while its counter is above zero is replaced by the next spare (M17's `pfbid` post would have been swapped before approval, not after).

**F5. THE TYPED PROMISE.** Every stage's number has exactly one type, set by the compiler and shown by one fixed sentence:
- `exact(n)`: the customer's count of parents (2 posts, 20 tweets);
- `counter(n)`: the sum of the platform counters of the chosen, checked parents («بحسب عدّاد المنصة»);
- `open`: no counter exists anywhere in the cards («كل ما يعرضه المصدر»).
An estimate (a sample mean, a model number) **never** becomes a promise; it may only size the reserve's maximum. Delivery is judged by type: `exact` and `counter` after reading every chosen parent to the source's end with every eligible comments card and the spares; the residual gap per parent is stated with the platform counter beside what the source showed. `promise_total`, `replies_open`, `children_open`, the replies share estimate and the counter-basis guess collapse into this one field.

**F6. NO FALLBACK.** When a platform's flag is on or test, its missions never run the old pipeline. A stage the compiler cannot build is a «not included» line on the card (the #345 repair), never a model recipe and never the old engine. `redesignStagesOf` becomes "compiled or not offered" for flagged platforms.

**F7. REAL RESPONSES ARE THE TESTS.** A replay harness serves stored `raw/call_*.json` pages to the compiler and the engine through a fake gateway (keyed by endpoint and input digest) and compares with the stored `rows/*.json` (what was really delivered). Each live failure is added as a fixture before its fix; the fix is then, in most cases, a card change.

### 3.2 What each root cause becomes

| Cause (ROOT-CAUSE.md) | Removed by |
|---|---|
| 1. No request contract | F1: the Ask drives the plan instead of checking it after |
| 2. Ten passes, six send-backs, no final gate | F3: one compiler pass; the gate becomes an invariant test (a compiled plan cannot lack an asked stage) |
| 3. Silent fallback | F6 |
| 4. Listing tools read too little | F3 (search tools with topic and date win) + F4 (pool depth by Ask, not by model samples) |
| 5. Promise = estimate, delivery = what the source exposes | F5 (no estimate is a promise) + F4 (exposure check and spares before approval) |
| 6. Tests on invented worlds | F2 (cards verified on real pages) + F7 (replay of real pages) |

### 3.3 When selection happens

**Planning.** The owner's rule needs the promise before approval, and the promise is the counters of the chosen items, so the choice must be made before the card. What changes is *who reads and how much*: code reads the pool by the card, the model does not choose the pages. Execution reads exactly the chosen parents and, if one gives nothing, the next spare (already #344).

### 3.4 Patch code that can be deleted once the compiler serves a platform (social only; companies keep theirs until Stage 3)

- `agent/src/tools.ts`: the country send-back (730-742), the sort/query send-back (743-769), the account-page send-back (770-787), the comments-recipe-by-code pass (788-807), the media send-back for social (935-952), the named-source send-back (960-972), the derive-recipes-from-samples path for social (695-720), the comment-language-column pass (723-729, moves into the card's columns), the contract send-back (974-984 becomes an assertion), and the `RunState` counters `countrySendBacks`, `sortSendBacks`, `accountPageSendBacks`, `mediaSendBacks`, `contractSendBacks`.
- `src/lib/agentMission/completeCount.ts`: `basisOf` share estimate, `pageCapOf`, the candidates-from-samples reader, `promise_total` (replaced by F4 and F5).
- `src/lib/agentMission/replies.ts`: the replies estimate (`plannedRepliesFor`, the "stated unknown 2 a comment"); the replies stage becomes a compiler stage.
- The regexes for social: `wantsReplies`, `wantsAllChildren`, `engagedDefault`, `wantsNewestOrDate`, `conditionsOfRequest`, `perParentQuantities` (social use), `topicMeaningOf` word list and `topicMeaningFromModel` (moves into the Ask).
- After all five platforms are `on` and stable: the old pipeline's social content filters (`relevance.ts` rules, `filters.ts` drops) for social stages.
- Kept: `toolInput.ts` (Cairo dates, countries), `toolProfile.ts` (feeds the cards), `requestContract.ts` parsing (becomes the Ask's code reader), engine paging, spares, pins, replies tokens, workbook, marks, money files.

---

## 4. Facebook, Instagram and YouTube: the concrete approach

All endpoint facts below are V from `data/treg/treg_catalog_sellable.json` unless marked. Prices are the catalog's.

### 4.1 Facebook: «منشورات عن [الموضوع] من صفحة قناة العربية آخر ٣ شهور، مع كل التعليقات والردود»

**Parents (posts).**
1. `justoneapi.x.facebook-search-post-v1`: `keyword` (required), `startDate`, `endDate` (`yyyy-MM-dd`, inclusive), `cursor`; list `data.results`, cursor `data.cursor`; fields `post_id, url, message, timestamp, comments_count, reactions_count, reshare_count, author, author_title, comments_id, …`; 0.02952 USD a successful page; observed 5.1 rows a page (V Q9). The compiler writes the Cairo days of the period (start day and end day; the file's «ضمن الفترة المطلوبة» mark checks the exact instant). The named page is **chosen**, not filtered: the pool rows whose `author` is the page come first. Whether `author` identifies the page: NOT VERIFIED (raw pages).
2. `anyapi.facebook.search_posts`: `query`, `startDate`, `endDate` (`YYYY-MM-DD`), `location`, `limit` 1-20; list `output.data.items`; fields `authorName, authorUrl, commentCount, createdUtc, id, text, url, …`; 0.06606 USD a call; **no cursor** (one page of ≤ 20); capability `None` in the catalog, so a card must give it its role. One planning call was refused (V Q9; the refusal reason was not read). `authorUrl` makes the page match exact.
3. Only when the Ask has no topic and no period: the page listing `anyapi.facebook.user.posts` (`url` or `pageId`, `cursor`; 3 a page; fields `author, createdUtc, id, media, text, url`: **no comment counter**), so the promise is `open` or needs a detail read per post.

**Comments.** `scrapecreators.x.v1-facebook-post-comments` (`url` or `feedback_id`, `cursor`; list `comments`; billed per call even when empty), then `anyapi.facebook.post_comments` (`url` or `feedbackId`, `cursor`; list `output.data.comments`; 0.002; capability `None`), then `justoneapi.x.facebook-get-post-comments-v1` (`postId`, `cursor`; 0.02952; no list path: needs a card from a real page, one exists from `msn_25fb87d4b0dd80c6ae12` call 4). The exposure check (F4) reads the first page before the card.

**Replies.** `anyapi.facebook.comment_replies` and `scrapecreators.x.v1-facebook-post-comment-replies` (both `feedbackId` + `expansionToken` from the comment row). 8 of 8 live reads were empty (V); whether that is "no replies" or a broken read is NOT VERIFIED (raw pages of 294 bytes). Until a real page shows a reply, the replies promise on Facebook is `open`.

**Truly impossible with today's catalog (V):**
- A tool that takes both an author/page and a keyword. «Posts of page X about Y» is always a search plus a choice, never a server-side filter.
- A calendar date range on any page listing (5 listing tools, none has a date input).
- A country or language input on any Facebook post tool (`location` on `anyapi.facebook.search_posts` is a place hint, not a country filter: GUESS from its note).
- Reading three months of a news page through a listing: at 3 posts a page this is thousands of calls (GUESS on the page's volume); not feasible inside the daily cap.
- **Cost limit, not impossibility:** at 0.02952 USD a search page, the 0.80 USD daily provider cap allows about 27 pages a day for all customers. The compiler must cap the pool per mission (decision 7.6).

### 4.2 Instagram: «منشورين من حساب الحدث (alhadath)، مع كل التعليقات والردود»

**Parents (posts of an account).**
1. `anyapi.instagram.user.posts`: `handle` (required), `cursor` (`nextCursor`); list `output.data.posts`; fields `caption, comments, createdUtc, id, likes, media, url, username, verified`; 0.0024 a page. **Pageable, has the comment counter and the date**, so the pool can walk back to a period's start and choose the most commented. **Never called by Diger** (V Q8): its page size is NOT VERIFIED.
2. `scrapecreators.instagram.user.posts`: `handle`, `next_max_id`; 12 a page (V); the catalog's `pagination` is empty, so the engine reads one page (V-R REDESIGN-PLAN F12). A card can declare `next_max_id` as its cursor once a real page shows the value.
3. `tikhub.instagram.user.posts` (`user_id` numeric, `count`, `max_id`; 0.001) after a profile lookup.
4. Not chosen: `crawl4ai.instagram.user.posts` (12 latest without a session; 2 of 9 calls failed on a 503 timeout, V Q8).

**Topic or period inside an account.** No account listing has a keyword or a date input (V). The approach: walk the account listing back by its cursor and choose by the caption (topic relation) and the counters; or search reels by keyword (`anyapi.instagram.search.reels`: `query`, `cursor`, about 110 results at most, relevance order, fields include `username`, `comments`) and choose the named account's rows; `scrapecreators.x.v2-instagram-reels-search` adds `date_posted` = last-week / last-month / last-year only.

**Comments.** `anyapi.instagram.post.comments` (`url`, `cursor`; no reply counter field), `scrapecreators.instagram.post.comments` (`url`, `cursor`; whether it has a reply counter: NOT VERIFIED). Not usable: `crawl4ai.instagram.post.comments` (`session is required`, V).

**Replies.** `anyapi.instagram.comment_replies` (`commentId` + `url`, `cursor`; 13 of 13 calls returned 1 row, V), `tikhub.x.instagram-v1-fetch-comment-replies` (`media_id`, `comment_id`, `min_id`). Without a reply counter on the comment rows, replies are a blind read per comment (priced), and the promise is `open`.

**Truly impossible today:** a calendar date range or a keyword on any account listing; a country or language input (0 of 8 listing tools, V-R consolidation table); the exact reply count before reading when the comments tool gives no counter.

### 4.3 YouTube: «فيديوهين عن نهائي السوبر … من القنوات الرسمية، مع كل التعليقات والردود»

- **Official channels:** resolve the channels first (`tikhub.x.youtube-web-v2-search-channels`, keyword), then read inside each channel: `tikhub.x.youtube-web-search-channel` (`channel_id` + `search_query`, 30 a page, V; no catalog list path: card from M2's real pages `raw/call_0006`, `call_0007`) or `tikhub.youtube.channel.videos` (`channel_id`, continuation; list `data.videos`). M18 and M20 used the plain search (`crawl4ai.youtube.search.videos`), which has no channel input: that is why video 2 was from another channel.
- **Counters:** no search or listing tool returns a comment counter (V-R consolidation table, V for the fields above). `youtube.youtube.video.detail` (`part=statistics`, up to 50 ids a call, free, «included with the connected account») returns `statistics`; never called by Diger (V Q8). If our TREG account has YouTube connected (NOT VERIFIED, decision 7.7), the promise becomes `counter`; otherwise `open`.
- **Comments:** `tikhub.youtube.video.comments` (`video_id`, `continuation_token`; fields `reply_count`, `reply_continuation_token`) is the one that feeds replies; `crawl4ai.youtube.video.comments` (≤ 500, no cursor, no reply token) cannot.
- **Replies:** `anyapi.youtube.comment_replies` (capability `None`) or `tikhub.x.youtube-web-v2-get-video-comment-replies`, both by the comment's continuation token.
- **M20 (comments stage lost):** impossible under F3: the stage shape comes from the Ask, not from the model.

---

## 5. The remaining work as the fewest PRs (7)

**Rules for every PR** (unchanged from `REDESIGN-PLAN.md` section 3): red test committed first, then green; flags-off output byte-identical; no SQL; protected files untouched (`agent/src/gateway.ts` caps, `price.ts` charge formula, `jobPointsCap.ts`, `src/functions/**`, `supabase/**`, `finalize.ts` settlement lines, ledger and billing files, the protected PRs); merge commits only; after each merge, **Heroku Activity shows Build succeeded and Deployed on the merge SHA** (site-only PRs: Vercel production READY on the SHA) before any live check.

**The anti-loop rule (new):** after PR 2, a live failure on a platform is first stored as a replay fixture. If the replay shows a card is wrong or missing, the fix is a card change in the same platform PR (PR 3) or a follow-up commit to the open PR. A new code pass in `propose_plan` is not allowed; if the compiler itself is wrong, that is a defect of PR 2, fixed with a replay that proves it.

### PR 1: Real responses in (Stage 1, part 1)

- **Goal:** the owner can download, as one ZIP, the stored `raw/` and `rows/` objects of the missions the owner selects, from the admin agent page. Nothing else.
- **Files:** `src/app/api/admin/agent/[id]/file/route.ts` or a sibling `raw-zip/route.ts` (admin only, `authenticateAdmin`), the admin agent page button, `tests/admin-raw-zip.test.ts`.
- **Risks:** exposing raw pages: admin only, same check as today's file route; ZIP size (largest object seen 673 KB, V Q4).
- **Rollback:** `git revert -m 1 <merge>`.
- **Acceptance (real):** for `msn_6bb78c15d116268b0b9b` the ZIP lists `raw/call_0001.json` … `raw/call_0013.json` with byte sizes 714, 5,200, 7,899, 66,738, 21,812, 5,847, 113, 113, 7,802, 294, 294, 294, 294 (equal to `storage.objects` metadata, query Q4 of this plan).
- **Live check (owner):** Vercel production READY on the SHA; download the ZIP for the 20 missions of ROOT-CAUSE.md plus the eight Facebook search missions `msn_71577d2920048f9ebf22`, `msn_aaed7fa9ffecc854edc0`, `msn_5324df5fff82ef3c6a0e`, `msn_a6e52e97658bc41fa7ad`, `msn_25fb87d4b0dd80c6ae12`, `msn_020bf5c4110c15c86ab8`, `msn_e39585e687833914039e`, `msn_980f9a239454964b0583`; the file count equals `select count(*) from storage.objects where bucket_id='agent-missions' and split_part(name,'/',1) = '<id>' and name ~ '/(raw|rows)/'`.
- **Model:** cheaper model (mechanical route and button).

### PR 2: The foundation (Stage 1, part 2): F1-F7, TikTok and X moved onto it

- **Goal:** the Ask, the Tool Cards (TikTok and X cards verified on real pages; the generic counter-card and exposure-check mechanism), the compiler, the pool, the typed promise, no fallback, the replay harness; the social send-backs and passes of 3.4 deleted for compiled platforms. TikTok and X keep their live results.
- **Files:** new `src/lib/agentMission/ask.ts`, `toolCards/*.ts` (data) + `toolCards/verify.ts`, `compilePlan.ts`, `pool.ts`, `promise.ts`; `agent/src/tools.ts` (social `propose_plan` path replaced by the compiler; model tool `understand_request`), `agent/src/redesign.ts` (F6), `agent/src/engine/run.ts` (typed promise judgement; no change to paging), `src/lib/agentMission/customerView.ts` and card sentences (one per promise type); `tests/fixtures/live/raw/**` (from PR 1, anonymised per decision 7.1), `tests/helpers/replayGateway.ts`, `tests/foundation-*.test.ts`. Not touched: the protected files.
- **Risks:** the largest change of the plan; a TikTok/X regression (mitigated by the replays below and by the per-platform flag); planning time should fall (the model writes an Ask, not stages and mapping code: G14) but is NOT VERIFIED; deleting passes changes behaviour only for compiled platforms (flags-off byte-identical test stays).
- **Rollback:** per-platform flag `off` (settings, no deploy); then `git revert -m 1`.
- **Acceptance (real):**
  1. The Ask of each of the 20 stored request texts equals a hand-written table (real Arabic texts, `replay-missions.json`).
  2. Replaying M12 `msn_5851abc92a1e6645a9cd` (TikTok) on its stored pages: the compiled plan uses the same tools as the stored plan, promise type `counter`, and the engine replay delivers the ids of the stored `rows/*.json` (369 rows). M14 `msn_b060d3347ed7660f972e` (X): 20 of 20, the same ids.
  3. M20 `msn_adcfafabcdebc27ff803`: the compiled plan has videos, comments and replies stages from the Ask alone (no model).
  4. M6, M9, M13: no promise of type estimate exists; the replies promise is `counter` or `open`.
  5. A flagged platform's mission cannot run the old pipeline (engine selector test over all 20 stored plans).
  6. `agent/src/tools.ts` contains none of the deleted counters (a test reads the file).
- **Live check (owner, after Heroku Build succeeded and Deployed on the SHA):** in `test` mode run benchmark 3 (TikTok) and 5 (X) of `docs/benchmarks/antigravity-10.md`; then `select kind, counts from mission_events where mission_id = '<id>' and kind in ('plan','result','call')`: `pipe_new = 1`, `fallback_stage` absent, delivered per stage equal to the promise per stage (or the stated per-parent gap with the platform counter).
- **Model:** **strong model** (design-heavy, subtle pipeline logic, many deletions).

### PR 3: Facebook, Instagram, YouTube on the foundation (Stage 1, part 3)

- **Goal:** verified cards for the tools of section 4 (data), the role entries for capability-`None` tools, the YouTube counter card, fixtures from the real pages of M1, M2, M4, M15-M20 and the eight Facebook search missions; then the three platform flags can go to `test`.
- **Files:** `src/lib/agentMission/toolCards/facebook.ts`, `instagram.ts`, `youtube.ts`, fixtures, `tests/platform-cards-*.test.ts`. **No change to the compiler.** If the replay shows a compiler defect, that part goes back to the strong model as a PR 2 defect.
- **Risks:** a card the real pages do not support stays `catalog_only` (test accounts only, decision 7.4); Facebook search cost against the daily cap (decision 7.6).
- **Rollback:** the three platform flags `off`; `git revert -m 1`.
- **Acceptance (real):**
  1. M17 `msn_6bb78c15d116268b0b9b` and M19 `msn_96beb9f7a1d937a90cd0` request text, replayed on the stored pages (`raw/call_0004.json`, `raw/call_0005.json` of M17 and the eight search missions): the compiler chooses a Facebook keyword search with `startDate 2026-08-02`, `endDate 2026-11-02` (Cairo days of the request date) over the page listing; the card states, with the real numbers of the stored pages, how many pool posts are from the Al Arabiya page and talk about the topic; no line «لا يسمح بتحديد الفترة الزمنية».
  2. M16 `msn_e3e7632e2fb2d42f9c19` and M15: the compiled plan reads the account with a pageable card, chooses the two most commented of the pool (from the real stored page), and has a replies stage; the promise types are `counter` for comments and `open` for replies (no reply counter on the comments card).
  3. M2 `msn_ee599cdbbde993073b15`, M18, M20: the compiled videos come from the channel ids of the stored channel-search pages; comments and replies stages exist; the promise is `counter` only if the detail card is verified, else `open`.
- **Live check (owner, after Heroku Build succeeded and Deployed):** benchmarks 1, 2, 4 in `test` mode; the same SELECTs as PR 2; plus the call log: no `anyapi.facebook.user.posts` call for a request with a topic and a period.
- **Model:** cheaper model, **under the rule** that it may change only `toolCards/` data and fixtures; anything else goes to the strong model.

### PR 4: Stage 2, understanding cards and the live sheet

- **Goal:** the «فهمنا طلبك» card is the Ask, open and editable; an edit recompiles the plan by code; at most three question cards from the cards' inputs (+ «شيء آخر»); polling feed over the item store (no Realtime); desktop sheet with the file's column names; mobile cards with «X من N» and the notebook line from a code whitelist; the final file equals the rows watched. If all five platform flags are `on` and stable (decision 7.9), the first commit pair deletes the old social content filters.
- **Files:** `src/components/mission/*`, `src/app/api/missions/[id]/rows/route.ts` (new polling feed), `customerView.ts`, `notebookLines.ts` (whitelist), tests including a scan of every new string by `checkCustomerText`.
- **Risks:** free-plan polling load (adaptive, jittered, as `startNotificationPolling`); customer-text rules.
- **Rollback:** `git revert -m 1`; the feed is read-only.
- **Acceptance (real):** for M12 and M14, the feed served from the stored `rows/*.json` equals the workbook rows of the stored `result.xlsx` (same ids, same order); the Ask card of the 20 stored requests renders the expected fields.
- **Live check:** Vercel READY and Heroku Build succeeded and Deployed on the SHA; one benchmark run watched on desktop and on a phone (390 px); the counter ends equal to the file.
- **Model:** cheaper model (UI and a read-only feed; the recompile is a call to the PR 2 compiler).

### PR 5: Stage 3, companies and queue

- **Goal:** the same Ask → cards → compiler shape for companies and decision makers (company general e-mail and HQ phone as deliverable columns, people with marks, exact duplicates only, every relevant tool before «غير متوفر»); the people send-back and contact passes of 1.4 move into the compiler; the queue message with position and start time; one e-mail per job only when the measured wait exceeds one minute, within the Resend 50,000 a month.
- **Files:** `ask.ts` (companies fields), `toolCards/companies.ts`, `compilePlan.ts` (companies shape), `contactFinders.ts`, `customerView.ts`, `notices.ts`.
- **Risks:** the e-mail template lives in the `send-email` Edge Function (`src/functions/**`, protected; deploy only on the owner's go, decision 7.10); finder yields are low (AUDIT G18).
- **Rollback:** the `companies` / `people` flags `off`; `git revert -m 1`.
- **Acceptance (real):** replays of the stored companies missions `msn_7539ea17512cf58aa0e7` and `msn_4969a50fed8c45b37d8f` on their raw pages (PR 1 ZIP): the compiled columns are the AUDIT 1A reference in order; the HQ phone cell is filled wherever the stored companies page has `phone_number`; no row removed except exact duplicates (D5).
- **Live check:** benchmarks 8 and 9 in `test` mode after Heroku Build succeeded and Deployed; every company row has a source call in `mission_calls` (the hard check of benchmark 8).
- **Model:** **strong model** (pipeline logic, the contact chain, the e-mail rules).

### PR 6: Stage 4, review, edits, versions (no charging)

- **Goal:** file versions (the old one kept); the optional paid review that never deletes a row, with a report and a score, price shown by code (1 point per 100 cells, minimum 100, as a price input only); fix-and-merge as a new version; the post-delivery edit on the same file (price shown: real cost x markup, minimum 100). The charge itself waits for PR 7.
- **Files:** `src/lib/agentMission/versions.ts`, `review*.ts`, `reviewPrice.ts` (price input, not wired to a charge), `customerActions.ts` (edit after delivery), card components.
- **Risks:** an edit path that is not priced yet must not deliver paid work for free: shipped behind a flag that stays `off` until PR 7.
- **Rollback:** the flag; `git revert -m 1`.
- **Acceptance (real):** an edit «ضيف عمود …» on the stored result of M12 produces version 2 of the same file with only the changed part re-read, version 1 unchanged; a review of the stored M14 file lists problems and deletes no row.
- **Live check:** after Heroku Build succeeded and Deployed, one edit and one review on a test-account delivery with the flag in `test`; no ledger row is written (SELECT on `credit_ledger` for the mission).
- **Model:** **strong model** (versions and edit flow are design-heavy).

### PR 7: The money PR (explicit owner brief required)

- **Goal:** charges for review, fix and edit through the existing ledger functions with new deterministic ids; staged jobs above 25,000 points (each stage its own plan, approval and charge).
- **Files:** only those the owner's brief names.
- **Risks:** money. Append-only ledger, release-first, idempotent, `ceil(delivered x unit)`, never above the reserve.
- **Rollback:** per the brief; ledger rows are never deleted.
- **Acceptance:** replay of the M12 edit with ledger rows `res_ / chg_ / rel_` balanced; a 30,000-point request becomes two stages with two approvals.
- **Live check:** after Heroku Build succeeded and Deployed, one edit charge on the test account; ledger SELECT balanced.
- **Model:** **strong model**.

---

## 6. Model split

| PR | Model | Why |
|---|---|---|
| 1 Real responses in | cheaper | one admin route, one button, one test |
| 2 Foundation | **strong** | the compiler, the pool, the promise types and the deletions decide every later platform |
| 3 FB / IG / YT cards | cheaper, data only | the compiler chooses; the work is cards and fixtures from real pages. Any code change outside `toolCards/` returns to the strong model |
| 4 Stage 2 | cheaper | UI, a read-only feed, fixed text; the recompile calls PR 2 |
| 5 Stage 3 | **strong** | companies pipeline, contact chain, e-mail limits |
| 6 Stage 4 | **strong** | versions, review without deletion, edits after delivery |
| 7 Money | **strong** | money paths, owner brief |

Product models are unchanged: Claude Haiku 5.5 for chat; Haiku 5.5 with extended thinking for planning. With the compiler, planning asks the model only to fill the Ask, which should shorten planning (AUDIT G14: time follows output tokens). NOT VERIFIED until PR 2 runs live.

---

## 7. Decisions the owner must make (recommendation in one line each)

| # | Decision | Recommendation |
|---|---|---|
| 7.1 | **Where real pages may be stored for tests. The GitHub repo `iammagdy/digr` is PUBLIC (V).** Raw pages contain commenters' names and texts. | Commit only anonymised fixtures (person names, handles, avatars and comment texts replaced by stable placeholders; ids, counters, dates, cursors and structure kept); never commit the raw ZIP. |
| 7.2 | Pool depth at planning versus the protected cap of two samples per source (`gateway.ts:40`). | Keep the cap for PR 2 and PR 3 (search tools put the topic and period in the request, so two pages are usually enough); change it only with a separate owner brief if the replays show it is not. |
| 7.3 | The exposure check: read the first comments page of each chosen item before the card (our cost, about 0.002 USD an item). | Yes. |
| 7.4 | Allow `catalog_only` (not yet verified) cards for test-account missions only, so the first live run captures their first real response. | Yes, with a ceiling of 0.10 USD of such calls per mission. |
| 7.5 | Facebook named page + topic + period when the pool holds fewer than N posts from that page. | Show a question card before approval: only the k found (default), or fill from other pages with the mark «المصدر المسمّى: غير مطابق», or cancel. |
| 7.6 | Facebook search costs 0.02952 USD a page against the 0.80 USD daily cap. | Keep the cap; limit one mission's search pool to 6 pages (0.18 USD) and say on the card how many were read. |
| 7.7 | The free YouTube detail tool needs YouTube connected on our TREG account. | Check the TREG dashboard; if connected, use it for YouTube counters; if not, YouTube promises stay `open`. |
| 7.8 | Delete the patch passes of 3.4 inside PR 2 (not later). | Yes, for compiled platforms only; companies keep theirs until PR 5. |
| 7.9 | Delete the old pipeline's social content filters. | Yes, in PR 4, once all five platform flags have been `on` for 7 days with clean benchmark runs. |
| 7.10 | The queue start e-mail needs a template in the `send-email` Edge Function (protected; deploy on your go). | Approve one new template in PR 5 with the usual hash read-back, or drop the e-mail. |
| 7.11 | The anti-loop rule of section 5 (a live failure becomes a fixture and, normally, a card change; no new pass). | Adopt it as a standing rule in HANDOFF. |

---

## 8. What I could not verify

1. **The content of every raw page** of the 20 missions and of the eight Facebook search missions (no Storage read; section 2). Everything in 2.3 depends on it.
2. Why the M17 planner sampled the Facebook keyword-and-date search and then planned the page listing (the model's reasoning is not stored; GUESS: the named-source rule and the price).
3. Why the one `anyapi.facebook.search_posts` call was refused (the refusal reason was not read as text).
4. Page sizes of tools Diger never called: `anyapi.instagram.user.posts`, `anyapi.youtube.*`, `youtube.youtube.video.detail`, `anyapi.facebook.post_comments`.
5. Whether YouTube is connected on Diger's TREG account (`youtube.youtube.*` "included with the connected account").
6. How the two-sample cap counts a search tool: listing endpoints are keyed by endpoint + source value (`gateway.ts:135`, V); a search endpoint falls to the per-endpoint count (`gateway.ts:239-241`, V for the line, GUESS that two keywords of one search tool share the two samples).
7. Heroku: build and deploy state of `0268fec`, worker logs, heartbeat (no access). Vercel production state (not checked in this session).
8. Whether Facebook's empty reply reads mean "no replies" or a broken read.
9. Planning time and token use after the compiler (only measurable live).
10. The test suite was not run (docs-only PR).

---

## 9. Every query run (read-only `SELECT`, through the read-only database tool)

- Q1 `list_tables` for schemas `public`, `storage` (row counts only).
- Q2 `select id, public, file_size_limit from storage.buckets`.
- Q3 objects of `agent-missions` grouped by top folder (count, first, last).
- Q4 object names and sizes (metadata only) of M15-M20, outside `items/`.
- Q5 columns of `mission_calls` (information_schema).
- Q6 every `mission_calls` row of M1, M2, M4, M15-M20 (phase, endpoint, status, rows, cost, `params_digest`, storage path), left-joined to object metadata (the join on the mission prefix returned no sizes; sizes come from Q4).
- Q7 per stage of M16-M20: endpoint, `built_by`, planned rows, pins, summary, notes.
- Q8 per Facebook / Instagram / YouTube endpoint and phase, over all missions: calls, rows, average rows of non-empty calls, ok / empty / bad, cost.
- Q9 every call of `justoneapi.x.facebook-search-post-v1`, `anyapi.facebook.search_posts`, `justoneapi.x.facebook-get-post-comments-v1`, with the mission's request text.
- Not SQL: `list_repos` (GitHub metadata: the repository is public); `pull_request_read` and `list_pull_requests` for #329-#345.

No write, no migration, no flag change, no paid call, no secret requested or seen.
