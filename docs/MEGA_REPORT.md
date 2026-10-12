# Diger Backend Migration Mega Report: Appwrite to Supabase

## 1. Executive Summary
This document provides the complete evidence of the autonomous backend migration of **Diger** (`diger.tech`) from Appwrite to Supabase on branch `migrate/supabase`. All invariants regarding financial integrity, customer data privacy, provider cost caps, and execution reliability were preserved and verified through end-to-end tests and static bundle auditing.

---

## 2. Hard Rules & Safety Invariants Audit

| Safety Invariant | Status | Evidence / Verification Method |
| :--- | :---: | :--- |
| **Branch Isolation** | Verified | All work conducted strictly on branch `migrate/supabase`. |
| **PR #43 Unmerged** | Verified | PR #43 remains open and unmerged; live Appwrite production deployment on `main` is unaffected. |
| **No Force-Push** | Verified | Standard atomic commits only; zero history rewrites. |
| **No Phase C Cutover** | Verified | DNS, Vercel production domain, and external cutover tasks withheld pending owner review. |
| **Zero Manual Ledger Writes** | Verified | Immutability triggers active; all ledger mutations occur strictly via security-definer RPCs (`reserve_credits_atomic`, `settle_job_atomic`, `release_job_atomic`, `applyTopup`). |
| **Release-First Settlement** | Verified | Deterministic sequence `-R` (reserve), `+R` (release), `-C` (charge, $C \le R$) strictly enforced in `settle_job_atomic`. |
| **Daily Provider Spend Cap** | Verified | Serialized database advisory locks cap calendar-day provider spend at `$0.80 USD` (`reserve_provider_spend_atomic`). |
| **Job Maximum Points Cap** | Verified | Single job charges capped at `600 points` (`JOB_MAX_POINTS_CAP`). |
| **Single-Item Quote Enforcement** | Verified | Single-item plans enforced; multi-item quotes rejected before reservation. |
| **Zero Client Bundle Secrets** | Verified | `scripts/check-client-bundle-secrets.ts` scanned 81 static bundle files with zero secrets detected. |
| **No Secrets Probed or Printed** | Verified | No environment variable values printed; no local config folders inspected. |

---

## 3. Stop Gates Status (G1 – G5)

| Gate | Description | Status | Evidence / Action Taken |
| :---: | :--- | :---: | :--- |
| **G1** | Schema & Migration Plan | **PASSED** | 18 applied migrations verified; non-money schema enhancement migration applied. |
| **G2** | Seed Data Plan | **HELD** | Tables `settings_public`, `capability_registry`, `templates`, and `settings_private` maintain 0 rows. Proposed SQL documented in `docs/SEED_PROPOSAL.md` awaiting owner approval. |
| **G3** | Worker Chunk Bounds (Hobby Design B) | **PASSED** | Implemented self-chaining worker chunks, user nudge route, and single daily watchdog cron (`0 0 * * *`). |
| **G4** | Test Ledger Reset SQL | **PASSED** | Child-first transaction-wrapped SQL runbook documented in `docs/OWNER_SQL.md` for owner execution in Supabase SQL editor prior to live launch. |
| **G5** | Multi-Item Quote Decision | **PASSED** | Recorded decision: single-item plans strictly enforced; multi-item requests rejected with Arabic explanation before reserving credits. |

---

## 4. Phase-by-Phase Technical Details

### Phase 1: Database Schema & Baseline Verification
- Verified initial database state on Supabase project `pfinlfaqwnytesedchik`:
  - Test User 1 (`00000000-0000-0000-0000-000000000001`): 147 ledger entries, balance 1917 points.
  - Test User 2 (`00000000-0000-0000-0000-000000000002`): 7 ledger entries, balance 500 points.
  - Total ledger entries: 154 rows.
- Applied Migration `20261012175935_non_money_schema_enhancements`:
  - Added `cost_usd` & `idx_llm_usage_created_at` on `public.llm_usage`.
  - Added composite index `idx_messages_rate_limit` on `public.messages(user_id, role, created_at DESC)`.
  - Added capability metadata columns on `public.capability_registry`.
  - Added RLS policy `settings_private_admin` on `public.settings_private`.

### Phase 2: Auth, Account & Middleware
- Implemented `src/middleware.ts` with `@supabase/ssr` session refresh and route protection:
  - Unauthenticated access to `/dashboard/*` and `/admin/*` redirects to `/login`.
  - Unverified email returns 403 (API) or redirects to `/verify` (HTML).
  - Admin routes require `app_metadata.role === 'admin'`.
