# Admin invoices («الفواتير»)

An **admin-only** builder for quotes («عرض سعر») and invoices («فاتورة») for research work the owner does by hand for companies, with a PDF and PNG export carrying the Diger logo.
It is **completely separate from the points wallet** (see "Isolation"). The SQL was **applied by the owner** on 2026-10-31 (parts 01 to 05, one at a time) and checked by `98_verify_after_apply.sql` (18 rows, `ok = true`); see `docs/proposals/admin-invoices/README.md`.

> **Update (INVOICE AGENT 1):** a unit price is now TYPED in US dollars (up to 4 decimals) or in points per item, never in cents; the stored unit is unchanged. A chat assistant fills the draft from files and words: `docs/ADMIN_INVOICES_AGENT.md`.
>
> **Update (INVOICES SIMPLE 1):** the builder is now one simple screen with sector rows, a data-statement mode («بيان بيانات»), one saved exchange rate, a Claude helper, and the «total does not work» fix: see `docs/ADMIN_INVOICES_SIMPLE.md`. The statement mode needs SQL part 06 (not applied until the owner applies it).

## What it is

- **Screens** (`/admin/invoices`, section «الفلوس والشحن»): the list (filters by status, type, client, text; the total still unpaid), the builder, item types with default prices, saved clients, seller text.
  Built for a 380 px phone: cards instead of wide tables, 16 px inputs, 44 px touch targets; a table that must be wide (item types) scrolls inside its own box; the page never scrolls sideways.
- **Documents**: type (quote or invoice); client block (saved clients are reusable; the document keeps its own copy); lines (type, description, quantity, unit price prefilled from the type and editable per line);
  batches («المرحلة ١ — ٥٠ شركة») with a subtotal each and a summary of the batches; discount (percent or fixed dollars); an optional tax line (off by default); notes; payment text (from the saved Instapay address) with an optional QR;
  issue and due dates; per-line hide; per-batch «summary only».
- **Hide rules**: a hidden line still counts in every total. The reader sees ONE row «بنود أخرى (n)» with its amount; a summary-only batch is one row (title, count, subtotal). A test checks that the printed rows always add up to the printed totals.
- **Statuses**: مسودة → مرسلة → مدفوعة, or ملغية. A confirmation dialog precedes «مرسلة», «مدفوعة» and «ملغية». «مدفوعة» and «ملغية» are final. After «مرسلة» the document is locked (the database refuses any change to lines, prices, rate, client, number);
  the correction is «void, then duplicate». Every change is stored in an append-only log with the time and the admin id; «مدفوعة» also stores the payment date and reference. Nothing is e-mailed: «مرسلة» is a status the owner sets.
