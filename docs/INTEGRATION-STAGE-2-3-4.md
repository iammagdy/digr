# INTEGRATION READINESS: Stage 2 (#369) + Stage 3 (#370) + Stage 4 (#371 to #404) on `main` `0728e06f`

## ROUND 4 (5 Nov 2026): F-2 closed (#409), Round 37 fixtures searched, final validation (branch `integration/rehearsal-r4-main-0728e06f`, never a PR)

This branch is the round-3 rehearsal plus **#409** (`878b887d`: one progress counter on a phone, stacked on #408). #409 is based on the Stage 2 base, where the card still has its older progress line; main's Round 26 card carries the same competing total inside its status sentence («نجمع العناصر (١٤ من ٤٢)»), so merging conflicts in `AgentMissionCard.tsx` (2 hunks). **Resolution in this tree** (the merge-time edit the owner repeats): main's props (`pendingText`, `quietSinceMs`, `nowMs`) and signature are kept, plus `live`/`onData`; the older progress-line span of #409 is dropped (main's card has none); the rule is applied to main's sentence by `phoneCollectLine` (`stage2/singleCounter.ts`): on a phone with live progress the sentence is shown without its «(X من N)», and «جمعنا العناصر، ونجهّز ملفك الآن» is kept only once the live snapshot is complete (done, or delivered reached promised), else «نجمع العناصر»; the desktop keeps the full sentence. #409's golden (`tests/fixtures/stage2-card-flags-off.json`) was regenerated from main's card without the change (flag off = main's markup byte for byte) and its two progress-line tests were rebased on the sentence; three tests pin `phoneCollectLine` against main's real `collectLineOf`.

**Round 37 fixtures (task B).** The three files (`delivered.csv`, `methodology.csv`, `delivered-saved-by-excel-android.xlsx`, sha256 in `tests/fixtures/round37/README.md`) were searched by **content hash** in every locally authorized artifact: 122 csv/xlsx/zip files on the local disk (outside `node_modules`, `.next`, `.git`) and all 15 csv/xlsx blobs reachable from any ref of the clone: **no match**, and no path in any branch is named like them. No live customer data or production storage was queried. **Not resolved**: PR #407 only removes the `.gitignore` trap. The test stays «cannot load» until the owner supplies the three files (copy from the device that saved them, check the hashes, look at them, commit). Option needing a separate authorization (NOT done): the stored `result/result.csv` of the mission is described as identical in size (6,247 bytes) to `delivered.csv`, but the delivered XLSX was re-saved by Excel for Android (16,140 bytes against the stored 13,418), so the stored files cannot replace it.

**Results of this tree** (head before this paragraph: `dbc8433f`):

| Gate | Result |
|---|---|
| `tsc --noEmit` (site), `npm run agent:typecheck` (worker) | clean |
| `next build` + client-bundle secret scan (206 files) | pass, zero secrets |
| full suite, two shards | **11,897 tests passed, 0 failed, 57 skipped** (shard 1: 5,922 / 27; shard 2: 5,975 / 30) |
| test FILES | 911 passed, 5 skipped, **1 could not load**: `tests/round37-real-reels-excel-acceptance.test.ts` (`ENOENT delivered.csv`), counted separately and NOT a pass |
| real Chromium, 390 px (iPhone user agent) and 1280 px, locally running app with a dummy configuration and fake API answers made by the repo's own planner, snapshot builder, poll contract and customer view from stored real rows | F-2 journey **29 of 29** (loading, progress 1 and 2, over-delivery, exact, unknown total, refresh, failed polls, completed, flag off); full customer journey **33 of 33**; counter journey **23 of 23** |

The suite is **not** described as fully passing: one test file cannot load. Not verified: a real mission on a test account; Heroku (no access); an authenticated Vercel preview session; a physical phone; production.

## ROUND 3 (5 Nov 2026): fresh rehearsal on the CURRENT main `0728e06f7965fba5fee3b76fcfe6212b2c9fed11`

The first rehearsal (round 2) was built on `9b478568` and later merged with `0728e06f`. This is a **new** merge from scratch on `0728e06f` (branch `integration/rehearsal-r3-main-0728e06f`, never a PR, never for merge), in this order: #369 (`74dbff2b`), #406 + #408 (`f45ea5df`), #370 (`36adf28e`), the Stage 4 stack ending #404 (`3575d5fe`), #407 (`ef086d17`). Conflicts reproduced exactly (same files, same rules), and each resolution was checked by diffing the resulting tree against the round-2 merge commit: the only differences are main's Round 38 (9 files, merged cleanly into all of them, `customerView.ts` carries its `export` line next to Stage 3's import) and the two new PRs.

