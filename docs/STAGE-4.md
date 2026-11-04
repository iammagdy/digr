# STAGE 4: review, edits and versions, with NO charging (FOUNDATION-PLAN section 5, "PR 6")

Branch `stage-4/review-edits-versions`, started from `main` = `239ca94`. Draft PR only.

- **Nothing here charges, reserves, releases or writes a ledger row.** The prices are shown by code as price inputs. All charging waits for the separate money PR (FOUNDATION-PLAN "PR 7"), which needs the owner's explicit brief.
- Every new module is reached by tests only (`tests/stage4-isolation.test.ts`).
- A test walks the import graph and proves that no money path can reach the quote functions (`tests/stage4-quotes.test.ts`).
- No SQL, no migration, no new table, no paid call, no model call. **No existing file was changed.**

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

**Changed:** none.

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
| `stage4-isolation.test.ts` | the repo's sources | no production file imports a `stage4/` module |

## 7. Done by Opus

1. The version model: frozen versions, a content digest, derive-from-old, and a diff.
2. The review engine: report, score and per-column issues, without deleting or changing a row.
3. Display-only quotes, with the import-graph proof.
4. The edit-as-new-version contract: request in, new version and diff summary out, no charge.

## 8. Left for Sonnet (step by step; NO charging anywhere)

**S1. Version 1 at delivery (behind `DIGER_STAGE4_VERSIONS`).**
1. In the worker's finalize step, right after `buildMissionFiles`, read the built workbook's cells, the same way the test helper `cellsOf` does.
2. Make `firstVersionFromCells(...)` and store it with `putNew` at `versionPathOf(1)`.
3. A failure only logs. It never fails the delivery.
4. This is not the settlement code: do **not** touch the settlement lines of `finalize.ts`. Add the call in `runMission.ts` after the file is stored, behind the flag.

**S2. Versions list (UI).**
1. Add a new route `GET /api/missions/[id]/versions`: owner only, flag off → 404. It returns `{ version, parent, reason, createdAt, digest }[]` from the `versions/` listing.
2. Add a new component `src/components/mission/VersionList.tsx` that shows «النسخة ١ (التسليم)», «النسخة ٢ (تعديل)» and so on, each with a download of that version's file.
3. Not in `ResultsCanvas.tsx`: that file is locked. Put it on the requests page.

**S3. Review offer and report (behind `DIGER_STAGE4_REVIEW`, after the money PR).**
1. Show the review button with `quoteLineAr("review", reviewQuote(reviewCellsOf(version)))`.
2. On «اطلب المراجعة», the money PR's charge runs first. It is **not** part of this stage.
3. Then call `reviewFile(version)`, store the report (`reviews/rNNNN.json`), and show `reportAr` in a new `src/components/mission/ReviewReport.tsx`: the score as «التقييم: X من ١٠٠», then the lines.
4. A «أصلح» action turns a chosen issue into an `EditRequest` (`set_cells`) and makes a `review_fix` version. Use `deriveVersion` with `reason: "review_fix"`, or add a `reason` option to `applyEditRequest` with its own test.

**S4. Edit request (behind `DIGER_STAGE4_EDITS`, after the money PR).**
1. The customer's words («ضيف عمود ...») become an `EditRequest`:
   - the column title by code, from the words;
   - the values by re-reading only the needed part, through the existing engine with a one-stage plan on the delivered rows' ids.
2. The real cost of that re-read gives `editQuote(realCostUsd)`, shown before the customer approves. The charge belongs to the money PR.
3. On approval: `applyEditRequest(prev, request, { createdAt, realCostUsd })`, then store the new version and build its file.
4. Add a new component `src/components/mission/EditRequestCard.tsx`: an input for the request, the quote line, and the diff summary («أُضيف عمود "..."، ٣٠٠ خانة جديدة، لم يُحذف شيء»).

**S5. Wording review** of `REVIEW_ISSUE_AR` and `EDIT_REJECTION_AR`, for example «٢ خانة» should read «خانتان».

## 9. Needs change in a locked file (not done here)

- **`ResultsCanvas.tsx`** (the methodology parts are locked): if the versions list, the review report or the edit request should appear in the results canvas, that needs the canvas to render the new components. Until then, use the requests page.
- **The download routes** (`src/app/api/missions/[id]/file/route.ts` and the other Excel/CSV/PDF routes): to download a **specific version**, a route must accept `?version=N` and serve `versions/vNNNN/result.xlsx`. This is a change in a locked file. Until then, only the latest delivery is downloadable.
- **`src/functions/**`, ledger and billing** (forbidden): every charge for a review, a fix or an edit belongs to the money PR (FOUNDATION-PLAN PR 7). It needs an explicit owner brief, new deterministic ledger ids (`res_` / `chg_` / `rel_`), and must stay at or below the shown quote.

## 10. Open decisions for the owner

1. **Storage of versions:** create-only storage objects (recommended, no schema change) or the `file_versions` table proposal (section 5).
2. **The review's score rule:** do duplicates and unexplained empty cells count against the score (as here), and do stated gaps not count? Recommended: as here.
3. **Is a review-fix version priced like an edit?** Recommended: yes, `editQuote` on its real cost, at least 100.
4. **Edits allowed after delivery:** add a column, rename, correct cells, add rows (as here). Removing rows is not offered. Recommended: keep it so.
5. **The money PR** (PR 7): the order of reserve and charge for review and edit, and the ids. Explicit brief needed.

## 11. Verified facts vs assumptions

- **Verified by tests:** section 6, including real-file reviews. M14 scores 100 (535 cells; 20 stated gaps in «المصدر المسمّى»). M12 (the round 11 world, 636 cells) scored 93 before the reply-to rule: its 40 empty «معرّف التعليق الأصلي» cells are empty by design on comment rows. After the rule it scores 100, with 26 stated gaps reported.
- **Assumption:** reading the built workbook's cells at finalize (S1) costs little time. Not measured.
- **Read-only SELECT queries run for this stage:** none.
