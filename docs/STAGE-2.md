# STAGE 2: understanding cards and the live sheet (FOUNDATION-PLAN section 5, "PR 4")

Branch `stage-2/understanding-and-live-sheet`, started from `main` = `239ca94`. Draft PR only. **Nothing here changes what a customer sees**: every new module is reached by tests only (`tests/stage2-isolation.test.ts` proves no production file imports a `stage2/` module), and every new behaviour is gated by a new flag that is OFF when unset.

No SQL, no migration, no new table, no paid call, no model call, no money file. One shared file changed: `agent/src/workbook.ts` (a pure move, see "Files").

---

## 1. Goal, in plain words

Before approval, the customer sees **«فهمنا طلبك»**: what we understood (platform, count, topic, source, period, country, language, order, comments, replies, budget), and can change it. A change recompiles the plan **by code** (no AI call, no new cost) when it only changes numbers; when it changes what must be read (the topic, the period...), the plan is made again. At most **three** question cards come before the plan; when the count is missing, the card is **«تحب كام؟»** with ١٠ / ٥٠ / ١٠٠ and a **budget** option, and the budget is a **hard ceiling** on the hold.

While the job runs, the customer **watches the file fill**: on a desktop a sheet that looks like the Excel file (the same sheets and columns), on a phone cards and a counter **«X من N»**, and a short **«دفتر شغل»** of what the work is doing, in Arabic, from a fixed list of sentences. The screen asks for news every few seconds (**polling**; the free Supabase plan has no Realtime). When the job ends, **the rows watched are exactly the rows of the file**.

## 2. How the foundation works today (what this stage builds on)

1. **Ask** (`src/lib/agentMission/foundation/ask.ts`, `buildAsk`): the customer's words become one typed record, by code.
2. **Tool Cards** (`foundation/toolCards/*`): one data record per provider endpoint (inputs that carry each Ask condition, list and cursor paths, mapping, counter, status `verified` / `catalog_only` / `broken`), verified on stored real pages.
3. **Compiler** (`foundation/compilePlan.ts`, `compilePlan`): pure. Stage shape from the Ask (parents, comments, replies), tool by the conditions it carries, inputs and mapping from the card, one promise type per stage (`exact` / `counter` / `open`), price by `priceMissionByCode`.
4. **Pool** (`foundation/pool.ts`): the parent pages read at planning (through the gateway, in `agent/src/compiled.ts` `planByCompiler`) are ranked in the owner's order; the exposure check swaps a parent with no readable comment.
5. **Budget** (`foundation/budgetFit.ts`, `fitToBudget`): the largest version whose hold fits the budget.
6. **Run and delivery**: the engine (`agent/src/engine/run.ts`) writes every item into the append-only item log (`agent/src/items/itemStore.ts`; first appearance of an id wins); at finalize `runMission.ts` reads each stage's first `planned_rows` accepted rows and `buildMissionFiles` (`agent/src/workbook.ts`) lays the sheets out and applies the delivery contract (R1-R4, `foundation/deliveryContract.ts`), which only completes descriptions (a mark or precision cell, a limits line).

## 3. Flags (all OFF by default)

| Flag | Values | Default | Gates |
|---|---|---|---|
| `DIGER_STAGE2_ASK_CARD` | `on` (everyone), `test` (test accounts only), anything else = off | **off** | the «فهمنا طلبك» card and its edit action |
| `DIGER_STAGE2_QUESTION_CARDS` | same | **off** | the up-to-three question cards before planning |
| `DIGER_STAGE2_LIVE_SHEET` | same | **off** | the worker writing live snapshots, the polling route, the live sheet UI |

Read with `stage2Enabled(flag, isTestAccount)` from `src/lib/agentMission/stage2/flags.ts` (test accounts: `isTestAccount` of `src/lib/server/testAccounts.ts`). No existing switch, flag or environment variable was changed, added or removed. Nothing was set in Vercel, Heroku or Supabase.

## 4. Files

**New (all isolated):**

