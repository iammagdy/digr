# FOUNDATION PLAN: one design that ends the per-platform patch loop

Written 2026-11-02 against `main` = `0268fec` (merge of #345). **Planning only.** No runtime code, no SQL write, no migration, no flag change, no paid provider call, no merge. The only file this PR adds is this one.

**Update 2 (2026-11-02, against `main` = `1b4049a`, the merge of #347).** PR 1 of section 5 has shipped (#347: the admin raw-pages ZIP). The owner downloaded the `raw/` and `rows/` objects of all 28 missions of PR 1: 509 files, 19,603,637 bytes, every manifest equal to `storage.objects`. The ZIPs stay on the owner's device. A reviewer has read M17 so far. This update changes sections 0, 2 (new 2.0; 2.1, 2.2, 2.3), 3.1 (F4), 3.4, 4.1, 5, 6, 7, 8 and 9, and adds section 10 (backlog). Still docs only.

Marks: **V** = I read the line, row or catalog entry myself in this session. **V (owner's ZIP)** = read in the real stored page of the owner's ZIP (M17 only so far). **V-R** = reported by an earlier document or session (`docs/ROOT-CAUSE.md`, `docs/S1-LIVE-FINDINGS.md`, `docs/REDESIGN-PLAN.md`, `docs/AUDIT-2026-11.md`, `docs/HANDOFF.md`), not re-read here. **GUESS** = inference no line or row proves. **NOT VERIFIED** = needs data this session cannot read.

Every database query of this session is listed in section 9 (read-only `SELECT` only; none failed).

---

## 0. The answer in ten lines

1. Every live failure since #330 has the same shape: **the model composes the plan from a few pages it chose to sample, and about fifteen code passes then repair it**. #345 added a final check, but the check accepts a plan that *states* a gap even when the catalog has a tool that *carries* the condition (V, section 1.5). That is exactly the Facebook failure.
2. **Tool choice never sees the topic.** The ranking runs inside the model's `catalog_search`; the pool is "tools with the same catalog capability as the first hits", and coverage counts only date, language, country, account, sort, replies (V). There is no topic class, `rankByCoverage` is never called by product code (V), and D7's "prefer a tool that can" is enforced only for the country (V).
3. **The catalog is better than what the pipeline uses.** Facebook has two post searches with keyword + start/end date (`justoneapi.x.facebook-search-post-v1`, `anyapi.facebook.search_posts`); the second has no catalog capability, so it is never in the pool (V). In M17 the planner *did* sample the first one with `startDate 2026-08-02 / endDate 2026-11-02`, then planned the 3-rows-a-page listing, and the card said «المصدر المختار لا يسمح بتحديد الفترة الزمنية» (V, queries Q6 and Q7).
4. **Selection happens at planning, over at most two sampled pages per source** (`GATEWAY_MAX_SAMPLES_PER_SOURCE = 2`, protected file, V). With a 3-row listing that is 6 posts. No later pass can choose well from 6. A search tool has the same limit per endpoint, whatever the keyword or cursor (V, `gateway.ts:240-242`). So under today's cap a Facebook search pool is 2 pages of `justoneapi`, about 10 posts (section 7.2).
5. **The raw pages are now in the owner's hands (PR 1, #347).** The first one read, M17, settles the Facebook points: search rows carry the author (page id, name, URL), a unix-seconds `timestamp`, `comments_count`, `comments_id` and a cursor. The empty comment and reply answers are successful empty answers, not errors (V (owner's ZIP), section 2.3). Every other page is still NOT VERIFIED.
6. **The foundation (section 3)**: (F1) one ASK record built once and used by everything; (F2) a TOOL CARD per usable endpoint, verified on real stored responses; (F3) a PLAN COMPILER in code that builds parents → comments → replies from the Ask and the cards in one pass (no model-written stages, no send-backs); (F4) a candidate POOL read by code with an exposure check before the card; (F5) a TYPED PROMISE (exact / counter / open, never an estimate); (F6) no fallback to the old pipeline for a flagged platform; (F7) every acceptance test replays real stored responses.
7. With F1-F7, a new platform problem becomes a **card or fixture change (data)**, not a new pass (code). That is the stopping rule for the loop.
8. **Remaining work: 7 PRs after PR 1 (8 in all; PR 1 shipped as #347).** Stage 1 needs four in all: real pages in (done), the foundation in two halves (**PR 2a** adds the compiler and deletes nothing; **PR 2b** deletes the passes once 2a is live and benchmarked), and the Facebook/Instagram/YouTube cards. Then one PR each for Stages 2, 3 and 4, and the money PR. Five need the strong model: 2a, 2b, Stage 3, Stage 4 and money.
9. Owner decisions (section 7): **decided** 7.1 (anonymised fixtures only), 7.3 (exposure check) and 7.4 (`catalog_only` on test accounts, 0.10 USD a mission). Awaiting the owner: 7.2, now restated with the verified cap rule, and 7.5 to 7.11. 7.6's "6 search pages" contradicted 7.2. It is now 2 pages, unless a separate owner brief changes the protected `gateway.ts`.
10. Not verified: every raw page except M17's, the Heroku and Vercel deploy state of later merges, whether the free YouTube detail tool is connected on our TREG account, why the M17 planner dropped the search tool (section 8).

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

### 2.0 Update 2: yes, through the owner (PR 1, #347)

- The admin page `/admin/agent` now downloads, as one ZIP, the `raw/` and `rows/` objects of up to 40 chosen missions. It is admin only, read-only, and logs names and sizes only.
- The owner downloaded all 28 missions of PR 1: 509 files, 19,603,637 bytes. Every `manifest.json` matched `storage.objects` exactly. The ZIPs stay on the owner's device and are never committed (decision 7.1).
- The largest stored `raw/` or `rows/` object is 5,535,284 bytes (V, `storage.objects` metadata). The 673 KB in 2.1 and in PR 1's risks was the largest object of M15-M20 only.
- Read so far: **M17** (`msn_6bb78c15d116268b0b9b`), by a reviewer, with the findings in 2.3. The other 27 missions' pages have not been read yet. Everything they alone can answer stays NOT VERIFIED.

### 2.1 No (first version, before PR 1). What exists and what is missing.

- **Exists (V, Q2-Q4):** bucket `agent-missions` (private), 8,687 objects in `storage.objects`. Per mission: `raw/call_NNNN.json` (one per provider call), `out/*.json`, `rows/<stage>.json` (what was delivered), `result/result.xlsx/.csv`, `planning_state.json`, `run_state.json`. Example, M17 `msn_6bb78c15d116268b0b9b`: 13 raw pages of 714, 5,200, 7,899, **66,738**, **21,812**, 5,847, 113, 113, 7,802, 294, 294, 294, 294 bytes; calls 4 and 5 are the two Facebook keyword-and-date searches.
- **Missing:** the bytes. SQL reads only object metadata; the content lives in Storage, not in Postgres. This session has a read-only SQL tool, no Storage download tool, no service key (and must not ask for one), no Heroku access. The admin route `src/app/api/admin/agent/[id]/file/route.ts:14` accepts only `result.xlsx` or `result.csv`. The worker reads raw pages itself (`store.getFile(mission.id, "raw/…")`, `tools.ts:798`), so the credentials exist only on Heroku and Vercel.
- **Smallest way to get them (PR 1):** an admin-only "download the raw pages of these missions as one ZIP" action in the existing admin agent page, using the server's existing Storage client. The owner clicks it once and gives the ZIPs to the PR 2a session on the owner's own device (see the PR #346 description). No secret changes hands.

### 2.2 What the call log and object sizes already prove (V, Q4, Q6, Q8; cost = observed per call, except where the tool was never billed: catalog price)

| Platform | Tool | Calls (all missions) | Rows a call | Empty / failed | Cost a call (USD) | What it means |
|---|---|---|---|---|---|---|
| Facebook | `anyapi.facebook.user.posts` (page listing, cursor) | 30 | **2.9-3.0** | 0 / 1 | 0.0012 | 3 posts a page; M1 read 11 pages = 33 posts |
| Facebook | `crawl4ai.facebook.user.posts` | 11 | 0 | **11 / 0** | 0 (free when empty) | dead without a session |
| Facebook | `scrapecreators.x.v1-facebook-profile-posts` | 3 | 1.0 | 0 / 1 | 0.00188 | its own summary: «limited to 3 posts per page» |
| Facebook | `justoneapi.x.facebook-search-post-v1` (keyword, startDate, endDate, cursor) | 22 | **5.1** | 0 / 2 refused | **0.02952** | the only working keyword+date post search; 0.531 USD spent at planning over 8 missions; never paged with a cursor, although `data.cursor` was non-empty on both M17 pages (V (owner's ZIP)) |
| Facebook | `anyapi.facebook.search_posts` (query, dates, location, limit ≤ 20) | 1 | 0 | 0 / 1 | 0.06606 | capability None; failed once (refused) |
| Facebook | `scrapecreators.x.v1-facebook-post-comments` | 38 | 5.9-8.2 | 6 / 2 | 0.00188 a page with rows | empty twice on the same `/posts/pfbid…` link (M17), 500 on a bare domain (M1). The first version said "billed even empty"; that is wrong for M17. Its two empty answers carry `credits_charged 0` (V (owner's ZIP)) and are recorded at 0.000000 USD (V, Q11). The other 4 empty calls were not re-read. |
| Facebook | `anyapi.facebook.comment_replies`, `scrapecreators.x.v1-facebook-post-comment-replies` | 4 + 4 | 0 | **8 / 0** | 0.0012 / 0.00188 | every Facebook reply read was empty (M17, M19); raw page 294 bytes each. M17's four are successful empty answers (V (owner's ZIP)), each billed 0.0012 USD (V, Q11). |
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

### 2.3 What only the raw pages can answer

**Now V (owner's ZIP, M17 `msn_6bb78c15d116268b0b9b`, read by a reviewer; the call order matches the call log, Q11):**

1. **`justoneapi.x.facebook-search-post-v1` (`raw/call_0004.json`, `raw/call_0005.json`):**
   - The rows carry `author.id`, `author.name`, `author.url`, `timestamp` (**unix seconds**), `comments_count`, `comments_id`, `post_id` and `url`.
   - `data.cursor` is **non-empty on both pages**, so more pages existed and were never read.
   - The stored `requestParams` show the keyword plus `startDate 2026-08-02` / `endDate 2026-11-02`, so the period was sent to the provider.
   - **3 of the 10 rows were authored by Al Arabiya pages.** The named page can therefore be recognised by `author` (id or URL), as a choice among pool rows (F3 rule 3).
   - The 10 rows match the call log: 5 rows on each call (Q11).
2. **`scrapecreators.x.v1-facebook-post-comments`, execution (`raw/call_0007.json`, `raw/call_0008.json`, 113 bytes each):**
   - `success true`, `credits_charged 0`, `comments []`, `has_next_page false`.
   - This is a **successful empty answer, not an error**. The call log records both as `empty` at 0.000000 USD (Q11).
3. **`anyapi.facebook.comment_replies`, execution (`raw/call_0010.json` … `raw/call_0013.json`, 294 bytes each):**
   - `found true`, `replies []`, `items 0`.
   - These are **successful empty answers, not errors**. They are billed 0.0012 USD each (Q11).

**Still NOT VERIFIED (pages not read yet, or the question is not answered by an empty answer):**

- **Facebook:**
  - whether `comments_count` counts replies;
  - whether `comments_id` feeds a comments tool (not replayed);
  - **why** the comments tool returned nothing for the `pfbid` post: the post had no visible comments, or that link form does not reach them. The answer says "none" without saying why, and the post's own `comments_count` was not compared;
  - **why** the reply reads returned nothing: the comments had no replies, or the tool cannot see them. No reply counter on a comment row was compared;
  - the other seven Facebook search missions' pages;
  - why `anyapi.facebook.search_posts` was refused.
- **Instagram:**
  - whether a `scrapecreators` page carries `next_max_id`;
  - the reply counter of `scrapecreators.instagram.post.comments`.
- **YouTube:**
  - the shape of `tikhub.x.youtube-web-search-channel` pages (list path, channel id per row, published time);
  - whether crawl4ai's `replies` field is a count.
- **All platforms:** page size against counters, and how often a counter exceeds what the source exposes.

The PR 2a and PR 3 sessions read these from the owner's ZIPs on the owner's device (see the PR #346 description) and commit only anonymised fixtures (decision 7.1).

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

**F4. THE POOL, read by code at planning, and the EXPOSURE CHECK.** The compiled parent stage is read by code (not by model samples) to a depth that the card and the Ask decide: until the period's start is reached, the listing ends, or the depth limit is hit (decision 7.2: the protected two-sample cap). Every pool read goes **through the gateway**: the planning budget, the daily-cap reservation and the call record live there, and a code path around it is not allowed. So under today's cap, the depth limit is 2 pages that return rows per search endpoint, and 2 per source value for a listing (V, `gateway.ts:135, 240-242`). The card says how many pages were read and whether the source had more (a non-empty cursor). The parents are chosen in the owner's order (named source → country and language → own text about the topic → most commented, or newest when asked) among **all pool rows**, and N spares are kept. If the parent card has no counter and a counter card exists (YouTube: `youtube.youtube.video.detail`, 50 ids a call, free), the counters of the pool are read in one call. **Exposure check** (decision 7.3): before the card is shown, the first comments page of every chosen parent is read; a parent whose page is empty while its counter is above zero is replaced by the next spare (M17's `pfbid` post would have been swapped before approval, not after).

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

**When:** never in PR 2a. These passes are deleted in **PR 2b**, for TikTok and X only, after PR 2a is live and their benchmarks pass. They are deleted for Facebook, Instagram and YouTube only after PR 3 is live and benchmarks 1, 2 and 4 pass (section 5). A pass is deleted only when a replay test has shown it changes nothing on every compiled plan of that platform.

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
1. `justoneapi.x.facebook-search-post-v1`: `keyword` (required), `startDate`, `endDate` (`yyyy-MM-dd`, inclusive), `cursor`; list `data.results`, cursor `data.cursor`; fields `post_id, url, message, timestamp, comments_count, reactions_count, reshare_count, author, author_title, comments_id, …`; 0.02952 USD a successful page; observed 5.1 rows a page (V Q9).
   - **Row fields, V (owner's ZIP, M17 calls 4 and 5):**
     - `author.id`, `author.name`, `author.url`;
     - `timestamp` in **unix seconds** (the card converts it to a Cairo instant);
     - `comments_count`, `comments_id`, `post_id`, `url`;
     - `data.cursor`, non-empty on both pages.
   - The stored request shows the keyword and `startDate 2026-08-02` / `endDate 2026-11-02`, so the period reaches the provider. The compiler writes the Cairo days of the period: the start day and the end day. The file's «ضمن الفترة المطلوبة» mark checks the exact instant.
   - The named page is **chosen, not filtered**: the pool rows whose `author.id` or `author.url` is the page come first. In M17, **3 of the 10 rows** were authored by Al Arabiya pages (V (owner's ZIP)). This card can be `verified` in PR 3 from these two pages.
   - **Pool under today's cap:**
     - 2 pages with rows per mission at planning, about 10 posts (V, section 7.2).
     - A named page + topic + period request will therefore often find fewer posts of that page than asked (M17: 3), so decision 7.5 matters.
     - Whether `comments_count` counts replies: NOT VERIFIED.
2. `anyapi.facebook.search_posts`: `query`, `startDate`, `endDate` (`YYYY-MM-DD`), `location`, `limit` 1-20; list `output.data.items`; fields `authorName, authorUrl, commentCount, createdUtc, id, text, url, …`; 0.06606 USD a call; **no cursor** (one page of ≤ 20); capability `None` in the catalog, so a card must give it its role. One planning call was refused (V Q9; the refusal reason was not read). `authorUrl` makes the page match exact. Under decision 7.4 it is `catalog_only`, so test accounts only, with a ceiling of 0.10 USD a mission. That allows **one** call (0.06606 USD), not the two the cap would allow (0.132 USD).
3. Only when the Ask has no topic and no period: the page listing `anyapi.facebook.user.posts` (`url` or `pageId`, `cursor`; 3 a page; fields `author, createdUtc, id, media, text, url`: **no comment counter**), so the promise is `open` or needs a detail read per post.

**Comments.** `scrapecreators.x.v1-facebook-post-comments` (`url` or `feedback_id`, `cursor`; list `comments`; billed per call even when empty), then `anyapi.facebook.post_comments` (`url` or `feedbackId`, `cursor`; list `output.data.comments`; 0.002; capability `None`), then `justoneapi.x.facebook-get-post-comments-v1` (`postId`, `cursor`; 0.02952; no list path: needs a card from a real page, one exists from `msn_25fb87d4b0dd80c6ae12` call 4). The exposure check (F4, decided: 7.3) reads the first page before the card.
- M17's two execution reads of the `pfbid` post (`raw/call_0007.json`, `call_0008.json`, 113 bytes) are **successful empty answers**: `success true`, `credits_charged 0`, `comments []`, `has_next_page false` (V (owner's ZIP)).
- So the exposure check must treat "success with no comments" as **empty**, not as an error: replace the parent with the next spare, and do not retry.
- Why that post gave no comments: NOT VERIFIED.

**Replies.** `anyapi.facebook.comment_replies` and `scrapecreators.x.v1-facebook-post-comment-replies` (both `feedbackId` + `expansionToken` from the comment row).
- 8 of 8 live reads were empty (V).
- M17's four (`raw/call_0010.json` … `call_0013.json`, 294 bytes) are **successful empty answers**: `found true`, `replies []`, `items 0` (V (owner's ZIP)). They are not errors, and each was billed 0.0012 USD (Q11).
- Whether those comments really have no replies, or the tool cannot see them: NOT VERIFIED. No reply counter was compared.
- Until a real page shows a reply, the replies promise on Facebook is `open`. A replies read is spent only on comments whose row shows a reply counter above zero, if the comments card has one (NOT VERIFIED).

**Truly impossible with today's catalog (V):**
- A tool that takes both an author/page and a keyword. «Posts of page X about Y» is always a search plus a choice, never a server-side filter.
- A calendar date range on any page listing (5 listing tools, none has a date input).
- A country or language input on any Facebook post tool (`location` on `anyapi.facebook.search_posts` is a place hint, not a country filter: GUESS from its note).
- Reading three months of a news page through a listing: at 3 posts a page this is thousands of calls (GUESS on the page's volume); not feasible inside the daily cap.
- **Cost limit, not impossibility:** at 0.02952 USD a search page, the 0.80 USD daily provider cap allows about 27 pages a day for all customers. Today the protected two-sample rule already limits the planning pool to 2 `justoneapi` pages a mission (0.059 USD). A deeper pool needs a protected-file change (decision 7.6).

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

## 5. The remaining work as the fewest PRs (8: PR 1 shipped as #347; PR 2 is split into 2a and 2b for safety; 7 remain)

**Rules for every PR** (unchanged from `REDESIGN-PLAN.md` section 3): red test committed first, then green; flags-off output byte-identical; no SQL; protected files untouched (`agent/src/gateway.ts` caps, `price.ts` charge formula, `jobPointsCap.ts`, `src/functions/**`, `supabase/**`, `finalize.ts` settlement lines, ledger and billing files, the protected PRs); merge commits only; after each merge, **Heroku Activity shows Build succeeded and Deployed on the merge SHA** (site-only PRs: Vercel production READY on the SHA) before any live check.

**The anti-loop rule (new, decision 7.11 awaiting owner):**
1. After PR 2a, a live failure on a platform is first stored as a replay fixture (anonymised, decision 7.1).
2. If the replay shows a card is wrong or missing, the fix is a card change, in the platform PR (PR 3) or as a follow-up commit to the open PR.
3. A new code pass in `propose_plan` is not allowed.
4. If the compiler itself is wrong, that is a defect of PR 2a, fixed by the strong model with a replay that proves it.
5. PR 2b only deletes. It adds no pass, no send-back and no new rule.
6. A pass may be deleted only when a replay test shows it changes nothing on every compiled plan of that platform.
7. A pass that **does** change a compiled plan is a compiler defect. It is fixed in the compiler, and the pass stays until that is proven.

### PR 1: Real responses in (Stage 1, part 1): SHIPPED

- **Status:** shipped as #347 (merge `1b4049a`, Vercel production READY on it, V in that session). The owner's live check is done: all 28 missions downloaded, 509 files, 19,603,637 bytes, every manifest equal to `storage.objects`. One defect was found in use: a truncated ZIP at the time limit (backlog, section 10).
- **Goal:** the owner can download, as one ZIP, the stored `raw/` and `rows/` objects of the missions the owner selects, from the admin agent page. Nothing else.
- **Files:** `src/app/api/admin/agent/[id]/file/route.ts` or a sibling `raw-zip/route.ts` (admin only, `authenticateAdmin`), the admin agent page button, `tests/admin-raw-zip.test.ts`.
- **Risks:** exposing raw pages: admin only, same check as today's file route; ZIP size. The first version said the largest object seen was 673 KB (Q4, M15-M20 only). The largest in the bucket is 5,535,284 bytes, and #347 caps a file at 10 MB and a ZIP at 60 MB.
- **Rollback:** `git revert -m 1 <merge>`.
- **Acceptance (real):** for `msn_6bb78c15d116268b0b9b` the ZIP lists `raw/call_0001.json` … `raw/call_0013.json` with byte sizes 714, 5,200, 7,899, 66,738, 21,812, 5,847, 113, 113, 7,802, 294, 294, 294, 294 (equal to `storage.objects` metadata, query Q4 of this plan).
- **Live check (owner):** Vercel production READY on the SHA; download the ZIP for the 20 missions of ROOT-CAUSE.md plus the eight Facebook search missions `msn_71577d2920048f9ebf22`, `msn_aaed7fa9ffecc854edc0`, `msn_5324df5fff82ef3c6a0e`, `msn_a6e52e97658bc41fa7ad`, `msn_25fb87d4b0dd80c6ae12`, `msn_020bf5c4110c15c86ab8`, `msn_e39585e687833914039e`, `msn_980f9a239454964b0583`; the file count equals `select count(*) from storage.objects where bucket_id='agent-missions' and split_part(name,'/',1) = '<id>' and name ~ '/(raw|rows)/'`.
- **Model:** cheaper model (mechanical route and button).

### PR 2a: The foundation, added (Stage 1, part 2): F1-F7, TikTok and X routed through the compiler behind their flags. Deletes nothing.

- **Goal:**
  - Add the Ask, the Tool Cards (TikTok and X cards verified on real pages; the generic counter-card and exposure-check mechanism), the compiler, the pool, the typed promise, no fallback for compiled platforms, and the replay harness.
  - TikTok and X missions go through the compiler **only when their per-platform flag is `test` or `on`**.
  - **No existing pass or send-back is deleted.** Every pass of 3.4 stays in `propose_plan` and still runs for every platform, so a compiled TikTok/X plan still passes through them. 2a adds a test proving that each pass changes nothing on every compiled replay plan.
  - **Flags off: output byte-identical** to `main`. The existing test stays, plus a replay of all 20 stored missions with every flag off.
- **Files:**
  - New: `src/lib/agentMission/ask.ts`, `toolCards/*.ts` (data) + `toolCards/verify.ts`, `compilePlan.ts`, `pool.ts`, `promise.ts`.
  - `agent/src/tools.ts`: an added, flag-gated compiler path ahead of the model's stages for TikTok/X, and the model tool `understand_request`. **No removal.**
  - `agent/src/redesign.ts` (F6, for compiled platforms only).
  - `agent/src/engine/run.ts`: the typed promise judgement; no change to paging.
  - `src/lib/agentMission/customerView.ts` and the card sentences (one per promise type).
  - Tests: `tests/fixtures/live/**` (anonymised fixtures only, decision 7.1, made on the owner's device; see the PR #346 description), `tests/helpers/replayGateway.ts`, `tests/foundation-*.test.ts`, and `tests/fixtures-anonymised.test.ts`, which fails if a name, handle, avatar or text field of a committed fixture is not a placeholder.
  - Not touched: the protected files, including `agent/src/gateway.ts` (pool reads go through it, under today's cap: section 7.2).
- **Risks:**
  - The largest addition of the plan.
  - A TikTok/X regression with the flag on, mitigated by the replays and by the per-platform flag. With the flag off nothing changes.
  - Planning time should fall (the model writes an Ask, not stages and mapping code: G14), but that is NOT VERIFIED.
  - Two paths live side by side until PR 2b.
- **Rollback:** per-platform flag `off` (settings, no deploy); then `git revert -m 1`.
- **Acceptance (real, on anonymised fixtures of the stored pages):**
  1. The Ask of each of the 20 stored request texts equals a hand-written table (`replay-missions.json`).
  2. M12 `msn_5851abc92a1e6645a9cd` (TikTok), replayed:
     - the compiled plan uses the same tools as the stored plan, with promise type `counter`;
     - the engine replay delivers the ids of the stored `rows/*.json` (369 rows).
  3. M14 `msn_b060d3347ed7660f972e` (X): 20 of 20, the same ids.
  4. M20 `msn_adcfafabcdebc27ff803`: the compiled plan has videos, comments and replies stages from the Ask alone (no model).
  5. M6, M9, M13: no promise of type estimate exists; the replies promise is `counter` or `open`.
  6. A flagged, compiled platform's mission cannot run the old pipeline (engine selector test over all 20 stored plans).
  7. **Every pass and send-back of 3.4 is still present** (a test reads `tools.ts`), and each is a no-op on every compiled TikTok/X replay plan.
  8. Flags off: byte-identical plans and files for all 20 stored missions.
- **Live check (owner, after Heroku Build succeeded and Deployed on the 2a merge SHA):**
  - With the TikTok and X flags in `test` mode, run benchmark 3 (TikTok) and benchmark 5 (X) of `docs/benchmarks/antigravity-10.md`.
  - Then run `select kind, counts from mission_events where mission_id = '<id>' and kind in ('plan','result','call')`.
  - Pass when: `pipe_new = 1`; `fallback_stage` is absent; and the delivered count of each stage equals its promise, or the stated per-parent gap with the platform counter.
- **Model:** **strong model** (the compiler, the pool and the promise types decide every later platform).

### PR 2b: The foundation, cleaned (Stage 1, part 2b): delete the passes of 3.4 for compiled platforms

- **Starts only when all three hold:**
  - PR 2a is live: Heroku Activity shows **Build succeeded** and **Deployed** on the 2a merge SHA.
  - Benchmarks 3 (TikTok) and 5 (X) passed in `test` mode by the 2a live check.
  - 2a's acceptance 7 (each pass a no-op on compiled plans) is green on `main`.
- **Goal:**
  - For **TikTok and X only**, the passes and send-backs of 3.4 no longer run. Code that **no** platform still uses is deleted.
  - Code still used by Facebook, Instagram, YouTube (until PR 3 is live and benchmarked) or companies (until PR 5) stays.
  - The `RunState` counters go only once no path reads them.
  - Nothing is added except the tests.
- **Files:** `agent/src/tools.ts` (removals; one list of platforms whose compiled path is live), `src/lib/agentMission/completeCount.ts`, `replies.ts` (removals for compiled platforms), and the tests. Not touched: the protected files.
- **Risks:** a pass that was quietly needed. Mitigated by the no-op replays of 2a and by keeping the code for every other platform.
- **Rollback:** `git revert -m 1` (the passes return). The TikTok/X flags `off` also returns them to the old pipeline in full.
- **Acceptance (real):**
  - For TikTok and X, the 2a replays give the same plans and files with the passes gone.
  - For all other platforms, and with flags off, plans and files are byte-identical.
  - A test reads `tools.ts`: no TikTok/X path reaches the deleted passes.
- **Live check (owner, after Heroku Build succeeded and Deployed on the 2b merge SHA):** the same benchmarks 3 and 5 in `test` mode, with the same SELECT and the same pass rule as 2a.
- **Later, the same rule for the other platforms:**
  - **Facebook, Instagram and YouTube:** after PR 3 is live and benchmarks 1, 2 and 4 pass, adding them to the list is a one-line change with its own red/green tests. It is done in PR 4's first commit pair, by the strong model, together with the deletion of the social-only pass code.
  - **Companies:** in PR 5.
- **Model:** **strong model** (deletions inside the planning pipeline).

### PR 3: Facebook, Instagram, YouTube on the foundation (Stage 1, part 3)

- **Goal:** verified cards for the tools of section 4 (data), the role entries for capability-`None` tools, the YouTube counter card, fixtures from the real pages of M1, M2, M4, M15-M20 and the eight Facebook search missions; then the three platform flags can go to `test`.
- **Starts after:** PR 2a is live (PR 3 needs the compiler, not the deletions of 2b).
- **Files:** `src/lib/agentMission/toolCards/facebook.ts`, `instagram.ts`, `youtube.ts`, anonymised fixtures (decision 7.1), `tests/platform-cards-*.test.ts`. **No change to the compiler.** If the replay shows a compiler defect, that part goes back to the strong model as a PR 2a defect.
- **Facebook pool:** 2 `justoneapi` search pages a mission under today's cap (section 7.2). On test accounts, at most one `anyapi.facebook.search_posts` call, since it is `catalog_only` (decision 7.4, 0.10 USD a mission).
- **Risks:** a card the real pages do not support stays `catalog_only` (test accounts only, decision 7.4); Facebook search cost against the daily cap (decision 7.6).
- **Rollback:** the three platform flags `off`; `git revert -m 1`.
- **Acceptance (real):**
  1. M17 `msn_6bb78c15d116268b0b9b` and M19 `msn_96beb9f7a1d937a90cd0` request text, replayed on the stored pages (`raw/call_0004.json`, `raw/call_0005.json` of M17 and the eight search missions): the compiler chooses a Facebook keyword search with `startDate 2026-08-02`, `endDate 2026-11-02` (Cairo days of the request date) over the page listing; the card states, with the real numbers of the stored pages, how many pool posts are from the Al Arabiya page and talk about the topic. For M17, 3 of the 10 pool rows are by Al Arabiya pages (V (owner's ZIP)); topic matches are still to be counted. The card has no line «لا يسمح بتحديد الفترة الزمنية». The exposure check, replayed on `raw/call_0007.json`, treats the successful empty comments answer as empty and swaps in a spare.
  2. M16 `msn_e3e7632e2fb2d42f9c19` and M15: the compiled plan reads the account with a pageable card, chooses the two most commented of the pool (from the real stored page), and has a replies stage; the promise types are `counter` for comments and `open` for replies (no reply counter on the comments card).
  3. M2 `msn_ee599cdbbde993073b15`, M18, M20: the compiled videos come from the channel ids of the stored channel-search pages; comments and replies stages exist; the promise is `counter` only if the detail card is verified, else `open`.
- **Live check (owner, after Heroku Build succeeded and Deployed):** benchmarks 1, 2, 4 in `test` mode; the same SELECTs as PR 2a; plus the call log: no `anyapi.facebook.user.posts` call for a request with a topic and a period.
- **Model:** cheaper model, **under the rule** that it may change only `toolCards/` data and fixtures; anything else goes to the strong model.

### PR 4: Stage 2, understanding cards and the live sheet

- **Goal:** the «فهمنا طلبك» card is the Ask, open and editable; an edit recompiles the plan by code; at most three question cards from the cards' inputs (+ «شيء آخر»); polling feed over the item store (no Realtime); desktop sheet with the file's column names; mobile cards with «X من N» and the notebook line from a code whitelist; the final file equals the rows watched. **First commit pair (strong model):** if PR 3 is live and benchmarks 1, 2 and 4 passed in `test` mode, Facebook, Instagram and YouTube join PR 2b's list of platforms that skip the 3.4 passes, and pass code no longer used by any social platform is deleted (the PR 2b rules apply). If all five platform flags are `on` and stable (decision 7.9), the same pair also deletes the old social content filters.
- **Files:** `src/components/mission/*`, `src/app/api/missions/[id]/rows/route.ts` (new polling feed), `customerView.ts`, `notebookLines.ts` (whitelist), tests including a scan of every new string by `checkCustomerText`.
- **Risks:** free-plan polling load (adaptive, jittered, as `startNotificationPolling`); customer-text rules.
- **Rollback:** `git revert -m 1`; the feed is read-only.
- **Acceptance (real):** for M12 and M14, the feed served from the stored `rows/*.json` equals the workbook rows of the stored `result.xlsx` (same ids, same order); the Ask card of the 20 stored requests renders the expected fields.
- **Live check:** Vercel READY and Heroku Build succeeded and Deployed on the SHA; one benchmark run watched on desktop and on a phone (390 px); the counter ends equal to the file.
- **Model:** cheaper model (UI and a read-only feed; the recompile is a call to the PR 2a compiler), except the first commit pair (deletions): strong model.

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
| 1 Real responses in (shipped, #347) | cheaper | one admin route, one button, one test |
| 2a Foundation, added | **strong** | the compiler, the pool and the promise types decide every later platform; flag-gated, deletes nothing |
| 2b Foundation, cleaned | **strong** | deletions inside the planning pipeline, after 2a is live and TikTok/X benchmarks pass |
| 3 FB / IG / YT cards | cheaper, data only | the compiler chooses; the work is cards and fixtures from real pages. Any code change outside `toolCards/` returns to the strong model |
| 4 Stage 2 | cheaper (first commit pair, the deletions for FB/IG/YT: **strong**) | UI, a read-only feed, fixed text; the recompile calls PR 2a |
| 5 Stage 3 | **strong** | companies pipeline, contact chain, e-mail limits |
| 6 Stage 4 | **strong** | versions, review without deletion, edits after delivery |
| 7 Money | **strong** | money paths, owner brief |

Product models are unchanged: Claude Haiku 5.5 for chat; Haiku 5.5 with extended thinking for planning. With the compiler, planning asks the model only to fill the Ask, which should shorten planning (AUDIT G14: time follows output tokens). NOT VERIFIED until PR 2a runs live.

---

## 7. Decisions the owner must make (recommendation in one line each)

| # | Decision | Recommendation | Status |
|---|---|---|---|
| 7.1 | **Where real pages may be stored for tests. The GitHub repo `iammagdy/digr` is PUBLIC (V).** Raw pages contain commenters' names and texts. | Commit only anonymised fixtures (person names, handles, avatars and comment texts replaced by stable placeholders; ids, counters, dates, cursors and structure kept); never commit the raw ZIP. | **DECIDED by the owner (2026-11-02): yes.** Only anonymised fixtures may enter the repo. Names, handles, avatars and comment texts are replaced by stable placeholders; ids, counters, dates, cursors and structure are kept. The raw ZIPs are never committed and never uploaded anywhere public. |
| 7.2 | Pool depth at planning versus the protected cap of two samples per source (`gateway.ts:40`). | Keep the cap for PR 2a, 2b and 3. Facebook's pool is then 2 search pages a mission (see the note below the table). A deeper pool is its own owner-approved brief that changes `gateway.ts`. | awaiting owner |
| 7.3 | The exposure check: read the first comments page of each chosen item before the card (our cost, about 0.002 USD an item). | Yes. A successful empty answer (`success true`, `comments []`, as M17's) counts as empty: swap in a spare. | **DECIDED by the owner (2026-11-02): yes.** |
| 7.4 | Allow `catalog_only` (not yet verified) cards for test-account missions only, so the first live run captures their first real response. | Yes, with a ceiling of 0.10 USD of such calls per mission. | **DECIDED by the owner (2026-11-02): yes,** test accounts only, capped at 0.10 USD per mission. Consequence: at most one `anyapi.facebook.search_posts` call (0.06606 USD) a mission. |
| 7.5 | Facebook named page + topic + period when the pool holds fewer than N posts from that page. | Show a question card before approval: only the k found (default), or fill from other pages with the mark «المصدر المسمّى: غير مطابق», or cancel. M17's pool had 3 of 10 by the page (V (owner's ZIP)), so this card will be common. | awaiting owner |
| 7.6 | Facebook search costs 0.02952 USD a page against the 0.80 USD daily cap. | **Corrected.** Under today's protected cap the pool is **2 `justoneapi` pages a mission (0.059 USD)**, not 6. The card says how many pages were read and that the source had more. **6 pages requires changing the protected `agent/src/gateway.ts`** and must become its own owner-approved brief, not part of PR 2a, 2b or 3. | awaiting owner |
| 7.7 | The free YouTube detail tool needs YouTube connected on our TREG account. | Check the TREG dashboard; if connected, use it for YouTube counters; if not, YouTube promises stay `open`. | awaiting owner |
| 7.8 | Delete the patch passes of 3.4 for compiled platforms. | Yes, but **not inside PR 2a**: in PR 2b for TikTok and X, after 2a is live and benchmarks 3 and 5 pass; in PR 4's first commit pair for FB/IG/YT, after PR 3 is live and benchmarks 1, 2 and 4 pass; companies in PR 5. | awaiting owner |
| 7.9 | Delete the old pipeline's social content filters. | Yes, in PR 4, once all five platform flags have been `on` for 7 days with clean benchmark runs. | awaiting owner |
| 7.10 | The queue start e-mail needs a template in the `send-email` Edge Function (protected; deploy on your go). | Approve one new template in PR 5 with the usual hash read-back, or drop the e-mail. | awaiting owner |
| 7.11 | The anti-loop rule of section 5 (a live failure becomes an anonymised fixture and, normally, a card change; no new pass; PR 2b only deletes). | Adopt it as a standing rule in HANDOFF. | awaiting owner |

**7.2 / 7.6: how the pool is read under the current cap, without touching `gateway.ts`.** This resolves the contradiction in the first version, where 7.2 kept the cap while 7.6 and F4 described a 6-page Facebook pool. It answers section 8 point 6.

**Verified by reading the code** (`agent/src/gateway.ts` and `src/lib/agentMission/namedRoutes.ts` at `1b4049a`; neither file is changed by this PR):

1. **The rule applies at planning only** (`gateway.ts:242`: `deps.phase === "planning" && repeated` gives `repeat_sample`). Execution calls are not limited by it, only by the job budget and the daily cap.
2. **It counts by source value only for a listing endpoint** (`gateway.ts:135`, `sourceKeyOf`). A listing is a capability of the shape `<platform>.(channel|user|page|profile|account).<kind>` with a source input (`namedRoutes.ts:13, 25`).
   - `justoneapi.x.facebook-search-post-v1` has capability `facebook.search.posts` and inputs `keyword, startDate, endDate, cursor`, so it is **not** a listing.
   - `anyapi.facebook.search_posts` has capability `null`, so it is **not** a listing either.
3. **A non-listing endpoint is refused once it has 2 samples with rows** (`gateway.ts:240-241`: `sampled >= GATEWAY_MAX_SAMPLES_PER_SOURCE`, keyed by endpoint id).
   - A second keyword or a cursor page 2 is one of those two samples.
   - This was a GUESS in the first version and is now V.
4. **Only calls with `status ok` and rows above zero count** (`gateway.ts:144, 309`). An empty or refused page does not use up a sample.
5. **The count survives a customer's answer and a restart.** It is rebuilt from the recorded planning calls (`gateway.ts:136-150`).
6. **Each endpoint has its own count.** Two different search endpoints give 2 + 2 samples.
7. **M17 hit the cap exactly:** two `justoneapi` planning calls with 5 rows each (Q11), both with a non-empty `data.cursor` (V (owner's ZIP)).

**Therefore, under today's cap, the Facebook pool at planning is:**
- **Every account:** 2 `justoneapi` pages, about 10 posts (V: M17 10 rows; 5.1 rows a page on average, Q8), for 0.059 USD.
- **Test accounts:** plus at most 1 `anyapi.facebook.search_posts` call of up to 20 posts. The limit of 1 comes from decision 7.4's 0.10 USD ceiling, not the cap. That it returns rows is NOT VERIFIED, since its one call was refused.
- The compiler chooses parents among these rows only, and the card says «قرأنا صفحتين من نتائج البحث» and that more exist.
- **Not an option:** reading more pages at execution to choose parents. It would choose after approval and break the promise-before-approval rule (3.3).
- **GUESS:** later pages at execution could serve only as extra spares, never to change the promised parents. That is a PR 2a design question, not a cap change.

**A pool of 6 search pages requires changing `GATEWAY_MAX_SAMPLES_PER_SOURCE` or the per-endpoint rule in the protected `agent/src/gateway.ts`.** That is not allowed in PR 2a, 2b or 3. It becomes its own owner-approved brief, written only if the PR 3 replays show 2 pages are not enough.

---

## 8. What I could not verify

1. **The content of the raw pages.**
   - **Update 2:** PR 1 (#347) shipped and the owner holds all 28 missions' `raw/` and `rows/` (509 files). **M17 has been read** (V (owner's ZIP), section 2.3).
   - The other 27 missions, including the seven other Facebook search missions, are **NOT VERIFIED** until a session reads them on the owner's device.
2. Why the M17 planner sampled the Facebook keyword-and-date search and then planned the page listing (the model's reasoning is not stored; GUESS: the named-source rule and the price).
3. Why the one `anyapi.facebook.search_posts` call was refused (the refusal reason was not read as text).
4. Page sizes of tools Diger never called: `anyapi.instagram.user.posts`, `anyapi.youtube.*`, `youtube.youtube.video.detail`, `anyapi.facebook.post_comments`.
5. Whether YouTube is connected on Diger's TREG account (`youtube.youtube.*` "included with the connected account").
6. ~~How the two-sample cap counts a search tool.~~ **Now V (update 2):**
   - Listing endpoints are keyed by endpoint + source value (`gateway.ts:135`).
   - The Facebook search endpoints are not listings (`namedRoutes.ts:13, 25`; capabilities `facebook.search.posts` and `null`), so every keyword and every cursor page of one search endpoint shares the 2 samples with rows (`gateway.ts:240-242`), at planning only.
   - M17 used exactly 2 (Q11). See the note under section 7.
   - Still a GUESS: whether 2 pages are enough for most named page + topic + period requests (M17: 3 of 10 rows by the page).
7. Heroku: build and deploy state of `0268fec` and of later merges, worker logs, heartbeat (no access). Vercel production of `1b4049a` was READY in the PR #347 session (V there; not re-checked in this docs update).
8. Whether Facebook's empty reads mean "nothing there" or "the tool cannot see it".
   - **Update 2, V (owner's ZIP, M17):** they are successful empty answers, not errors. Comments: `success true`, `credits_charged 0`, `comments []`, `has_next_page false`. Replies: `found true`, `replies []`, `items 0`.
   - Still NOT VERIFIED: **why** they are empty. No counter was compared, and M19's reply pages and the other missions' empty pages are not read yet.
9. Planning time and token use after the compiler (only measurable live).
10. The test suite was not run (docs-only PR).
11. **Update 2:** the cause of the truncated ZIP of section 10. The route's own 50-second budget ends the stream after the headers were sent; or the platform ended the function at its 60-second limit; or both. NOT VERIFIED (Vercel's function log for that download was not read).

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

**Update 2 (this commit):**
- Q10, quoted from the PR #347 session: `storage.objects` metadata of the `agent-missions` bucket's `raw/` and `rows/` objects (count, size, nesting). Largest object 5,535,284 bytes; 28 plan missions = 509 objects, 19,603,637 bytes.
- Q11: `select phase, endpoint_id, status, rows_returned, cost_usd, created_at from mission_calls where mission_id = 'msn_6bb78c15d116268b0b9b' order by created_at;`
  - 13 rows, in the order of `raw/call_0001` … `call_0013`.
  - Calls 4 and 5: `justoneapi` planning, `ok`, 5 rows each, 0.02952 USD.
  - Calls 7 and 8: comments, `empty`, 0.000000 USD.
  - Calls 10-13: `anyapi.facebook.comment_replies`, `empty`, 0.0012 USD each.
- Code read, not changed: `agent/src/gateway.ts:40-42, 135-150, 236-242, 309` and `src/lib/agentMission/namedRoutes.ts:13-25`.
- Catalog read: the capability, inputs and pagination of `justoneapi.x.facebook-search-post-v1`, `anyapi.facebook.search_posts` and `anyapi.facebook.user.posts` in `data/treg/treg_catalog_sellable.json`.
- The M17 page facts in 2.3 come from the owner's ZIP as read by a reviewer. This session did not open any raw page, and no raw content is quoted here beyond field names, counts, dates and flags.
- Not SQL: `list_computer_folders` (no folder of the owner's computer is shared with this cloud session) and the environment's Remote Control documentation, for the hand-over answer in the PR #346 description.

No write, no migration, no flag change, no paid call, no secret requested or seen.

---

## 10. Backlog (found, not fixed now)

1. **The raw ZIP can arrive truncated instead of failing clearly (PR 1, #347).**
   - **What happened:** a download of 392 entries (the size of batch 1 of the owner's download list: 14 missions, 16,638,084 bytes listed) reached the time limit. The browser saved a ZIP with **258 of 392 entries and no central directory**, so it does not open.
   - **Why it was missed:** the route had already answered 200, so the admin page showed success. The owner noticed only because a reviewer tested the file.
   - **Workaround used:** smaller batches. All 28 missions then downloaded, and every manifest matched `storage.objects`.
   - **Cause:** NOT VERIFIED (section 8 point 11). Today the stream is errored after the headers (`src/lib/agentMission/rawZip.ts`, the time-budget check in the stream).
   - **Proposed fix, in a small site-only PR with a red test first:**
     - (a) Refuse before the first byte, with a clear Arabic message, when the listed objects or bytes are above an amount measured to finish in time.
     - (b) The admin page checks the ZIP's end-of-central-directory record, plus that the last entry is `manifest.json`, before saving. Otherwise it shows «لم يكتمل الملف. اختر مهام أقل وأعد المحاولة.» and saves nothing.
     - (c) Optionally, the page splits a long list into batches by itself.
   - **Priority:** low (the workaround works; admin only); not blocking PR 2a.
