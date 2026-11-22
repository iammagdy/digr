# Customer Release Wording: Unified «رجع لمحفظتك» (DT-20261122-release-wording)

Task: DT-20261122-release-wording (follow-up of PR #626, Megz decision D-0187).
Branch: `team/DT-20261122-release-wording` from `origin/main` (`13f2e9c5`).

## Summary of Changes

This is a copy-only update across the repository. Zero changes have been made to financial calculation, ledger operations, billing rules, database schemas, or point allocations.

### 1. Customer-Facing Copy Normalization
- Replaced all customer-facing instances of `«حجز مؤقت مُحرَّر»` (and variants `«مُحرَّر/محرر»` denoting returned holds) with `«رجع لمحفظتك»`.
- Status chip for unserved/refunded requests now uniformly displays `«رجع لمحفظتك»` (`src/app/dashboard/requests/page.tsx` lines 525, 530, 559 and `src/lib/jobs/requestStatus.ts:32`).
- Updated email templates in `src/functions/shared/emailTemplates.ts` and `supabase/functions/send-email/templates.ts` to use `«رجع لمحفظتك [النقاط] نقطة»` and unified card/status badges.
- Updated notifications, activity feed messages, watchdog release notices, and landing page explanations.

### 2. Grammatical Correction
- Fixed accusative grammatical issue in contacts mission card / status line:
  `src/lib/jobs/requestStatus.ts:90`: `«في عنصرًا واحدًا»` → `«في عنصر واحد»` (when `unmatched === 1`).

### 3. Release Wording Normalizer
- `src/lib/releaseWording.ts`: Updated `normalizeReleaseWording` to convert legacy forms and stored texts to `«رجع لمحفظتك»` (and `«والباقي رجع لمحفظتك»`), while preserving internal non-customer strings like `«تعذر تأكيد الحجز المؤقت المُحرَّر للمهمة.»`.

### 4. Regression & Guard Coverage
- Added repo-wide guard test `tests/dt-20261122-zero-old-release-wording.test.ts` (5 tests) scanning:
  - `src/components`
  - `src/app/dashboard`
  - `src/lib/jobs`
  - `src/functions/shared`
  - `supabase/functions`
  ensuring zero customer-facing `«حجز مؤقت مُحرَّر»` remains.
- Updated existing test assertions across 32 test files to expect the new wording.
- Core suites pass with 100% identical test counts and zero failures:
  - `tests/agent-wording-and-money.test.ts` (35/35 passed)
  - `tests/wallet-mission-group.test.ts` (6/6 passed)
  - `tests/release-text.test.ts` (39/39 passed)
  - `tests/engine-contract.test.ts` (14/14 passed)
  - `tests/dt-20261122-zero-old-release-wording.test.ts` (5/5 passed)
  - Full candidate suites: 53 files, 1152 passed, 0 failed.

## Verification
- TypeScript (`tsc --noEmit` + `agent/tsconfig.json`): Exit code 0, 0 errors.
- Production Next.js build (`next build` + bundle secrets check): Exit code 0, 0 errors, 140/140 static pages generated, zero client bundle secrets.
