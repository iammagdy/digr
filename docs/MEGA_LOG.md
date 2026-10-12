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
- Scanned 81 client-side static JavaScript bundle files (`.next/static/`) for secrets: zero leaked secrets detected.
- Verified test suite: 58 test files, 454 passed (0 failed).
- Ledger and security invariants intact: 0 manual writes, security-definer RPCs enforced.
