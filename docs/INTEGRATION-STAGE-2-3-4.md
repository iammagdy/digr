# INTEGRATION READINESS: Stage 2 (#369) + Stage 3 (#370) + Stage 4 (#371 to #404) on `main` `9b478568`, then `0728e06f`, then `0728e06f`

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
