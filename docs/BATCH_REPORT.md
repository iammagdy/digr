# Feature batch report (promo codes, typed credit, wallet and admin tools, support, identity, file shaping)

Raw evidence only. Anything not run is marked NOT RUN. Post-merge facts (merge commit, production deployment, smoke test) are
appended in a follow-up docs-only pull request after the deployment is verified, and are in the final message.

## Baseline and tests

| | main 7aa1782 (before) | this branch (after) |
|---|---|---|
| `vitest run` | 155 files, 1293 tests passed | 167 files passed, 1 skipped (the scratch-Postgres suite); 1430 tests passed, 11 skipped |
| `vitest run` with `DIGER_TEST_PG` set to a scratch PostgreSQL 16 | not run | 168 files, 1441 tests passed (the 11 real-SQL tests included) |
| `tsc --noEmit` | exit 0 | exit 0 |
| `npm run build` | READY on Vercel | exit 0, 101 client files scanned, zero client-bundle secrets |

No migration was applied by the author. The database was only read (SELECT).

## The 15 items

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Credit typing | DONE | Side table `credit_ledger_kinds` plus view `credit_ledger_typed`; legacy `topup` rows classify as `topup_instapay`, `grant` and `goodwill` as `admin_grant`; the view's `SUM(delta)` and row count equal the ledger's (real-SQL test). The ledger itself is untouched. Migration file only (not applied). Live ledger by type today (read-only): topup 14 rows / 10,965 points, grant 2 / 200, charge 59 / -1,628, release 176 / 4,649, reserve 188 / -4,844. |
| 2 | Promo codes | DONE | `promo_codes`, `promo_redemptions`, `redeem_promo_code_atomic` (locks the code row, serializes redemptions) and `admin_grant_credit_atomic` (admin role checked inside from the auth record, idempotent by request id) plus `admin_save_promo_code_atomic`. Real-SQL test: one account cannot redeem twice (repeat refused, balance unchanged); 25 parallel redemptions of a code limited to 7 gave exactly 7 credits; 8 parallel redemptions by one account gave 1; a non-admin is refused by the functions themselves. |
| 3 | Customer wallet | DONE | «كود ترويجي» box with Arabic outcomes and an immediate balance refresh; history labelled «رصيد ترويجي», «هدية من الإدارة», «شحن عبر انستاباي». Not tried in a real browser (NOT RUN). |
| 4 | Admin «الأكواد الترويجية» | DONE | Create, edit, enable/disable, remaining count, and per code the accounts that redeemed with time and «حساب جديد / حساب قائم» (created within 7 days before). Not tried in a real browser (NOT RUN). |
| 5 | Admin user detail | DONE | Balance, creation date, last sign-in (from the auth record), job count and last job time, promo used, full credit history with kind, amount, running balance, note and granting admin; «إضافة رصيد يدوي» form. Non-admin refused at the route and in the SQL function. |
| 6 | Finance summary | DONE | Real income (approved Instapay, EGP and points) apart from promotional points, admin-granted points, consumed, refunded and net outstanding, with a date filter. Test: promo and admin credit never count as income. |
| 7 | Low balance in chat | DONE | Message written by code from the quote and balance: reduce to what fits, or top up and continue in the same conversation with the same plan; announced again once the top-up makes the plan affordable. States: affordable, can reduce, top-up only. |
| 8 | Paid exploration and cap statement | PARTIAL | DONE: the offer for large or vague social plans (sample of 10 records priced by the shared formula, at least 1 point, 15% buffer on the reserve only), a button that swaps the plan for that sample quote, an Arabic explanation of the sample's result from its own numbers, a plain statement of how many records fit under the 600 cap, and `JOB_MAX_POINTS_CAP_LARGE = 2000` as a documented constant (default off, needs the flag and an explicit customer confirmation; nothing reads it, so the live cap is unchanged). NOT RUN: a real sample job end to end (no provider call was made); the sample result message is covered by unit tests only. |
| 9 | Volume pricing | PARTIAL | Module, flag (default off), floor, tiers and tests are done and the arithmetic is below. Deliberately NOT wired into the quote builder: the live formula and the 600 cap must stay unchanged until you pick the tiers. |
| 10 | File shaping | DONE | The model returns a strict spec (columns, filters, sort, group by); code validates it against the real columns (any extra key such as price, points or formula invalidates it), builds the Excel (one sheet per value, Excel sheet-name rules, formula guard on every cell) or shapes the CSV and PDF rows, from the saved data with no provider call and no charge. Download link `/api/jobs/<id>/download?format=xlsx&spec=...`. PDF grouping is not supported (filters, sort and columns are). Not tried in a real browser (NOT RUN). |
| 11 | Support | DONE | `/contact` form (stores to `support_messages` after migration 3, sends through Resend when `RESEND_API_KEY` exists on the site), support email and WhatsApp number from admin settings (placeholder «سيُضاف قريبًا» until set), admin list «رسائل الدعم», «بلّغ عن مشكلة» on failed and partial jobs that sends the job id automatically (owner of the job only, one report per job). |
| 12 | Emails | DONE | Verified in code and tests: sender `Diger <noreply@diger.tech>` (verified domain), key read as `RESEND_API_KEY` in the Edge Function, deterministic idempotency keys `job-done:<jobId>` and `topup-approved:<topupId>`, sent after settlement inside their own try/catch. New: fixed safe failure reason codes (`resend_not_configured`, `resend_rejected`, `unauthorized`, `timeout`, ...) in logs and results; never an address, header or body. Finding: `RESEND_API_KEY` is not set on Vercel; the Edge Function reads it from Supabase secrets (not checked, no access). |
| 13 | Diger AI identity and speed | PARTIAL | DONE: the fixed identity, tone and ban on vendor talk in the prompt, «إنت مين؟» and technology questions answered by code (no model turn), final replies scrubbed of vendor names and generic chatbot phrasing, model string unchanged. The Arabic name is «ديجر الذكي» (customer text must be Arabic only). Cost: see below; the 0.005 USD target is NOT yet verified in production. |
| 14 | Security hygiene | DONE | The capability id is no longer in page markup: the built site served locally has 0 provider-name hits in `/`, `/services`, `/calculator` and `/contact` (production before this change had 1 on `/services` and 1 on `/calculator`). Content-Security-Policy added in report-only mode with `/api/csp-report`. Remaining risks below. |
| 15 | Tests | DONE | Every case you listed is covered (see the list below). |

