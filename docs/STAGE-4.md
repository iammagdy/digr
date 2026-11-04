# STAGE 4: review, edits and versions, with NO charging (FOUNDATION-PLAN section 5, "PR 6")

Branch `stage-4/review-edits-versions`, started from `main` = `239ca94`. Draft PR only.

- **Nothing here charges, reserves, releases or writes a ledger row.** The prices are shown by code as price inputs. All charging waits for the separate money PR (FOUNDATION-PLAN "PR 7"), which needs the owner's explicit brief.
- Every new module is reached by tests only (`tests/stage4-isolation.test.ts`).
- A test walks the import graph and proves that no money path can reach the quote functions (`tests/stage4-quotes.test.ts`).
- No SQL, no migration, no new table, no paid call, no model call.
- **Wiring (Sonnet, steps S1, S2, S5):** two existing files got one small, flag-gated change each (`agent/src/runMission.ts`, `src/app/dashboard/requests/[id]/page.tsx`); see section 3. With every flag unset a customer sees exactly what they saw before (tests: `tests/stage4-first-version.test.ts`, `tests/stage4-versions-list.test.ts`).

---

## 1. Goal, in plain words

- **Versions.** The delivered file is **version 1**. Every later change, whether a review fix or an edit, makes a **new version** from the old one. The old version is never changed.
- **Review.** The customer may ask for a paid **review**. It gives a **report** and a **score**, and it **never deletes or changes a row**. Its price is shown by code: **1 point per 100 cells, at least 100**.
- **Edits after delivery.** The customer may ask to change the delivered file, for example «ضيف عمود ...». The change becomes a new version of the **same file**. Only the changed part is re-read. The price is shown by code: **the real cost × the markup, at least 100**. Our own mistake is not free.

## 2. Flags (all OFF by default)

| Flag | Values | Default | Gates |
|---|---|---|---|
| `DIGER_STAGE4_VERSIONS` | `on`, `test` (test accounts only), anything else = off | **off** | writing and listing versions |
| `DIGER_STAGE4_REVIEW` | same | **off** | the review offer, its report and its quote |
| `DIGER_STAGE4_EDITS` | same | **off** | the edit request and its quote |

- Read the flags with `stage4Enabled(flag, isTestAccount)` from `src/lib/agentMission/stage4/flags.ts`.
- **Keep `DIGER_STAGE4_REVIEW` and `DIGER_STAGE4_EDITS` off until the money PR is merged.** FOUNDATION-PLAN PR 6 risk: an edit that is not priced must not deliver paid work for free.
- No existing switch, flag or variable was changed. Nothing was set in Vercel, Heroku or Supabase.

## 3. Files

**New:**

| File | What |
|---|---|
| `src/lib/agentMission/stage4/flags.ts` | the three flags |
| `src/lib/agentMission/stage4/versions.ts` | `FileVersion`, `firstVersionFromCells`, `sheetFromCells`, `deriveVersion`, `diffVersions`, `versionPathOf` |
| `src/lib/agentMission/stage4/review.ts` | `reviewFile`, `reviewCellsOf`, `REVIEW_CODES`, `REVIEW_ISSUE_AR` |
| `src/lib/agentMission/stage4/quotes.ts` | `reviewQuote`, `editQuote`, `quoteLineAr` (display only) |
| `src/lib/agentMission/stage4/editVersion.ts` | `EditRequest`, `applyEditRequest`, `EDIT_REJECTIONS`, `EDIT_REJECTION_AR` |
| `tests/stage4-versions.test.ts`, `tests/stage4-review.test.ts`, `tests/stage4-quotes.test.ts`, `tests/stage4-edit-version.test.ts`, `tests/stage4-isolation.test.ts` | red-then-green tests |
| `docs/STAGE-4.md` | this file |

**Added by the wiring (S1, S2, S5):**

| File | What |
|---|---|
| `agent/src/stage4/firstVersion.ts` | S1: `storeFirstVersion`, `workbookCells`; one try/catch, 10 second limit, the flag read first |
| `src/lib/agentMission/stage4/versionList.ts` | S2, server only: `listVersionSummaries`, `versionsAvailable`, `ownsMission` |
| `src/lib/agentMission/stage4/versionLabels.ts` | S2, client-safe: `versionLabelAr`, `versionParentAr`, `VersionSummary` |
| `src/lib/agentMission/stage4/countAr.ts` | S5: `countedAr` (one / two / three to ten / eleven and more) |
| `src/app/api/missions/[id]/versions/route.ts` | S2: `GET`, flag off is 404, owner only, `no-store` |
| `src/components/mission/VersionList.tsx` | S2: the list, drawn only on the request's page |
| `tests/stage4-first-version.test.ts`, `tests/stage4-versions-list.test.ts`, `tests/stage4-review-wording.test.ts` | the tests of S1, S2 and S5 |

