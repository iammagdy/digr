# Admin invoices: «مساعد الفواتير» 2 (INVOICE AGENT 2)

Follow-up to `docs/ADMIN_INVOICES_AGENT.md`. The owner counted his five real xlsx files with a script and the assistant was wrong; he also asked for a conversation instead of a form, the look of Diger's customer chat, and polish from his first real invoice.
**No SQL.** No wallet, ledger, mission, price-engine, cap or agent-worker code touched. The real files were never used or committed (they hold personal data): every test uses SYNTHETIC files that reproduce their SHAPES.
Evidence (screenshots at 380 px, the browser run, the old-code counts): `docs/admin-invoices-agent-2/`.

## 1. Why the counts were wrong (root causes, reproduced)

The shapes: row 1 = a title MERGED across the table, row 2 = the headers, data from row 3; a company row has «م» and the company name and the rows below it with an empty company cell are MORE contacts of that company; cells may hold several values separated by « / » (phones with «(Ext. 142)»);
the petroleum workbook has an OVERALL sheet and two DETAIL sheets of the same companies. Synthetic files with exactly those shapes: `tests/helpers/ownerShapeFixtures.ts`.

| Case | Truth (by construction) | Old code | New code | Root cause of the old number |
|---|---|---|---|---|
| Electromechanical, 4 files x 50 companies | 200 companies, 601 managers, 0 departments | **201 / 605** (header row used = 1 in all four) | 200 / 601 / 0 | exceljs gives EVERY cell of a merged range the master's text, so the merged TITLE looked like a full-width text row and was chosen as the header: the real header row became data, +1 company and +1 manager per file |
| Petroleum, the model maps ONE detail sheet | 149 companies, 239 people, 32 departments | **36 companies** (35 + the header row), 68 manager rows | 149 / 239 / 32 | the other two sheets were never read and nobody was told; the same merged-title bug added the header row |
| Petroleum, all three sheets mapped naively | 149 / 239 / 32 | 150 companies, 547 manager rows | 149 / 239 / 32, **151 repeats ignored** (300 company rows) | the overall list and its details were counted again, sheet by sheet |