### Required tests (item 15)

- One code cannot be redeemed twice by one account: real SQL (`tests/sql/promo-and-grants.local-pg.test.ts`) and function-level tests (`tests/promo-wallet-admin.test.ts`).
- Concurrent redemptions never exceed the maximum: real SQL, 25 parallel against a limit of 7.
- A non-admin cannot grant credit even calling the routes directly: `tests/promo-wallet-admin.test.ts` (401 without a session, 403 for a customer, a spoofed role in the body or headers changes nothing) and the SQL function (`not_admin`).
- Balance equals `SUM(delta)` unchanged for legacy data: `tests/promo-wallet-admin.test.ts`, `tests/migration-fallbacks.test.ts` and the real-SQL test.
- Finance summary excludes promo and admin credit from real income: `tests/promo-wallet-admin.test.ts`, `tests/migration-fallbacks.test.ts`.
- Prices and quotes unchanged across account types and balances: `tests/low-balance-flow.test.ts` (same quoted, expected, unit price, volume and formats for balance 0, 100000, researcher, business, promo history).
- The screens work BEFORE and AFTER each migration: `tests/migration-fallbacks.test.ts` drives every new route with the tables and functions missing, then present.

## Model cost per turn (item 13)

Measured from the live `llm_usage` table (read-only), turns of the Claude model from 2026-10-13 to 2026-10-18 (before the cacheable prompt reached production): 287 turns, average 0.01528 USD, median 0.01532, 90th percentile 0.02008; average 17,562 input and 459 output tokens; average latency 6.6 s, median 5.7 s. Daily averages 0.01376 to 0.01675 USD. That is about three times the 0.005 USD target.

Offline estimate of the real prompt after the cacheable-prompt change (`npx tsx scripts/measure-llm-cost.ts`, no model call): the fixed rules are about 6,600 tokens (chars/4) and the per-turn context about 970; the full capability list (20) stays in the prompt.

| Turn | chars/4 | cautious (chars/2.5, Arabic uses more tokens) |
|---|---|---|
| first turn, cache write, short reply | 0.00814 USD | 0.01256 USD |
| typical turn, cache hit, short reply | 0.00238 USD | 0.00316 USD |
| typical turn, cache hit, plan reply | 0.00430 USD | 0.00508 USD |
| long conversation, cache hit, plan reply | 0.00790 USD | 0.00868 USD |

Reading: with caching, a typical turn is at or under 0.005 USD, a plan reply is at the target, and a first turn or a long conversation is above it. The estimate counts the prompt and a typical history, not the catalogue block added on search turns (up to about 2,500 tokens), so the real average will be somewhat higher. Real post-deploy numbers are NOT RUN: they need turns made after this deployment (ask Codex to run the browser test, then read `llm_usage`).

## Volume pricing proposal (item 9, flag off, not wired)

Rule: the price of one record is the provider's cost in points (`cost USD x 55 / 0.10`) times a markup multiple, rounded up. Today the multiple is 10. Tiers lower the multiple for large jobs; the price is never below cost x 4 (floor) and never above today's price. Below 100 records nothing changes.

| Records | Markup | Rule |
|---|---|---|
| 1 to 99 | 10 (today) | unchanged |
| 100 to 499 | 8 | `ceil(cost points x 8)` |
| 500 to 999 | 6 | `ceil(cost points x 6)` |
| 1000 and more | 5 | `ceil(cost points x 5)` |

