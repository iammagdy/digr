# INTEGRATION READINESS: Stage 2 (#369) + Stage 3 (#370) + Stage 4 (#371 to #404) on `main` `0728e06f`

## FINAL RELEASE RUN (5 Nov 2026): what was merged, in which order, with which evidence, and the conflict audit

**Merge order and exact SHAs (all by GitHub PR, no direct push to `main`, no force-push):** #420 (E-37a exception) `5174a542` → #419 (trusted e-mail verification) `35aee90a` → #416 (Stage 2) `9796a07d` → #417 (Stage 3) `05dc7f47` → #418 (Stage 4, this PR; includes #421 financial clean-refusal fix and #422 test-account gate). Each stack PR was re-based by merging the CURRENT `main` into it and re-validated; none was merged on a stale base. The final `main` merge SHA of #418 is recorded in the release report and in `docs/launch/PRODUCTION-GATES-2026-11-05.md` §7.

**Gates on the integrated tree (#418 head before the docs/harness commits `4660c2fd`):** `tsc` site + worker clean; full suite (2 workers, warm) **923 files passed, 5 skipped; 12,066 tests passed, 0 failed, 65 skipped** (including the 8 named E-37 known-gap checks); `next build` exit 0; client-bundle secret scan zero; real Chromium desktop 1280 + phone 390 **32/32** on fake money (`docs/launch/BROWSER-JOURNEY.md`). The first run in a FRESH worktree fails two timing-sensitive tests (`company-research-fallback-and-error-codes` expects < 1000 ms; `mission-estimate` 429 test cold-imports with `vi.resetModules()`); both pass in isolation (144 ms / 250 ms) and in every warm full run; they were not changed.

**PR1 / Boost audit.** `#347` (FOUNDATION PR 1) and PR 2a/2b are fully merged (`ccr-05abe766-375qtc-pr1/-pr2a/-pr2b-fix` are 0 commits ahead of main); the only other Boost branch (`ccr-05abe766-375qtc`, PR #346) changes one docs file (`docs/FOUNDATION-PLAN.md`) and overlaps none of the 352 files this integration changes. `src/app/api/admin/agent/raw-zip/route.ts`, `src/lib/agentMission/rawZip.ts` and `tests/admin-raw-zip.test.ts` are byte-identical to main; `src/app/admin/agent/page.tsx` differs only by the add-on label (the ZIP control is untouched). `tests/admin-raw-zip.test.ts` and `tests/admin-export-zip.test.ts` pass in the integrated tree (the PR1 admin ZIP export and its guards). Rounds 32–38 (CSV from Excel, layout, Reels, requested fields, Round 37 title/methodology, relative dates) are all main code the integration merged INTO; their tests run in the 12,066.

**Conflict audit (existing main behaviour / incoming behaviour / resolution / regression test proving both survive).** All resolutions are unions; no side was chosen mechanically (details of each hunk in the round-2/3 tables below). Verified again in the final tree by the named tests:

| File | main (kept) | incoming (kept) | Regression tests that run green |
|---|---|---|---|
| `agent/src/runState.ts`, `agent/src/compiled.ts`, `agent/src/runMission.ts` | Round 25/30/31/33/34 platform answers, Instagram/YouTube discovery | Stage 2 pending/topic-relation, question cards, ask edits; Stage 3 companies plan | `tests/integration-stage2-3-4-flags.test.ts` (same mission under all-OFF, Stage 2/3/4 ON, all ON: money identical, file identical, live DONE = file cell by cell), `tests/stage3-flags-off.test.ts`, the Round 18–36 planning replays |
| `src/components/mission/AgentMissionCard.tsx`, `src/app/dashboard/requests/[id]/page.tsx` | Round 26 quiet clock, «جارٍ» spelling | Stage 2 ask card / live panel, F-1 / F-2 counter wording; every Stage 4 panel | `tests/stage2-single-counter.test.tsx` (flag-off golden = main's markup byte for byte), `tests/stage2-live-counter-wording.test.ts`, `tests/stage4-*-ui.test.ts`, the Chromium run (page renders every panel) |
| `agent/src/workbook.ts`, `src/lib/agentMission/customerView.ts` | Round 35 layout, Round 36/37/38 wording, dates | Stage 2 `deliveredSheetsOf`, Stage 3 `extraLimitLines` and queue columns | `tests/round35-workbook-layout.test.ts`, `tests/round32-customer-csv.test.ts`, `tests/f4-delivered-quantities-agree.test.ts`, `tests/agent-customer-view.test.ts`, the three Stage 3 flags-off digests |
| `src/app/api/missions/[id]/file/route.ts` | Round 32 CSV by name (built from the Excel) | `?version=N` Excel of a published version | `tests/stage4-version-download.test.ts`, `tests/round32-customer-csv.test.ts`, FLOW 10 of `tests/stage4-e2e-resilience.test.ts` |
| `src/lib/agentMission/customerActions.ts`, `openMissions.ts`, `adminActions.ts` | Round 34 `setSocialDiscovery`, own-running query | add-on marker filter, Stage 3 queue columns | `tests/open-missions.test.ts`, `tests/money7e-isolation.test.ts`, `tests/stage2-addon-rows.test.ts`, `tests/agent-customer-actions.test.ts` |
| methodology and workflow files | Round 28/37 methodology wording | Stage 4 marker column in `methodology/missions` | `tests/round28-methodology-topic-relation.test.ts`, `tests/customer-methodology.test.ts`, `tests/methodology*.test.ts` |

## LAUNCH ROUND (5 Nov 2026): the stacked integration PRs on main `0728e06f`, the approval route and button, and the first real-browser run of the paid journey

**Structure (replaces the rehearsal branches as the thing to review and merge; nothing was merged, no existing PR branch was force-pushed, Boost untouched).**

| Order | PR | Branch | What |
|---|---|---|---|
| 1 | #416 | `integration/launch-1-stage2-main-0728e06f` (on main) | Stage 2 (#369 + #406 + #408 + #409) + #407. No money. |
| 2 | #417 | `integration/launch-2-stage3-main-0728e06f` (on #416) | Stage 3 (#370), the three flags-off digests re-recorded. No money. |
| 3 | #418 | `integration/launch-3-stage4-main-0728e06f` (on #417) | Stage 4 (#371 … #404) with six union resolutions + **the launch round's own work**: approval route (#411), approval button (#413), real-browser fetch fix (#415), F-4 test (#410). **Financial; flags OFF.** |

Satellite PRs (all DRAFT): #410 F-4 regression test (on main), #411 approval route, #413 approval button, #415 browser fetch fix (all on the Stage 4 stack), #412 release documents (`docs/launch/`: Round 37 exception, launch checklist, Arabic launch e-mail), #414 the unique-index migration re-verified on a disposable PostgreSQL + read-only production audit.
The tree of #418 equals the earlier rehearsal `integration/rehearsal-r4-main-0728e06f` plus exactly these additions (checked by `git diff` of the two trees).

**Results on #418's code (SHA in the PR; the documentation commit that follows changes no code).**

| Gate | Result |
|---|---|
| `tsc --noEmit` (site), `npm run agent:typecheck` (worker) | clean |
| `next build` + client-bundle secret scan | exit 0; 207 client files, zero secrets |
| full suite, two shards | **11,977 tests passed, 0 failed, 57 skipped**; test files: **916 passed, 5 skipped, 1 could not load** (922 files). The one file that cannot load is `tests/round37-real-reels-excel-acceptance.test.ts` (its three fixtures were never committed; fails identically on plain main). **The suite is NOT fully passing while that file cannot load.** |
| protected money files and SQL vs main | only the prepared, unapplied `supabase/migrations/20261104222136_one_open_addon_per_file.sql`; no money file, wallet route or worker money code is edited |
| real Chromium (Playwright), desktop 1280 and phone 390, the real route handlers over the fake money core, fake storage and the real worker runner | **62 of 62** checks: review quote, unpaid request, explicit approval (one hold, double-click safe), status «processing» then «delivered», review report, edit request, second approval, two versions, version 2 downloads as a real Excel, ledger reserve → release → charge, balance = start − charges; not enough points (nothing held, request still waiting); a lost answer («may be held», one hold after the retry); approval flag OFF (no control drawn) |

**Defects found by this round's own checks (each fixed in its own PR, tested):**
1. **Real-browser `fetch` «Illegal invocation» (#415).** All Stage 4 panels but one never sent a request in a real browser (they said «تعذّر الاتصال الآن»); 1,000+ unit tests missed it because a mock has no `this` rule. Found by the first real-browser run. **Without this fix none of the Stage 4 customer screens would have worked on the day the flags were turned on.**
2. **A clean refusal (not enough points) left the request «possibly paid» (#411).** The approval function keeps the approval time it wrote when it claimed the row; every reader then hid the request (no button, no cancel), another request was refused, and the status said the points may be held. Now cleared only when the job's own ledger state is proved empty. (The one-line fix inside `addonSettlement.ts`'s `revert` is proposed for the owner; that is a protected money file and was not touched.)
3. **Independent review of the route (a separate reviewer):** a kept hold that cannot start was reported as «refused» (fixed), the client misread a 401, the «may be held» warning unmounted (fixed), the «already approved» wording, JSON-only POST (fixed). Not fixed here: `emailVerified` also reads client-writable `user_metadata` (pre-existing, shared with mission approval; owner).
4. **Consent wording** used refund-style words banned by `tests/audit-phase3-release-wording.test.ts`; reworded to «يُحرَّر الحجز المؤقت».
5. **F-4 retracted.** «The completed card says ٤٢ while the Excel says ٧٠» came from a test fixture that built a completed card from the plan at approval; the worker stores the judged plan in the completing update. 215 deliveries on the stored real rows: card and Excel agree (#410).

**Still not verified (limits):** Heroku and the worker's deployed revision (no access); a real browser against the real Supabase/Vercel app with a logged-in customer; a real mission, real money or real providers; Vercel production. The unique-index migration is **not applied** (read-only audit: 216 missions, 0 add-on rows, 0 duplicates; apply procedure in #414).

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
