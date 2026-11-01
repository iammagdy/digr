# REDESIGN PLAN: findings, stages, items

Companion to `docs/REDESIGN.md` (the design). Planning only: **no runtime code, config, env var, database or SQL write was changed**, no provider call was made, no secret was read. Written against `main` = `e2c4fda` (#328), 2026-11-01.

**Updated 2026-11-01 (second pass):** the owner's decisions D1, D2, D3, D5, D6, D7, D8, D10 are recorded in section 7.1 and removed from the open list; the 45 items are regrouped into **four stages, each one pull request** (section 4); the Realtime/preview-table items are dropped ("later, not planned"); the benchmark list is `docs/benchmarks/antigravity-10.md`; the SDK thinking option was checked and is VERIFIED.

Marks: **V** = I read the line myself. **V-R** = a read-only research agent read it and reported it; I did not re-read it (I re-read the strongest ones and mark them V). **GUESS** = inference. **NOT VERIFIED** = needs live data, the live database, Heroku or Vercel env, or the paid provider.

Why V-R is used: four research agents read in parallel, each with a narrow brief (filters, provider request, cards/Realtime/RLS/models/queue). Their file:line claims are quoted as reported. The load-bearing ones (ingest, gateway, engine run, spec, card, chat handler) I re-read myself.

---

## 1. FINDINGS (evidence first)

### F1. Where the provider request is built, per request type (V, V-R)

- **The model writes it; code freezes it.** `propose_plan` has no `params` field (V-R `agent/src/tools.ts:561-570`). The stage's recipe is the model's own sample-call params, kept in `state.callParams` and copied into `EngineSpec.params` (V-R `agent/src/engine/spec.ts:103,193`). The gateway copies the model's `params` (V `agent/src/gateway.ts:188`).
- **What code adds:** the cursor or page number (V `agent/src/engine/run.ts:394-396`), the parent-bound input (V-R `spec.ts:337-352`), `limit` lifted to the input maximum only for per-call-priced endpoints with no other pagination input and a numeric maximum (V-R `spec.ts:268-276`), and since/until windows in three narrow cases (V-R `dateWindow.ts:19,40-55`). Replies stage, contact finders and the company-phone helper are code-built (V-R `replies.ts`, `contactFinders.ts`).
- **The customer's count** is the only condition bound by code, and it becomes `planned_rows`, not a tool input (V-R `plan.ts:324-330,368-378`).
- **The people helper `src/lib/peopleSearchInput.ts` is not used by the agent path** (V-R, grep): it is imported only by the legacy `tregAdapter.ts:33` and `requestIntent.ts:6`.

### F2. Which customer conditions are dropped (V-R unless marked)

| Condition | Posts search (a) | Account/URL posts (b) | Comments (c) | Replies (d) | Companies (e) | People (f) | Places (g) |
|---|---|---|---|---|---|---|---|
| Language | post-filter, auto (`plan.ts:532-535`); tool field (`hl`, `language_code`, `language`) never filled by code | post-filter | **none** (child filters stripped: `filters.ts:55`, V-R) | none | post-filter | none | tool `language` defaults to `en` on the maps tool, never set by code |
| Date range | post-filter only if the model declares it; windows only for 3 mechanisms; TikTok `date_posted`, YouTube `upload_date`, LinkedIn `datePosted` never code-filled | post-filter if declared | post-filter if declared | post-filter if declared | n/a | n/a | n/a |
| Country/place | **none** (no auto place filter for posts) | none | none | none | post-filter auto; tool `country` only if the model wrote it | none | same as companies |
| Account/URL | name-match post-filter; tool input only if the listing endpoint was sampled; **a pasted URL is not parsed to an account** | same | n/a | n/a | n/a | n/a | n/a |
| Count | `planned_rows`, page-size left as typed | same | per parent: `min(per_parent_rows, ceil(planned/parents))` | share per comment, max 50 | `planned_rows` | default 2 per company | `planned_rows` |
| Replies yes/no | post-filter only if the model declares it; nothing parses «بدون ردود» | same | code adds a replies stage; switch only in the editor | code-built | n/a | n/a | n/a |
| Sort | **none** in code; prompt assumes newest first (`agent/prompts/system.md:13`, V-R); real sort inputs exist and are model-only | same | none | none | none | none | none |

### F3. The gateway silently deletes fields and does not validate them (V)

`agent/src/gateway.ts:201-202`: `for (const k of Object.keys(params)) if (!known.has(k)) delete params[k];` A misspelled `language` or `country` disappears with no refusal. Line 205 refuses only missing required inputs. Enum, minimum and maximum are not checked (V-R). Consequence: a condition the model tried to express can vanish before the call.

### F4. FILTER INVENTORY: 25 drop points, not about 12 (V for the starred lines, V-R for the rest)

Full table in section 2. Summary: 8 typed card filters, 7 content rules, review-limit rows left pending, 3 structural rules, 2 count caps, 2 swaps, 2 duplicate rules, plus cell-level and column-level drops and a second live pipeline.

### F5. Dedupe today contradicts the new rule (V)

- By id: `agent/src/items/ingest.ts:125` (V).
- **By same text, across different authors, for top-level posts:** `ingest.ts:87` (`const dedupeText = isTextItemStage(stage) && !isChild;`) and `ingest.ts:132-139` (V). The key is the first 12+ letters of aggressively normalised text (V-R `contract.ts:122-132`), so two different people posting the same text are merged. This directly contradicts "same text from different people is kept".
- `docs/HANDOFF.md:584` ("posts/comments with the same text are one item") is STALE for comments: children are exempt (V `ingest.ts:87`).
- Companies/people: no name or domain dedupe in the agent pipeline, only derived id (V-R `contract.ts:45-51`, `ID_KEY_FIELDS` includes website/domain). The legacy chunk pipeline dedupes by domain, id, then name (V-R `src/lib/server/rowDedupe.ts:28-41`).

### F6. Surplus rows and the 500-row cap (V, V-R)

A match beyond the approved count is kept in the log as `excluded` with reason `target_reached` and is never delivered (V `ingest.ts:259-260`). After 500 excluded rows in a stage the later ones are stored with `row: null` (V-R `constants.ts:231`, `itemStore.ts:121,132`), so their content is gone. Pending rows (review not reached) never reach the file (V-R `runMission.ts:466`).

### F7. JOB_MAX_POINTS_CAP (V)

- **25,000** at `src/lib/jobPointsCap.ts:13` (V). `effectiveJobPointsCap` lets the env var only LOWER it: `Math.min(Math.floor(raw), JOB_MAX_POINTS_CAP)` (V, lines 20-23). The agent's cap is the same constant (`AGENT_JOB_POINTS_CAP = JOB_MAX_POINTS_CAP`, V `src/lib/agentMission/constants.ts:190`). The legacy worker takes `Math.max(stored, 25000)` so a stale stored 600 cannot cut a charge (V `src/app/api/worker/chunk/route.ts:167-177`).
- **600 still appears in:** the seed migration setting `'jobMaxPointsCap', 600` (V `supabase/migrations/20261012200628_seed_initial_configuration.sql:25`), `LARGE_PLAN_FROM_POINTS = 600` (V `src/lib/capacityRefusal.ts:9`), `AGENT_IMPLIED_PEOPLE_RESERVE_TARGET_POINTS = 600` (V `constants.ts:195`, a default-people sizing target, not a cap), and comments.
- **NOT VERIFIED:** the live value of the `JOB_MAX_POINTS_CAP` environment variable on Vercel and Heroku, and the live SQL functions (`create_quote_atomic`, `settle_*`). No SQL was run. `docs/HANDOFF.md:256` records both as 25,000 on 2026-10-31. The code header says the SQL had to be raised by hand first (`jobPointsCap.ts:3-7`, V).
- **Not implemented:** splitting a bigger job into stages with their own plan, approval and charge. No such flow was found (GUESS: absence in grep of the cap readers; confirm in item 6.4).

### F8. Why the generative UI cards stopped (V, V-R; the date is NOT PROVEN)

1. **The old planner cards have no code path any more.** `AGENT_SERVES_CHAT = true` (V `constants.ts:18`); `chatHandler.ts:2711` (V) sends every research turn to `answerWithAgent` before the old clarification chips, the «فهمت أنك تريد» intro and the `PlanQuoteCard` path. It has been `true` since the first commit visible in this repo (root `8f82971`, V-R), so git cannot date the change; owner-side proof is the Vercel deployment of #279 on 2026-10-28, or the first `messages` row with `plan->>'agentMissionId'`.
2. **The "how we understood your request" block was folded away on 2026-10-31.** It now sits inside a closed `<details>` titled «تفاصيل الخطة» (V `src/components/mission/AgentMissionCard.tsx:196-201`). Commit `3fd8f7f` ("UI pass 1", `docs/UI_PASS_1.md` item 6, V-R) removed the open version.
3. **The agent's question card is rare by design.** `agent/prompts/system.md:13` says "DECIDE, DO NOT ASK" and "Ask at most once" (V, line confirmed, text partly omitted by the tool); `ask_question` allows ONE question, 2 to 4 options, planning only, and refuses Latin words (V `tools.ts:531-558`). The chips render when it fires (V `AgentMissionCard.tsx:142`). It did fire live on 2026-10-30 and 2026-10-31 (V-R `HANDOFF.md:394,229`) and a guard added 2026-10-31 refuses contact-verification questions (V `tools.ts:550-552`).
4. **The starter cards were replaced by six chips and a form** (V-R `UI_PASS_1.md:13,17`), so requests arrive more complete.
- **Proof steps, read-only SELECTs for the owner (not run):** first `messages` row with `plan->>'agentMissionId'`; daily `count(*) filter (where kind='question')` vs `kind='plan'` in `mission_events`; `missions.status='needs_input'` per day; `agent_worker_heartbeat` newest `beat_at`.

### F9. Supabase Realtime and RLS (V)

- **Realtime is not used anywhere, and a test forbids it.** `tests/supabase-free-plan-limits.test.ts:18-27` fails if any file under `src` contains `.channel(`, `postgres_changes` or `.subscribe()` (V). Reason: the free plan allows 200 concurrent Realtime connections (V `docs/SUPABASE_FREE_PLAN.md:16,25-36`). Job status moved to polling in PR #97 (V, same doc). The comment at chat `page.tsx:504` says "subscribe" but nothing subscribes (V-R). **Owner decision D3 (2026-11-01): no Realtime for now; the earlier decision stands and the live sheet polls a feed (item 2.6).**
- **RLS exists on the mission tables, but the DDL is not in `supabase/migrations`.** It lives in `docs/proposals/agent-worker/01_agent_tables.sql` ("NOT APPLIED. The owner applies it by hand", V-R line 1): RLS enabled on `missions`, `mission_events`, `mission_calls` (V lines 97-101); column-level `GRANT SELECT` to `authenticated` on safe columns and policy `missions_read_own` (V lines 103-111); `mission_events_read_own` (V lines 113-117); no policy or grant on `mission_calls` (V line 119). `docs/HANDOFF.md:595` says the tables exist on the live project, so they were applied by hand. **Whether the live database matches the proposal is NOT VERIFIED.** Browser code already reads `missions` directly (`src/app/dashboard/requests/page.tsx:211`, V-R), so those policies are load-bearing.
- **There is no preview table, and none is planned** (owner decision D3, 2026-11-01: no Realtime for now; the live sheet reads the item store through a polling feed, no SQL; the preview table and Realtime are "later, not planned").

### F10. Where planning loses state on restart (V)

- The SDK session is not persisted: `persistSession: false` (V `agent/src/sdkOptions.ts`, option list). Every planning run is a fresh model conversation.
- The run's working state is in memory only: `newRunState` (V `agent/src/tools.ts:89`): `proposedPlan`, `question`, `tried`, `callParams`, `samples`, `skips`, `moreAvailable`.
- After a restart the model is told only a list of call ids, endpoints, a digest of params and row counts (V `agent/src/runMission.ts:92-106`). Its reasoning, its comparison of tools and any partial plan are gone.
- Memory stop: the worker stops a run at `AGENT_MEMORY_HARD_LIMIT_MB = 580` (V `constants.ts:97`), and planning goes back to `queued` (V `runMission.ts:306`), at most `AGENT_MEMORY_REQUEUES_MAX = 2` (V `constants.ts:99`); a deploy restart is a separate cause with limit 6 (V `constants.ts:122`).
- Cost of the loss, measured: the G4 planning run of 2026-11-01 lost 105 s and 0.0275 USD to the memory stop, then re-ran for 165 s (V `docs/HANDOFF.md:18`). One SDK session at a time on a 512 MB dyno; the SDK's own process is about 270 MB (V `constants.ts:96`, `AGENT_SDK_CHILD_PEAK_MB`; one session at a time, `AGENT_SDK_SESSIONS_AT_ONCE = 1`).
- **What survives:** `mission_calls` rows, raw pages in the bucket, `run_state.json` counters, the running `planning_llm_usd` checkpoint (V `runMission.ts:282-284`).
- **Execution is already resumable:** the item store is append-only and a resumed mission continues from its log (V `runMission.ts:372` comment; V `run.ts:395` reads the last cursor from stream state). The remaining gap is planning, not execution.
- **Root cause of the 580 MB peak: NOT VERIFIED** (no heap profile exists; `docs/HANDOFF.md:22` says the same).

### F11. Models used where (V, V-R)

| Purpose | Where | Model | Thinking |
|---|---|---|---|
| Research chat turn (agent path) | `chatTurn.ts`, `chatHandler.ts:1612-1620` (V-R) | **no model call** (fixed text, creates a mission) | n/a |
| Greeting, general question, file-shaping reply | `src/functions/shared/llmClient.ts:2407-2432` (V-R) | env else `claude-haiku-5-5` | none sent |
| Agent planning | `agent/src/modelConfig.ts:10-11` (V) | `planning_model` setting (Haiku or Sonnet) else `AGENT_MODEL` else `claude-haiku-5-5` | **not set in code** (V `sdkOptions.ts` option list has no thinking option) |
| Agent execution | `modelConfig.ts` (V) | `AGENT_MODEL` else `claude-haiku-5-5` | not set |
| Agent row review | `agent/src/review.ts:159` (V-R) | `claude-haiku-5-5` | none sent |
| Server row review | `rowReviewAdvisor.ts:139,147` (V-R) | env else `claude-haiku-5-5` | explicitly off |
| Old planner, invoices assistant, others | various (V-R) | `claude-haiku-5-5` | none sent |

Gaps against the design: (1) **no fast chat reply or card model call exists on the research path**; (2) **extended thinking is not enabled anywhere**; the repo's own comment says Haiku 5.5 runs adaptive thinking by default when no field is sent (V-R `rowReviewAdvisor.ts:131-136`), which is not verified; (3) **Sonnet 5.5 is selectable** (`constants.ts:51-52`, V). `docs/HANDOFF.md:1026` still says "Claude Haiku 3.5" in section 1: stale (V). The pinned SDK is `@anthropic-ai/claude-agent-sdk 0.3.312` (V `agent/package.json:7`); **it exposes a thinking option: VERIFIED** after installing the agent dependencies in the 2026-11-01 update: `agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1958` declares `thinking?: ThinkingConfig` (V), `{ type: 'enabled', budgetTokens: N }` documented at `:1972` (V). Whether Haiku 5.5 thinks by default through the SDK when no option is passed is still NOT VERIFIED.

### F12. Catalog tool schemas (V-R)

`data/treg/treg_catalog_sellable.json` is 10,389,806 bytes, 3,276 endpoints (V-R). Each endpoint has `inputs[]` with `name, type, required, enum, minimum, maximum, default, note`, plus `pagination[]`, `cursor_path`, `item_fields`, `cost`. Consequences found:
- `catalog_search` shows only the first 10 inputs per hit (V-R `src/lib/modelPlanner/tools.ts:76-80`); `describe_endpoint` clips each note to 140 characters (V-R). A long caveat on a search field is cut.
- **Cursor inputs missing from `pagination`:** `x.x.search-posts-recent`, `x.x.search-posts-all`, `x.x.user.posts`, `youtube.youtube.video.comments`, `youtube.youtube.channel.videos.uploads`, `scrapecreators.instagram.user.posts`, three `tikhub.x.tiktok-app-v3-fetch-user-post-videos*` have a cursor-like input but `pagination` has no non-limit entry, so the engine reads ONE page (V `spec.ts:164`, `run.ts:426`; endpoint list V-R). The routed `treg.*` endpoints (`treg.tiktok.search.videos`, `treg.tiktok.video.comments`) have no cursor input at all and say "first page only" (V-R).
- Real condition fields that exist and are never code-filled: `scrapecreators.tiktok.search.videos` (`date_posted`, `sort_by`, `region`), `tikhub.tiktok.search.videos` (`publish_time`, `sort_type`), `youtube.youtube.search.videos` (`publishedAfter`, `order`), `justoneapi.x.facebook-search-post-v1` (`startDate`, `endDate`), `treg.companies.search` (`country`), `treg.google.serp.maps` (`language`, `country`) (V-R).

### F13. Fetch-until-count, "all comments", fallback (V, V-R)

- Pages are read until `accepted >= planned_rows`, source exhausted, 2 barren pages, page cap `max(400, planned*2)`, time, a refusal, or a review stall (V-R `run.ts:374-407,437-438`). A failed page is retried once, then the stream ends `failed` (V `run.ts:403-406`).
- **No cross-tool fallback in execution.** If every stage has a proven recipe the model is not started at all (V-R `runMission.ts:386-392`). Only same-endpoint recoveries exist: alternative inputs of the same child endpoint, spare parents, date-window walk-back (V-R `spec.ts:290-305`, `run.ts:133,147-157`).
- **"All comments means all" has no code.** Only a prompt sentence (V-R `system.md:41`); `perParentQuantities` needs a number (V-R `quantity.ts:230-238`); the engine caps each parent at `min(per_parent_rows, ceil(planned/parents))` (V-R `run.ts:122-124`); total delivered rows are capped at 5,000 (V-R `constants.ts:234`).
- Reply sources exist for TikTok, Instagram, Douyin, Kuaishou and a few more; none the plan can feed for Facebook, YouTube, LinkedIn, Reddit (V-R `replies.ts:57-72`; `docs/HANDOFF.md:41`, V). X and Threads have no nested endpoint. The design must say so on the plan card.

### F14. Queue and e-mail (V-R)

- Queue line exists: «مهمتك في الدور… · ترتيبك N», position from `readQueue` (V-R `customerView.ts:194-200`, `customerActions.ts:47-56`); worker concurrency 1, shared by planning and execution, FIFO (V `constants.ts:71`; V-R `02_agent_claim_function.sql`).
- **No "started" e-mail for agent missions** (`notices.ts:48` returns `email: null`; V-R). Completion e-mails go through `sendMissionNotice` to the `send-email` Edge Function and Resend, idempotency key `mission-update:<kind>:<missionId>` (V-R). No monthly e-mail counter was found. Whether `RESEND_API_KEY` is set in the function secrets: NOT VERIFIED.
- A second pipeline exists: the legacy chunk worker (`src/app/api/worker/chunk/route.ts`) with its own dedupe, date and relevance rules (V-R). Whether production still routes any request to it is NOT VERIFIED (`docs/HANDOFF.md:1081-1083` says `accept-quote` dispatches to it; `AGENT_SERVES_CHAT` bypasses that for research turns, V-R).

---

## 2. FILTER INVENTORY (what each removal drops, and what replaces it)

Source: agent pipeline, `agent/src/items/ingest.ts`, `src/lib/agentMission/filters.ts`, `relevance.ts`, `engine/run.ts`, `workbook.ts`. Lines marked * I re-read; others V-R. "Judges": C = content, I = id/text duplicate, S = structural.
Decision: **KEEP** (allowed or structural), **REMOVE** (no replacement), **MARK** (becomes a column), per `REDESIGN.md` section 4.

| # | Drop point (reason code) | file:line | Drops what | Judges | New |
|---|---|---|---|---|---|
| 1 | Same record id (`duplicates_ignored`) | `ingest.ts:125`* | an id seen before in the stage | I | **KEEP** (the rule) |
| 2 | Same normalised text (`duplicate_texts`) | `ingest.ts:87,132-139`*; key `contract.ts:122-132` | top-level posts/tweets with equal text, any author | I | **REMOVE** (violates "same text from different people is kept") |
| 3 | `unknown_parent` | `ingest.ts:130`* | child whose parent is not accepted | S | **KEEP** (structural; follows from other removals) |
| 4 | `no_verified_contact` | `ingest.ts:195`* | contact-finder row that is not a named person and has no verified value | S/C | **MARK** (deliver; status column) |
| 5 | `not_a_person` | `ingest.ts:201`*, rule `people.ts:70-77` | people row with no name, role mailbox, department | C | **MARK** «نوع الجهة»; the mailbox already feeds the company column (`workbook.ts:199`, V-R) |
| 6 | `not_at_company` | marking `run.ts:245-256,422`; drop `ingest.ts:198`* | person whose current job does not name the parent company | C | **MARK** «يعمل حاليًا في الشركة» |
| 7 | `filter_reply` | `filters.ts:171-176`; used `ingest.ts:147-149` | text starting `@handle` or reply flag | C | **MARK** |
| 8 | `filter_repost` | `filters.ts:177-181` | `RT @…` or repost flag | C | **MARK** |
| 9 | `filter_language` | `filters.ts:182-190`*, default ON `plan.ts:532-535` | text with Arabic-letter share under 50% | C | **MARK** «لغة النص» |
| 10 | `filter_period` | `filters.ts:191-205`; walk `run.ts:285-326` | outside the date window or undated | C | **MARK** «ضمن الفترة المطلوبة»; the window walk stays as a FETCH parameter |
| 11 | `filter_account` | `filters.ts:206-213`; quota `ingest.ts:94-97` | author not among named sources | C/S | **MARK** «المصدر المسمّى» |
| 12 | `filter_place` | `filters.ts:224-236`; `places.ts:176-215` | country/city/TLD/phone evidence points elsewhere or none | C | **MARK** «المكان» |
| 13 | `filter_government` | `filters.ts:219-223`; `government.ts:60-70` | .gov/.mil/.edu or ministry words | C | **MARK** |
| 14 | `filter_media` | `filters.ts:214-218` | post with no video/image field | C | **MARK** |
| 15 | `no_text`, `no_term`, `mention_only` | `relevance.ts:194-204`; gate `ingest.ts:213-218` | no text, no topic word, bare mention | C | **REMOVE** |
| 16 | `other_person`, `name_extended`, `other_meaning` (namesakes) | `relevance.ts:205,210,211` | exclude terms, extended names, other meaning | C | **REMOVE** |
| 17 | `review_no` (LLM relevance review) | `ingest.ts:222-244`*; `review.ts:41` | rows the rule called uncertain and the model said no | C (LLM) | **REMOVE** (the model never decides rows) |
| 18 | `uncertain` with review off | `ingest.ts:245`* | uncertain rows | C | **REMOVE** |
| 19 | `not_reviewed` / `review_failed` left PENDING | `ingest.ts:246-248`*; `review.ts:189,234-238` | rows the review budget never reached; never delivered | C | **REMOVE** (cost-caused drop) |
| 20 | `target_reached` (surplus) | `ingest.ts:260`* | matches beyond `planned_rows` or per-parent cap | S | **KEEP** as a cap (D6) |
| 21 | Named-source share | `ingest.ts:262-267`* | items of a named source beyond its share | S | **KEEP** (cap) |
| 22 | Parent swap | `run.ts:147-157,188-197`; `itemStore.ts:136-144` | accepted parent with no children replaced by a spare | S | **KEEP** (count-neutral) |
| 23 | Decision-maker upgrade swap | `run.ts:233-242`; `itemStore.ts:141` | worse-title person replaced by a better spare | C | **KEEP for now**; borderline, a quality choice not a duplicate rule (D8) |
| 24 | Intermediate stages not in file | `workbook.ts:112` | `deliver:false` stages | S | **KEEP** (plan's choice, stated) |
| 25 | Page cap and barren pages | `run.ts:380,388,438` | stops reading after 2 barren pages | S | **KEEP**, but "no new ids" must not end a read while the count is unmet and another tool exists (item 1.9) |

Cell and column level (V-R unless marked): contact cells are emptied when the value is masked or malformed (`ingest.ts:187-193`; found values are otherwise kept and marked: **KEEP**); **a column whose values equal another column on at least 80% of rows is silently dropped** (`workbook.ts:135,161`, `sameValues` at `:80` V): **REMOVE in raw mode**. Reason-text tables that must be pruned when drops go: `finalize.ts:129-135` (`REASON_TEXT_AR`), `finalize.ts:92-104,144`, `methodology.ts:265-320`, `stageTruthBodyAr` (V-R).

Second pipeline (V-R, sampled only): legacy chunk worker `route.ts:1003-1054` (dedupe incl. same text across authors via `rowDedupe.ts:49-55,89-93`), `route.ts:964` and `dateRangeFilter.ts:121-132` (date window, drops undated rows), `route.ts:1172-1177` (relevance gate). Not covered by this redesign unless it is still live (D9).

Model-written mapping code can itself drop rows and is invisible from the repo (`plan.ts:544,549` rely on it, V-R). The raw mode must run a mapping that returns one output row per input row, or refuse the recipe (item 1.1).

Tests that pin the current drops, a lower bound (V-R, assertions not all read): `engine-contract`, `scale-engine-2000`, `agent-relevance-and-pricing`, `agent-general-checking`, `filters-and-contract`, `namesakes-replies-names-notes`, `people-are-persons`, `people-without-contact-replay`, `truthful-limits-text`, `review-to-completion`, `mission-10/11/12/13` replays, `golden-r2-limits-truth`. In the new pipeline these keep passing because raw mode is a separate code path behind a flag; they are the safety net for the old one.

---

## 3. STANDARD PROTOCOLS (referenced by every PR)

**SP-TEST (tests).** For every item a failing test is written first and committed first (red), then the change (green) in the next commit. The stage PR head also runs `npm run test`, `npx tsc --noEmit` (site and `agent/`), `npm run build`, `npm run check:secrets` (V `package.json` scripts, HANDOFF section 5). A PR that touches an existing test line marks the line `CHANGED` with the reason (the repo's own convention).

**SP-FLAG.** All new behaviour is behind the per-type flag of section 5, default OFF. With the flag OFF a PR must not change any output: a replay test pins this.

**SP-LIVE (verify live, after merge).**
1. **Heroku Activity shows the latest build `Succeeded` on the merge SHA** (and the worker heartbeat is green on the admin page «الوكيل»). A PR that changes only the website also checks the Vercel production deployment READY on the SHA. This session has no Heroku or Vercel access (`docs/HANDOFF.md:117`): the owner or a session with access checks.
2. Flag OFF: run the **golden set** G1 to G6 (`docs/AUDIT-2026-11.md` section 7) once; the shape must equal the last baseline.
3. Flag in **TEST-account mode**: rerun the golden prompts for the request types the PR touches, plus the **10 Antigravity benchmark requests**. *The list is `docs/benchmarks/antigravity-10.md` (supplied by the owner, D10, added with the 2026-11-01 update of this plan).*
4. Read-only SELECTs (written in the PR, run by the owner): delivered vs requested, ledger rows balanced for the mission (`res_/rel_/chg_`), seconds to the `plan` event, planning output tokens, calls with 0 rows, customer text scan.

**SP-ROLLBACK.** `git revert -m 1 <merge commit>` (the repo's rollback rule, V `docs/HANDOFF.md:610`). For a behaviour PR the first rollback is the flag OFF (a settings change, no deploy). A PR with an extra rollback says so.

**SP-MONEY.** A PR marked **[MONEY]** touches ledger, settlement, price, gateway caps or the reserve. These need an explicit owner brief, are never combined with other work, and ship only in the separate Stage 4 money PR (or the conditional 6.5 PR), except where a pure code function that computes a price is added without being wired to a charge (marked **[PRICE-INPUT]**, still reviewed by the owner).

**SP-SQL.** A PR marked **[SQL]** only adds a proposal under `docs/proposals/<name>/` marked NOT APPLIED with a verify query and a rollback file. The owner applies it by hand (repo rule, V `docs/HANDOFF.md:655`). No agent runs SQL.

---

## 4. STAGES AND ITEMS

The 45 items of the first version of this plan are regrouped (owner decision, 2026-11-01) into **four stages, each shipped as ONE pull request**. An "item" (numbered `0.1` to `5.2`, `6.3`, `6.4` as before so nothing is lost) is **two commits inside its stage PR**: first a commit that adds only the failing test (red), then the commit that makes it pass (green). Merge commits only, no squash, no force-push. All new behaviour is behind the per-request-type flag, default OFF (section 5). Social media comes first (researchers are waiting), companies second.

### 4.1 The four stages (final table)

| Stage | Pull request | Items (old numbers) | Item count |
|---|---|---|---|
| **1. Social media** | one PR | old Phase 0 + Phase 1: flags (0.1), golden/benchmark harness (0.2), raw-delivery contract (0.3), telemetry (0.4), tool profile (1.4), ranking by coverage (1.5), code-built request (1.6), gap statement (1.7), pagination (1.8), cross-tool fallback (1.9), raw ingest (1.1), mark columns (1.2), count guarantee (1.3), all comments (1.10), planning resume (1.11), execution resume (1.12) | **16** |
| **2. Understanding and live sheet** | one PR | old Phase 2: cards fix (2.1), understanding step (2.2), question cards (2.3), editable card (2.4), fast chat (2.5), polling feed (2.6), desktop sheet (2.7), mobile cards + counter + notebook (2.8), file equals rows watched (2.9) | **9** |
| **3. Companies and queue** | one PR | old Phase 3 + Phase 5: raw people/companies (3.1), exact duplicates (3.2), company/people request build (3.3), not-found after all tools (3.4), retries inside reserve (3.5), queue message (5.1), start e-mail (5.2) | **7** |
| **4. Review, edits, versions** | one PR | old Phase 4: file versions (4.1), review report (4.2), review buttons (4.3), review price [PRICE-INPUT] (4.4), fix-and-merge (4.5), post-delivery edit (4.6) | **6** |
| **4M. Money PR (the one exception)** | **separate PR, only after an explicit owner brief** | old 6.3 (charges for review/fix/edit) and 6.4 (staged jobs above 25,000) | **2** |
| Conditional | own PR, only if Stage 1 proves it | old 6.5 (price inputs in `price.ts`) | 0 or 1 |
| Not PRs | | old 6.7 (flag flips: a settings change); old 6.6 (e-mail counter SQL: dropped unless needed); old 6.1 and 6.2 (preview table, Realtime: dropped, "later, not planned", D3) | |

Check: 16 + 9 + 7 + 6 = 38 firm items in the four stage PRs, plus 2 in the money PR = **40 firm items**, plus 6.5 (conditional), 6.6 (dropped unless needed), 6.7 (settings), 6.1 and 6.2 (dropped) = the original 45.

### 4.2 Rules for every stage PR

- One commit pair per item (red test, then green change), in the order given for the stage. The PR head must pass the whole suite; intermediate red commits are expected and are the evidence that each test failed first.
- All new behaviour is behind the per-type flag, default OFF; with the flag OFF the old pipeline's output is byte-identical (a replay test pins this).
- No SQL anywhere. No change to the files listed at the end of section 6.
- After each stage merges: SP-LIVE (Heroku Activity `Succeeded`, golden set with flag OFF, then test mode with the benchmark file) before the next stage starts.

### 4.3 STAGE 1 ORDERING RULE (explicit)

**In Stage 1, the raw-delivery items (1.1 raw ingest, 1.2 mark columns, 1.3 count guarantee) must NOT be switched on, even in `test` mode, until the tool profile (1.4), ranking by coverage (1.5) and the code-built request (1.6) are merged in the same Stage 1 PR.** Reason: raw delivery without a request that already carries the customer's conditions would deliver everything the provider returns for an under-specified request.

How it is enforced, not only written:
1. **Commit order inside the Stage 1 PR:** 0.1, 0.2, 0.3, 0.4, **1.4, 1.5, 1.6**, 1.7, 1.8, 1.9, **then 1.1, 1.2, 1.3**, then 1.10, 1.11, 1.12.
2. **Code gate (item 1.1 and 1.6):** a mission's recipe records `built_by` (`"code"` when built by item 1.6, `"model"` otherwise). Raw delivery is effective only when the flag is `test` or `on` AND `built_by === "code"`. A test asserts that a model-built recipe never runs raw, whatever the flag says.
3. **Live gate:** item 6.7 (flag flip) for a raw-delivery type is not allowed until SP-LIVE 3 passed with the code-built request on the benchmark file.

### 4.4 Stage order of items (execution order inside each stage)

- Stage 1: 0.1, 0.2, 0.3, 0.4, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.1, 1.2, 1.3, 1.10, 1.11, 1.12.
- Stage 2: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9.
- Stage 3: 3.1, 3.2, 3.3, 3.4, 3.5, 5.1, 5.2.
- Stage 4: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6.
- Money PR: 6.3, 6.4.

The item bodies below keep their original grouping headings (old phases) so the numbering stays traceable; "Stage" in the heading says where each ships.

### Old Phase 0 -> STAGE 1: Rails (no behaviour change)

**Item 0.1: per-request-type flag.**
- Goal: one switch per request type (`social_posts`, `social_account`, `social_comments`, `companies`, `people`, `places`) with modes `off | test | on`, read from the existing `agent_settings` table key `redesign_flags` (no SQL: key/value jsonb, V `docs/proposals/agent-worker/01_agent_tables.sql` lines 89-95 region). `test` = only test accounts (the shared classifier from #244, `docs/HANDOFF.md:647`).
- Files: new `src/lib/agentMission/redesignFlags.ts`; `agent/src/runMission.ts` reads it through `store.readSettings()` (V `agent/src/supabaseStore.ts:112`); admin setting write through the existing `src/app/api/admin/agent/route.ts` pattern with an audit row.
- Failing test first: `redesign-flags.test.ts`: default off for every type; `test` mode true only for a test user; unknown value reads as off; an unreadable setting reads as off.
- Risks: reading settings at the start of every mission adds one SELECT (already done for pricing, `runMission.ts:280`, V).
- Rollback: SP-ROLLBACK. Verify live: SP-LIVE 1 and 2 only (nothing changes).

**Item 0.2: golden and benchmark harness.**
- Goal: one command replays the six golden prompts and the 10 benchmark requests offline against fixtures and prints the shape checks of `AUDIT-2026-11.md` section 7; the live checklist is a doc.
- Files: `tests/helpers/goldenWorld.ts` (extends the existing `g4RepliesWorld`), `docs/benchmarks/antigravity-10.md` (supplied by the owner, D10; added with the 2026-11-01 update of this plan, the harness consumes its shape checks), `scripts/golden-live-checks.sql` (read-only SELECTs, a proposal, not run here).
- Failing test first: `golden-harness.test.ts` asserts the harness fails when a delivered sheet lacks a required column or a delivered count differs from the approved count.
- Risks: benchmark requests 6, 7 and 10 (LinkedIn, Google Maps, medical papers) may need sources that are not in the current sellable catalog; the harness marks them `no_tool` rather than failing silently.
- Rollback: delete files. Verify live: run the 10 requests in test mode, SP-LIVE 4.

**Item 0.3: raw-delivery contract test (inventory snapshot).**
- Goal: pin the set of removal reasons that exist today (the 23 codes of `finalize.ts:129-135`) and define `ALLOWED_REMOVALS_RAW = {id_duplicate, unknown_parent, target_reached, named_source_share}` as the only ones allowed when raw mode is on.
- Files: `src/lib/agentMission/rawDelivery.ts` (constants only), `tests/raw-delivery-contract.test.ts`.
- Failing test first: the test asserts every reason outside the allowed set is either absent or converted to a mark under raw mode (red until item 1.1).
- Risks: none at runtime (constants).
- Rollback: SP-ROLLBACK. Verify live: not applicable until 1.1.

**Item 0.4: planning telemetry (events only).**
- Goal: answer F10's unknown (why planning reaches 580 MB, how the 36,577 output tokens split) with data: per-turn rss, output tokens and cache sizes recorded as internal events.
- Files: `agent/src/sdkRuntime.ts` (read usage per turn, V-R lines 62-69), `agent/src/runMission.ts` (`recordTokens` already exists, V `runMission.ts:288-289` area).
- Failing test first: `planning-telemetry.test.ts`: a fake driver emitting 3 turns produces 3 internal events with counts only, no text, no provider names.
- Risks: event volume (3 to 60 rows per planning); counts only; guarded by `guardEvent` (V `memoryStore.ts:97`).
- Rollback: SP-ROLLBACK. Verify live: next planning run shows the events; SELECT per mission.

### Old Phase 1 -> STAGE 1: Social media

**Item 1.1: raw ingest mode.**
- Goal: when the flag is on for the type, `ingest` applies only id-dedupe, parent structure and the count cap; every content rule becomes a mark value (kept in the row, not a drop). Mapping that returns fewer rows than the page is refused as a recipe in raw mode.
- Files: `agent/src/items/ingest.ts` (new `raw` option; branches at lines 87, 132-139, 147-149, 195-201, 213-248), `src/lib/agentMission/filters.ts` (new `markVerdict` returning the verdict without removing), `src/lib/agentMission/contract.ts` (text-dedupe off in raw mode), `agent/src/engine/spec.ts` (mapping-count check; records `built_by`), `src/lib/agentMission/redesignFlags.ts` (the gate below).
- Failing test first: `raw-ingest-social.test.ts`: (1) same text from two authors is two rows; (2) same id twice is one row; (3) an English post, a reply, a repost and an out-of-period post are delivered with marks; (4) a topic-unrelated text is delivered; (5) with the flag off the old tests' outputs are byte-identical; (6) **the Stage 1 ordering gate: a mission whose recipe has `built_by !== "code"` never runs raw, even with the flag `on`** (raw delivery is switched on only after items 1.4, 1.5 and 1.6 of the same PR; section 4.3).
- Risks: the largest PR; customer sees unrelated rows by design; `finalize.ts` reason tables unused in raw mode (text-only edits later). Count semantics (D6, D7): the customer pays for N and rows beyond N are not delivered; raw rows count toward N, so a request for 50 on a tool that cannot filter, when no better tool exists and the customer chose to continue (item 1.7), may return 50 mostly-unrelated rows, each marked. The same-text merge across authors (inventory row 2) is removed in raw mode.
- Rollback: flag OFF, then SP-ROLLBACK. Verify live: SP-LIVE with G3, G4 (flag test mode), compare delivered count and the mark columns.

**Item 1.2: social mark columns and no silent column drop.**
- Goal: add «رد أم أصلي», «إعادة نشر», «لغة النص», «ضمن الفترة المطلوبة», «المصدر المسمّى» to the first sheet in raw mode; stop dropping a column equal to another (`workbook.ts:135,161`).
- Files: `agent/src/workbook.ts`, `src/lib/agentMission/taskContracts.ts` (contract columns for posts and comments, V `docs/HANDOFF.md:102`).
- Failing test first: `social-mark-columns.test.ts`: header order equals the contract; a duplicated column survives; values come from the same verdict function as item 1.1.
- Risks: wider sheets; Arabic header review; every string through `checkCustomerText`.
- Rollback: flag OFF. Verify live: open the file from G3 and G4, compare headers with the live-sheet headers once Stage 2 exists.

**Item 1.3: count guarantee and honest shortfall.**
- Goal: in raw mode the engine keeps reading (next page, window, next tool per item 1.9) until the approved count N is reached (**D6: N is a cap, the customer pays for N, rows beyond N are not delivered**); any shortfall is stated from recorded counts with the stop reason; charge = ceil(delivered x unit) (formula untouched).
- Files: `agent/src/engine/run.ts` (stop rules at 374-407, 437-438: remove `review_limit` stall in raw mode), `agent/src/finalize.ts` TEXT only (shortfall sentence; no settlement line).
- Failing test first: `count-guarantee.test.ts`: a source with 60 rows and an approved 50 delivers 50; a source with 30 delivers 30 and says why; a barren page does not end the read while another tool remains.
- Risks: reading more pages costs more provider spend inside the reserve; the reserve already prices `planned_rows`; confirm no price change (**not a money PR** only if `finalize.ts` has text edits only).
- Rollback: flag OFF. Verify live: SP-LIVE, plus ledger balanced SELECT.

**Item 1.4: tool input profile (pure, catalog-driven).**
- Goal: a function `toolProfile(endpoint)` returning which condition classes the tool can express (date from/to or preset, language, country/region, account/URL, count/limit, sort, replies/exclude, cursor) from `inputs[]`, `enum`, `pagination`, with the exact field names.
- Files: new `src/lib/agentMission/toolProfile.ts`; reads `src/lib/treg/catalog.ts` (V-R).
- Failing test first: `tool-profile.test.ts` against real catalog endpoints: `scrapecreators.tiktok.search.videos` has date preset + sort + region, no language; `justoneapi.x.facebook-search-post-v1` has date range; `anyapi.x.search.posts` has none except query operators; `x.x.search-posts-recent` has a cursor input not listed in `pagination`.
- Risks: heuristic name matching; unknown names are reported as "unknown", never guessed.
- Rollback: delete file. Verify live: none (pure); SP-LIVE 1 only.

**Item 1.5: candidate comparison by coverage, then price; schema always read.**
- Goal: rank candidates by (conditions expressible, then cost/success); `catalog_search` and `describe_endpoint` show every input (no 10-input cut, no 140-character clip on notes that mention a condition); `treg_call` is refused in new mode until `describe_endpoint` was called for that endpoint.
- Files: `src/lib/agentMission/sourceRanking.ts` (new ordering key behind flag), `src/lib/modelPlanner/tools.ts:76-130` (display), `agent/src/tools.ts:375-399` (guard).
- Failing test first: `ranking-by-coverage.test.ts`: with a date range requested, the dearer tool with a date field outranks the cheaper without one; with no tool able, the cheaper wins and a gap is reported (**D7: the planner first tries every other candidate that expresses the condition; only when none exists is the gap reported**); guard test: `treg_call` before `describe_endpoint` is refused only in new mode.
- Risks: dearer sources raise the price (priced by code, shown at approval); prompt size grows (planning tokens).
- Rollback: flag OFF. Verify live: G3 plan card names a source that has a date field; compare planning seconds and output tokens (SP-LIVE 4).

**Item 1.6: code-built provider request from an understood record.**
- Goal: `buildToolInput(profile, understood)` writes date, language, country, account/URL, count (page size), sort and replies into the tool's own fields from the structured record; refuses unknown/invalid fields instead of deleting them; the recipe freezes the result and records `built_by: "code"` (the key of the raw-delivery gate in item 1.1).
- Files: new `src/lib/agentMission/toolInput.ts`; `agent/src/engine/spec.ts` (recipe from built input, not from model params, behind flag); **`agent/src/gateway.ts:201-202` is NOT changed** (it holds the spend caps, treated as a money file); the refusal happens in the engine layer before the gateway.
- Failing test first: `tool-input-builder.test.ts`: Arabic + last 7 days + TikTok -> `date_posted: "this-week"`; X search with a range -> `since:`/`until:` in the query; a language with no field -> reported gap, no invented field; an enum value outside the allowed list is refused.
- Risks: date presets are coarser than the customer's range (the post-hoc mark column in item 1.2 states it); provider schema changes (catalog snapshot date, V `docs/HANDOFF.md:191` 2026-10-27).
- Rollback: flag OFF. Verify live: G3 (50 tweets, last week, Arabic) and one TikTok benchmark; check the stored recipe params in the plan view (admin).

**Item 1.7: honest gap statement on the plan.**
- Goal (**D7**): the planner has already tried every other candidate tool (item 1.5); for each condition (date, topic, language, country) with no field in any candidate, the plan card says so in plain Arabic **before approval and the customer chooses** (continue with raw rows delivered marked, change the request, or cancel); no price is charged before that choice; the plan check refuses a plan whose card promises a condition that nothing enforces (replacing the old "every promise is a filter" rule, `docs/HANDOFF.md:584`).
- Files: `src/lib/agentMission/plan.ts` (gap list into `assumptions_ar`), `src/components/mission/AgentMissionCard.tsx` (shown open).
- Failing test first: `plan-gaps.test.ts`: a request with a country for a post search yields the line; no line when the tool has the field.
- Risks: wording; all text through `checkCustomerText`.
- Rollback: flag OFF. Verify live: read the plan card on the benchmark requests.

**Item 1.8: pagination coverage.**
- Goal: discover the cursor input from `inputs[]` when `pagination` lacks it (names `cursor`, `next_token`, `pageToken`, `pagination_token`, `max_cursor`, `next_max_id`, `continuationToken`), verified by the shape reader on a real page; endpoints with no cursor at all (`treg.*` routed) are ranked below a pageable one for counts above one page.
- Files: `agent/src/engine/spec.ts:164`, `src/lib/treg/shapeReader.ts` (V-R `:243-336`), `toolProfile.ts`.
- Failing test first: `cursor-discovery.test.ts`: `x.x.search-posts-recent` and `youtube.youtube.video.comments` get a cursor param; a replay of 3 pages delivers 3 pages' rows.
- Risks: a wrongly discovered cursor loops (the barren-page rule ends it, V-R `run.ts:380`); cost per extra page.
- Rollback: flag OFF. Verify live: a 100-comment YouTube benchmark.

**Item 1.9: fetch-to-count with continuation across tools.**
- Goal: when a tool fails twice or returns empty/short, the engine picks the next suitable tool (same profile coverage, next cheapest) and continues by remaining count, date boundary reached and stored ids; everything inside the approved reserve; past it, stop and offer a new priced plan.
- Files: `agent/src/engine/run.ts` (new fallback chain in `runStream` area 374-407), `agent/src/engine/spec.ts` (ordered alternatives in `EngineSpec`), `src/lib/agentMission/plan.ts` (alternatives stored with the plan, priced by code).
- Failing test first: `tool-fallback-continues.test.ts`: tool A gives 20 of 50 then fails; tool B continues with `until = oldest date so far`; delivered = 50 with no duplicate ids; spend never exceeds the reserve; at the reserve edge it stops with `need_new_plan`.
- Risks: different tools return different shapes (each alternative needs a proven map recipe, so alternatives are measured at planning time, which costs planning budget); duplicates across tools are caught by id only when ids agree across providers (they often do not: GUESS), so the date-boundary is the main guard. Documented limit: cross-provider overlap can produce near-duplicates that exact-id dedupe does not catch (D5).
- Rollback: flag OFF. Verify live: force a failure with a fake provider in the replay, then one live run on a benchmark.

**Item 1.10: "all comments means all".**
- Goal: `per_parent_rows: "all"` reads each parent to its source's end using each parent's own comment counter for the estimate; the plan states the estimate and the price; above the job cap the plan keeps today's behaviour (the count is lowered to fit, V-R `PlanQuoteCard.tsx:429`) until the Stage 4 money PR (item 6.4) adds staging; Stage 1 ships "all" only inside the 25,000 cap.
- Files: `src/lib/agentMission/quantity.ts` (V-R `:230-238`), `plan.ts` (estimate from sampled counters, as `repliesEstimateFor` does, V-R `HANDOFF.md:16`), `agent/src/engine/run.ts:122-124`.
- Failing test first: `all-comments.test.ts`: 5 videos with counters 12, 40, 7, 0, 100 plan 159 comments (0-counter parent not read), delivered 159; the card says «كل التعليقات» with the count.
- Risks: pricing input only (`plan.ts`, not `price.ts`): **[PRICE-INPUT]**, needs owner review; the 5,000 total-row cap (V-R `constants.ts:234`) must be lifted by staging, not removed.
- Rollback: flag OFF. Verify live: G4 variant with «كل التعليقات».

**Item 1.11: planning checkpoint and resume.**
- Goal: after each tool turn, persist the planning state (`samples`, `tried`, `callParams`, `proposedPlan`, `question`, plus a short model-written working summary) to `planning_state.json` in the mission folder; on a restart or memory requeue, the prompt carries it so the model does not redo comparison or samples. The memory stop no longer throws away the run.
- Files: `agent/src/tools.ts` (RunState serialise, line 89), `agent/src/runMission.ts` (write at checkpoint, read at 279, prompt at 102-106), `agent/src/runState.ts` pattern (V: best-effort JSON in the bucket, never critical).
- Failing test first: `planning-resume.test.ts`: a run killed at turn 3 (memory stop) resumes with the same samples and does not repeat a paid provider call (call count equals the uninterrupted run); the stored state contains no secret.
- Risks: the state can be large (cap its size; samples are digests, not pages); a corrupt file is ignored (never critical); a changed catalog between runs.
- Rollback: flag OFF (planning flag follows the type flag). Verify live: SP-LIVE, plus an owner-triggered restart of the worker during a planning run (Heroku restart) and check the `plan` event arrives without a second set of sample calls.

**Item 1.12: execution resume proof.**
- Goal: prove, with a kill-and-restart replay, that execution resumes from the last saved batch (the item store already does this); fix any gap found (stream position of the fallback chain from 1.9, preview sequence from Stage 2).
- Files: tests plus small fixes in `agent/src/items/itemStore.ts`, `engine/run.ts`.
- Failing test first: `execution-restart-replay.test.ts`: kill after page 3 of 6, restart, final file equals an uninterrupted run, provider calls after restart start at page 4, no row twice, ledger rows unchanged by the restart.
- Risks: low; test-driven.
- Rollback: SP-ROLLBACK. Verify live: restart the worker during a G4 run, check delivered count and ledger balance.

### Old Phase 2 -> STAGE 2: Understanding cards and the live sheet (social first, then every type)

**Item 2.1: bring back the "how we understood your request" block (regression fix).**
- Goal: show `assumptions_ar` open on the plan card instead of inside the closed `<details>` (the 2026-10-31 regression, F8.2).
- Files: `src/components/mission/AgentMissionCard.tsx:195-204`.
- Failing test first: `agent-card-assumptions-open.test.tsx`: the assumptions block is visible without opening the details (revert of the `3fd8f7f` item 6 behaviour).
- Risks: card height on mobile (check at 380 px, the repo's standard, V `docs/HANDOFF.md:270`).
- Rollback: SP-ROLLBACK. Verify live: Vercel production READY on the SHA; open a plan card on a phone-width window.

**Item 2.2: understanding step (Haiku 5.5 with extended thinking) producing the structured record.**
- Goal: a step before planning that reads the catalog and candidate input schemas (item 1.4), then writes an `understood` record {platform, topic, source, period, language, country, count, replies} and the list of fields the candidate tools need that the request left empty. Pinned to `claude-haiku-5-5`; `planning_model` setting ignored in the new path; extended thinking enabled if the SDK supports it.
- Files: new `agent/src/understand.ts`; `agent/src/runMission.ts` (before the planning run); `agent/src/modelConfig.ts` (pin); `agent/src/sdkOptions.ts` passes `thinking: { type: "enabled", budgetTokens: N }`. **VERIFIED that the pinned SDK 0.3.312 declares it:** `agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1958` (`thinking?: ThinkingConfig`), usage documented at `:1972`; `maxThinkingTokens` is the deprecated form. N defaults to 8,000 (open decision D4, default in section 7.2).
- Failing test first: `understand-record.test.ts`: «هات ٥٠ تغريدة عن الذكاء الاصطناعي في مصر آخر أسبوع باللغة العربية» yields platform X, count 50, period 7 days, language ar, country EG, replies unspecified; model id asserted equal to `claude-haiku-5-5`; a record field never contains a provider name.
- Risks: extra model cost per mission (priced by code as a planning input, **[PRICE-INPUT]**); added latency (target: the step under 20 s; planning targets in `AUDIT` PR 2 stay 90 s / 15,000 tokens, NOT PROVEN); thinking tokens bill as output.
- Rollback: flag OFF. Verify live: SP-LIVE 3 with the record visible on the plan card; SELECT planning seconds and tokens.

**Item 2.3: up to three catalog-driven question cards plus «شيء آخر».**
- Goal: the missing fields from 2.2 become at most 3 cards (a condition that NO candidate tool can express is not asked as a question: it is the item 1.7 gap line, where the customer chooses, D7) (one field each), 2 to 4 ready options from the tool's enum or sensible presets, plus a free-text «شيء آخر»; no generic question; the code, not the model, decides which field is worth asking (it changes a tool input and the request left it empty).
- Files: `agent/src/tools.ts:531-558` (`ask_question` becomes a batch of up to 3; keep `checkCustomerText`), `src/components/mission/AgentMissionCard.tsx:138-149` (render several cards in order), `src/lib/agentMission/customerView.ts:369` (options per question), `agent/prompts/system.md:13` (remove "ask at most once" for the new path).
- Failing test first: `question-cards.test.ts`: a request without a period for a TikTok search asks one card with the tool's `date_posted` options plus «شيء آخر»; a request with every field present asks none; never more than 3; an option containing Latin words is refused (existing rule, V `tools.ts:546`).
- Risks: question fatigue (3 max is the owner's rule); the existing one-question state (`state.question !== null`, V `tools.ts:540`) and storage (`plan_public.question_options`, V `tools.ts:555`) assume ONE question: this PR changes the stored shape, so the reader must accept both.
- Rollback: flag OFF. Verify live: benchmark requests that omit period/country show cards.

**Item 2.4: editable "understood as" card.**
- Goal: the record is shown with each field tappable; an edit changes the record, code rebuilds the tool input (item 1.6) and re-prices (existing re-price on edit, V-R `planEdit.ts`). If an edit moves a condition onto a tool that cannot express it, the item 1.5 search for another tool runs first and the item 1.7 gap line (customer chooses) follows (D7).
- Files: `src/components/mission/PlanEditor.tsx` (add fields), `src/lib/agentMission/planEdit.ts`, `AgentMissionCard.tsx`.
- Failing test first: `understood-edit.test.ts`: changing the count 50 to 20 changes `planned_rows`, price and tool input in one step; changing the period to one with no field adds the gap line; every string through `checkCustomerText`.
- Risks: edits that change the tool (a country the chosen tool lacks) need a re-plan; the editor must say so.
- Rollback: flag OFF. Verify live: edit a benchmark plan and approve.

**Item 2.5: fast chat replies and cards (Haiku 5.5).**
- Goal: the acknowledgement turn («فهمت، أراجع الأدوات المتاحة…») and short replies come from a small Haiku call instead of the fixed text `AGENT_TURN_CONTENT_AR` (V-R `chatTurn.ts:28`); no tool use; guarded by `checkCustomerText`; money untouched.
- Files: `src/lib/agentMission/chatTurn.ts`, `src/functions/shared/llmClient.ts` pattern (V-R `:2407-2432`).
- Failing test first: `fast-chat-reply.test.ts`: reply produced with model `claude-haiku-5-5`, Arabic only, no emoji, no provider names; a refused text falls back to the fixed sentence.
- Risks: added latency on the chat turn (set a short timeout, fall back); cost per turn (priced into platform cost, not the customer).
- Rollback: flag OFF. Verify live: chat turn latency measured in the browser; SELECT model cost per turn.

**Item 2.6: preview feed API (polling, no SQL).**
- Goal (**D3: polling only, no Realtime, no SQL, no new table; `tests/supabase-free-plan-limits.test.ts` stays unchanged and must keep passing**): `GET /api/missions/[id]/preview?after=<seq>` returns the rows accepted since `seq`, read from the item store with the service role and an explicit owner check (the pattern of `src/app/api/missions/[id]/route.ts`, V-R), plus counters and the notebook line; each row carries its sheet, columns and parent id.
- Files: new `src/app/api/missions/[id]/preview/route.ts`; new `src/lib/agentMission/previewFeed.ts`; the item store read side (`agent/src/items/itemStore.ts` shared code, V-R).
- Failing test first: `preview-feed.test.ts`: only the owner reads; rows arrive in order with no gaps for `after`; a row removed by a swap does not appear twice; response never contains provider names, endpoint ids, USD.
- Risks: reading the segment objects per poll; Storage serves overwritten objects stale (the item store uses immutable objects for that reason, V `docs/HANDOFF.md:596`); poll cost at scale (use jittered adaptive polling like `startNotificationPolling`, V `tests/supabase-free-plan-limits.test.ts:36-60`).
- Rollback: SP-ROLLBACK (route only; flag off hides the UI). Verify live: curl the route as the test account during a run.

**Item 2.7: desktop sheet component.**
- Goal: an Excel-like RTL sheet: frozen header with the final file's column names, row numbers, new-row highlight that fades; reads the feed of 2.6.
- Files: new `src/components/mission/LiveSheet.tsx`; used in `AgentMissionCard.tsx`.
- Failing test first: `live-sheet.test.tsx`: header equals the contract columns; rows append without re-rendering old rows; highlight class removed after the fade; Arabic-Indic row numbers.
- Risks: render cost for thousands of rows (virtualise; cap rendered rows to the latest N with a count); RTL freeze.
- Rollback: flag OFF. Verify live: watch a G3 run on desktop.

**Item 2.8: mobile cards, counter, progress bar, notebook line.**
- Goal: below a width breakpoint, small cards for the latest rows (newest first, replies indented under their comment), a «X من N» counter and a progress bar; «تحميل الملف» replaces the counter at the end; the notebook line is selected from a code whitelist by event, never free model text.
- Files: new `src/components/mission/LiveCards.tsx`, `MissionCounter.tsx`, `workNotebook.ts` (whitelist), `AgentMissionCard.tsx`.
- Failing test first: `live-cards.test.tsx` and `work-notebook.test.ts`: every whitelisted line passes `checkCustomerText` and contains no provider/endpoint/USD/vendor word; replies indent under their parent; counter and button swap.
- Risks: the notebook must not leak internals (whitelist, not model text); 380 px layout.
- Rollback: flag OFF. Verify live: phone-width check on a G4 run.

**Item 2.9: the final file equals the rows watched.**
- Goal: a test and a runtime check that the workbook rows equal the preview rows (same ids, same order, same cells).
- Files: `tests/preview-equals-file.test.ts`; small fix wherever they diverge (`agent/src/workbook.ts`).
- Failing test first: that test with a G4 world including replies and a swap.
- Risks: swaps change earlier rows (preview must show a swap as a replacement, not a duplicate).
- Rollback: SP-ROLLBACK. Verify live: compare the downloaded file with the last preview state on a benchmark.

### Old Phase 3 -> STAGE 3: Companies and people

**Item 3.1: raw people and company delivery (marks).**
- Goal: `not_at_company`, `not_a_person` and `no_verified_contact` rows are delivered with marks («يعمل حاليًا في الشركة»: نعم / غير مؤكد / لا; «نوع الجهة»; status columns); place, government, language filters become marks («المكان», «جهة حكومية»); relevance and LLM review removed in raw mode for companies.
- Files: `agent/src/items/ingest.ts:195-201`, `agent/src/engine/run.ts:245-256` (verdict kept, not a drop), `agent/src/workbook.ts`, `src/lib/agentMission/taskContracts.ts`.
- Failing test first: `raw-people-companies.test.ts`: the live G1 shape (a person at another company, a role mailbox, a German company for an Egypt request) delivers all of them with marks; counts per company unchanged; golden-r2 location tests still pass in the OLD mode.
- Risks: owner's earlier rule "every person currently works at that company" (`AUDIT` section 1A) is now a mark, not a guarantee (**D8**): a person not currently at the company is delivered with «يعمل حاليًا في الشركة: لا» and counts toward the requested number; the company's next people no longer "take the place". The decision-maker upgrade swaps (inventory row 23) stay for now (D8). Counting changes what is charged: **delivered rows rise**, still ceil(delivered x unit) with the formula untouched, but check `finalize.ts` settlement reads the file rows (V `docs/HANDOFF.md:98`); no settlement line is edited.
- Rollback: flag OFF. Verify live: G1 and G2, compare against baselines `msn_7539…`, `msn_020c…`.

**Item 3.2: exact-duplicate rule for companies and people.**
- Goal: duplicate company = same provider company id or same web domain; duplicate person = same profile URL, or same normalised name at the same company; remove only those, keep the first; name-only never removes.
- Files: `agent/src/items/ingest.ts` (new keys beside the id check at 125), `src/lib/agentMission/contract.ts` (`deriveItemId`).
- Failing test first: `company-person-dedupe.test.ts`: two ids with the same domain are one company; two companies with the same name and different domains are two; a person with the same profile URL is one person, and the same normalised name at the same company is one person, but the same name at two different companies stays two rows (**D5**: name-only never removes).
- Risks: the current store key is stage + id so a person id repeated under a second company is dropped today (V-R `ingest.ts:125`); the new rule changes that.
- Rollback: flag OFF. Verify live: G1 with overlapping companies.

**Item 3.3: tool coverage for companies and people requests.**
- Goal: the request builder (1.6) fills sector, country, size, domain fields; candidates compared by coverage (1.5); `aviato.companies.search` (a free `dsl` string, V-R) gets a code-built DSL from the record instead of model text.
- Files: `toolInput.ts` (company tools), `sourceRanking.ts`, `contactFinders.ts` (V-R).
- Failing test first: `company-request-build.test.ts`: Egyptian electromechanical, 5 companies -> `treg.companies.search` with `country: "EG"` and sector terms in the tool's own fields; DSL built by code for the DSL tool.
- Risks: `peopleSearchInput.ts` is legacy (V-R); the title field for decision makers must come from the roles lexicon, not the model.
- Rollback: flag OFF. Verify live: G1, G2.

**Item 3.4: "not found" only after every relevant tool.**
- Goal: for a company e-mail, HQ phone or a decision maker, try each relevant catalog tool (cheapest first, inside the reserve) before writing «غير متوفر»; record each attempt as counts.
- Files: `agent/src/engine/contacts.ts` (company steps, V-R `runCompanyStage`), `contactFinders.ts`.
- Failing test first: `not-found-after-all-tools.test.ts`: with 4 tools in the catalog and 3 empty, the 4th is called; «غير متوفر» is written only after all answered or the reserve is spent (then «لم يُبحث»).
- Risks: spend per company; capped by the existing step caps (V-R `HANDOFF.md:130`) and the reserve; the daily cap stays 0.80 USD.
- Rollback: flag OFF. Verify live: G1 company e-mail and phone fill rate (NOT PROVEN today, `AUDIT` section 8).

**Item 3.5: retries and alternatives inside the reserve; new priced plan beyond it.**
- Goal: the fallback chain (1.9) for company and people stages; when the reserve is spent and the count is unmet, stop with `need_new_plan` and show the customer a new priced plan (see 6.4 for staging).
- Files: `agent/src/engine/run.ts`, `src/lib/agentMission/customerActions.ts`, `AgentMissionCard.tsx`.
- Failing test first: `reserve-boundary.test.ts`: never spends beyond the reserve; produces a follow-up plan object with its own price; no charge for the follow-up before approval.
- Risks: touches the approval path: the follow-up plan is an ordinary new mission (existing `res_/chg_/rel_`), no ledger code changes.
- Rollback: flag OFF. Verify live: a deliberately underfunded benchmark.

### Old Phase 4 -> STAGE 4: Review, edits, versions

**Item 4.1: file versions (no SQL).**
- Goal: every delivery is `v1`; an edit or fix creates `v2`, `v3`…; the old version stays downloadable; versions listed in `missions.files` (jsonb, V-R `customerActions.ts:23` column list) with a label.
- Files: `agent/src/workbook.ts` / `publishResult` paths (V `memoryStore.ts:121-126` shape), `customerActions.ts` `customerFileLink` (V-R `:170`), card file buttons (V-R `AgentMissionCard.tsx:276-281`).
- Failing test first: `file-versions.test.ts`: v2 does not overwrite v1; both links work; the card shows both with Arabic labels.
- Risks: storage growth; the bucket allows three MIME types only (V `constants.ts` `AGENT_BUCKET_ALLOWED_MIME`).
- Rollback: SP-ROLLBACK. Verify live: download v1 and v2 of one benchmark file.

**Item 4.2: review engine (report and score, never deletes).**
- Goal: checks of the delivered rows (empty required cells, numbering, header consistency, broken links by format, parent links, duplicate ids) produce a report and a score; a model (Haiku 5.5) only phrases the report in Arabic; the score is computed by code.
- Files: new `agent/src/reviewReport.ts`; reuses the sandbox checks.
- Failing test first: `review-report.test.ts`: a file with 30% missing e-mails scores 70% on that check; no row is ever removed (rows in = rows out); text passes `checkCustomerText`.
- Risks: link checking by network is out of scope (format only) unless the owner wants live checks (cost and time) (D11).
- Rollback: flag OFF. Verify live: review a delivered G1 file.

**Item 4.3: review checkbox and interactive buttons.**
- Goal: «راجع الملف قبل التسليم» on the plan card and «راجعه الآن» after delivery; the report ends with buttons نعم / لا / شيء آخر.
- Files: `AgentMissionCard.tsx`, `PlanEditor.tsx`, `customerActions.ts`.
- Failing test first: `review-buttons.test.tsx`: the three buttons exist; choosing «لا» ends with no charge beyond the review price.
- Risks: wording; flows through approval (money) only in 6.3.
- Rollback: flag OFF. Verify live: click-through at 380 px.

**Item 4.4: review price by code from file size [PRICE-INPUT].**
- Goal: `reviewPriceFor(fileSize)` pure function (rows x cells to a point price), shown before approval, no charge wired yet. Default constants (D12): 1 point per 100 cells (rows x columns), rounded up, minimum 100 points.
- Files: new `src/lib/agentMission/reviewPrice.ts` (not `price.ts`).
- Failing test first: `review-price.test.ts`: monotonic in size, minimum applies, ceiling integer points, deterministic.
- Risks: price policy is the owner's (D12); the review minimum (default 100 points, same as the edit minimum) and the per-cell rate are the D12 default, tunable by the owner in this one file.
- Rollback: delete file. Verify live: price shown on a review offer.

**Item 4.5: fetch the missing part, merge into a new version.**
- Goal: from the review's problem list the customer picks "fetch what is missing"; a new priced plan for only the missing fields/rows; on approval, the fetched rows are merged into a NEW version; the old version stays.
- Files: `agent/src/runMission.ts` (merge mode over an existing item store), `workbook.ts`.
- Failing test first: `review-fix-merge.test.ts`: v1 with 3 empty e-mails -> v2 has the 3 filled, other cells byte-identical, v1 intact.
- Risks: merge keys (parent id + row id); charge in 6.3.
- Rollback: flag OFF. Verify live: one benchmark.

**Item 4.6: post-delivery edit mode (same file, new version).**
- Goal: a message in a conversation whose last mission is delivered is an edit request: Claude checks and edits the same file as the next version (`AUDIT` G16); only the changed part is read; price shown before approval (**D2: minimum 100 points, superseding the 20 recorded in `AUDIT-2026-11.md`; D1: a fix caused by our own mistake is priced like any edit, no free path**); replaces "a follow-up starts a new mission with no memory" (V-R `AUDIT` G16, mission `msn_5273…`).
- Files: `src/lib/agentMission/chatTurn.ts`, `customerActions.ts:141-152` (V-R, edit only while `plan_ready` today), `agent/src/runMission.ts`.
- Failing test first: `edit-after-delivery.test.ts`: «ضيف عمود العنوان لكل شركة» on a G1 file yields v2 with the column, no new plan from scratch, price shown before approval; nothing charged when nothing changes.
- Risks: intent routing (a follow-up that is really a new request); charge in 6.3.
- Rollback: flag OFF. Verify live: the AUDIT golden follow-up.

### Old Phase 5 -> STAGE 3: Queue and e-mail

**Item 5.1: queue message with position and approximate start time.**
- Goal: extend `queueLine` (V-R `customerView.ts:194-200`) with an approximate start from the running mission's stage and a recent median; copy through `checkCustomerText`.
- Files: `customerView.ts`, `AgentMissionCard.tsx:136`.
- Failing test first: `queue-line.test.ts`: position 3 with a running job shows position and a rounded Arabic-Indic minutes range; no ETA claim when no history.
- Risks: a wrong ETA is worse than none (`docs/HANDOFF.md` rule "never an ETA" for planning, V `src/lib/agentMission/constants.ts:125`); show a range, never a promise.
- Rollback: SP-ROLLBACK. Verify live: queue two missions.

**Item 5.2: "email me when my job starts", one e-mail per job, only if the wait exceeds one minute.**
- Goal: an option on the queue message; the "started" notice gets an e-mail only when the customer opted in and the wait was over 60 seconds; idempotency key `mission-update:started:<id>` (V-R pattern); a monthly cap check against 50,000, read from the Resend usage API at send time with no SQL table (D13 default: if the count cannot be read, no optional e-mail is sent).
- Files: `src/lib/agentMission/notices.ts:48-50`, `src/lib/server/missionNotify.ts:28`, a counter source (see D13: Resend usage API read, or a count in `agent_settings`, no SQL).
- Failing test first: `started-email.test.ts`: wait 45 s -> no e-mail; wait 90 s with opt-in -> exactly one; a second call -> none; at 49,990 sent this month it still sends, at 50,000 it does not.
- Risks: the e-mail path is shared with money notices (`job-update` template); a bug must not block completion e-mails.
- Rollback: SP-ROLLBACK. Verify live: send one to the test account and read the Resend log (the Resend usage tool exists in this session's MCP list, not used here).


### STAGE 4 MONEY PR: [MONEY] charges for review, fix and edit, and staged jobs (items 6.3 and 6.4)

This is the ONLY exception to "one pull request per stage". It is a separate pull request, opened only after Stage 4 is merged and **only after an explicit owner brief** (SP-MONEY). It has two items, one commit each, failing test first.

**Item 6.3: [MONEY] charge for review, fix and edit through the ledger.**
- Goal: review, "fetch missing" and post-delivery edit are charged through the EXISTING reserve/settle functions with new deterministic ids (`res_`, `rel_`, `chg_` per edit version), release-first, idempotent; price = code (review: `reviewPriceFor`; edit: real cost x markup, **minimum 100 points, D2**); **a fix caused by our own mistake is priced the same way (D1)**; nothing charged before approval.
- Files: `src/lib/agentMission/approval.ts`, `customerActions.ts`, `agent/src/runMission.ts` settlement call sites only to ADD a new mission kind; **no ledger SQL change, no change to `chargeForDelivered`/`settlementCharge`**.
- Failing test first: `edit-ledger.test.ts`: res/rel/chg rows balance for an edit; a retried approval is idempotent; an edit priced below 100 points is charged 100; an edit flagged as caused by our mistake is still charged; charge never above the reserve.
- Risks: this is the money path. The 20-point minimum recorded in `docs/AUDIT-2026-11.md` section 9 item 4 is SUPERSEDED (D2); any test pinning 20 must be changed in this item and marked `CHANGED`.
- Rollback: flag OFF, then SP-ROLLBACK. Verify live: SP-LIVE 4 ledger-balanced SELECT for the edit.

**Item 6.4: [MONEY] staged jobs above 25,000 points.**
- Goal: a request whose reserve would exceed `JOB_MAX_POINTS_CAP` (25,000, F7) is split into stages, each with its own plan, approval and charge; the customer sees "المرحلة ١ من ٣".
- Files: `src/lib/agentMission/plan.ts` (the clamp that today lowers the count to fit the cap, V-R `PlanQuoteCard.tsx:429`), `customerActions.ts`, `AgentMissionCard.tsx`.
- Failing test first: `staged-job.test.ts`: 40,000-point request -> two stages, 25,000 and the rest; each stage reserves, charges and releases independently; the cap constant is not changed.
- Risks: today there is no staging (F7); every stage is an ordinary mission. Do not change `JOB_MAX_POINTS_CAP`.
- Rollback: flag OFF. Verify live: owner-approved test with a small artificial cap via the env var (it can only LOWER the cap, V `jobPointsCap.ts:20-23`).

### CONDITIONAL AND NON-PR ITEMS (old Phase 6 leftovers)

- **Item 6.5: [MONEY] price inputs for raw delivery and all-comments.** Built ONLY if Stage 1 proves the reserve estimate needs a new input (more rows delivered in raw mode, estimate from counters). If so it is its own small money PR with an explicit owner brief, `price.ts` inputs only, never `chargeForDelivered`. Failing test first: `raw-delivery-price.test.ts` (the standard G1/G4 requests keep unit price within the pinned bands of `tests/standard-request-price.test.ts` unless the owner changes the band). Proof gathered by Stage 1: the price of G1 and G4 plans with the flag on, compared with the flag off.
- **Item 6.6: e-mail counter [SQL].** **Dropped unless needed.** Default D13 reads the monthly count without a table, so no SQL is planned.
- **Item 6.7: flip the flags.** A **settings change, not a PR**: after a request type passes SP-LIVE 3 for a full week in `test` mode and the owner signs, set that type to `on` (settings write with an audit row). Rollback: set it back to `off`. Verify live: SP-LIVE 4 for 24 hours after each flip.

### LATER, NOT PLANNED (owner decision D3, 2026-11-01)

These were in the first version of this plan and are **dropped**. They are recorded so the idea is not lost, not scheduled:
- **Old item 6.1 [SQL]:** a `mission_preview_rows` table with Row Level Security (a customer reads only their own rows).
- **Old item 6.2:** a Supabase Realtime subscription in the site, which would also have required changing `tests/supabase-free-plan-limits.test.ts:18-27`. **That test stays as it is.**
- Retirement of the legacy chunk pipeline (D9) and of the old filters after every type is on.

If the owner reopens Realtime later, the live sheet code (Stage 2) already reads a feed through one function, so a second source can be added without redoing the UI; no work toward it is done now.

---

## 5. FEATURE FLAG DESIGN (summary)

- Store: `agent_settings` key `redesign_flags`, value `{"social_posts":"off","social_account":"off","social_comments":"off","companies":"off","people":"off","places":"off"}` (V-R pattern: `src/lib/missionPricing.ts:56-59` reads another key the same way). Modes: `off`, `test` (test accounts only), `on`.
- Read: worker at mission start (`agent/src/runMission.ts`, beside the pricing settings read, V line 280); site for the UI pieces through the existing customer view.
- Per-type routing: the request type is known from the plan's stage shapes (post stage, comments stage, companies stage, people stage, places stage); a mission with mixed types uses the flag of each stage and the old path if any stage's flag is off (no half-new mission).
- A mission records the pipeline that ran it (`new` or `old`) as an event so a result can always be traced.
- **Dependency rule (Stage 1 ordering rule, enforced in code):** raw delivery is effective only for a mission whose recipe was **built by code** (`recipe.built_by === "code"`, set by item 1.6). A model-built recipe always runs the old path, even with the flag in `test` or `on`. A test in item 1.1 asserts this.
- Old pipeline stays intact and tested; no old code is deleted in this plan.

---

## 6. MONEY AND SQL ITEMS (kept separate and last)

| Item | Kind | Where it ships | Why it needs owner approval |
|---|---|---|---|
| 1.10, 2.2, 4.4 | **[PRICE-INPUT]** | inside Stage 1, Stage 2, Stage 4 | add a price input or a pure price function; not wired to a charge; owner reviews numbers in the PR |
| 6.3 | **[MONEY]** | Stage 4 money PR (separate, last) | review/fix/edit charges through the ledger with new ids; edit minimum 100 points (D2); own-mistake fixes priced (D1) |
| 6.4 | **[MONEY]** | Stage 4 money PR (separate, last) | staged jobs above the 25,000 cap |
| 6.5 | **[MONEY]** | its own PR, only if Stage 1 proves it is needed | price inputs in `price.ts` |
| 6.6 | **[SQL]** | dropped unless needed | e-mail counter |
| 6.7 | Settings change | not a PR | flag flips |
| old 6.1, 6.2 | [SQL], test change | **dropped (D3), "later, not planned"** | preview table with RLS and Realtime |

No SQL is planned in any stage. Files that no item in Stages 1 to 3 may touch: `agent/src/finalize.ts` settlement lines (text edits only, as past PRs did, V `docs/HANDOFF.md:9`), `src/lib/agentMission/price.ts` charge formula, `agent/src/gateway.ts` caps, `src/functions/**`, `supabase/**`, `src/lib/jobPointsCap.ts`, `tests/supabase-free-plan-limits.test.ts`, anything under `docs/proposals/` that is already applied.

---

## 7. DECISIONS

### 7.1 Owner decisions (2026-11-01), recorded

| ID | Decision | Where it lands in the plan |
|---|---|---|
| D1 | Fixes caused by our own mistake are **NOT free**; priced like any edit. | item 4.6, money item 6.3 |
| D2 | Post-delivery edit minimum = **100 points**. Supersedes the 20 in `docs/AUDIT-2026-11.md` section 9 item 4 (marked SUPERSEDED there). | items 4.4, 4.6, money item 6.3 |
| D3 | **No Realtime for now.** The live sheet uses the polling feed (no SQL). The Realtime ban test stays. Old 6.1 and 6.2 dropped, listed under "Later, not planned". | Stage 2 items 2.6 to 2.9; section 4 "Later, not planned" |
| D5 | Duplicate company = same provider company id or same web domain. Duplicate person = same profile URL, or same normalised name at the same company. Name-only never removes. | item 3.2 |
| D6 | Keep the count cap. The customer pays for N; rows beyond N are not delivered. | items 1.1, 1.3 |
| D7 | If the chosen tool cannot express a condition (date, topic, language, country), first look for another tool that can; if none, the plan card says so before approval and the customer chooses; raw rows are then delivered marked. | items 1.5, 1.7, 1.9, 2.3, 2.4 |
| D8 | A person not currently at the company is delivered with the mark «يعمل حاليًا في الشركة: لا». Decision-maker upgrade swaps stay for now. | item 3.1 |
| D10 | Benchmark list supplied: `docs/benchmarks/antigravity-10.md`. | item 0.2, SP-LIVE 3 |

### 7.2 Still open, with a proposed default for each (the default applies unless the owner says otherwise)

- **D4.** Extended-thinking budget and Sonnet. **Default:** `thinking: { type: "enabled", budgetTokens: 8000 }` on the planning step only (the SDK option exists, F11); the new pipeline is pinned to `claude-haiku-5-5` and the admin `planning_model` setting is ignored for flagged types; Sonnet stays selectable only for the old pipeline.
- **D9.** Is the legacy chunk pipeline still serving production requests? **Default:** treat it as retired for research turns (`AGENT_SERVES_CHAT = true` routes them to the agent), leave it untouched, confirm with a read-only look at `jobs` created through `accept-quote` over 7 days, and schedule its removal after Stage 4 is stable.
- **D11.** Review link checks. **Default:** format checks only (empty, malformed, wrong domain pattern); live HTTP checks are a later paid option.
- **D12.** Review price constants. **Default:** 1 point per 100 cells (rows x columns), rounded up, minimum 100 points (same as the edit minimum); shown before approval; the owner tunes the constants in `reviewPrice.ts`.
- **D13.** Resend monthly count and the wait threshold. **Default:** read the month's count from Resend's usage API at send time; if it cannot be read, send nothing optional (fail closed); no SQL table. The threshold is a measured wait over 60 seconds (time from approval to start), not the estimate.
- **D14.** Preview-row retention. **Default:** not needed (D3: no preview table; the feed reads the item store, whose retention is unchanged).
- **D15.** Cross-provider continuation. **Default:** accepted as written: "continue where it stopped" means by count, date boundary and id; cursors never cross providers; near-duplicates across providers that exact-id dedupe cannot catch are accepted and not removed (D5).

## 8. COULD NOT VERIFY

1. Live value of `JOB_MAX_POINTS_CAP` on Vercel and Heroku and in the live SQL functions (no env or SQL access; `HANDOFF.md:256` says 25,000).
2. Whether the live database matches `docs/proposals/agent-worker/01_agent_tables.sql` (RLS and column grants on `missions`, `mission_events`).
3. The date the cards stopped appearing (git root commits are 2026-10-28; earlier history is absent), and how often the agent asks questions.
4. ~~Whether the SDK exposes a thinking option~~ **now VERIFIED:** `@anthropic-ai/claude-agent-sdk` 0.3.312 (V `agent/node_modules/@anthropic-ai/claude-agent-sdk/package.json:3`) declares `thinking?: ThinkingConfig` at `sdk.d.ts:1958`, with `{ type: 'enabled', budgetTokens: N }` documented at `sdk.d.ts:1972` and `maxThinkingTokens` as the deprecated form (`sdk.d.ts:357,1974`). Still NOT VERIFIED: whether Haiku 5.5 thinks by default when no option is passed, and the token split of a real run.
5. Why planning reaches 580 MB and how its output tokens split per turn.
6. Heroku Activity, worker logs, live `AGENT_CONCURRENCY`, live `planning_model`.
7. The content of model-written mapping code in stored plans (it can drop rows invisibly); whether TREG bills per call or per row for pages we drop.
8. Whether the TREG server forwards unknown params or ignores `limit` on routed `treg.*` endpoints; whether routed endpoints return a cursor in live answers.
9. Assertions of most tests listed in the inventory (matched by symbol, not read), so the count of tests that would change is a lower bound.
10. Whether the legacy chunk pipeline is still reachable in production (D9 default); `RESEND_API_KEY` in the Edge Function secrets.
11. The fill rates of company phone/e-mail fields for Egyptian companies (already NOT PROVEN in `AUDIT` section 8).

No secret was seen in the files read. No paid provider call, SQL write, env read, or runtime code change was made.