Arithmetic from the live registry (provider cost read-only on 2026-10-18; points per record = cost x 550):

| Service | Provider cost per record | Cost in points | Today | 100+ | 500+ | 1000+ | Floor |
|---|---|---|---|---|---|---|---|
| TikTok comments | 0.001 USD | 0.55 | 6 | 5 (-17%) | 4 (-33%) | 3 (-50%) | 3 |
| TikTok videos | 0.001 USD | 0.55 | 6 | 5 (-17%) | 4 (-33%) | 3 (-50%) | 3 |
| YouTube comments | 0.0009 USD | 0.495 | 9 | 4 (-56%) | 3 (-67%) | 3 (-67%) | 2 |
| YouTube videos | 0.0009 USD | 0.495 | 5 | 4 (-20%) | 3 (-40%) | 3 (-40%) | 2 |
| Facebook comments | 0.00188 USD | 1.034 | 11 | 9 (-18%) | 7 (-36%) | 6 (-45%) | 5 |
| Facebook posts | 0.002 USD | 1.1 | 11 | 9 (-18%) | 7 (-36%) | 6 (-45%) | 5 |

Facts that decide it:

- With the live 600-point cap and the 15% buffer, the most records one job can hold today is 86 (TikTok), 57 (YouTube comments), 104 (YouTube videos), 47 (Facebook). Only the first tier is reachable under 600, and only for TikTok (104 records at 5 points) and YouTube (130 at 4 points); Facebook (57 records at 9 points) does not even reach 100.
- Even with a 2,000-point cap, the 500-record tier is reachable only for YouTube (579 records at 3 points); TikTok fits 434 at 4 points, Facebook 248 at 7 points. The 1,000-record tier is not reachable anywhere. So the tiers only matter if you also raise the cap, or if you lower the record counts of the tiers.
- YouTube comments cost you 0.495 points of provider cost but are priced at 9 points (an effective multiple of 18) in the registry, against 10 for most others; the proposal would cut that to the same multiples as the others.

## Migrations (none applied by the author)

Apply in this order, each followed by its verification (full text in `docs/APPLY_MIGRATIONS_2.md`):

1. `20261018140000_credit_ledger_kinds.sql`
2. `20261018140500_promo_codes_and_admin_grants.sql` (needs 1)
3. `20261018141000_support_messages.sql`

Merging this pull request does not apply them: the repository already holds migration files that are not in the database's migration history (`20261013170000_welcome_email_on_confirm`, `20261015185600_prevent_claim_after_collection_complete`, `20261016011500_seed_company_and_people_capabilities`), and the six files merged earlier were applied by hand under other version stamps. Whether those three were applied by hand under other names or never applied was not checked (verify before launch).

## Remaining risks

- Promo codes, typed history and manual credit stay off (the screens say so in Arabic) until migrations 1 and 2 are applied. Until migration 3 and a `RESEND_API_KEY` on Vercel exist, the contact form cannot store or send; it then says so and points to WhatsApp.
- `RESEND_API_KEY` is not set on Vercel (only in Supabase secrets, unchecked): add it before relying on the contact email.
- The rate limits on promo attempts (8 per 10 minutes per account) and on the contact form (5 per 10 minutes per address) are in memory per server instance; serverless instances do not share them. They slow guessing and spam; they are not a hard limit.
- The Content-Security-Policy is report-only and allows inline scripts and styles (Next needs them until a nonce setup replaces them). Violations are logged as `[csp:report]`; nothing is blocked yet.
- The client JavaScript still contains the stored capability slug (the markup does not). It is not visible text.
- Exploration, volume pricing and the larger cap are proposals that need your decision; none changes a price or cap today.
- File shaping was not tried in a browser; for tabular results the columns are named «حقل إضافي ١» and so on, so a customer must use the column's key (the assistant is given the list) or one of the clearer titles social and company results have.
- The deterministic identity answers use the Arabic name «ديجر الذكي»; if you want the Latin «Diger AI» in customer text the Arabic-only rule must change.
- Existing legacy `grant` rows in the ledger (2 rows, 200 points) are classified as admin credit; if they were meant as something else, say so.
- The production cost per turn is not yet measured after the cacheable prompt (see above).

## Owner's to-do list (nothing is applied for you)

1. Review and apply the three migration files in order (`docs/APPLY_MIGRATIONS_2.md`); then create the launch code in «الأكواد الترويجية» (for example 500 points, the number of friends, an expiry date).
2. Set `RESEND_API_KEY` on Vercel (same key as in Supabase), and the support email and WhatsApp number in the admin settings.
3. Change the test account password; clean test accounts and balances (`docs/OWNER_SQL.md`).
4. Set the Anthropic monthly spend cap.
5. Decide the volume-pricing tiers and whether to raise the per-job cap (the two go together).
6. Ask Codex to run the browser test on https://diger.tech with the test account: wallet and promo box, admin pages, «شيت لكل …» file shaping, the exploration button, the contact page and the report button. Then read `llm_usage` for the real cost per turn.
