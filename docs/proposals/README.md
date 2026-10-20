# Money proposals (NOT applied, NOT merged)

Everything here is prepared on the parked branch `claude/money-bundles-and-pricing` and waits for the owner's decision at gate G-MONEY.
Nothing in this folder is in `supabase/migrations`, nothing was applied, and no function of the live money path
(`settle_job_atomic`, `release_job_atomic`, `approve_topup_atomic`, `accept_quote_atomic`, `reserve_credits_atomic`) was changed.

## Apply order (each file is independent of the later ones; 01 is required by 02, 03, 04)

| # | File | What it adds | Ledger ids |
|---|------|--------------|-----------|
| 1 | `01_extend_ledger_kinds.sql` | three new kinds in the append-only kinds table | none |
| 2 | `02_bundle_bonus.sql` | `wallet_bundles` (7 bundles), `topup_bundle_choices`, `record_topup_bundle_choice_atomic`, `grant_topup_bonus_atomic(topup id)` | `bon_<topup id>` |
| 3 | `03_email_bonus.sql` | free-domain list, bonus accounts, `grant_email_bonus_atomic(topup id)` (+5 percentage points, «بريد عمل أو جامعي») | `bon_email_<topup id>` |
| 4 | `04_referral.sql` | codes, referrals, `register_referral_atomic`, `grant_referral_reward_atomic` | `ref_<referral id>_referrer` / `_referee` |
| 5 | `05_job_cap_and_start_gate.sql` | `job_points_cap()`, `provider_spend_today_usd()`, `job_start_gate()` (read-only) | none |
| 6 | `06_custom_offers.sql` | `custom_offers`, `admin_create_custom_offer_atomic`, `consume_custom_offer_atomic` (no ledger write) | none |
| 7 | `07_pg_cron_driver.sql` | `drive_jobs_tick()` + a one-minute schedule (needs two Vault secrets, see the file) | none |

Every function is `SECURITY DEFINER`, has a pinned `search_path`, is `REVOKE ... FROM PUBLIC, anon, authenticated` and granted to
`service_role` only. Every credit row is `type = 'grant'` (positive), has a deterministic id, and is written after taking an advisory
or row lock, so a repeat can never credit twice. The ledger stays append-only.

## What a later wiring step would change (frozen today, listed so nothing is a surprise)

1. **Unit prices (4d):** `calculateCapabilityUnitPricePoints` returns a whole number; replace it by `src/lib/money/pricingProposal.ts`
   (`unitPriceMicro`, `billedUnitMicro`) and store the fractional unit in `capability_registry.unit_price_credits` and `jobs.unit_price`
   (both already `numeric`). Settlement already does `CEIL(delivered x unit_price)`, so `settle_job_atomic` needs no change for this.
2. **Cap (4e):** change the literal `600` in `settle_job_atomic` (default and clamp), `settle_people_job_atomic` and the
   `create_quote_atomic` proposal to `public.job_points_cap()`; in TypeScript `DEFAULT_JOB_POINTS_CAP` (`providerSpend.ts`,
   `calculatorPricing.ts`) and the hard-coded 600 in `decisionMakerPricing.ts`, `platformGuide.ts` read the same setting. The 600-point
   confirmation threshold lives in `src/lib/money/capsProposal.ts` and `job_start_gate`.
3. **Bundles, bonuses and referral (4a-4c):** `approve_topup_atomic` is NOT edited. (a) The top-up submit route (`src/app/api/topup/submit/route.ts`, today only `amount > 0`) enforces the 100 EGP minimum for a free amount (`checkFreeAmount`) and, for a bundle, calls `record_topup_bundle_choice_atomic` after the pending row exists. (b) The admin approval route (`src/app/api/admin/topups/approve/route.ts`), after the approval returns success, calls in order `grant_topup_bonus_atomic`, `grant_email_bonus_atomic`, `grant_referral_reward_atomic`; all three are idempotent so a retry is safe. Note: that route has a TypeScript fallback that writes the ledger row itself when the RPC is missing (`callAtomicOrFallback`, line 77-96); the bonus functions only act when `top_<topup id>` exists, so they are safe after either path.
4. **Custom offers (4f):** the quote writer reads the customer's open offer for the unit price and the higher reserve limit; plan
   acceptance calls `consume_custom_offer_atomic`.
5. **Driver (4g):** add `/api/cron/drive` (already on this branch) and apply file 07.

## Verification done

`verify/run.mjs` loads files 01-07 into a throw-away in-memory Postgres (PGlite) next to minimal stand-ins for `auth.users`, `profiles`,
`credit_ledger` (with its real CHECK constraints), `topups`, `settings_private`, `provider_costs` and `jobs`, then exercises every
function: grants, idempotent repeats, refusals, role privileges. Run: `npm i --no-save @electric-sql/pglite && node docs/proposals/verify/run.mjs`.
**Not verified:** behaviour against the real project (the proposals were never applied; stand-in tables are simplified), concurrent calls
(the locks are standard Postgres advisory/row locks, but no concurrency test ran), and `pg_cron`/`pg_net`/Vault (stubbed).
TypeScript counterparts and their tests: `src/lib/money/*.ts`, `tests/money-proposals/*.test.ts`.