**Changed (existing files):**

| File | Change |
|---|---|
| `agent/src/runMission.ts` | one import and one line, at the very end of `settleExecution`: `if (resultPath && delivered > 0 && !ourFailure) await storeFirstVersion(...)`. It comes after `settleMission`, after the status update and after the customer's notice. No money line changed. |
| `src/app/dashboard/requests/[id]/page.tsx` | one import and one line: `<VersionList missionId={missionId} />` after the mission card, only for a mission that delivered something |
| `src/lib/agentMission/stage4/review.ts` | S5: the report's sentences count in correct Arabic |
| `tests/stage4-isolation.test.ts` | the list of files that may import a Stage 4 module is now explicit: the three wiring files |

## 4. Data shapes and contracts

### 4.1 Versions (`versions.ts`)

```ts
FileVersion = { v: 1; missionId; version: 1, 2, ...; parent: number | null; reason: "delivery" | "edit" | "review_fix"; createdAt; sheets: VersionSheet[]; digest (sha-256 of the content) }   // deeply frozen
VersionSheet = { nameAr; headers: string[]; rows: { id; parentId | null; cells: string[] }[] }      // the file's own sheets; rows keyed by «المعرّف»
firstVersionFromCells({ missionId, cells: { sheetName: string[][] }, createdAt })                 // the delivered file; the summary sheet is not versioned
deriveVersion(prev, change: (oldSheets) => newSheets, { reason, createdAt })                       // prev untouched (a changer that mutates it throws)
diffVersions(a, b) -> { rowsAdded; rowsRemoved; rowsChanged; cellsChanged; cellsAdded; columnsAdded[]; columnsRemoved[]; sheetsAdded[]; sheetsRemoved[]; bySheet }
versionPathOf(n) -> "versions/v0001.json"
```

### 4.2 Review (`review.ts`)

```ts
reviewFile(version) -> { score 0..100; cells; rowsReviewed; issues: { code; sheet; column; count; rowIds (first 20) }[]; reportAr: string[] }
REVIEW_CODES = empty_cells | invalid_email | invalid_phone | invalid_link | invalid_date | exact_duplicate | stated_gap
reviewCellsOf(version) -> the readable cells (every row × every column except the id columns): the review's price base
```

- **Columns checked.** The checks are chosen by the column's header:
  - e-mail («إيميل», «البريد»);
  - phone («هاتف», «محمول», «موبايل», «جوال»): at least 7 digits;
  - link («رابط», «الموقع الإلكتروني»);
  - date («تاريخ»).
- **Empty cells.** A cell left empty with no reason given counts against the score. There is one exception: «معرّف التعليق الأصلي» is empty by design on a comment's own row.
- **Stated gaps** («غير متوفر», «غير متاح», «لم يكتمل البحث», «غير محدد») are reported, but never counted against the score.
- **Exact duplicates** are reported, and their cells count against the score. **Nothing is removed.**
- **Score** = ⌊100 × sound cells / cells⌋.
- **Report.** Its first line is «التقييم: X من ١٠٠.», then one fixed sentence per issue. The report never names a provider.

### 4.3 Quotes, display only (`quotes.ts`)

```ts
reviewQuote(cells) = max(100, ceil(cells / 100))                          // whole cells ≥ 0, else it throws
editQuote(realCostUsd, settings = DEFAULT_MISSION_PRICING_SETTINGS) = max(100, ceil(realCostUsd × pointsPerCostUsd(settings)))   // 5,500 points per USD by default
quoteLineAr(kind, points) -> «سعر المراجعة: ٢٥٠ نقطة، محسوب بالكود. لم يُخصم شيء.»
```

- **Markup.** `pointsPerCostUsd` (`missionPricing.ts`) is the existing read-only rate: dollars to points, with the markup included. `editQuote` reads the cost to the micro-dollar so the result never depends on floating-point rounding.
- **No free path.** `editQuote` takes no reason, so an edit that fixes our own mistake is priced like any other.
- **Not reachable from money code (proved by the import-graph test).**
  - No file under `src/`, `agent/src/` or `supabase/` whose path is a money path imports `quotes.ts`, directly or through a chain of imports. Money paths are: gateway, price, jobPointsCap, finalize, missionPricing, recordPricing, approval, runMission, and anything named ledger, billing, charge, settle, reserve, topup, wallet, payment, invoice or credit, plus `src/functions/**` and `supabase/**`.
  - Only `stage4/` files may import it.

