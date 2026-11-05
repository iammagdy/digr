# Round 37 historical acceptance test: impact on launch and a proposed EXCEPTION (for owner signature)

Status: PROPOSAL. Nothing in this document changes a test, a fixture or a `.gitignore` rule. The owner has said they do not possess the original file; **we stop asking for it.**

## 1. What the test is and what it needs

`tests/round37-real-reels-excel-acceptance.test.ts` (on `main`) checks the three files the customer's viewer really held for the real mission `msn_b56312efe3a41bef94a8` (5 Instagram Reels). It reads, with no network and no points:

| File it needs (`tests/fixtures/round37/`) | sha256 (from that folder's README) | Why it is evidence |
|---|---|---|
| `delivered.csv` | `2d85cac9209903ac920ab3e2c9c6fde0218287717efe7b4b7bbd9ef2185b7686` | the CSV the customer saw (14 columns, 5 records, 19-digit ids last) |
| `methodology.csv` | `ad0c6a558da70e51aea8be7d6b59f4b706326b09f2e2439199f2cdb5f5555d58` | the methodology as delivered |
| `delivered-saved-by-excel-android.xlsx` (16,140 bytes) | `bfd1002e0b0f8698740563b4982cc4b6ede226133a5e35219e4ee2f7477d0a2a` | the Excel **re-saved by Excel for Android** (`docProps/app.xml`: `Application: Excel Android`), not written by Diger's writer. The stored `result/result.xlsx` is a different file (13,418 bytes) and cannot stand in for it |

None of the three was ever committed (the `.gitignore` rules `/tests/**/*.csv` and `/tests/**/*.xlsx` kept them out); on a clean checkout the file fails to load (`ENOENT: tests/fixtures/round37/delivered.csv`) on every branch. PR #407 only adds the `.gitignore` exception and a README; **#407 alone does not make the test pass.**

## 2. What the test proves (read from the test file)

| Group | Assertions | Needs the Android XLSX? |
|---|---|---|
| A. The real Excel against the real CSV | CSV shape (14 cols, 5 records, ids `^\d{19}$` as strings); every cell of sheet «الريلز» equals the CSV; ids are TEXT cells (never a float); row → account → URL → id relation and hyperlink targets are the visible address; no text cut (longest cell 1,097 chars); counters are numbers equal to the CSV; both sheets RTL, header frozen, no hidden column, no merged cell, widths, row height ≤ 409; the methodology sheet's non-empty lines equal `methodology.csv` | **Yes** (reads the re-saved XLSX with ExcelJS) |
| B. The title of the real request | `subjectOfMission` / `missionTitleAr` give «٥ ريلز عن الذكاء الاصطناعي» (not «… عن وعدد المشاهدات»); a column name containing «الحساب» never becomes the subject; a real account/channel request keeps its subject | No (the request text is in the test) |
| C. The methodology does not contradict itself | topic-relation mark counted 5 of 5; the «كيف فُحصت الصلة بطلبك» line no longer says no relevance check was applied; a stage with no mark column keeps the old honest sentence | No (uses delivered rows) — but the rows come from the CSV |
| D. Regenerated export | the export rebuilt locally from the delivered rows equals the delivered CSV cell by cell, ids as text | Needs `delivered.csv` |

Only group A (and D's comparison data) depends on the three real files. B and C depend on the request text and row values.

## 3. What is ALREADY covered by independently executable tests (verified by reading the test names)

| Customer-visible behaviour | Test file (on `main`) | What it asserts |
|---|---|---|
| CSV built from the customer's own Excel; Excel = CSV cell by cell on stored real rows of five platforms; BOM, Arabic headers, ids last; quoted commas / line breaks stay in their cell; ids unique; links kept | `tests/round32-customer-csv.test.ts` (sections 1–10, 16) | e.g. «the CSV says what the Excel says, cell by cell, on the stored real rows of the five platforms»; «a comma, a quote and a line break inside a cell never move a column or add a row»; formula-start marks |
| Excel layout: widths from content, row height from the tallest cell (never above 409 pt), ids/links on one line, every value whole (a 6,300-char text), Excel and CSV carry the same records | `tests/round35-workbook-layout.test.ts` | «every value is where it was and is whole… the Excel and the CSV carry the same records»; the customer's CSV of the new Excel has the same rows and ids |
| Instagram Reels naming and the media contract | `tests/round35-instagram-reels.test.ts` | Reels parsed, `media` contract, filter sent on every call |
| Requested fields (date, account, views): recovered or honestly «غير متاح»; Reels titles the stage «الريلز»; Excel and CSV agree | `tests/round36-requested-fields.test.ts` | «DATE AND ACCOUNT PRESENT… Excel and CSV agree»; «NEITHER ON THE PAGE… «غير متاح» in every row… nothing is invented» (pages SIMULATED, labelled) |
| Methodology topic-relation lines and that the real workbook gets only a new methodology item | `tests/round28-methodology-topic-relation.test.ts` | counts follow the rows; no execution limit invented; workbook counts unchanged |
| Completed card vs Excel quantities | `tests/f4-delivered-quantities-agree.test.ts` (PR #410, not yet on main) | 215 deliveries: the card's denominator equals the Excel's |
| Round 37's own wording fixes (title subject, methodology sentence) | group B and C of the Round 37 file itself, which need no real file except through the delivered rows | — |

## 4. Exact impact on launch readiness if the original is permanently unavailable

NOT proven (and cannot be proven by any other test in the repository):

1. **Reader compatibility with a file re-saved by Excel for Android.** No other test opens an XLSX that another application re-saved (a search for `Excel Android` / `re-saved` in `tests/` finds only the Round 37 files). Our writer's output is exercised by ExcelJS round-trips; a re-save by a mobile viewer (shared strings, styles, hyperlink relationships rewritten) is not.
2. **That the delivered 19-digit ids survive a re-save as text**, end to end. The writer stores ids as text cells (asserted on our own output), and round 32/36 assert the CSV keeps them; what a viewer does on re-saving is only evidenced by the lost file.
3. **CSV import of 19-digit ids in a spreadsheet's default import** (`3.94E+18`): a known customer-side effect (HANDOFF Round 36), not a defect we can test; the CSV writer was deliberately not changed. Not covered by any test and not coverable without a spreadsheet application.

Proven by other tests: our writer's cell content, layout, CSV equality, titles, methodology wording and field recovery (table in section 3). So the gap is a **compatibility-with-third-party-viewer** gap, not a data-correctness gap in our output. Severity for launch: **MEDIUM, customer-visible only for customers who open and re-save the file in Excel for Android**; no money or data-loss path.

## 5. PROPOSED EXCEPTION (needs the owner's signature; NOT applied)

**E-37: the Round 37 acceptance test stays in the repository, unchanged, as a named known gap.**

1. The test file is **never deleted, loosened or silently skipped.** Its fixtures are not recreated, approximated or regenerated, and no substitute is ever committed under the original names.
2. After owner approval ONLY, a follow-up PR makes the gap explicit with one of (owner picks):
   - **E-37a (preferred):** the file gets an environment gate with a printed reason, so a clean checkout reports it as *skipped with a named reason*, never as a load failure and never as passed:
     ```ts
     // tests/round37-real-reels-excel-acceptance.test.ts (PROPOSED DIFF, not applied)
     -describe("the real Excel (1).xlsx against the real CSV (1).csv: no data corruption, cell by cell", () => {
     +// KNOWN GAP E-37 (owner-approved, docs/launch/ROUND37-HISTORICAL-TEST-EXCEPTION.md): the three real files are permanently unavailable.
     +const REAL_FILES = existsSync(`${DIR}/delivered.csv`) && existsSync(`${DIR}/methodology.csv`) && existsSync(`${DIR}/delivered-saved-by-excel-android.xlsx`);
     +const realFiles = REAL_FILES ? describe : describe.skip;
     +realFiles("[KNOWN GAP E-37: original files unavailable] the real Excel (1).xlsx against the real CSV (1).csv: no data corruption, cell by cell", () => {
     ```
     (the module-level `readFileSync` of `delivered.csv` must move behind the same check so the file loads; groups B and C, which need no real file, would be kept running by reading their rows from a labelled SYNTHETIC source ONLY if the owner approves that too, otherwise they are gated together).
   - **E-37b:** leave the file as is and have the release report state «1 file not collected (round37), known gap E-37».
3. **Compensating control (proposed, not claimed as a replacement):** a new test `tests/round37-synthetic-resave.test.ts`, every fixture **built by code at test time** from the stored real rows under `tests/fixtures/live/missions/` (no committed binary), clearly labelled `SYNTHETIC`, that writes our workbook, re-opens and re-writes it with ExcelJS (a different writer pass, which rewrites shared strings, styles and hyperlinks), and asserts: ids remain text cells, hyperlinks keep text = target, cell text equals the CSV, RTL/frozen/no-merge survive. Its header must say it does **not** prove compatibility with Excel for Android. It reduces risk 1–2; it does not close them.
4. **Residual risk accepted by signing:** items 1–3 of section 4. Mitigation: the one bounded real test-account journey in `LAUNCH-CHECKLIST.md` opens the delivered XLSX in Excel for Android (or any available mobile viewer) once, and the owner records the result.
5. **How test counts are reported (exact wording):**
   > Tests: N passed, 0 failed, S skipped, **1 test file could not be collected (round37, known gap E-37 — fixtures permanently unavailable; not a pass).** The suite is NOT fully passing.
   After E-37a is merged the wording becomes «… K skipped, including the named known gap E-37 (original files unavailable)». At no point may a report say «all tests pass» while this file is uncollected or skipped.

## 6. Owner answer (one line)

Reply with exactly one of:

- `E-37 APPROVE a` — keep the test, gate it as a named known gap (E-37a), add the synthetic control (item 3), accept the residual risk in section 4.
- `E-37 APPROVE b` — keep the file untouched, report it as «1 file not collected», add the synthetic control.
- `E-37 REJECT` — the gap blocks launch; the original must be reconstructed some other way (we will not fabricate it).

Signed: ______________  Date: ________