- **Numbers**: `INV-2026-0001`, `QUO-2026-0001`, written by a database trigger from a per-type, per-year counter that only goes up (gap-tolerant, never reused, no document is ever deleted). Never by the app, never by a model.
  A quote converts into a NEW invoice (copied lines, its own number, the quote's frozen rate; the rate can be changed only while the invoice is a draft); a quote converts once unless that invoice is voided.
- **Title**: «فاتورة» only; no document is labelled a tax invoice anywhere. The tax and commercial-register lines print only when filled in the seller text.

## Money (integers only, no float anywhere)

| What | Stored as |
|---|---|
| unit price | hundredths of a US cent (`unit_price_usd_centi_cents`): 12 cents = 1200, 0.45 cent = 45 |
| line total | USD cents = **round_half_up(quantity × unit / 100), once per line** (a generated column in SQL, the same formula in `src/lib/invoices/money.ts`) |
| points | whole points = `round_half_up(cents × rate / (100 × point value))`, once per line |
| EGP | qirsh (1/100 EGP) = `round_half_up(cents × rate / 10000)`, once per line |
| exchange rate | EGP per USD × 10,000 (`50.75` = 507500), typed by the owner, **frozen on the document when it is sent** |
| point value | EGP × 10,000 (`1000` = 0.10 EGP), copied from the pricing settings when the draft is created |
| percent | basis points (10% = 1000) |

`round_half_up(x/d) = floor((2x + d) / 2d)`: exact, ties go up. The arithmetic runs in BigInt and comes back as a safe integer; limits (a line ≤ $10,000,000, 500 lines, rate ≤ 1000, point value ≥ 0.01 EGP) guarantee no sum can lose precision (tested at the limits).
**Each currency column is computed from its own lines**; a total is never converted from another currency's total (examples 3 below shows why). Subtotal = sum of the rounded lines (hidden ones included); percent discount = round_half_up of the subtotal in each currency; a fixed discount (dollars) is converted once and capped at the subtotal; tax is on (subtotal − discount); total = subtotal − discount + tax.
In points or EGP the unit-price column is the unit rounded once and may differ from line ÷ quantity; the sheet then prints a fixed footnote.

Worked examples (tests in `tests/invoice-money.test.ts`):

1. R = 50.00: 250 companies × 12¢ = 3000¢ = $30.00 = 15,000 points = 1,500.00 EGP.
2. R = 50.00: 50 managers × 35¢ = 1750¢; 10% off = 175¢ → $15.75; points 8,750 − 875 = **7,875**.
3. R = 50.75, examples 1 and 2 on one invoice, 10% off: USD 4750 − 475 = 4275¢ = $42.75; points 15,225 + 8,881 (8,881.25) = 24,106, discount 2,411 (2,410.6), total **21,695**. Converting $42.75 directly would give 21,696.
4. Fractions: 300 e-mails × 0.45¢ = 135¢ = $1.35 (R = 50.00: 675 points; R = 50.75: 685.125 → 685). With 250 companies × 12¢ and 10% off at 50.00: subtotal 3135¢ (15,675 points), discount 314¢ (313.5 rounds up) / 1,568 points, total 2821¢ / 14,107 points.

## Export (PDF and PNG, no new server and no paid service)

- The sheet is made of **real A4 pages** (210 × 297 mm elements). The browser measures every row with the real font, and `src/lib/invoices/paginate.ts` decides the breaks (a row is never split, a batch heading never ends a page, the column header repeats, the totals block and the notes block stay whole).
  Each page repeats the header with `public/brand/diger-wordmark.svg` and ends with «صفحة ١ من ٣». The page count is exact on screen, in print and in PNG because pages are elements, not CSS counters.
- **PDF**: «طباعة / حفظ PDF» uses `@page { size: A4; margin: 0 }` and the browser's «Save as PDF»: vector, selectable Arabic text, Vazirmatn embedded (checked with `pdffonts`).
- **PNG**: one image per page with `html-to-image` **1.11.13** (MIT, published 2025-02-14, client-only; the one new dependency, pinned exactly). The PNG is byte-identical at 1280 px and 380 px screens (the preview is scaled by an ancestor; the page element is captured at its own size).
- **Arabic**: the browser's text engine does the shaping and right-to-left order. Numbers are Arabic-Indic strings produced by the code (`toArabicDigits`), each part laid out as its own left-to-right box so the bidi algorithm cannot reorder `INV-٢٠٢٦-٠٠٠١` or a phone number.
  The decimal mark is a plain «.» between Arabic-Indic digits because the document font draws «٫» like a slash («٤٧/٥٠»). Digits in free text are shown Arabic-Indic too, except inside e-mail addresses and links. User text loses emoji and hidden direction marks on the way in.
- Never printed: provider names, endpoint ids, provider cost, internal ids, model vendor or any cost-based number. The tables have no cost column; the default prices are the owner's sale prices.

## Isolation from the wallet

No wallet, ledger, balance, mission, reserve, charge, top-up, price, cap or agent code is read, written or imported. Marking an invoice paid records the date and a reference on the document and **credits no points**. The only reads outside the invoice tables are the Instapay address and the point value from `settings_public/pricing`, and the shared Instapay QR constants in `src/lib/topupConfig.ts` (pure constants and one predicate).
`tests/invoice-ledger-isolation.test.ts` runs every action against a database that throws if a wallet-like table or any other function is touched, and scans the imports, the table names and the SQL.

## Admin only

Every route under `/api/admin/invoices/**` starts with `authenticateAdmin` (a test checks every handler (17 now), then checks 401 for no session and 403 for a customer or any non-admin role with no database access at all). RLS is on for the 8 new tables with **no policy**, all privileges revoked from `anon` and `authenticated`,
and `service_role` can only READ the document tables: documents, batches, lines, the counters and the log are written by three `SECURITY DEFINER` functions only.
All 10 invoice functions are revoked from PUBLIC, `anon`, `authenticated` and `service_role`; only the three runtime functions are granted back, to `service_role` alone (the other seven run inside them, as triggers or helpers). Every function has a fixed `search_path`. The verify SELECT checks all of this per function.

## Files

`src/lib/invoices/` (money, totals, sheet model, pagination, validation, form), `src/lib/server/invoices/` (data layer), `src/app/api/admin/invoices/**` (10 route files), `src/app/admin/invoices/**` (3 pages), `src/components/admin/invoices/**`,
`supabase/migrations/20261031120000_admin_invoices.sql`, `docs/proposals/admin-invoices/` (the five SQL parts, verify, rollback, check script), the invoice group in `/admin/export` (`src/lib/adminExport.ts`, `src/app/api/admin/export/**`, `src/app/admin/export/page.tsx`), the menu (`icons.tsx`, `nav.ts`).
Tests: `tests/invoice-*.test.ts`, `tests/helpers/invoiceDb.ts`; one existing test changed: `tests/admin-navigation.test.tsx` (the admin page list gained exactly one page, «الفواتير»).

## Screenshots (`docs/admin-invoices/`)

`invoice-1-page.png` / `.pdf`, `invoice-3-pages-{1,2,3}.png` / `invoice-3-pages.pdf` (the PNGs are the app's own export; the PDFs are Chromium's print of the same sheet), `invoice-3-currencies-fractions-pdf-page.png` (USD + points + EGP and a 0.45¢ price),
and at 380 px: `phone-380-list.png`, `-builder.png`, `-confirm-send.png`, `-sent-with-preview.png`, `-png-export.png`, `-sheet-preview-3-pages.png`, `-item-types.png`.
Made in headless Chromium with the real components and the real data layer over an in-memory model of the SQL (not the live site, which needs an admin login).

## Rollback

`git revert -m 1 <merge commit>`; then, only if the SQL was applied and the feature is abandoned, `docs/proposals/admin-invoices/99_rollback.sql` (download `/admin/export` first).
