# Public calculator shows the owned plan card price and hold, and company deduplication preserves distinct branches

DT-20261121-audit / FX-M2 (M7, M8, L4) and FX-M3 (M6, M9, M10) under D-0180 / D-0185 / D-0186, based on `origin/main` `2707f991175e969dfac45a1b13d36cff9746c491`.

## FX-M2 — Calculator = Sealed Card Parity

- **Root cause:** `POST /api/calculator/estimate` and `src/components/calculator/MissionEstimator.tsx` previously ran a separate static estimator (`src/lib/missionEstimate.ts` / `src/lib/pricingPage.ts`) and read a provider daily ceiling instead of projecting the worker's sealed plan card.
- **Fix:** The calculator now starts an ordinary agent-only planning conversation (`source: "calculator"` → `calculatorPlanOnly: true` in `src/app/api/chat/route.ts` and `src/functions/shared/chatHandler.ts`, never entering legacy planner/quote paths), preserves structured pre-card and split clarification (`splitSummary: true` in `src/lib/agentMission/chatTurn.ts`), and reads owned sealed cards via `POST /api/calculator/estimate` (`{ missionIds: string[] }`, `loadCustomerMission`, `calculatorCardOf` in `src/lib/missionEstimate.ts`) with separate «السعر حتى» and «حجز مؤقت» labels and `Cache-Control: private, no-store`. Public copy on `src/app/calculator/page.tsx`, `src/lib/pricingPage.ts`, and `src/app/pricing/page.tsx` links visitors to `/calculator` without hardcoded point rates or guessed capacity.
- **L4 interpretation:** A 200-point minimum makes per-company effective cost vary inversely with small volumes (4/company at 50 vs 1/company at 200), whereas above the floor (such as 1,000 rows at 5,892 points) measured yield, stages, and markup govern. T9 controlled proof (`markup: 12`) shifts 20 companies from `622 / 715` to `746 / 858` on the exact same measured inputs.

| Replay case (offline fakes, 0 live spend) | Card & Calculator charge | Card & Calculator hold | Counter-case / settlement |
| --- | ---: | ---: | --- |
| 20 companies with 30-day filter | 622 | 715 | No quote/job/reserve on preview |
| 10 companies + 1 manager each (email + phone) | 2,591 | 2,980 | No quote/job/reserve on preview |
| 200 Facebook comments (funded schedule) | 207 | 752 | Partial 162 → 168 charged / 584 net released; 0 rows → 0 charged / 752 released (D-0185 unchanged) |
| 20 companies at `markup = 12` | 746 | 858 | Saved edit + `199`-pt unaffordable `top_up` preview |

## FX-M3 — Branch-First Company Deduplication, Phone Shape & People Settlement Cap

- **M6 (`companyQuality.ts`, `itemStore.ts`, `ingest.ts`, `engine/run.ts`, `runMission.ts`):** Branch-level identifiers (`branch_id`, `outlet_id`, `location_id`, `store_id`) and distinct full street addresses take priority over shared company-level signals (`registration`, `profile`, `website+name`), assigning stable internal store IDs when raw IDs collide, scoping child lookups strictly to each branch's own external key (or leaving ambiguous shared-parent children unattached), preserving branch evidence across restarts, and excluding duplicates (`duplicate_company`) and identity conflicts (`company_identity_conflict`) before workbook sealing.
- **M9 (`src/functions/shared/decisionMakerPricing.ts`):** Legacy `contactValueDelivered` checks `phoneShape` on the original phone field so date-only strings (`"2026-11-21"`) do not bill base or phone units.
- **M10 (`supabase/migrations/20261122020000_record_people_settlement_cap.sql`):**
  - Additive/replacement migration SHA-256: `7f54e288e4bfcf5f95e4553d160897692f7c6c3f88fd4100cdd5239306c0a0f7`.
  - Raises `settle_people_job_atomic` default, `NULL` fallback, and final clamp from `600` to `25,000` (matching ordinary/stage settlement and `docs/proposals/job-cap-25000/02_settle_people_job_atomic_cap_25000.sql`), verified on disposable scratch PostgreSQL (`600 → 774` for 3 complete decision makers at `83 + 120 + 55`, cap `700` / `25,000`, reserve cap, idempotent duplicate settle, `service_role` only).

## Adapted existing tests (approved under FX-M2/FX-M3 Gate 1)

- `tests/account-suspension-route-inventory.test.ts`
- `tests/audit-phase2-flow-clarity.test.tsx`
- `tests/audit-phase4-mobile.test.tsx`
- `tests/calculator-estimator.test.tsx`
- `tests/decision-maker-pricing.test.ts`
- `tests/live-cap-surfaces.test.ts`
- `tests/live-check-fixes.test.tsx`
- `tests/mission-duration.test.tsx`
- `tests/mission-estimate.test.ts`
- `tests/pricing-page.test.tsx`
- `tests/public-pages-people-and-latin.test.tsx`
- `tests/security-hygiene.test.tsx`
- `tests/ui-pass-1.test.tsx`
- `tests/wallet-and-public-fixes.test.tsx`

## Rollout and rollback

- Deploy app changes with `FX-M2` / `FX-M3`; Commander applies `20261122020000_record_people_settlement_cap.sql` only after exact-head Gate 2 GREEN and QA PASS.
- **App rollback:** `git revert <merge-sha>` restores previous calculator route/UI and company/phone behavior without DB changes; already created calculator conversations remain accessible in `/chat`.
- **SQL rollback:** Owner review of prior `settle_people_job_atomic` definition against accepted prices before restoring `600`.
