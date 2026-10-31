# Admin invoices, simple (INVOICES SIMPLE 1)

Follow-up to `docs/ADMIN_INVOICES.md` (PR #308). Owner feedback after billing a real job (200 electromechanical companies with their managers, plus petroleum companies and contractors for one client):
every line by hand, a complicated builder, and **the total did not work**. This change makes the screen one simple page, fixes the total, adds sector rows, a data-statement mode and a Claude helper.
Invoices stay separate from the points wallet; an issued document is locked exactly as before; every new behaviour is draft-only.

## 1. «The total does not work»: root cause

Reproduced in a headless browser at 380 px on the real builder, against the **live state** (4 item types at price 0, no saved rate, no documents). Screenshot of the old behaviour: `docs/admin-invoices-simple/bug-total-before-empty-totals.png`.

| # | What the owner did | What he saw | Cause |
|---|---|---|---|
| 1 | ticked «نقاط», unticked the dollar, typed no rate | the totals box was **empty** (labels with no amounts); group totals still said «دولار»; the only message came at save time | `src/lib/invoices/form.ts` line 114 (now 123), `formToPreview`: `show: { usd: f.showUsd \|\| (!f.showPoints && !f.showEgp), points: f.showPoints && rate !== null, … }`. With the dollar off and no rate, **all three currencies were off**, so the sheet had no currency column and no amounts. |
| 2 | typed a quantity as «1,200» | that line counted as **0** in the preview, silently (the save then said the quantity is invalid) | `src/lib/invoices/money.ts` `parseScaled` treated «,» only as a decimal mark, so «1,200» (3 decimals) was refused and the tolerant preview read it as 0. |
| 3 | left every item type at price 0 (they start at 0 until the owner sets them) | every total read ٠.٠٠, with no warning | nothing told him that a used item type had price 0. |

Fix and tests (`tests/invoice-total-bug.test.ts`, written first and seen failing for causes 1 and 2; `tests/invoice-sectors.test.ts` for cause 3):
- no rate for points or EGP: the dollar total is shown instead (never an empty box), with a visible sentence next to the field (`rateIsMissing`);
- «1,200», «١٬٢٠٠» and «1 200» are 1200; «12,5» is still refused and never read as 125; «1.200» is refused;
- a sector that uses an item type at price 0 lists it in a red warning («سعر (شركة، مدير) ما زال صفرًا، فلا يدخل في الإجمالي»), and sending a document whose total is 0 shows an extra warning in the confirmation.
The owner's real job built through the form code gives the figure worked out by hand: 200×12¢ + 340×35¢ + 80×12¢ + 120×12¢ = 16,700¢ = **$167.00** = **84,753 points** at 50.75 (each line rounded once), EGP 8,475.25.

A fourth defect was found by the browser run and fixed: switching a document to «بيان بيانات» or deleting a row rendered the new document with a page plan measured for the old one and crashed the whole builder (`tests/invoice-stale-plan.test.ts`).

## 2. The simple builder (one screen)

`src/components/admin/invoices/InvoiceBuilder.tsx`. A short form on top and the **real sheet always visible** under it (beside it from 1024 px), updating as he types.
- **Mode** (new documents): فاتورة، عرض سعر، بيان بيانات. **Client is optional** (one name box; contact, e-mail, phone, address are under «خيارات إضافية»).
- **القطاعات** (a sector is a batch; no new storage): a name (suggestions: كهروميكانيكا، بترول، مقاولات) and four number boxes: عدد الشركات، المديرين، الإيميلات، أرقام الهاتف. A box with a number is one line; an empty box is no line. «+ إضافة قطاع» is one button.
- **Prices fill from the item types**; a small price box appears beside a number so he can change it only if he wants. A zero price is flagged on the box, in a red warning, and again at «إرسال».
- **العملة**: three chips (نقاط، جنيه، دولار), any combination, at least one. The USD rate is not shown or asked unless it is missing: one **saved rate** (settings, editable in «بيانات البائع») prefills silently on every new document and is frozen on the document at «مرسلة». If none is saved yet, the first document asks for it once and saves it.
- **خيارات إضافية** (one toggle): dates, client details, discount, tax, notes, payment text and QR, the document's own rate, summary-only per sector, and the per-line detail (price, hide, description).
- Buttons: «معاينة»، «حفظ مسودة»، «تنزيل صورة» (PNG per page), «تنزيل PDF» (the print dialog, «حفظ كـ PDF»). Arabic only, Arabic-Indic digits in every number box and on the sheet, no emoji.

## 3. «بيان بيانات» (data statement)

Title «بيان بالبيانات المستخرجة»: sectors and counts only; **no prices, no totals, no currency, no payment block, no client required**; numbered `STM-2026-0001`.
It can be sent (locked) or voided, **never marked paid**; it never appears in the unpaid total.
No money can be stored on one, at three levels: the app zeroes it on every save (`normalizeForStatement`), the SQL function refuses a non-zero price, and a table CHECK refuses points, a rate, a discount or tax.
**This needs SQL**: `docs/proposals/admin-invoices/06_statement_mode.sql` (also `supabase/migrations/20261031150000_admin_invoices_statement.sql`). **NOT APPLIED**; the owner applies it. Until it is applied, creating a statement answers with a plain Arabic error (the invoice and quote flows are unaffected).

## 4. The Claude helper (admin only)

«اكتب اللي عملته» + «رتّبهالي». Example: «سحبت ٢٠٠ شركة كهروميكانيكا ومعاهم ٣٤٠ مدير، و٨٠ شركة بترول و١٢٠ شركة مقاولات» gives 3 sectors with their counts as an **editable draft**; nothing is saved until «حفظ مسودة».
- Route `POST /api/admin/invoices/assist`: `authenticateAdmin` first. The key is the app's existing server-side Anthropic key (`resolveProviderKey("anthropic")`), used only on the server; never returned, logged or put in an error (tested).
- **Model: `claude-haiku-5-5`**, effort `low`, `max_tokens` 4000. List price $0.10 input / $0.50 output per million tokens (prompts up to 100K).
- **Cost per call**: a typical call (about 700 tokens in, 500 out) is about **$0.0003** (0.03 US cents, roughly 0.02 EGP); the worst case the limits allow (2,000 characters in, 50 sectors out, 4,000 output tokens) is about **$0.002**. At most 20 calls per admin per hour, so at most about **$0.04 an hour** per admin.
- The model sees the note and the item-type **names** only, and returns only `[{sector, item_type, quantity}]`. **It never sees a price and never sets money.** The reply is accepted only if every entry has exactly those three keys, a known item type of the owner's table and a whole quantity from 1 to 10,000,000, with at most 50 sectors; **any price, total, currency or other extra field rejects the whole reply** (tests). Prices then come only from the item-type table and totals only from the money library.
- Limits: 2,000 characters; 20 calls per admin per hour, counted in `admin_audit_log` and taken **before** the model is called (a failed call still counts; if the attempt cannot be recorded, nothing is sent).
- If it fails the owner gets one short Arabic sentence and **his text stays**. On success the box is cleared, so pressing the button twice cannot add the numbers twice.

## 5. Default prices (a proposal; nothing was written to the database)

The owner sets these from «أنواع البنود» (the box takes cents). They follow his own examples (12¢ a company, 35¢ a manager, 0.45¢ an e-mail) and the platform's per-record price level; points use the sample rate 50.00 EGP per USD (points = EGP ÷ 0.10).

| Item type | Enter (cents) | USD | Points (at 50.00) | EGP |
|---|---|---|---|---|
| شركة | 12 | $0.12 | 60 | 6.00 |
| مدير | 35 | $0.35 | 175 | 17.50 |
| بريد إلكتروني | 0.45 | $0.0045 | 2.25 | 0.225 |
| رقم هاتف | 5 | $0.05 | 25 | 2.50 |

A line is rounded once, so the e-mail price shows up on whole lines: 300 e-mails = 135¢ = 675 points. At the saved rate 50.75 the points are 60.9 / 177.6 / 2.28 / 25.4 per unit (a line's total is the authoritative figure).
The owner's job at these prices: 200 companies + 340 managers = $143.00 (71,500 points at 50.00); the three-sector job is $167.00.

## 6. Changed existing test lines (and why)

- `tests/invoice-service.test.ts`: the test «needs a client and at least one line…» asserted `client_required` for a document with no client; the client is now optional, so it asserts the send succeeds (a line is still required).
- `tests/invoice-access.test.ts`: the route list gains `assist/route.ts` and the handler count goes from 15 to 16 (the helper's `POST`); a new check that part 06 is its own migration.
- `tests/invoice-ledger-isolation.test.ts`: the allowed table names for the static scan gain `admin_audit_log` (the helper counts its own calls there; never a wallet table).

## NOT PROVEN

- The live Claude call: tests use a fake `fetch`; the browser run simulates the model's reply (the real runner, limits and validation run). No real API call was made. `output_config.effort` is retried once without it if the API refuses it, but that was not exercised against the real API.
- Part 06 on the owner's Supabase project (tested on an embedded Postgres only; the verify SELECT is the check).
- A real phone's keyboard and file downloads; «Save as PDF» outside Chromium.
- That the owner's four item-type names are unchanged: the four quick boxes appear only for item types with exactly the names شركة، مدير، بريد إلكتروني، رقم هاتف (a renamed type has no quick box; its lines stay editable under «خيارات إضافية»).