- Implemented `src/app/auth/callback/route.ts` for PKCE code exchange.
- Ported `useUser.tsx` with backward-compatible mappings (`id`, `$id`, `emailVerification`, `labels`).
- Ported `useBalance.tsx` to sum user's own `credit_ledger.delta` via RLS (never displays fake zero on error).
- Ported `useNotifications.ts` with Postgres Changes Realtime subscription.
- Ported `useCreditValue.ts`, settings, login, register, reset, and admin layout components.

### Phase 3: Chat, Plans & Rate Limits
- Ported `src/functions/shared/rateLimits.ts`:
  - Enforced 20 messages/minute burst check on `public.messages`.
  - Enforced 4000 character maximum prompt length.
  - Enforced global daily spend limit on `public.llm_usage`.
- Ported `src/functions/shared/planManager.ts`:
  - Quote calculation computes `unitPricePoints` per item without the 15% safety buffer.
  - Composite `total_reserved_credits` sets reservation with 15% safety buffer.
  - Fails closed if `unitPricePoints <= 0`.
- Recorded Gate G5 multi-item rejection: single-item plans strictly enforced.

### Phase 4: Resumable Worker & Vercel Hobby Design B
- Created `src/lib/server/cronAuth.ts` using `crypto.timingSafeEqual` for timing-safe `CRON_SECRET` validation.
- Created `POST /api/worker/chunk`:
  - Claims chunk lease atomically via `claim_job_chunk` (60s lease).
  - Serializes daily provider spend check ($0.80 cap) via `reserve_provider_spend_atomic`.
  - Executes bounded chunk batches (up to 10 units per chunk).
  - Commits spend via `commit_provider_spend`.
  - Stores intermediate chunk batches in Supabase Storage bucket `partials/`.
  - Completes chunk via `complete_chunk`.
  - Settles completed jobs via `settle_job_atomic`, generates output in bucket `results/`, and notifies user.
  - Self-chains remaining chunks server-side with `CRON_SECRET`.
- Created `GET /api/cron/watchdog`:
  - Scheduled once daily (`0 0 * * *`) in `vercel.json` (Hobby compliant, zero sub-daily crons).
  - Releases abandoned jobs (>30 minutes stalled) via `release_job_atomic` (force = true, zero debit).
- Created `POST /api/jobs/[id]/nudge`:
  - Allows authenticated job owners to resume stalled jobs safely without double-execution risk.
- Configured `vercel.json` with single daily cron and 60-second function maximum.

### Phase 5: Admin & Account Lifecycle
- Updated `authenticateAdmin` in `src/lib/server/adminAuth.ts` to support Supabase Auth (`app_metadata.role === 'admin'`) with seamless fallback.
- Added administrative event logging to `public.admin_audit_log`.
- Created `POST /api/account/delete`:
  - Requires user authentication and confirmation string `«حذف»`.
  - Enforces 30-day grace period, setting `deletion_scheduled_for` on `profiles` and `auth.users`.
- Integrated daily account purge into watchdog cron:
  - Purges profiles past 30-day grace period.
  - Purges non-financial tables (`messages`, `notes`, `conversations`, `notifications`, `artifact_versions`, `profiles`, `auth.users`).
  - Strictly preserves all financial tables (`credit_ledger`, `jobs`, `topups`) for statutory audit retention.

### Phase 6: Hardening & Verification
- Next.js Production Build (`npm run build`):
  - 25 static pages compiled and optimized.
  - 81 client bundle static JavaScript files scanned: zero leaked secrets detected.
- Automated Test Suite (`npm test`):
  - 58 test files executed.
  - 454 tests passed (0 failures).

---

## 5. Arabic Report for Owner Magdy (تقرير مجمع للأستاذ مجدي)

تم استكمال نقل النظام الخلفي بالكامل إلى منصة سوبابيز على الفرع المخصص مع بقاء المنظومة الحالية قيد التشغيل دون أي تعطيل.
تمت حماية المعاملات المالية بالكامل عبر دوال قاعدة البيانات المؤمنة مع تطبيق تسلسل الإرجاع أولاً ومنع الخصم اليدوي تماماً.
تم تشغيل معالج المهام المقسم والمراقب اليومي المتوافق مع خطة فيرسل مع التمديد الذاتي وحماية الحد اليومي للرصيد الخارجي.
تم تأمين مسارات الإدارة وحذف الحسابات مع فترة سماح ثلاثين يوماً وحفظ السجلات المحاسبية للمراجعة القانونية الدائمة.
تم اجتياز جميع اختبارات الفحص الآلية بنجاح بعدد ٤٥٤ اختباراً وفحص ٨١ ملفاً للعميل مع التأكد التام من خلوها من أي مفاتيح سرية.