(The old-code numbers are from `docs/admin-invoices-agent-2/old-code-counts.json`: the previous `countByMapping` run on these fixtures. The owner's live 605 and 36 are the same two mechanisms; his 36 managers is what that one sheet gave him.)
Proof that the tests catch it: with only the two header fixes reverted (merged-cell reading and the repeated-title rule), 12 of the new shape tests fail, including 200 / 601.

## 2. Part 1: how the files are read now (all by code, in memory)

- **Title and header rows**: a merged range is ONE cell (only its master holds the text), a row whose text is the same in every cell is a title, the header is the first wide text row (`detectHeaderRow`). Header and title rows are never counted.
- **Continuation rows**: a row with an empty company cell belongs to the company above (also when the company is merged down over its rows).
- **One company across sheets and files**: within a SECTOR a company is the same if its Arabic name OR its English name matches (alef, ya, tashkeel, tatweel, spacing and case ignored; «شركة» and «شركه» are NOT equated). The repeats are counted and reported: «تم تجاهل ١٥١ تكرار» (here 150 + 35 + 115 company rows - 149 distinct).
  The parts of one sector count as one: «كهروميكانيكا ١» ... «٤», «ملف 3», «(2)» are the sector «كهروميكانيكا»; the sheets of one file that list the same companies (at least half in common) share one sector whatever the model called each sheet.
- **Overall and detail sheets**: a sheet whose companies contain those of the other sheets of the file is the OVERALL list, the others are its DETAILS (labelled in the details; a tolerance of 5% of the detail's companies). Counting does not depend on the label (repeats are removed anyway); the contacts of the detail sheets are removed as repeats too, so nothing is counted twice.
- **Managers**: a contact is distinct per (company, name); «م.», «د.», «الأستاذ» and spacing do not make two people; the same person listed again is ignored (and reported). A contact row before any company is kept, not counted as a company.
- **People and departments**: a name starting with إدارة / الإدارة / قطاع / قسم / Department / Procurement / Purchasing is a department («جهة تواصل إدارية»), shown apart. The owner can move any row between the two lists («ده شخص» / «دي جهة إدارية», with a search over the people) and the counts change by one.
- **E-mails and phones** are information only (a manager with his e-mail and phones is ONE item): distinct valid addresses; distinct numbers by digits, «/» splits a cell, «(Ext. 142)» and «داخلي ٥٥» are not part of the number, +20 / 0020 / a lost leading zero are one number; fewer than 7 digits are reported, not counted.
- **Never a sheet skipped silently**: the profile shows the model EVERY sheet; a sheet it did not map is matched by its headers to a mapped sheet (same column titles, any order: its mapping is reused and the details say «أعمدتها من ورقة مشابهة»); a sheet with real data (3 rows, 2 columns) that matches nothing is put to the owner («الورقة دي ما اتحسبتش: … أحسبها؟» with «احسبها» / «سيبها»); a smaller one is listed as ignored with its size.
- Size: a 45,000-row workbook is read in about 1.7 s, profiled in 0.4 s and counted in about 2.2 s.

## 3. Part 2: a conversation, not a form

After the files are counted the assistant writes ONE sentence: «لقيت: كهروميكانيكا ٢٠٠ شركة و٦٠١ مدير، البترول ١٤٩ شركة و٢٣٩ مدير و٣٢ جهة إدارية. تم تجاهل ١٥١ تكرار.» (a collapsible «التفاصيل» holds the sectors, repeats, sheets and their roles, the columns used once per distinct mapping, and the people and department lists), then asks ONE question at a time with tappable chips:

1. «هتحاسب على إيه؟» الشركات / المديرين / الشركات والمديرين (skipped when only one kind exists).
2. «فيه ٣٢ جهة إدارية … أضيفها إزاي؟» بسعر صفر / بسعر المدير / من غير (only when departments exist and managers are billed).
3. «عايز الإجمالي يبقى كام؟ ولا أستخدم أسعارك العادية؟» «أسعاري العادية» or a typed amount: «٢٠٠٠ جنيه», «٥٠٠٠ نقطة», «١٧ دولار» (parsed by code; a bare number asks «٢٠٠٠ إيه؟» with جنيه / نقاط / دولار; anything else is explained).
4. «سعر الدولار النهارده كام؟» only when a rate is missing and something needs it, or when dollars are shown or asked for (then one tap on the saved rate).
5. «تحب الفاتورة باسم شركة معينة ولا من غير عميل؟» (not asked when a client is already named).

What the owner already said in his first message («الدولار النهارده ٥٦») is not asked again. Then the draft is built by the existing validated actions (`set_counts`, `set_unit_price`, `set_rate`, `set_client`, `set_target_total`) through the one executor, shown with the total BEFORE and AFTER and the exact difference, and applied only on «تمام» (undo as before). **The model is not called after the files are read: the questions, the parsing of the answers and the final actions are code** (`src/lib/invoices/chat/flow.ts`).
Everything stays editable in the manual builder; the sector card has a fifth box for the departments.

**The owner's billing model**: a manager is ONE billable item (the person with the contact data found); manager e-mails and phones are NOT billed separately; a company's general e-mails and phones belong to the company item. Departments are a separate line, «جهة تواصل إدارية», default price 0 (a virtual item type: if he creates an item type of that name its price is used; a zero price on it is not flagged as a forgotten price).

**Clean prices for a points or EGP target** (`targetTotal.ts`): the search runs on a grid of WHOLE POINTS per item and is used when it lands within 0.1% of the target or as near as the finest search (a hundredth of a cent); a price shared by every line of an item type is tried first (every «شركة» costs the same in every sector), then whole points per line, then the finest grid. The chat says which prices it chose («شركة من ٩ إلى ١١ نقطة») and, when the total is not exactly the target, the exact difference («المطلوب ٢٬٠٠٠.٠٠ جنيه، وأقرب إجمالي ممكن ١٬٩٩٩.٥٦ جنيه، والفرق ٠.٤٤ جنيه»).
A dollar target uses the finest grid (exact in most cases, as before). Limits that remain (see NOT PROVEN): the stored price is in hundredths of a US cent, so a whole-points price is the intended one and the sheet shows the decimals the line totals need (1.101 EGP for 11 points at 50.75).

## 4. Part 3: look and feel

`InvoiceChatPanel.tsx` uses the customer chat's own classes (tests compare them against `src/app/dashboard/chat/page.tsx` and `Composer.tsx`): the user's soft bubble, plain assistant text (15 px light, double line height), the pill answer chips, the pill file chips with a paperclip, the three moving dots, the pill composer with the round send button, the same fade-up animation. Short messages, no emoji, Arabic-Indic digits, no middle dot (it reads like the Arabic zero in this font).
Phone-first: the chat is full height on a phone with its composer pinned at the bottom; from the large breakpoint it sits beside the live preview. File names show the Arabic stem with a small separate extension badge (a name mixing Arabic, a number and «.xlsx» is reordered by the bidi algorithm in every variant tried).

## 5. Part 4: display polish

a. **Unit-price columns**: the fewest decimals at which, for every printed line, quantity x the shown unit is within what the printing itself costs of the printed total: half a cent in that currency (a line is rounded to whole cents once) plus half of the total's last digit (half a point; half a qirsh; for EGP from points, half the point value). One decimal count per column, at most 6. 12 cents at 56.5 EGP/USD shows 67.8 points, so 200 x 67.8 = 13,560 (a whole 68 would print 13,600). The rounding note appears only when no number of decimals can match. Tested on every line of 300 random documents in every currency combination.
b. **EGP = points x point value, exactly**, when both are shown (and the point value is a whole number of qirsh): per line, subtotal, discount, tax and total (17,097 points is 1,709.70 EGP). It lives in `finishTotals`, so the preview, the sent document and the target-total search agree. EGP alone keeps the independent rule. **A sent document is never recomputed**: it prints its frozen numbers (tested).
c. «ملخص المراحل» is **«ملخص القطاعات»**.
d. The payment block (Instapay text, address, QR) is **off on new documents**; one checkbox in «خيارات إضافية» turns it on (it then fills the saved text and the QR) and off again.
e. **Export names**: «فاتورة INV-2026-0002.pdf» (the print dialog takes the page title, set while it is open and restored after), «بيان STM-2026-0001.png», «عرض سعر QUO-….png»; a draft is «مسودة فاتورة» (also «مسودة بيان», «مسودة عرض سعر»); several PNG pages: «… - 2.png».
f. A new document defaults to **EGP only**; points and dollars are chips.

## 6. Changed existing test lines (and why)

- `tests/invoice-sheet.test.ts` (the rounding-note test rewritten, 8 lines): the note used to excuse a unit price shown rounded; the unit column now shows the decimals it needs, so the note appears only when none can match (the new rule is tested in `tests/invoice-display-polish.test.ts`).
- `tests/invoice-sectors.test.ts` (the quick-fields test, 3 lines): there is now a fifth, virtual field («جهة تواصل إدارية»).
- `tests/invoice-agent-count.test.ts` (2 lines) and `tests/invoice-agent-server.test.ts` (1 line): a copy of a file adds no managers (the same person of the same company is ignored); `unmapped` carries its size and status.
- `tests/invoice-agent-ui.test.ts` (the file-to-actions tests rewritten for departments; the confirm-rule regex), `tests/invoice-agent-apply.test.ts` (1 line: the "nearest total" is said once, with the exact difference, instead of twice).
- The new behaviour is covered by `tests/invoice-chat-shapes.test.ts`, `invoice-chat-flow.test.ts`, `invoice-chat-ui2.test.ts` and `invoice-display-polish.test.ts`.

## 7. NOT PROVEN

- **A real model call.** The tests and the browser run use a scripted stand-in that reads the real masked request (and, like the live model did, maps only ONE sheet per file). Whether the real model maps the English-name column, names the sectors without part numbers, or answers «احسبها» correctly is untested live; the code does not depend on it for counts.
- The owner's REAL files: only synthetic files of the same shapes. A real file with another quirk (a header in row 3, people in two columns, a sector in the file name only) may need a mapping correction; the chat's details show every column used so he can see it.
- «Whole points per item» is the intended price; on the sheet the unit shows the decimals the totals need, because the stored unit is a hundredth of a US cent. The 2,000 EGP example lands on 1,999.56 (0.44 off) with per-line prices of 9 to 11 points and 19 to 21 points; a shared price per item type is chosen only when it reaches the target as near.
- A person's name that starts with one of the department words, or a department named like a person, is classified wrongly; the owner can move it.
- A real phone's keyboard, file picker and photo library; «Save as PDF» file name outside Chromium (browsers differ in using the page title).

## Files

`src/lib/invoices/chat/`: `count.ts` (rewritten), `sheets.ts` (new), `flow.ts` (new), `targetTotal.ts` (whole-points grids, shared prices), `apply.ts`, `types.ts`, `profile.ts`, `prompt.ts`, `reply.ts`, `actions.ts`, `proposal.ts`; `src/lib/invoices/unitColumn.ts`, `totals.ts`, `money.ts`, `sheetModel.ts`, `labels.ts`, `form.ts`, `sectors.ts`; `src/lib/server/invoices/chat/parseFiles.ts`, `run.ts`; `src/components/admin/invoices/InvoiceChatPanel.tsx`, `InvoiceBuilder.tsx`, `InvoiceSheet.tsx`.
Tests: `tests/helpers/ownerShapeFixtures.ts`, `invoice-chat-shapes.test.ts`, `invoice-chat-flow.test.ts`, `invoice-chat-ui2.test.ts`, `invoice-display-polish.test.ts`.

## Rollback

`git revert -m 1 <merge commit>`. No SQL was involved.
