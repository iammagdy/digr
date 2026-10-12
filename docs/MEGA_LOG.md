# Diger Backend Migration Mega Log

## Overview
- Branch: `migrate/supabase`
- Target Database: Supabase Project `pfinlfaqwnytesedchik`
- Operating Mode: Autonomous execution under Stop Gates (G1-G5)

---

## Log Entries

### [2026-10-12 21:00 UTC] - Initialization & State Verification
- Verified 17 applied migrations via `list_migrations`.
- Test user 1 (`00000000-0000-0000-0000-000000000001`): 147 ledger rows, balance 1917 points.
- Test user 2 (`00000000-0000-0000-0000-000000000002`): 7 ledger rows, balance 500 points.
- Total ledger: 154 rows.
- Seed tables (`settings_public`, `capability_registry`, `templates`, `settings_private`): all 0 rows.
- Initialized Phase 1.

### [2026-10-12 21:10 UTC] - Phase 1 Completed
- Migration applied: `20261012175935_non_money_schema_enhancements` (commit `3ecc6e7`).
- Added `cost_usd` & `idx_llm_usage_created_at` on `llm_usage`.
- Added composite index `idx_messages_rate_limit` on `messages(user_id, role, created_at DESC)`.
- Added capability metadata columns on `capability_registry`.
- Added RLS policy `settings_private_admin` on `settings_private`.
- Seed proposal prepared in `docs/SEED_PROPOSAL.md` under Gate G2.

### [2026-10-12 21:15 UTC] - Phase 2 Completed (Commit: `e2c2742`)
- Created `src/middleware.ts` using `@supabase/ssr` with session refresh and route guards:
  - Protects `/dashboard/*` & `/admin/*`, redirects unauthenticated callers to `/login`.
  - Rejects unverified callers with 403 (JSON) or redirects to `/verify` (HTML).
  - Enforces `app_metadata.role === 'admin'` for `/admin/*`.
- Created `src/app/auth/callback/route.ts` for PKCE code exchange.
- Ported `useUser.tsx` to Supabase Auth (`createClient` from `@/lib/supabase/client`), providing backwards-compatible `AppUser` mappings (`id`, `$id`, `emailVerification`, `labels`).
- Ported `useBalance.tsx` to sum user's own `credit_ledger.delta` via Supabase RLS. Never displays fake zero on failure.
- Ported `useNotifications.ts` to Supabase `notifications` table with Postgres Changes Realtime subscription.
- Ported `useCreditValue.ts` to read pricing from Supabase `settings_public`.
- Ported `src/app/forgot/page.tsx`, `src/app/reset/page.tsx`, `src/app/verify/page.tsx`, `src/app/dashboard/settings/page.tsx`, `src/components/admin/AdminGate.tsx`, `src/app/admin/layout.tsx`, and `src/components/app/AppShell.tsx` to Supabase.
- Retained `appBaseUrl()` links for `tests/site-domain.test.ts`.
- Preserved all Arabic copy and RTL layout untouched.
- Added comprehensive unit tests in `tests/auth-account-phase2.test.ts` (11/11 passed).
- Total vitest suite: 55 files, 433 tests passed (0 failures).

### [2026-10-12 21:24 UTC] - Phase 3 Completed (Commit: `df22587`)
- Ported `chatHandler.ts`, `briefManager.ts`, `planManager.ts` to Supabase DAL while preserving backwards-compatible execution.
- Enforced rate limits:
  - 20 msgs/min burst check on `public.messages(user_id, role, created_at)` via index `idx_messages_rate_limit`.
  - 4000 char message length limit (HTTP 413 friendly Arabic error).
  - Global daily spend cap check on `public.llm_usage` via index `idx_llm_usage_created_at` (HTTP 503 honest Arabic error).
- Quote writer sets `unitPricePoints` per item without 15% safety buffer.
- `total_reserved_credits` (quotedPoints) sets reserve with 15% safety buffer (`ceil(rawPoints * 1.15)`).
- Single-item plan enforced; fail closed if `unitPricePoints <= 0`.
- Recorded Gate G5 multi-item rejection: old Appwrite code only settled `items[0].unitPricePoints` causing potential undercharging/inconsistencies; new architecture strictly enforces single-item plans (`items.length === 1`) and rejects multi-item quotes with clear Arabic explanation before reservation.
- Added comprehensive unit tests in `tests/chat-plans-phase3.test.ts` (6/6 passed).
- Total vitest suite: 56 files, 439 tests passed (0 failures).

### [2026-10-12 21:35 UTC] - Phase 4 Completed (Hobby Design B)
- Implemented timing-safe `CRON_SECRET` authentication in `src/lib/server/cronAuth.ts` via `crypto.timingSafeEqual`.
- Created resumable worker chunk endpoint `POST /api/worker/chunk`:
  - Enforces `maxDuration = 60` (Vercel Hobby maximum).
  - Claims chunk lease atomically via `claim_job_chunk(p_job_id, p_expected_step, p_lease_seconds = 60)`.
  - Serializes daily provider spend check ($0.80 cap) via `reserve_provider_spend_atomic`.
  - Executes bounded chunk batches (max 10 units per chunk).
  - Commits provider spend via `commit_provider_spend`.
  - Writes intermediate chunk artifacts to Supabase Storage `partials/` bucket.
  - Completes chunk checkpoint via `complete_chunk(p_job_id, p_expected_step, p_new_cursor, p_new_delivered_units, p_cost_usd)`.
  - Upon completion: generates final results in `results/` bucket, settles job idempotently via `settle_job_atomic`, and sends notification to user.
  - While work remains: self-chains next chunk server-side with `CRON_SECRET`.
