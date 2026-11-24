# DT-20261124-account-early-stop: Eliminate 21-Row Early Stop & Enable Timeline Cursor Continuity

- **Task ID:** `DT-20261124-account-early-stop`
- **Implementer:** هجرس (`FAWAALY`)
- **Base Commit:** `origin/main` (`c1c08999`, PR #670 merged)
- **Branch:** `team/DT-20261124-account-early-stop`
- **Scope:** 3 code files + 1 doc file (Tier B LLM layer & cursor continuity only, 0 Tier A money files touched)

---

## 1. Problem & Root Cause Analysis

During the 5x live full-flow replay of PR #670 (`msn_c41586cf9d40986250d0`), Runs 1, 2, and 5 scanned 79–98 rows across 4 timeline pages and found on-topic match `2111754500776030669`. In contrast, Runs 3 and 4 stopped after examining 21 rows (`1 + 20`) and reported `found: 0`.

Three interacting root causes on `origin/main` (`c1c08999`) produced this early stop:

1. **Prompt Contradiction in `TOOL_CHOICE_SYSTEM` (`prompts.ts`):**
   - Line 110 instructed the model to put the account timeline endpoint first for an exhaustive date-bounded scan.
   - Line 111 immediately contradicted this by telling the model to prefer a tool carrying all step conditions (e.g. search with query containing handle and topic) over a listing tool dropping `"topic"`.
   - The model non-deterministically flipped between placing paginated account listing first (Runs 1, 2, 5) and search first (Runs 3, 4).

2. **Planner Discarded Pagination State on `second` (`planner.ts`):**
   - When search was `options[0]` (`got`), it returned 1 off-topic row with `hasMore: false` and `nextCursor: null`.
   - The planner then probed `options[1]` (`second`, the account timeline), which returned 20 rows on page 1 with `hasMore: true` and a valid `nextCursor`.
   - However, `BuiltStep["second"]` discarded `hasMore`, `nextCursor`, and `callIds`.
   - `shouldProbeCursor` only checked `got.hasMore && (got.nextCursor || cursorKey)`. Because `got` was exhausted after 1 row, cursor scanning was completely bypassed.
   - Page 1 of `second` contained 0 on-topic items (the matching tweets were on pages 2–3), so the planner stopped at 21 rows with `found: 0`.

3. **Failed/Empty Probes Starved Timeline Cursor Cap (`planner.ts`):**
   - `got.callIds.length` in `probeStep` counted failed or empty candidate calls before the successful endpoint.
   - The cursor loop checked `got.callIds.length >= maxCallsForStep`, prematurely ending the timeline scan after 1–2 pages instead of allowing the full 4 pages of the active endpoint.

---

## 2. Changes Made

1. **`agent/src/llmPlanner/prompts.ts` (Phase P01):**
   - Harmonized `TOOL_CHOICE_SYSTEM` lines 110–111: for steps specifying a named source and topic, the model is instructed to always put the source's own paginated listing capability first (`options[0]`, listing `"topic"` in `conditions_not_carried` for post-fetch judging), supplemented by search tools in `options[1..]`.
   - The general preference for tools carrying all conditions explicitly excludes the named source + topic case.

2. **`agent/src/llmPlanner/planner.ts` (Phase P02):**
   - Added `pagesRead?: number` to `BuiltStep`.
   - Extended `BuiltStep["second"]` and `BuiltStep["alternates"]` to retain `hasMore`, `nextCursor`, `callIds`, and `rowsPerPage`.
   - In `probeStep` when building `second`/`alternates` entry, preserved `got2.hasMore`, `got2.nextCursor`, `[...got2.callIds]`, and `rows2.length`.
   - In the primary cursor loop, replaced the cap check with `(cursorPagesProbed + 1) >= maxCallsForStep` and set `builtStep.pagesRead = 1 + cursorPagesProbed`.
   - After judging `secondRows` (page 1 of `second`), if `sampleRows.length < pagingThreshold` and `second.hasMore && second.nextCursor`, the planner follows `second`'s pagination cursor for up to 4 pages of `second`, applying chronological cutoff (`shouldStopChronologicalScan`), terminal/repeated cursor guards, and `judgeSampleRows` on each page.
   - Promoted `second` to primary on `builtStep` when `primaryWasEmpty` and `second` was scanned or found matches.
   - Updated `canAskShortfallQuestion` to use `b?.pagesRead ?? 1`.

3. **`tests/x-account-rumors-replay.test.ts` (Phase P03):**
   - Added `describe("DT-20261124-account-early-stop: ...")`:
     - **Must-Pass 1 (Runs 3 & 4 Replay):** Search first returning 1 off-topic row (`hasMore: false`), timeline second returning 20 off-topic rows on page 1 (`hasMore: true`). Planner follows cursor across pages 2–4 (examining 79 rows total) and finds match `2111754500776030669` on page 3.
     - **Must-Pass 2:** Earlier empty/failed probes in `probeStep` do not starve the 4-page timeline cursor scan.
     - **Counter-Cases:** Truly empty account stops after initial probe; single-page account makes 0 extra cursor calls; repeated cursor stops immediately on page 2.

---

## 3. Verification & Evidence

- `npm run agent:typecheck && npx tsc --noEmit`: 0 errors.
- `npx vitest run tests/x-account-rumors-replay.test.ts tests/retrieval-state-machine.test.ts tests/design-guards.test.ts`: 100% pass.
- Full suite `npx vitest run`: all tests passing.
- Strictly 3 code files changed + 1 doc file (`<= 5` files limit). Zero Tier A money files touched.