| File | What |
|---|---|
| `src/lib/agentMission/stage2/flags.ts` | the three flags and their reader (off unless exactly `on` / `test`) |
| `src/lib/agentMission/stage2/askCard.ts` | the Ask card view, the edit contract (`AskEdit`, `parseAskEdit`, `applyAskEdit`, reason codes + fixed Arabic sentences), `editScopeOf`, `compileAsk`, `recompileWithEdit` |
| `src/lib/agentMission/stage2/questionCards.ts` | `questionCardsFor` (≤ 3, by importance), `answerQuestionCard` |
| `src/lib/agentMission/stage2/workLog.ts` | the «دفتر شغل» whitelist (`WORK_LOG_CODES`, `workLogLine`, `workLogFromEvents`) |
| `src/lib/agentMission/stage2/liveSheet.ts` | the live sheet read model types, `LIVE_SHEET_POLL`, `parsePollRequest`, `pollResponse`, `nextPollDelayMs`, `counterAr` (shared by site and worker; no I/O) |
| `agent/src/stage2/liveSnapshot.ts` | `deliveryRowsOf` and `buildLiveSnapshot` (worker side; uses the file's own layout code) |
| `tests/stage2-ask-card.test.ts`, `tests/stage2-question-cards.test.ts`, `tests/stage2-work-log.test.ts`, `tests/stage2-live-poll.test.ts`, `tests/stage2-live-equality.test.ts`, `tests/stage2-isolation.test.ts` | red-then-green tests |
| `docs/STAGE-2.md` | this file |

**Changed:**

| File | Why | Risk |
|---|---|---|
| `agent/src/workbook.ts` | The first steps of `buildMissionFiles` (reconcile parent columns, remove provider addresses, company mailboxes, threads, `layoutOf`, methodology, delivery contract) were **moved unchanged** into two exported functions, `fileLayoutsOf` and `deliveredSheetsOf`; `buildMissionFiles` now calls `deliveredSheetsOf`. This is what makes "the rows watched = the rows of the file" true **by construction**. | None in behaviour: same code, same order; the full suite (all the file and delivery tests) passes. **Likely rebase point** if another branch edits the top of `buildMissionFiles`. |

## 5. Data shapes and contracts

### 5.1 Ask card (`askCard.ts`)

```ts
askCardView(ask: Ask, poolCard?: ToolCard): AskCardView
AskCardView = { v: 1; titleAr: "فهمنا طلبك"; fields: AskCardField[] }
AskCardField = { key: AskFieldKey; labelAr; valueAr; customerWords: boolean; editable: boolean; input: AskFieldInput; scope: "recompile" | "new_read" }
AskFieldKey = platform | count | topic | source | period | country | language | order | comments | commentsPerParent | replies | repliesPerComment | budget   // fixed order
ASK_EDITABLE_FIELDS = every key except "platform" (a different platform is a new request)
AskEdit = { field: "count"; value: number } | { field: "period"; value: { from: "YYYY-MM-DD"; to: "YYYY-MM-DD" } | null } | ... (one per editable field)
parseAskEdit(raw: unknown) -> { ok: true; edit } | { ok: false; reason }        // checks the field name only
applyAskEdit(ask, edit, { nowMs }) -> { ok: true; ask } | { ok: false; reason }  // checks every value; returns a NEW Ask
editScopeOf(edit, ask, poolCard?) -> "recompile" | "new_read"
compileAsk(base, ask) -> RecompileResult                  // with a budget: fitToBudget; else compilePlan
recompileWithEdit(base, ask, edit, { nowMs }) -> { kind: "plan"; ask; result } | { kind: "new_read"; ask } | { kind: "rejected"; reason; compileReason? }
```

- Values follow the customer-text rules (Arabic, Arabic-Indic numerals, no Latin, no provider, no USD). The customer's own words (topic, a named source) are shown as typed and flagged `customerWords: true`.
- **Reason codes** (`ASK_EDIT_REJECTIONS`, each with ONE fixed Arabic sentence in `ASK_EDIT_REJECTION_AR`): `unknown_field`, `field_locked`, `not_whole_number`, `out_of_range`, `unknown_choice`, `period_reversed`, `period_in_future` (after today in Cairo), `period_bad_day`, `country_unknown`, `topic_empty`, `topic_too_long`, `source_too_long`, `comments_not_asked`, `replies_not_asked`, `not_offered` (comments on X), `budget_too_small`, `cannot_compile`.
- **Scope**: count, comments, comments per parent, replies, replies per comment, budget = `recompile` (from the pages already read, no call). Topic, source, period, country, language = `new_read` (a new planning). Order = `new_read` when the parent tool takes an order input (its pool was read in the other order), else `recompile`.
- Rules applied by code: comments «بدون» on a platform whose replies hang on comments also removes the replies; a number per parent makes comments «some» and drops a total; the platform is locked.
- Limits: count 1-5,000 (`AGENT_MAX_DELIVERED_ROWS`), comments per parent 1-5,000, replies per comment 1-50 (`AGENT_REPLIES_PER_COMMENT_MAX`), budget 1-10,000,000 points (the hold is still capped by the job cap inside `fitToBudget`), topic and source ≤ 200 characters.
- Persistence hint: `applyAskEdit` also writes `edits.count` / `edits.budget` / `edits.occurrence` so `buildAsk(..., edits)` can rebuild the same Ask.

### 5.2 Question cards (`questionCards.ts`)

```ts
questionCardsFor(ask, { requestText, alreadyAsked }) -> QuestionCard[]     // at most 3 - alreadyAsked (AGENT_MAX_QUESTIONS = 3)
QuestionCard = { code: QuestionCode; rank; questionAr; options: { value; labelAr }[]; other: boolean; budgetInput?: true; yearInput?: true }
QUESTION_CODES (importance order) = platform, count, occurrence, topic_relation, per_parent
answerQuestionCard(ask, card, { option?, budget?, year?, other? }, { nowMs }) -> { ok: true; ask } | { ok: false; reason }
```

- `count`: «تحب كام فيديو؟ ...» (the existing `COUNT_QUESTION_AR`), options `10`, `50`, `100`, `budget` (labels ١٠ / ٥٠ / ١٠٠ / «حدد ميزانية بالنقاط»), `other` = a typed number. `budget` + a whole number becomes `ask.edits.budget`; `compileAsk` then fits the plan under it (the hold never passes it; the card's first note says «... ولا يتجاوز ميزانيتك»).
- `occurrence` uses the existing decision-7 texts; a year sets the Cairo period of that year.
- `platform` sets `platform` and `parentKind` (X: the asked comments become the tweet's replies).
- A gap that is not asked keeps the compiler's default (today's behaviour).

### 5.3 Work log («دفتر شغل», `workLog.ts`)

```ts
WORK_LOG_CODES = queued, plan_approved, stage_started, page_read, items_saved, duplicates_removed, parent_replaced, next_tool, source_ended, retry_wait, stage_done, gap_stated, file_building, file_ready
WorkLogEvent = { code; at: ISO | ms; n?; total?; promised?; noun?: videos | tweets | posts | comments | replies | companies | people }
workLogLine(e) -> { code; at; timeAr ("١٠:٣٥", Cairo); textAr } | null      // null: unknown code, missing number/noun, bad time
workLogFromEvents(plan, storedEvents) -> WorkLogLine[]                      // today's `progress` events, by their NUMBERS only
```

An event's own words are never read or shown. Only these fixed sentences can reach the customer.

### 5.4 Live sheet read model and polling (`liveSheet.ts`, `agent/src/stage2/liveSnapshot.ts`)

```ts
LiveSnapshot = { v: 1; missionId; cursor; status: "running" | "done"; delivered: X; promised: N | null; counterAr: "X من N"; sheets: LiveSheet[]; workLog: WorkLogLine[]; builtAt }
LiveSheet = { stageKey; nameAr (the file's sheet name); headers (the file's headers, then «المعرّف», then «معرّف الأصل»); rows: { id; parentId; cells: LiveCell[] }[] }
LiveCell = { k: "text" | "number" | "date" | "link" | "empty"; v (exactly the file cell's value; a date: its ISO instant); d? (a date's Cairo text) }

buildLiveSnapshot({ missionId, plan (approved), snap (ItemSnapshot), status, companyMailboxes?, facts?, events?, nowMs }) -> LiveSnapshot   // worker side, pure
deliveryRowsOf(plan, snap) -> { plan; rowsByStage; repliesJudged }   // the finalize lines of runMission.ts (pinned by a test)

LIVE_SHEET_POLL = { intervalMs 5000, minIntervalMs 3000, maxIntervalMs 30000, backoffFactor 1.5, jitterShare 0.2, maxRowsPerResponse 200, defaultRowsPerResponse 50, maxCellChars 500, maxWorkLogLines 20, maxPayloadBytes 262144 }
parsePollRequest(query) -> { cursor | null; sheet | null; offset ≥ 0; limit 1..200 }
pollResponse(snapshot | null, req, delayMs?) ->
   { changed: false; cursor: null; retryAfterMs; empty: true }       // no snapshot / flag off: show today's panel
 | { changed: false; cursor; retryAfterMs }                          // same cursor
 | { changed: true; cursor; status; delivered; promised; counterAr; workLog (newest 20); sheets [{stageKey,nameAr,headers,total}]; window { stageKey; offset; rows }; truncated; retryAfterMs | null (done: stop) }
nextPollDelayMs(previousMs, changed, random?) -> 3..30 s, base 5 s, ×1.5 while unchanged, ±20 % jitter
```

- **Cursor** = `<item-log lastSeq>.<work-log lines>.<status>`: changes whenever anything shown changes.
- **Why a window, not a delta**: replies are placed under their comments in the thread sheet, and a parent swap or a filled cell can change earlier rows, so "rows after N" is not safe; the screen asks for the window it shows.
- **Payload**: ≤ 200 rows, cells cut at 500 characters in the answer only (`cut: true`; the file keeps them whole), whole answer ≤ 256 KB (the window halves until it fits).

### 5.5 Equality contract

At completion, `buildLiveSnapshot(status: "done")` equals the file `buildMissionFiles` writes: the same sheet names in order, the same headers, the same row ids in the same order, the same parent ids, and the same value in every cell (dates compared as instants). Same source (the item log), same order (log order), same de-duplication (the log keeps the first appearance of an id), same cap (`planned_rows` after `withPromiseCaps`), same layout and contract completion (`deliveredSheetsOf`).

## 6. Acceptance tests (all on stored real fixtures, anonymised, already in the repo)

| Test | Fixture | Proves |
|---|---|---|
| `stage2-ask-card.test.ts` | M12 `msn_5851abc92a1e6645a9cd` `raw/call_0007.json`, `raw/call_0008.json`; request texts of M14 `msn_b060d3347ed7660f972e`, M17 `msn_6bb78c15d116268b0b9b`, M16 `msn_e3e7632e2fb2d42f9c19`, M20 `msn_adcfafabcdebc27ff803` (`replay-missions.json`) | flags off when unset; view fields and Arabic; 17 invalid edits refused with their codes; count 2→1 changes the compiled plan (videos 2→1, comments 2251→1167, replies 1801→934, smaller hold) deterministically; 5 per video → comments 10; budget 250 → hold ≤ 250; budget 50 → `budget_too_small`; every budget 200..3000 → hold ≤ budget; a topic edit is `new_read` |
| `stage2-question-cards.test.ts` | M12 pages; the 20 stored request texts | never more than 3 (and never more than 3 − asked); order platform → count → occurrence → topic relation → per parent; «تحب كام؟» options; budget 400 → plan hold ≤ 400 on M12 pages |
| `stage2-work-log.test.ts` | the TREG catalog snapshot (provider names) | every code renders; unknown/incomplete events give nothing; no provider name, endpoint, USD, model vendor or Latin letter in any line |
| `stage2-live-poll.test.ts` | synthetic snapshots | request clamps, unchanged answer, window, cut cells, 256 KB limit, interval bounds |
| `stage2-live-equality.test.ts` | M12 (planning on stored pages by `replayGateway`, rows `rows/videos.json` 2, `rows/comments.json` 300, `rows/comments_replies.json` 67); `msn_97cdab58dc82fc2039ed` rows (posts 2, comments 30, replies 9) planned on M16 pages; M14 `raw/call_0003.json` and `rows/tweets.json` (20) | full cell-by-cell equality live = file at completion, with exact duplicates and left-out items injected in the log; mid-run rows are a subset of the final rows in the same order; counter never goes down; cursor stable/changes; a pin on the finalize lines of `runMission.ts` |
| `stage2-isolation.test.ts` | repo sources | no production file imports a `stage2/` module |

## 7. Done by Opus (this branch)

1. Ask view/edit contract, validation with reason codes, deterministic recompile through the existing compiler, budget as a hard ceiling.
2. Question-card policy (≤ 3, ordered) and answers by code.
3. Live sheet read model, polling contract, worker-side builder using the file's own code.
4. Work-log whitelist and the mapper from today's progress events.
5. Equality contract test on three stored real missions.
6. `workbook.ts` pure move (`fileLayoutsOf`, `deliveredSheetsOf`).

## 8. Left for Sonnet (step by step)

Do these in order, one small commit each, every new screen string checked by `checkCustomerText` / `checkCustomerLabel` in a test. Never show a provider, endpoint, USD or model name.

**S1. The FOUNDATION-PLAN "first commit pair" of PR 4 is NOT done here.** It (FB/IG/YT joining the PR 2b skip list and deleting social-only pass code) needs PR 3 live and benchmarks 1, 2, 4 passed in `test` mode, and the strong model. Do not do it in the Sonnet session; leave it for a strong-model session.

**S2. Ask edits reach the planning (worker).**
1. In `agent/src/compiled.ts`, add an optional `askEdits?: AskEdit[]` to `CompiledPlanningDeps`. Right after the `choices`/`budget` lines of `planInner` (after `if (budget !== undefined) ask = ...`), apply them in order: `for (const e of deps.askEdits ?? []) { const r = applyAskEdit(ask, e, { nowMs: deps.nowMs }); if (r.ok) ask = r.ask; }`. When `askEdits` is absent nothing changes.
2. Update `tests/stage2-isolation.test.ts`: allow exactly `agent/src/compiled.ts` as an importer of `stage2/askCard`.
3. Store the customer's accepted edits as the immutable object `ask_edits/<n>.json` in the mission's storage folder (`AGENT_BUCKET`, create-only `putNew`, like the item log; **no new column, no migration**). The worker reads them (list then download) when it plans a mission and passes them as `askEdits`.
4. Test (replay, no paid call): `planByCompiler` on `replayGateway("msn_5851abc92a1e6645a9cd", ...)` with the stored M12 request and `askEdits: [{ field: "count", value: 1 }]` gives one video; run it after a first planning with `priorCalls` set to the first run's calls and assert the gateway made **no new call** (the re-plan is served from the saved pages).

**S3. The edit action (site).**
1. In `src/app/api/missions/[id]/route.ts` POST (not a locked file), add an action `ask_edit` with body `{ action: "ask_edit", edit: { field, value } }`. If `stage2Enabled("DIGER_STAGE2_ASK_CARD", isTestAccount(user))` is false, answer 404 `{ error: "not_found" }`.
2. Validate with `parseAskEdit` then `applyAskEdit` on the Ask rebuilt from the mission (`buildAsk(request_text, answer_text, created_at, edits)`); on refusal answer 400 with `{ reason }` (the screen shows `ASK_EDIT_REJECTION_AR[reason]`). Only for a mission in status `plan` (before approval); never touch a hold.
3. On success write `ask_edits/<n>.json` and send the mission back to planning the same way an answer to a question does today (`answerForCustomer` path in `customerActions.ts`); the worker re-plans with S2. The price shown is the new plan's, computed by code.

**S4. The «فهمنا طلبك» card UI.** New component `src/components/mission/AskCard.tsx`, props `{ view: AskCardView; busy: boolean; onEdit: (edit: AskEdit) => void; errorReason: AskEditRejection | null }`. One row per field (label, value; an «تعديل» button when `editable`); the editor by `input.kind` (`number`: a whole-number input with min/max; `choice`: buttons from `options`; `period`: two date inputs, Cairo days; `text`: a text input with `maxChars`). Show `customerWords` values in quotes «...». A field whose `scope` is `new_read` shows «سنقرأ النتائج من جديد بعد هذا التعديل» under the editor. Refusals show `ASK_EDIT_REJECTION_AR[reason]`. Render it in `AgentMissionCardBody` (phase `plan`) only when the mission answer carries `askCard` (added by `customerView`/`loadCustomerMission` when the flag is on for the viewer: `askCardView(buildAsk(...))`). Tests: a render test (like `tests/plan-card-states.test.tsx`) and a text scan of every label.

**S5. Question cards UI.** In the worker, when `DIGER_STAGE2_QUESTION_CARDS` is on for the account, replace the single `questionNeeded` call of `planInner` by `questionCardsFor(ask, { requestText, alreadyAsked: deps.questionsAsked ?? 0 })` and ask the first card (its `questionAr` and option labels), keeping today's question flow (one card on screen at a time is fine; the other cards come after the answer). The budget option opens a number input; send `{ option: "budget", budget }`; the year option opens a year input. Map answers with `answerQuestionCard`. Flag off: today's `questionNeeded` stays. Test with `replayGateway` that a budget answer gives a plan whose `price.reservePoints` ≤ the budget.

**S6. Live snapshots (worker).** When `DIGER_STAGE2_LIVE_SHEET` is on for the mission's account: after each item-log commit of the engine (throttle: at most one snapshot per 5 seconds per mission, plus one at `done`), build `buildLiveSnapshot({ missionId, plan, snap: items.snapshotOfMemory(), status, companyMailboxes: companyMailboxesOf(plan, snap), events, nowMs })` and store it create-only as `live/snap_<lastSeq padded 9>_<writer>.json` (never overwrite: the CDN-staleness rule of `itemStore.ts`). At finalize, write the `done` snapshot with `facts: missionFactsOf(...)` right after the file is built. A failure to write a snapshot is logged and ignored (never fails a run). Test: a run on `createMemoryStore` writes snapshots and the last equals the file (reuse `tests/stage2-live-equality.test.ts` helpers).

**S7. Polling route (site).** New file `src/app/api/missions/[id]/live/route.ts` (GET; not a chat or download route). `resolveMissionViewer` + the same ownership check as `src/app/api/missions/[id]/route.ts`; flag off for the viewer → 404. List `live/` in the mission folder (newest name), download it, `pollResponse(snapshot, parsePollRequest(req.nextUrl.searchParams))`, `Cache-Control: no-store`. Tests: 404 with the flag off; owner only; unchanged cursor answer is small.

**S8. Polling hook.** New `src/hooks/useLiveSheet.ts`: like `startMissionPolling` (`src/lib/missionPoller.ts`): read `/api/missions/<id>/live?cursor=..&sheet=..&offset=..&limit=..`, wait `nextPollDelayMs(prev, changed)`, pause while the tab is hidden, stop when `retryAfterMs` is null (done) or the answer is `empty` three times in a row.

**S9. Desktop grid.** New `src/components/mission/LiveSheetGrid.tsx`: tabs = `sheets[].nameAr`; header row = `headers`; right-to-left; frozen header; cells by `k` (`date`: show `d`; `link`: an `<a>`; `number`: `toArabicDigits(v)` for display only); pages of 50 by `offset`. «م» numbering follows the file's own columns, do not add one.

**S10. Mobile cards and counter.** New `src/components/mission/LiveSheetCards.tsx` (≤ 640 px): the counter `counterAr` («X من N») on top, then one card per row (the first three non-empty cells with their headers), «عرض المزيد» loads the next window. Then `LiveWorkLog.tsx`: the newest lines `timeAr` + `textAr`. Show all three inside `AgentMissionCardBody` while the phase is live, on `src/app/dashboard/requests/[id]/page.tsx` first.

**S11. Wording review (Arabic)** of every fixed sentence in `askCard.ts`, `questionCards.ts`, `workLog.ts` (e.g. `deliveredOfAr` gives «٤٠ من ١٠٠ تعليقًا» and «فيديوهين من فيديوهين»: a shared function, change it only with its own tests). Keep the tests green.

## 9. Needs change in a locked file (not done here)

- **Chat page routing** (`src/app/dashboard/chat/page.tsx` and its routing): showing the Ask card, the question cards and the live sheet inside the chat needs the chat page to render the new components when the flags are on. Until the other session releases it, wire them on `src/app/dashboard/requests/[id]/page.tsx` only (S10).
- **`src/app/api/chat/route.ts` / `src/functions/shared/chatHandler.ts`**: if the chat turn should start the Ask card instead of today's plan card, the chat handler must pass the mission's `askCard`. Not needed for the requests page.
- **`ResultsCanvas.tsx`**: not touched. If the finished live sheet should hand over to the results view, the hand-over belongs there (later).
- Download routes: not touched. The equality contract is with the file `buildMissionFiles` builds, which those routes serve.

## 10. Open decisions for the owner

1. **Where the live sheet is shown first**: the requests page only (recommended, the chat page is locked) or wait for the chat page.
2. **Snapshot storage cost**: one small JSON object every ≤ 5 s per running mission in the mission's folder (create-only). Recommended; alternative: build on demand in the route (needs the worker's item log in the site, heavier).
3. **Edits after a `new_read` edit**: a new planning reads pages again through the gateway (planning cost, small). Recommended: allow, with the line «سنقرأ النتائج من جديد بعد هذا التعديل».
4. **Question cards: one at a time or all three on one screen** (the policy returns up to three; today's flow asks one). Recommended: one at a time (same flow as today).
5. **Budget upper bound** typed by a customer (10,000,000 points here; the hold is still capped by the job cap).

## 11. Verified facts vs assumptions

- Verified by tests in this branch: everything in section 6.
- Assumption: the polling load (one request every 5-30 s per open card) fits Vercel's free limits. Not measured.
- Assumption: writing a snapshot every 5 s does not slow the engine noticeably (pure fold + one upload). Not measured.