### 4.4 Edit as a new version (`editVersion.ts`)

```ts
EditRequest = { kind: "add_column"; sheet; titleAr; values: { rowId: value } }
            | { kind: "rename_column"; sheet; from; to }
            | { kind: "set_cells"; sheet; cells: { rowId; column; value }[] }
            | { kind: "add_rows"; sheet; rows: { id; parentId?; values: { header: value } }[] }
applyEditRequest(prev, request, { createdAt, realCostUsd? }) ->
    { ok: true; version (prev.version + 1, parent = prev.version, reason "edit"); diff; reread: { sheet; columns; rows }; quotePoints: number | null }   // no charge
  | { ok: false; reason }   // EDIT_REJECTIONS
```

- **New columns** go before the id columns.
- **A row with no value** from the re-read says «لم يكتمل البحث». A cell is never left empty.
- **The id columns** (`المعرّف`, `معرّف الأصل`) cannot be renamed or edited.
- **Rows are never removed.** A `remove_rows` / `delete_rows` request is refused with `row_removal_not_offered`.
- **Refusal codes**, each with one fixed Arabic sentence: `unknown_sheet`, `unknown_column`, `column_exists`, `unknown_row`, `duplicate_row`, `locked_column`, `bad_title`, `empty_edit`, `row_removal_not_offered`, `unknown_edit`.

## 5. Storage: a schema PROPOSAL only (no migration written)

Recommended, with no schema change:

- Each version is a **create-only object** in the mission's private folder (`AGENT_BUCKET`), at `versions/v0001.json`, `v0002.json`, and so on. It is written with `putNew`, the item log's create-only rule, so it is never overwritten and never served stale.
- The current version is the highest number in the listing.
- The files of a version are built from its sheets with the existing writer and stored as `versions/v0002/result.xlsx`.
- A review report is stored as `reviews/r0001.json`, linked to the version it read.

Alternative, if the owner prefers a table (**proposal only, not a migration**):

```
file_versions(
  mission_id text references missions(id),
  version int,
  parent int null,
  reason text check (reason in ('delivery','edit','review_fix')),
  digest text,
  storage_path text,
  created_at timestamptz default now(),
  primary key (mission_id, version)
)
```

It would be insert-only, with RLS so that only the mission's owner can read it, and no update or delete policy.

## 6. Acceptance tests (stored real fixtures)

| Test | Fixture | Proves |
|---|---|---|
| `stage4-versions.test.ts` | the M12 file (`msn_5851abc92a1e6645a9cd`), rebuilt by the current code from its stored real rows (`tests/helpers/round11Worlds.ts` `tiktokWorld`) | flags off; version 1 equals the file's sheets, ids and digest; version 2 is made from version 1, which stays unchanged (same JSON) and frozen; the diff; the same content gives the same digest |
| `stage4-review.test.ts` | the M14 file (`msn_b060d3347ed7660f972e`, `xWorld`) and the M12 file; one small sheet of fake values | **row count and content unchanged** before and after; the result holds no rows; the report passes the customer-text rules; it is deterministic; every check works with known counts; the score is exact (40 on the fake sheet); M14 and M12 both score 100 (only stated gaps); the reply-to column is not counted against the score |
| `stage4-quotes.test.ts` | the repo's sources (import graph) | the price formulas and minimums; bad inputs are refused; the line wording; **no money path reaches `quotes.ts`** |
| `stage4-edit-version.test.ts` | the M12 file | FOUNDATION-PLAN acceptance: «ضيف عمود» on M12 gives version 2, only the new column is new, version 1 is unchanged, and a price is shown, never charged; rename, cell fix and added rows each give a version with no removed row; the refusal codes |
| `stage4-isolation.test.ts` | the repo's sources | no production file imports a `stage4/` module except the three listed wiring files |
| `stage4-first-version.test.ts` | the replay harness (a whole mission) and a fake store | S1: flag unset reads and writes nothing; flag on stores version 1 equal to the delivered file's cells; a failing store, builder, file or clock never changes the mission or the one settlement call; create-only; the call sits after the settlement |
| `stage4-versions-list.test.ts` | the M12 file and an edit made from it, in a fake bucket | S2: 404 with the flag off, owner only, `no-store`, the five fields, malformed objects left out; the component and a text scan of every label; only the request's page shows it |
| `stage4-review-wording.test.ts` | the fixed sentences | S5: the exact sentence for 1, 2, 3, 10 and 11 of every code; no wrong «٢ خانة»; all refusals are clean sentences |

