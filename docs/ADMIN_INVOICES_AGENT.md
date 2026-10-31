# Admin invoices: «مساعد الفواتير» (INVOICE AGENT 1) and the live fixes

> **Update (INVOICE AGENT 2):** the file reading was rewritten for the owner's real shapes (title rows, continuation rows, overall and detail sheets, repeats, departments), the assistant now asks questions with chips, the panel looks like the customer chat, and the invoice display was polished: see `docs/ADMIN_INVOICES_AGENT_2.md`. Where this page and that one disagree, that one wins.

Follow-up to `docs/ADMIN_INVOICES.md` (#308) and `docs/ADMIN_INVOICES_SIMPLE.md` (#311). **No SQL.** No wallet, ledger, balance, mission, reserve, charge, price-engine, cap or agent-worker code is touched.
Evidence (screenshots at 380 px, the browser run, the masked payload, the benchmark): `docs/admin-invoices-agent/`.

## Part A: bugs the owner hit live

### A1. The exchange rate («٥.٠٠» instead of ٥٠)

**Cause** (reproduced in a real browser, typing key by key; `docs/admin-invoices-agent/rate-before.json`, `rate-before-builder.png`): the builder rendered the rate box only while the rate text was empty
(`form.rate.trim() === ""`). After the FIRST digit the box disappeared and was replaced by the note «سعر الصرف المحفوظ: ٥.٠٠»: whatever he typed («50», «٥٠», «56.5», «٥٦٫٥») ended as its first digit. The first document he saved then stored that
«5.00» as his saved rate (the first typed rate is remembered), which is exactly what the settings screen showed. The settings box itself was correct (the same four inputs, typed key by key, read 50 / 50 / 56.5 / 56.5).
My earlier browser runs used `page.fill` (the whole value in one event), which can never expose a field that vanishes after one key.
**Fix**: the box is always on screen while points or EGP are shown (`showRateBox`), with a live echo «١ دولار = ٥٦.٥٠ جنيه», one box instead of two, and a typo guard: a rate far from 20 to 200 gets a visible question («هل تقصد ٥٠.٠٠؟», not blocking). After: `partA-after.json`, `A1-rate-after-builder.png`, `A1b-rate-typo-hint.png`.
**Test written first** (`tests/invoice-live-fixes.test.ts`): the four inputs key by key keep the box after every key and read 500000 / 500000 / 565000 / 565000.

### A2. A price with more decimals than a hundredth of a cent became 0

**Cause**: the price box took CENTS with at most 2 decimals; «٠.٠٢٩» (meant as 2.9 cents) has 3, was refused by the parser, and the tolerant live preview turned a refused number into 0 with no message.
**Fix**: prices are typed in US DOLLARS with up to 4 decimals (the smallest price is 0.0001 dollar = one hundredth of a cent), so «٠.٠٢٩» is exactly 2.9 cents. A price that still cannot be stored exactly (5 decimals, letters, empty, above $10,000 a unit) shows a red Arabic sentence under its box
(`price-error-…`), and «حفظ مسودة» and «إرسال» stop on it with the line number. The preview still shows 0 for it, but never as the only signal. Switching the unit while a price is in error is refused (it would hide the error).

### A3. Price unit confusion («٠.٢٨» meant 28 cents)

One toggle above the sector boxes, default **دولار**: «دولار» or «نقاط لكل بند». The unit is printed next to EVERY price box (sector boxes, line details, «أنواع البنود»). «سنت» is no longer an input unit anywhere. Stored values are unchanged (integer hundredths of a cent); only the TEXT of a price changed unit (12 cents is now «0.12»), so every saved document reads back identically.
**Points per item**: converted with the document's own rate and point value, rounded half up ONCE to one hundredth of a cent:
`cc = round_half_up(points×100 × creditValueE4 × 100 / rateE4)`. Example R = 50.00, 1 point = 0.10 EGP: 60 points = 1200 = 12 cents; 2.25 points = 45 = 0.45 cent. A tie goes up (0.01 point at R = 20 is exactly half a step: 1). A points price that would round to 0 is an error, not a silent 0.
The rule is shown under the toggle in points mode; the stored price is shown back in dollars. Tests: random check over 400 cases that the stored value is within half a step of the exact conversion (exact BigInt arithmetic).

## Part B: «مساعد الفواتير» (a chat inside the builder)

`src/components/admin/invoices/InvoiceChatPanel.tsx` (open for a new document, collapsible, phone-first). He types, attaches Excel / CSV files and pictures, and talks naturally. The assistant answers with a **proposal**; everything lands in the manual builder as an editable draft; every applied step has «تراجع».
The older «رتّبهالي» box moved under «خيارات إضافية» (one AI box at the top, not two).

### The rules, and where each is enforced

| Rule | How | Test |
|---|---|---|
| **Counting is done by code** | The model returns only a MAPPING (which column is company / manager / e-mail / phone / sector, by column LETTER). `src/lib/invoices/chat/count.ts` counts the real cells: companies = distinct non-empty names per sector (alef / ya / tashkeel / tatweel / spacing / case count once), managers = non-empty manager rows, e-mails = distinct VALID addresses (several per cell allowed, case-insensitive), phones = distinct numbers by digits (+20, 0020, a lost leading 0, dashes and spaces are one number; fewer than 7 digits are reported, not counted). Several sheets or files for one sector merge (distinct sets are shared). The header row is found by code. The chat shows counts per sector, what was NOT counted (invalid e-mails, bad phones), the mapping used (file / sheet / header row / column letters and their header text) and asks for «تمام». | `invoice-agent-count.test.ts` (fixtures: 200 companies / 312 managers (116 with two, 80 with one, 4 with none) / 287 e-mails (+5 repeats, 6 malformed) / 140 phones (+10 repeats in other formats, 4 «-»); 150/190/120/95; a sector column; three files at once; the same sector in two files) |
| **The model sees no raw data** | Only: file name, sheet names, headers (masked if they look like data), row count, shape statistics per column (filled, distinct, e-mail / phone / number share, average words) and at most 5 MASKED samples per column: e-mails `u***@d***.com`, phones `101****000` (first 3 and last 3 digits), long digit strings `29****67`, names and text reduced to initials `م. أ. ح.`. The draft it sees has sectors, counts and line ids, never a price, a total or a rate value. | `invoice-agent-mask.test.ts`; `invoice-agent-server.test.ts`: not one raw cell (4+ characters, 2,000+ checked) of the three fixtures appears anywhere in the system prompt or payload, nor in the Anthropic request body through the real route; exact payload of one fixture: `docs/admin-invoices-agent/masked-payload-electro.json` |
| **Images (vision)** | Sent as pictures (shrunk in the browser to at most 1,600 px JPEG first). Their counts are labelled «تقريبي», editable before «تمام», and are applied ONLY to cells that are empty in the draft: a number from a file or typed by the owner is never overwritten or mixed with an estimate (the skipped cells are listed with the reason). | `invoice-agent-ui.test.ts`, browser run step 6 |
| **The model never decides money** | It translates words into a FIXED list of actions (strict JSON): `set_rate`, `set_currencies`, `add_sector`, `set_counts`, `set_unit_price`, `set_target_total`, `set_discount`, `set_doc_type`, `set_client`, `set_layout`, `rename_sector`, `remove_sector`. An unknown action, an extra key, a bad number, a column that does not exist, or a money field anywhere rejects the WHOLE reply. There is no action to send, mark paid, void, save or delete: «إرسال» stays a manual button. Its sentence («say») may contain no digit (a number the owner sees was made by code; a sentence with a number is replaced). Code executes actions with the existing money library. | `invoice-agent-reply.test.ts` |
| **Money-changing actions wait for «تمام»** | Each shows the grand total before and after (same library as the sheet). Layout actions (rename, client, hide / show lines, summary-only sectors, page fit) apply at once with «تراجع». Nothing is saved to the database from the chat: only «حفظ مسودة» saves. | `invoice-agent-apply.test.ts`, `invoice-agent-ui.test.ts` |
| **Files in memory only** | Read per request with `exceljs` (already a dependency, MIT) and a small RFC-4180 CSV reader; never written to disk, a database or storage; no console call anywhere in the chat code; the audit row records only SIZES (characters, number of files, tokens, cost), never content or file names. Magic bytes must match the extension; a zip that would unpack past 120 MB is refused from its central directory BEFORE it is inflated. Max 5 files, 10 MB each, 50,000 rows in total (45,000 rows × 4 columns: 1.2 MB, parsed in 1.7 s, profiled in 0.5 s, counted in 0.3 s). Customer files never go to the model in full. | `invoice-agent-parse.test.ts`, `invoice-agent-server.test.ts` |
| **Admin only, key on the server, limits** | `authenticateAdmin` first (401 / 403 with no model call). The Anthropic key is resolved on the server and never returned, logged or placed in an error. 30 turns per admin per hour (taken from the audit table BEFORE the model is called; a failed call still counts; it fails closed if it cannot be recorded), 4,000 characters, 5 files, 10 MB. An unreadable file costs no allowance. No provider cap is touched. | `invoice-agent-server.test.ts`, `invoice-access.test.ts` (17 handlers) |

### «خلي الإجمالي ١٧ دولار» (set_target_total): the rule

The target is the document's GRAND total (after discount and tax) in the chosen currency (cents, qirsh or whole points). Code, deterministic (same input, same output), on the existing money library (`src/lib/invoices/chat/targetTotal.ts`):
1. Every line with a quantity and a price is scaled by ONE common factor (BigInt, each unit price rounded half up, at least one hundredth of a cent, within the unit and the $10,000,000-a-line limits); zero-price and zero-quantity lines are never touched. The largest factor whose total is not above the target is found by binary search (the total never goes down when prices go up).
2. REMAINDER: raise unit prices by one hundredth of a cent, one line at a time, in document order, round-robin, accepting a step only while the total stays at or below the target.
3. REFINE: single steps (1 to 12 hundredths of a cent, up or down) and paired steps (two lines, 1 to 3 each, up to 40 lines) that bring the total strictly nearer; ties go to the LOWER total.
If the target is still not hit, the chat says so and shows the nearest total reached. **Dollars are hit exactly in the large majority of realistic requests (72 of 91 in the random test); points and EGP rarely exactly** (6 and 24 per cent): the money rule of this feature rounds every line to whole US cents FIRST, so at a rate of 56 one cent is 5.6 points and 56 qirsh and a points / EGP total can only land on that lattice. The chat says «ما قدرتش أوصل لـ … بالظبط … أقرب إجمالي ممكن …».
Asking for a total in a currency that is not shown switches that currency on (and says so); if the action fails, nothing changes.
Tests: `invoice-agent-target.test.ts` (the owner's job to exactly 1,700 cents; points / EGP within the lattice; discount and tax; ties go down; the limits; 300 random documents: the reported total is the real total and no single or paired step gets nearer (brute-force check), deterministic).

### Layout actions

- «خلي الـ PDF صفحة واحدة»: the sheet's page count is only known from the real measurement in the browser, so the builder folds sectors into «summary only» rows (largest first; then lines with no sector are hidden together) until the measured page count fits, trusting a measurement only when it belongs to the CURRENT document (capped at 60 steps). Totals never change. The chat says what it did (or the fewest pages it could reach).
- «شيل الأرقام المخفية»: read as **show the hidden lines again** (`unhide_all`). A hidden line still counts in every total and appears as one row «بنود أخرى (n)»; deleting hidden lines would break the rule that the printed rows add up to the totals. *This reading is an assumption (see NOT PROVEN).* Hiding a given line is `hide_line_ids` (ids `L1…` that code gave the model).
- «ضيف ملخص المراحل»: the sector summary table is already printed whenever a document has sectors, so this confirms it. Hiding it (`show_phase_summary: false`) is a display option for the current session and its export only; **it is not stored** (storing it would need SQL).

### Model and cost

`claude-haiku-5-5` (the cheapest current model, with vision), effort `low`, `max_tokens` 6000, list price $0.10 input / $0.50 output per million tokens (prompts up to 100K tokens). The call is a plain `fetch` with the app's existing server-side key (`resolveProviderKey("anthropic")`), like the earlier helper (the repo does not use the Anthropic SDK; adding it would be a new dependency).
Estimated from the real request (text length ÷ 2.2 to 3.2 characters per token; Arabic and JSON are the pessimistic end): a text-only turn (system prompt 5.5K characters + payload) about 1,800 to 2,500 input tokens and 150 output = **$0.0003 to $0.0004**; the first turn with the three fixture files (3.9K characters of payload) about 2,900 to 4,300 input and 700 output = **$0.0006 to $0.0008**; a picture adds roughly 1,500 input tokens ($0.00015).
A whole invoice (one turn with files, about six short turns) is **about $0.003 to $0.005**. The worst case the limits allow (14K input, 6K output) is **$0.0044** a call, and 30 calls an hour is at most **$0.13 an hour** per admin. Real token counts are recorded per call in the audit table (model, input, output, cost).

### Not what was asked (and why)

- **`.xls`** (the old binary Excel format) is refused with «احفظه xlsx»: `exceljs` cannot read it and the only library that can (SheetJS from npm) is stale with known advisories; no dependency was added. `.xlsx`, `.csv` (UTF-8 or Windows-1256, `,` `;` tab `|`), `.png`, `.jpg` work.
- **Upload size**: the screen stops a message above about 4 MB in total (a Vercel function accepts a body of about 4.5 MB). The server enforces 10 MB per file as asked, but a 10 MB file cannot reach it through that platform limit. Files can be sent in several messages (a sector re-imported by name is REPLACED, never doubled).
- The chat history lives in the browser tab (memory only): a page reload clears it, the draft in the builder is as before (saved only by «حفظ مسودة»).

## Changed existing test lines (19 removed, with the reason)

- `tests/invoice-form.test.ts` (5), `tests/invoice-sectors.test.ts` (5), `tests/invoice-total-bug.test.ts` (1), `tests/invoice-assist.test.ts` (1): the TEXT of a unit price is now dollars: «12» cents became «0.12», «0.45» became «0.0045», and the over-precise example «0.455» became «0.00455». Every stored value and every total they assert is unchanged.
- `tests/invoice-simple-builder.test.ts` (2): asserted the rate box exists only while the rate is empty, which was bug A1; now asserts `showRateBox(form)` and the new note.
- `tests/invoice-access.test.ts` (3): the route list and the handler count 16 to 17 (the new `POST /agent`, admin-first like the others).
- `tests/invoice-assist.test.ts` (+1 line): the in-memory SQL model stamped audit rows at a FIXED 2026-10-31T10:00Z while the route counts the last hour on the real clock, so «20 an hour» passed only within an hour of 10:00Z that day; the model now takes the real clock. A pre-existing flaw of my earlier test, found because main moved on and the clock with it.
- `tests/methodology-section.test.ts` (2): the guard «nothing reads a delivered workbook's first sheet» lists the files that open a workbook; `src/lib/server/invoices/chat/parseFiles.ts` opens only the ADMIN's own uploaded spreadsheets (never a delivered file, never written back) and was added to the list with that reason. `agent/src/finalize.ts` and the settlement are untouched.

## NOT PROVEN

- **A real model call.** Every test and the browser run use a scripted stand-in that reads the real masked request. It proves the real model is given what it needs and that the code rejects what is not allowed; it cannot prove the real model chooses the right columns or actions. The first real turn is the test. The key and the fetch were never exercised against the real API (effort retry included).
- **Vision**: the picture path (base64 image block, browser downscale) was exercised with a 1×1 test image; the quality of real counts from a real photo is unknown, which is why they are «تقريبي».
- «شيل الأرقام المخفية» = show hidden lines again is an interpretation.
- Real xlsx files from the owner's phone and Excel for Mac / Google Sheets exports (fixtures are built with `exceljs`); very large real files; `.xls`.
- A real phone's file picker, keyboard and photo library; «Save as PDF» outside Chromium. The 1-page PDF was produced by headless Chromium (`B5-one-page.pdf`, `pdfinfo`: 1 page).
- Page-fit is measured in Chromium with the real font; another browser can measure a row differently.

## Files

`src/lib/invoices/chat/` (limits, mask, types, profile, count, actions, reply, targetTotal, apply, fit, proposal, prompt), `src/lib/server/invoices/chat/` (parseFiles, run), `src/app/api/admin/invoices/agent/route.ts`, `src/components/admin/invoices/InvoiceChatPanel.tsx` (+ builder wiring), `src/lib/invoices/priceInput.ts` (part A), small changes in `form.ts`, `money.ts`, `totals.ts` (`finishTotals`, `addMoney`, `subMoney`), `sheetModel.ts` (display option), `InvoiceSheet.tsx` (`settled`), `adminApi.ts` (FormData), `server/invoices/assist.ts` (`callAnthropicBlocks`).
Folder and component names say «chat» (not «agent») because `tests/invoice-ledger-isolation.test.ts` forbids any import path containing «agent» (the platform's agent worker); the route URL stays `/api/admin/invoices/agent`.
Tests: `tests/invoice-live-fixes.test.ts`, `invoice-agent-{mask,parse,count,reply,target,apply,server,ui}.test.ts`, helpers `tests/helpers/agentFixtures.ts` and `agentFakeModel.ts`.

## Rollback

`git revert -m 1 <merge commit>`. No SQL was involved.