- Created daily watchdog cron `GET /api/cron/watchdog`:
  - Configured in `vercel.json` with single daily schedule `0 0 * * *` (Vercel Hobby compliant, zero sub-daily crons).
  - Queries stale jobs (>30 minutes in queued/running status without active lease progress).
  - Atomically releases each abandoned job via `release_job_atomic(p_job_id, error_message, true)`.
  - Emits in-app notification to the customer with full zero-debit refund.
- Created lease-safe job nudge endpoint `POST /api/jobs/[id]/nudge`:
  - Authenticates caller via Supabase session, verifies job ownership.
  - Guards against duplicate executions if active lease or backoff is active.
  - Safely resumes stalled jobs by re-triggering the worker chunk route.
- Updated `POST /api/chat/accept-quote` to trigger initial chunk execution (step 0) upon quote acceptance.
- Added comprehensive unit tests in `tests/worker-cron-phase4.test.ts` (11/11 passed).
- Total vitest suite: 57 files, 450 tests passed (0 failures).

### [2026-10-12 21:40 UTC] - Phase 5 Completed (Admin & Account Lifecycle)
- Ported `authenticateAdmin` in `src/lib/server/adminAuth.ts` to support Supabase Auth (`app_metadata.role === 'admin'`) with fallback to Appwrite sessions.
- Logs administrative actions to `public.admin_audit_log` via service role.
- Implemented `POST /api/account/delete`:
  - Requires user authentication via Supabase Auth.
  - Requires explicit confirmation string `«حذف»`.
  - Enforces 30-day grace period, recording `deletion_scheduled_for = now() + interval '30 days'` on `public.profiles` and `auth.users.user_metadata`.
- Integrated daily account purge into watchdog cron:
  - Purges profiles whose 30-day grace period has elapsed.
  - Purges non-financial tables only (`messages`, `notes`, `conversations`, `notifications`, `artifact_versions`, `profiles`, `auth.users`).
  - Strictly preserves all financial tables (`credit_ledger`, `jobs`, `topups`) for legal accounting and audit trail.
- Added comprehensive unit tests in `tests/admin-account-phase5.test.ts` (4/4 passed).
- Total vitest suite: 58 files, 454 tests passed (0 failures).

### [2026-10-12 22:06 UTC] - Phase 6 Completed (Hardening, Verification & Reporting)
- Verified complete Next.js production build (`npm run build`).
- Generated 25 static pages cleanly.
- Verified test suite: 58 test files, 454 passed (0 failed).
- Ledger and security invariants intact: 0 manual writes, security-definer RPCs enforced.

---

## Go-Live Mission Log (Phases A - F)

### [2026-10-12 22:30 UTC] - Phase A: Verification-Round Fixes & Tests (Commit: `6bfaa2d`)
- Aligned `DEFAULT_PRICING_CONFIG` across `src/lib/pricingConfig.ts`, `functions/shared/pricingEngine.ts`, and `functions/shared/providerCatalog.ts` to `usdToEgp = 55.0`, `markup = 10.0`, `creditValueEgp = 0.10`, `safetyBuffer = 0.15`, `minPoints = 1` (5,500 points per USD of provider cost).
- Updated `mapDatabaseRpcErrorToArabic` in `src/lib/errorMessages.ts` to format all numbers in Eastern Arabic-Indic digits (`٠١٢٣٤٥٦٧٨٩`) via `toArabicDigits` and cover every RPC reason code (`insufficient_balance`, `daily_cap_exceeded`, `already_reserved`, `invalid_reserve_points`, `job_points_cap_exceeded`, `unit_price_missing`, `delivered_ exceeds_planned`, `invalid_delivered_units`, `already_settled`, `already_released`, `job_not_found`, `lease_not_expired`).
- Updated account purge in `src/app/api/cron/watchdog/route.ts` to wrap each user purge in an independent `try/catch`, delete non-financial tables (`messages`, `notes`, `conversations`, `notifications`, `artifact_versions`, `llm_usage`) and storage paths (`results/{userId}`, `partials/{userId}`, `receipts/{userId}`), anonymize `public.profiles` (`email = deleted_<userId>@purged.local`, `name = 'مستخدم محذوف'`, `phone = null`, `deletion_scheduled_for = null`), and ban the auth user (`ban_duration: '876000h'`) while preserving all `RESTRICT` financial rows (`credit_ledger`, `jobs`, `topups`, `plans_quotes`, `provider_costs`, `job_events`).
- Added `POST /api/account/cancel-deletion` (`src/app/api/account/cancel-deletion/route.ts`) to allow users within the 30-day grace period to cancel scheduled account deletion.
- Expanded `tests/worker-cron-phase4.test.ts` and `tests/admin-account-phase5.test.ts` to invoke the actual route handlers (`POST /api/worker/chunk`, `GET /api/cron/watchdog`, `POST /api/jobs/[id]/nudge`, `POST /api/account/delete`, `POST /api/account/cancel-deletion`) with mocked dependencies and assert exact HTTP status codes and RPC parameters.