| Step | Conflicting files | Round 38 touched them? |
|---|---|---|
| main <- #369 | `compiled.ts`, `runMission.ts`, `runState.ts`, `AgentMissionCard.tsx`, requests `[id]/page.tsx` | no: round-2 union reused and verified |
| + #408 (+#406) | none | n/a |
| + #370 | `agent/src/workbook.ts` (round-2 union), `customerView.ts` (both imports, by hand) | `customerView.ts` yes (one line): kept |
| + #404 (Stage 4 stack) | `file/route.ts`, `customerActions.ts`, `methodology/missions.ts`, `openMissions.ts`, `adminActions.ts`, requests `[id]/page.tsx` | no: round-2 union reused and verified |
| + #407 | none | n/a |

New in round 3: **#407** (main's red test: `.gitignore` exception for the three Round 37 fixtures; the files themselves are not in any branch and were not recreated: **owner action**) and **#408** (finding F-1: the live counter says in words when the delivery is above the plan's number; stacked on #406).

**F-2 measured (not fixed).** On the stored real rows of M12, at the same moment, the phone card's own progress line says «١٤ من ٤٢ عنصرًا» and the live counter below it says «١٤ من ٧٠»: the card (`customerView.ts`, `planned` = the sum of the delivering stages' rows) does not count the replies' estimate, the live counter and the Excel (`promisedTotalOf`) do. The Excel at completion says 70. This predates Stage 2 (the card's header and the Excel already differed on main); Stage 2 only puts a second number beside it. Not changed: it is main's shared card code and the choice of the one denominator is the owner's (options: the card's progress line uses `promisedTotalOf`; or the line is hidden while the live counter is shown).

**Results of the fresh tree (head before this document: `7ec5cc79`).**

| Gate | Result |
|---|---|
| clean `npm ci` (site 368 packages, worker 106) | pass |
| `tsc --noEmit` (site), `npm run agent:typecheck` (worker) | clean |
| `next build` + client-bundle secret scan (206 files) | pass, zero secrets |
| full suite, two shards | **11,878 tests passed, 0 failed, 57 skipped** (shard 1: 5,903 / 27; shard 2: 5,975 / 30); test FILES: 910 passed, 5 skipped, **1 file cannot load** (the skipped count, 57, is the same as in round 2; this round added no skip) |
| the file that cannot load | `tests/round37-real-reels-excel-acceptance.test.ts`: `ENOENT tests/fixtures/round37/delivered.csv` (fails identically on plain main; #407 removes the `.gitignore` trap, the owner must supply the three real files) |
| `tests/integration-stage2-3-4-flags.test.ts` (7) | pass |
| real Chromium on the integrated tree, desktop 1280 + phone 390 (iPhone user agent, locally running app with a dummy configuration, fake API answers made by the repo's own planner, snapshot builder, poll contract and `buildMissionFiles` from stored real rows) | full customer journey **33 of 33** (round 2: 32 of 33; the failure was F-1); counter journey **23 of 23** |
| money files vs main (`price`, `lifecycle`, `approval`, `missionPricing`, `jobPointsCap`, `src/functions`, `gateway`, `callBudget`) | empty diff |
| `supabase/` vs main | only the prepared, unapplied migration `20261104222136_one_open_addon_per_file.sql` |
| real migration history (read-only list, 5 Nov 2026) | newest applied `20261017184147`: the migration is NOT applied |
| approval route | no site route imports `approvalGuard`, `addonSettlement` approval or `addonRecovery`: UNWIRED |

Not verified: a real mission on a test account; Heroku (no access: the worker revision and any live run); an authenticated Vercel preview session; a physical phone; production.

(The sections below are the round-2 text; where they say `9b478568` read `0728e06f`.)

**This branch is a REHEARSAL. It is not a PR, not for merge, and was never deployed to production.** It is the tree obtained by merging the three independent workstreams into `main` `9b478568069bcc0c9052a8da6635c0f5f6f010ad`, in the order below, with every conflict resolved locally. No existing PR branch was changed or rebased. No migration was applied, no flag set, no provider or payment touched.

## 1. What was combined (all SHAs re-verified on GitHub on 5 Nov 2026)

| PR | Branch | Head | Based on |
|---|---|---|---|
| #369 Stage 2 | `stage-2/understanding-and-live-sheet` | `74dbff2b` | main `62959fbf` |
| #370 Stage 3 | `stage-3/companies-and-queue` | `36adf28e` | main `42d58e72` |
| #371 .. #400 .. #404 Stage 4 + safety | chain ending `safety/e-worker-hold-recovery` | `3575d5fe` | main `0bf7b2cf` |
| #406 compat (new) | `compat/stage2-refuse-addon-rows` (base: #369's branch) | `3ec64480` | #369 |

Stage 2, 3 and 4 are **siblings**, each branched from main (the Stage 3 branch does not contain `docs/STAGE-2.md`): none depends on another. They meet only in shared files.

## 2. Merge steps and exact conflicts (this tree)

| Step | Merge | Conflicting files | Resolution | Owner PR |
|---|---|---|---|---|
| 1 | main <- #369 | `agent/src/runState.ts` (3 hunks), `agent/src/compiled.ts`, `agent/src/runMission.ts` (2), `src/components/mission/AgentMissionCard.tsx` (3), `src/app/dashboard/requests/[id]/page.tsx` | **Unions.** `RunState` keeps main's Rounds 25/30/31 fields (`platformAnswer`, `instagramAccount`, `youtubeChannel`...) AND Stage 2's `stage2Pending`/`topicRelation`; `why` adds `"topic_relation"` to main's list; the planning keeps main's Instagram/YouTube answer handling and discovery (Round 33/34) AND Stage 2's question cards and ask edits in ONE `planByCompiler` call; the card keeps main's Round 26 quiet-clock props AND Stage 2's `askCard`/`onAskEdit`/live panel; main's «جارٍ» spelling is kept | **#369** |
| 2 | + #370 | `agent/src/workbook.ts` (2), `src/lib/agentMission/customerView.ts` | `workbook.ts`: Stage 2 moved the head of `buildMissionFiles` into `deliveredSheetsOf`; Stage 3's `extraLimitLines` option joins the new signature and is applied right after `deliveredSheetsOf` returns (same order as before). `customerView.ts`: both imports | **#369 / #370** (second to merge) |
| 3 | + #404 (whole Stage 4 stack) | `src/app/api/missions/[id]/file/route.ts` (2), `src/lib/agentMission/customerActions.ts` (2), `methodology/missions.ts` (2), `openMissions.ts`, `adminActions.ts`, `src/app/dashboard/requests/[id]/page.tsx` | file route: main's CSV branch AND the stack's `?version=N` branch (version first, Excel only); `customerActions`: both imports; `loadCustomerMission` keeps Stage 3's queue columns AND Stage 4's add-on refusal; `methodology/missions`: main's title imports, `updated_at` AND the marker column; `openMissions`: the marker filter is applied to main's new `ownRunning` query too (an executing add-on is not a research request ahead of the customer's own); `adminActions`: main's Round 34 `setSocialDiscovery` AND the stack's marker columns; requests page: Stage 2's `stage2` prop AND every Stage 4 panel | file route **#381**; the rest **#388**; the page blocks **#371/#384/#389/#390/#391** |

All resolutions are unions. **No feature was deleted to hide a conflict.**

## 3. Merge-time edits that no existing branch can carry alone

| Where | What | Why it cannot be made on the PR itself |
|---|---|---|
| `tests/fixtures/stage3-flags-off.json` (#370) | the three `file` digests become `70a763c1b7ba7d09`, `7fb553063d5674a9`, `16ac2fc8b686f485` (plan, rows and status digests are unchanged) | main's Round 37 changed the Excel title and methodology wording. **Proved:** the same test copied onto PLAIN main (no Stage 2/3/4 code) gives exactly these digests; the integrated tree gives the same. Changing them on #370 would break #370 on its own base |
| `tests/stage4-e2e-resilience.test.ts` FLOW 10 (#394) | a CSV asked by name is now built from the Excel and returned as the file: one signed link, `content-type` csv | main's Round 32 |
| (pre-existing on main) `tests/round37-real-reels-excel-acceptance.test.ts` | cannot load: its fixtures `tests/fixtures/round37/delivered.csv` and `methodology.csv` are matched by `.gitignore` rule `/tests/**/*.csv` and were never committed | **fails identically on plain main `9b478568`**; not caused by any stage. Needs the owner's real files committed (with a `.gitignore` exception) or the test removed |

## 4. Compatibility defect found and fixed in a separate draft PR (#406)

Stage 2's `ask_edit` action, Ask-card loader and live-sheet route read the customer's `missions` row with no add-on check. A Stage 4 review/edit request is a `plan_ready` row of the same customer, so with `DIGER_STAGE2_ASK_CARD` on, `ask_edit` on its id answered **200 and sent it back to `queued`, into the research planner** (reproduced). #406 makes an add-on row «not found» at the three sites. Found by `tests/money7e-isolation.test.ts` in the combined tree.

## 5. Result in this tree

| Gate | Result |
|---|---|
| clean `npm ci` site + worker, `tsc --noEmit`, `agent:typecheck`, `next build`, client-bundle secret scan | pass |
| full suite (two shards) | **11,865 passed, 0 failed, 57 skipped** (on main `0728e06f`: Round 38 / #405 landed during the round and merged with no conflict; the Stage 3 digests were unaffected); one FILE cannot load (round37, pre-existing on main, section 3) |
| `tests/integration-stage2-3-4-flags.test.ts` (new, 7) | the same companies mission under all-OFF, Stage 2 ON, Stage 4 ON, Stage 3 ON and all ON: money identical (one reserve, one release, at most one charge, never above the hold), file identical with Stage 2/4 ON, live DONE snapshot = file cell by cell, version 1 = the file's sheets, nothing written for a flag that is off, no add-on objects |
| real browser (Chromium via Playwright) on the locally running app, API answers produced by the repo's own planner, snapshot builder, poll contract and `buildMissionFiles` from stored real rows: desktop 1280 px and phone 390 px | 32 of 33 checks pass (table in the report); the one failure is finding F-1 |

## 6. Findings that need an owner decision (nothing was changed for them)

- **F-1 (Stage 2, wording).** When delivered rows exceed the plan's number, the Excel says it in words («تم تسليم ١٠٩ عناصر (أكثر من ٧٠ عنصرًا المحسوبة في الخطة، لأن المصدر أعطى ردودًا زيادة)») but the live counter shows only «١٠٩ من ٧٠», which reads as a contradiction. The numbers agree (same function, `promisedTotalOf`). Option: show only the delivered count (or add the file's wording) when delivered > promised.
- **F-2.** On a phone the card's own progress header and the live counter can use different bases while the run is on; not measurable without a real run on a test account.
- **F-3.** On a desktop the live panel shows no «X من N» counter (only the page line and sheet tabs); this is the Stage 2 design (the counter is a phone element), recorded so it is not mistaken for a bug.

## 7. Recommended merge sequence (when the owner approves)

0. **Fix main's red file first:** commit the Round 37 fixtures (or remove the test), so every later run is green.
1. **#369 (Stage 2)** with **#406** merged into it first; rebase onto main and resolve the five files of step 1 once. Flags OFF, no money.
2. **#370 (Stage 3)** onto main + Stage 2; resolve `workbook.ts` and `customerView.ts`; re-record the three Stage 3 digests (section 3). Flags OFF, no money.
3. **The Stage 4 chain last**, bottom to top: #371 <- #378 <- #381 <- #384 <- #386 <- #388 <- #389 <- #390 <- #391 <- #392 <- #393 <- #394 <- #396 <- #397 <- #398 <- #400 <- #404. Resolve the conflicts of step 3 once at #371/#381/#388 and fix FLOW 10 at #394. **Do not merge #378 and its descendants before the owner decisions below.**
4. The Stage 2/3 flags may be turned on one at a time on a TEST account after step 2 (rollback: unset). The Stage 4 flags stay OFF.

## 8. BLOCKED FOR OWNER APPROVAL (not done, not to be done by this round)

The approval route (`approveAddonOnce` has no caller outside tests); applying `20261104222136_one_open_addon_per_file.sql` (read-only check of the real migration history on 5 Nov 2026: **not applied**, newest applied is `20261017184147`); edits in protected money code; deploying the worker; any Stage 4 flag; the live check on a test account with real money movement.