## 7. Done by Opus

1. The version model: frozen versions, a content digest, derive-from-old, and a diff.
2. The review engine: report, score and per-column issues, without deleting or changing a row.
3. Display-only quotes, with the import-graph proof.
4. The edit-as-new-version contract: request in, new version and diff summary out, no charge.

## 8. Left for Sonnet (step by step; NO charging anywhere)

**Status.** S1, S2 and S5 are **done** (this branch, flag-gated). S3 and S4 are **not started**: they need the separate money PR first.

**S1. Version 1 at delivery (behind `DIGER_STAGE4_VERSIONS`). DONE.**
1. In `agent/src/runMission.ts`, at the end of `settleExecution` (after `settleMission`, the status update and the customer's notice), one call to `storeFirstVersion` (`agent/src/stage4/firstVersion.ts`).
2. It reads the delivered workbook back from the mission's folder (`result/result.xlsx`), makes `firstVersionFromCells(...)` and stores it with `putNew` at `versionPathOf(1)`.
3. The whole helper (flag read, account lookup, read-back, build, write) is inside one try/catch with a 10 second limit. A failure only logs («version_not_stored»); the helper never throws, never changes the mission's status or any number, and never delays the settlement.
4. The flag is read first: unset (or «test» for a customer) reads and writes nothing.
5. The settlement lines of `finalize.ts` and the money lines of `runMission.ts` are untouched.

**S2. Versions list (UI). DONE.**
1. `GET /api/missions/[id]/versions`: owner only; flag off is 404 before anything is read; **only `on` lists (`test` is 404 here, see section 11)**; `Cache-Control: no-store`; returns `{ version, parent, reason, createdAt, digest }[]` from the `versions/` listing (never a cell of the file).
2. `src/components/mission/VersionList.tsx` shows «النسخة ١ (التسليم)», «النسخة ٢ (تعديل)» and so on. **No download button** (see section 9).
3. It is rendered by the request's own page (`src/app/dashboard/requests/[id]/page.tsx`) directly, not through the mission card: the card and the chat page are not changed at all (a test proves neither mentions it).

**S3. Review offer and report (behind `DIGER_STAGE4_REVIEW`, after the money PR). NOT DONE.**
1. Show the review button with `quoteLineAr("review", reviewQuote(reviewCellsOf(version)))`.
2. On «اطلب المراجعة», the money PR's charge runs first. It is **not** part of this stage.
3. Then call `reviewFile(version)`, store the report (`reviews/rNNNN.json`), and show `reportAr` in a new `src/components/mission/ReviewReport.tsx`: the score as «التقييم: X من ١٠٠», then the lines.
4. A «أصلح» action turns a chosen issue into an `EditRequest` (`set_cells`) and makes a `review_fix` version. Use `deriveVersion` with `reason: "review_fix"`, or add a `reason` option to `applyEditRequest` with its own test.

**S4. Edit request (behind `DIGER_STAGE4_EDITS`, after the money PR). NOT DONE.**
1. The customer's words («ضيف عمود ...») become an `EditRequest`:
   - the column title by code, from the words;
   - the values by re-reading only the needed part, through the existing engine with a one-stage plan on the delivered rows' ids.
2. The real cost of that re-read gives `editQuote(realCostUsd)`, shown before the customer approves. The charge belongs to the money PR.
3. On approval: `applyEditRequest(prev, request, { createdAt, realCostUsd })`, then store the new version and build its file.
4. Add a new component `src/components/mission/EditRequestCard.tsx`: an input for the request, the quote line, and the diff summary («أُضيف عمود "..."، ٣٠٠ خانة جديدة، لم يُحذف شيء»). The count in that line must use `countedAr` (S5).

**S5. Wording review. DONE.**
- `REVIEW_ISSUE_AR` now counts in correct Arabic with agreeing adjectives and verbs: «خانة واحدة فارغة»، «خانتان فارغتان»، «٣ خانات فارغة»، «١١ خانة فارغة» (`countedAr`, the same rule as `pointsAr`). The dual takes the dual («قيمتان لا تبدوان»). The sentence of `stated_gap` no longer says «غير متوفرة من المصدر» for every gap (a gap may also be «لم يكتمل البحث»): it now says «أن القيمة غير متاحة أو لم يكتمل البحث عنها».
- `EDIT_REJECTION_AR` was read sentence by sentence: all ten are correct and carry no count, so none was changed (a test keeps it so).
- The version labels and `quoteLineAr` (it counts through `pointsAr`) needed no change.
- For 101 and 102 the singular is used («١٠١ خانة»), as `pointsAr` does.

## 9. Needs change in a locked file (not done here)

- **`ResultsCanvas.tsx`** (the methodology parts are locked): if the versions list, the review report or the edit request should appear in the results canvas, that needs the canvas to render the new components. Until then, use the requests page.
- **The download routes** (`src/app/api/missions/[id]/file/route.ts` and the other Excel/CSV/PDF routes): to download a **specific version**, a route must accept `?version=N` and serve `versions/vNNNN/result.xlsx`. This is a change in a locked file. Until then, only the latest delivery is downloadable.
- **Download per version needs `?version=N` on the download route** (`src/app/api/missions/[id]/file/route.ts` is locked): the versions list therefore has no download button. Until the route accepts `?version=N` (and serves `versions/vNNNN/result.xlsx`, which nothing writes yet), a version other than the latest delivery cannot be downloaded.
- **`src/functions/**`, ledger and billing** (forbidden): every charge for a review, a fix or an edit belongs to the money PR (FOUNDATION-PLAN PR 7). It needs an explicit owner brief, new deterministic ledger ids (`res_` / `chg_` / `rel_`), and must stay at or below the shown quote.

## 10. Decisions of the owner

1. **Storage of versions: decided.** Create-only storage objects in the mission's own folder (`versions/vNNNN.json`, written with `putNew`). No table, no migration. (The `file_versions` table in section 5 stays a proposal only.)
2. **The review's score rule: decided.** Duplicates and unexplained empty cells count against the score; gaps stated in the file do not (as in `review.ts`).
3. **A review-fix version: decided.** Priced like an edit: `editQuote` on its real cost, at least 100. Display only; charging waits for the money PR.
4. **Edits allowed after delivery: decided.** Add a column, rename, correct cells, add rows. Removing rows is never offered.
5. **The money PR (PR 7): decided as a rule, not started.** It is separate and needs the owner's explicit approval. S3 and S4 wait for it.

## 11. Verified facts vs assumptions

- **Verified by tests:** section 6, including real-file reviews. M14 scores 100 (535 cells; 20 stated gaps in «المصدر المسمّى»). M12 (the round 11 world, 636 cells) scored 93 before the reply-to rule: its 40 empty «معرّف التعليق الأصلي» cells are empty by design on comment rows. After the rule it scores 100, with 26 stated gaps reported.
- **Verified by tests (S1, S2, S5):** with the flag unset a whole mission stores no version and its mission row, events and settlement are identical to a run with the flag on (apart from the one version object); a store that refuses the version, a builder that throws, an unreadable or missing file, a store that never answers (10 second limit) and a flag read that throws all leave the mission and the one settlement call exactly as with the flag off; the list route is 404 with the flag off (before the viewer is asked), owner only, `no-store`, and answers only the five fields; every label the list can show passes `checkCustomerText` and `checkCustomerLabel`; the review's sentences have the right form for 1, 2, 3 to 10 and 11 or more.
- **Assumption (S1):** reading the built workbook's cells after settlement costs little time. Not measured. The helper holds the worker for at most 10 seconds after the customer was told, so the delivery itself is never delayed; a very large workbook is read on the worker's own thread, which a time limit cannot interrupt.
- **Assumption (S2):** the list reads each version's whole object to get its five fields. For a delivered file of thousands of rows that is one download per version on a page view of a mission, only with the flag on. If it proves slow, S3/S4 can write a small `versions/vNNNN.meta.json` beside each version (also create-only).
- **Limit (S2):** the versions list answers only when `DIGER_STAGE4_VERSIONS` is exactly `on`. With `test` the worker still stores version 1 for a test account (the agent may read the test-account list), but this customer-side route answers 404, because `tests/admin-calls-log.test.ts` forbids any customer-side code from importing the test-account list. If the owner wants the list in `test` mode, the worker could record «test» in the version object, or that guard must be changed on purpose.
- **Not checked:** the real storage bucket's listing and download were not called (no network in this stage); the route is proved against a fake with the real listing's shape (entries with an id; a folder has none).
- **Read-only SELECT queries run for this stage:** none.