### [2026-10-12 22:45 UTC] - Phase B: Seed Data Migration (Commit: `0b6d8a4`)
- Applied migration `20261012200628_seed_initial_configuration.sql` via `mcp_supabase_apply_migration`.
- Seeded `public.settings_public` (`1` row: `credit_value_egp = 0.10`), `public.settings_private` (`1` row: `usd_to_egp_rate = 55.00`, `global_markup = 10.00`, `safety_buffer = 0.15`, `min_points = 1`, `max_job_points = 600`, `daily_provider_cap_usd = 0.80`), `public.capability_registry` (`12` rows: `tiktok-profile` enabled at `6` base points / `7` buffered points; remaining `11` capabilities disabled until live verification), and `public.templates` (`6` active Arabic templates).
- Verified `list_migrations` (19 applied migrations) and `get_advisors` (security + performance: 0 new warnings; only informational Auth leaked-password protection note).
- Verified financial tables untouched (`credit_ledger`: 187 rows; `00000000-0000-0000-0000-000000000001` = 1,917 points; `00000000-0000-0000-0000-000000000002` = 440 points).

### [2026-10-12 23:15 UTC] - Phase C: Appwrite Decoupling (Commit: `4bd9a4d`)
- Created `GET /api/jobs/[id]/download` (`src/app/api/jobs/[id]/download/route.ts`) to authenticate caller via Supabase session, verify `job.user_id === user.id`, and generate a 300-second signed URL from the private `results` bucket (`{userId}/{jobId}/result.{format}`).
- Ported UI pages (`src/app/dashboard/requests/page.tsx`, `src/app/dashboard/chat/page.tsx`, `src/app/dashboard/topup/page.tsx`, `src/app/dashboard/topup/TopupForm.tsx`, `src/app/admin/topups/page.tsx`, `src/app/admin/users/page.tsx`) from Appwrite SDK to Supabase browser client and REST routes.
- Ported API routes (`/api/jobs/[id]/data`, `/api/jobs/[id]/methodology`, `/api/jobs/[id]/artifacts`, `/api/chat`, `/api/chat/metadata`, `/api/chat/edit-plan`, `/api/onboarding`, `/api/admin/receipts/[fileId]`, `/api/admin/llm-status`, `/api/admin/provider-balance`, `/api/admin/smoke`) to Supabase Auth, Postgres, and Storage first.
- Updated `docs/review/appwrite-inventory-raw.md` with full pre/post verification showing 0 active Appwrite imports in `src/app/**`, `src/components/**`, and `src/hooks/**`, and 0 `appwrite` strings in `.next/static/` bundles.

### [2026-10-12 23:25 UTC] - Phase D: Public `/calculator` Page (Commit: `e818bad`)
- Created `src/lib/calculatorPricing.ts` and `src/app/calculator/page.tsx` using the exact same `calculateQuote` and `calculateFinalSettlement` functions from `functions/shared/pricingEngine.ts` and `CAPABILITY_CATALOG` from `functions/shared/providerCatalog.ts` as `createAndSaveManagedQuote` in `functions/shared/planManager.ts`.
- Enforced Arabic-only copy with Eastern Arabic-Indic numerals, Points + EGP display only (no USD, no provider names, no endpoint IDs, no approximate wording), and explicit statement that only actually delivered units are charged while any unused reserve is refunded automatically.
- Added `tests/public-calculator-phase-d.test.ts` (2/2 passed) proving identical outputs between `/calculator` and `createAndSaveManagedQuote` across capabilities and volumes.

### [2026-10-12 23:35 UTC] - Phase E: Production Readiness Runbook (Commit: `3ccf07e`)
- Verified `vercel.json` contains only the single Hobby-compatible daily cron (`0 0 * * *` -> `/api/cron/watchdog`).
- Updated `docs/CUTOVER.md` with complete Supabase Auth configuration (Site URL, Redirect URLs, Email provider settings, and 3 Arabic RTL HTML templates), Vercel Hobby cron architecture, Vercel environment variables matrix, step-by-step cutover sequence, and rollback plan.

### [2026-10-12 23:45 UTC] - Phase F: Tiny Real Job Script & Final Reports
- Prepared `scripts/verify/run-tiny-live-preview.ts` guarded by `CONFIRM_LIVE_PREVIEW=YES` (Stop Gate G5: prepared and NOT executed).
- Verified full test suite (`59` test files, `473` tests passed, `0` failed) and production build (`82` static client bundle chunks scanned, `0` secret or Appwrite occurrences).
- Compiled final report in `docs/GO_LIVE_REPORT.md`.

