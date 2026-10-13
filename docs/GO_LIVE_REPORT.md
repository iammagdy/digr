# Diger Go-Live Mission Report (`diger.tech`)

- **Branch:** `migrate/supabase` (PR #43 remains OPEN and UNMERGED per Gate G3)
- **Supabase Project:** `pfinlfaqwnytesedchik`
- **Applied Migrations:** `19` total (latest: `20261012200628_seed_initial_configuration`)
- **Test Suite Status:** `59` test files, `484` tests passed (`0` failures)
- **Production Build & Bundle Scan:** Client-side static chunks scanned in `.next/static/` — `0` secret strings, `0` `appwrite` references

---

## 1. Phase-by-Phase Execution Summary (Verified Against Real Commits)

| Phase | Commit | Exact Modified Files (`git show --stat`) | Real Summary |
|---|---|---|---|
| **Phase A: Verification-Round Fixes & Tests** | `6bfaa2d` | `src/app/api/account/delete/cancel/route.ts`, `src/app/api/chat/accept-quote/route.ts`, `src/app/api/cron/watchdog/route.ts`, `src/app/api/worker/chunk/route.ts`, `src/functions/shared/capabilityRegistry.ts`, `src/functions/shared/quotes.ts`, `src/lib/supabase/quoteAccept.ts`, `tests/admin-account-phase5.test.ts`, `tests/chat-plans-phase3.test.ts`, `tests/p1-capabilities-quotes.test.ts`, `tests/supabase-routes.test.ts`, `tests/worker-cron-phase4.test.ts` | Aligned pricing constants (`55 / 10 / 0.10`, `5,500` pts/USD), isolated each user inside `try/catch` in `src/app/api/cron/watchdog/route.ts` with profile anonymization (`deleted_<id>@purged.local`, `مستخدم محذوف`) + auth ban while keeping all `RESTRICT` financial tables intact, added `POST /api/account/delete/cancel`, and expanded route-handler unit tests. |
| **Phase B: Seed Data Migration** | `0b6d8a4` | `supabase/migrations/20261012200628_seed_initial_configuration.sql` | Applied migration `20261012200628_seed_initial_configuration.sql` seeding `settings_public` (`1` row, `key = 'pricing'`), `settings_private` (`1` row, `key = 'pricing'`), `capability_registry` (`12` rows; only `tiktok-profile` enabled at `6` credits), and `templates` (`6` rows; `1` enabled: `tiktok-profile`). `get_advisors` returned `0` new security or performance warnings. |
| **Phase C: Appwrite Decoupling** | `4bd9a4d` | `src/app/api/jobs/[id]/download/route.ts`, `src/app/api/chat/route.ts`, `src/app/dashboard/jobs/page.tsx`, `src/app/dashboard/page.tsx`, `docs/review/appwrite-inventory-raw.md`, `tests/admin-account-phase5.test.ts`, `tests/supabase-routes.test.ts` | Created `GET /api/jobs/[id]/download` (300s signed URL from private `results` bucket after ownership verification), wired dashboard & chat routes to Supabase, and updated `docs/review/appwrite-inventory-raw.md` proving `0` active Appwrite imports in `src/app/**`, `src/components/**`, and `src/hooks/**`. |
| **Phase D: Public `/calculator` Page** | `e818bad` | `src/app/calculator/page.tsx`, `src/lib/calculatorPricing.ts`, `tests/public-calculator-phase-d.test.ts` | Built `/calculator` (`src/app/calculator/page.tsx` + `src/lib/calculatorPricing.ts`) calling the shared pricing functions in `src/functions/shared/quotes.ts`, with `tests/public-calculator-phase-d.test.ts` verifying equality with the quote writer. |
| **Phase E: Production Readiness Runbook** | `3ccf07e` | `docs/CUTOVER.md` | Updated `docs/CUTOVER.md` with Supabase Auth settings, 2 Arabic RTL HTML email templates (Confirm Signup, Reset Password), Vercel Hobby daily cron (`0 0 * * *`), Vercel environment variable table, and step-by-step cutover runbook. |
| **Phase F & Handoff Fixes: Worker Port, Chat Supabase DAL, UI & Evidence** | `31b2540`, `a8136c8`, `086cc7e`, `346f6ab` | `src/app/api/worker/chunk/route.ts`, `src/lib/worker/artifactBuilders.ts`, `src/app/api/chat/route.ts`, `src/functions/shared/chatHandler.ts`, `src/functions/shared/llmClient.ts`, `src/app/page.tsx`, `src/components/landing/GlassHeader.tsx`, `src/components/landing/Sections.tsx`, `src/components/app/AppShell.tsx`, `src/app/login/page.tsx`, `src/app/register/page.tsx`, `src/app/admin/layout.tsx`, `scripts/verify/verify-worker-dry-run.ts` | Ported real chunked worker execution + CSV/XLSX/PDF artifact generation + `artifact_versions` & `notifications` inserts into `/api/worker/chunk`, ported `ChatHandler` to support Supabase client (`sb.from`) with `[chat:request_failed] requestId=... step=... reason=...` diagnostics, fixed landing session & `/calculator` navigation, and verified 2-chunk settlement + refund dry-run. |

---

## 2. Final Pricing Table (`55` EGP/USD, `10x` Markup Applied Once, `0.10` EGP/Point = `5,500` Points/USD)

### Single Source of Truth Formula (`src/functions/shared/quotes.ts`)
- `calculateCapabilityUnitPricePoints(unitCostUsd, settings, explicitUnitPriceCredits)`:
  - When `unitCostUsd` is provided without pre-multiplied credits: `max(minPoints, ceil((unitCostUsd * 55 * 10) / 0.10))` = `max(1, ceil(unitCostUsd * 5500))`
  - For `tiktok-profile` at `0.001` USD: `ceil(0.001 * 55 * 10 / 0.10) = 6` points (`0.60` EGP)
- `calculateCapabilityQuote(params, settings)`:
  - `rawPoints = max(1, ceil(plannedUnits * unitPricePoints))`
  - `reservedPoints (with 15% buffer) = max(1, ceil(rawPoints * 1.15))`
  - For `tiktok-profile` (`1` unit): `unitPricePoints = 6`, `reservedPoints = ceil(6 * 1.15) = 7` points (`0.70` EGP)
- `calculateFinalSettlement(deliveredUnits, unitPricePoints, reservedPoints)`:
  - `actualCharge = min(reservedPoints, ceil(deliveredUnits * unitPricePoints))` (`0` if `deliveredUnits = 0`)
  - `refundAmount = max(0, reservedPoints - actualCharge)`
  - For `tiktok-profile` (`1` delivered unit): `actualCharge = 6` points (`0.60` EGP), `refundAmount = 1` point (`0.10` EGP)

### A. Database Seeded Capabilities (`public.capability_registry` — 12 Rows Applied in `20261012200628_seed_initial_configuration.sql`)

| `slug` | `name_ar` | `endpoint_id` | `unit_price_credits` | 1 Unit Reserve (`+15%`) | `enabled` |
|---|---|---|---:|---:|:---:|
| `tiktok-profile` | استخراج ملف تيك توك الشخصي | `tikhub.tiktok.user.profile` | `6` pts (`0.60` ج.م) | `7` pts (`0.70` ج.م) | `true` |
| `tiktok-user-videos` | مقاطع فيديو مستخدم تيك توك | `tikhub.tiktok.user.posts` | `2` pts (`0.20` ج.م) | `3` pts (`0.30` ج.م) | `false` |
| `tiktok-keyword-videos` | بحث مقاطع تيك توك بالكلمات الدلالية | `tikhub.tiktok.search.video` | `2` pts (`0.20` ج.م) | `3` pts (`0.30` ج.م) | `false` |
| `x-user-tweets` | تغريدات مستخدم منصة X | `twitter.user.tweets` | `2` pts (`0.20` ج.م) | `3` pts (`0.30` ج.م) | `false` |
| `x-keyword-search` | بحث منشورات منصة X (تويتر) | `twitter.search.tweets` | `2` pts (`0.20` ج.م) | `3` pts (`0.30` ج.م) | `false` |
| `instagram-profile` | ملف إنستغرام الشخصي | `instagram.user.profile` | `7` pts (`0.70` ج.م) | `9` pts (`0.90` ج.م) | `false` |
| `instagram-user-posts` | منشورات مستخدم إنستغرام | `instagram.user.posts` | `3` pts (`0.30` ج.م) | `4` pts (`0.40` ج.م) | `false` |
| `youtube-channel` | بيانات قناة يوتيوب | `youtube.channel.details` | `6` pts (`0.60` ج.م) | `7` pts (`0.70` ج.م) | `false` |
| `youtube-video-search` | بحث مقاطع يوتيوب | `youtube.search.video` | `3` pts (`0.30` ج.م) | `4` pts (`0.40` ج.م) | `false` |
| `facebook-page-posts` | منشورات صفحة فيسبوك | `facebook.page.posts` | `3` pts (`0.30` ج.م) | `4` pts (`0.40` ج.م) | `false` |
| `google-serp-search` | نتائج بحث جوجل (SERP) | `google.serp.organic` | `11` pts (`1.10` ج.م) | `13` pts (`1.30` ج.م) | `false` |
| `telegram-channel-posts` | رسائل قناة تيليجرام | `telegram.channel.messages` | `2` pts (`0.20` ج.م) | `3` pts (`0.30` ج.م) | `false` |

---

## 3. Read-Only Post-Launch Audit SQL Queries & Live Results

All queries below use the exact schema column names verified in `information_schema.columns` (`public.jobs`: `reserved_credits, charged_credits, delivered_units, unit_price`; `public.capability_registry`: `enabled`; `public.templates`: `enabled`).

```sql
-- 1. Ledger reconciliation per user
SELECT
  user_id,
  COUNT(*) AS ledger_rows,
  COALESCE(SUM(delta), 0) AS balance_points,
  ROUND(COALESCE(SUM(delta), 0) * 0.10, 2) AS balance_egp
FROM public.credit_ledger
GROUP BY user_id
ORDER BY user_id;

-- 2. Verify zero terminal jobs with unbalanced reserve/release rows (expect 0 rows)
SELECT
  j.id,
  j.user_id,
  j.status,
  j.reserved_credits,
  j.charged_credits,
  j.delivered_units,
  j.unit_price,
  COALESCE(SUM(CASE WHEN l.type IN ('reserve', 'release') THEN l.delta ELSE 0 END), 0) AS net_reserve_delta
FROM public.jobs j
LEFT JOIN public.credit_ledger l ON l.job_id = j.id
WHERE j.status IN ('completed', 'failed')
GROUP BY j.id, j.user_id, j.status, j.reserved_credits, j.charged_credits, j.delivered_units, j.unit_price
HAVING COALESCE(SUM(CASE WHEN l.type IN ('reserve', 'release') THEN l.delta ELSE 0 END), 0) <> 0;

-- 3. UTC daily provider spend vs $0.80 cap
SELECT
  (now() AT TIME ZONE 'utc')::date AS utc_day,
  COUNT(*) AS spend_entries,
  ROUND(COALESCE(SUM(cost_usd), 0), 4) AS total_cost_usd,
  ROUND(0.80 - COALESCE(SUM(cost_usd), 0), 4) AS remaining_cap_usd
FROM public.provider_costs
WHERE (created_at AT TIME ZONE 'utc')::date = (now() AT TIME ZONE 'utc')::date;

-- 4. Seeded configuration and catalog verification
SELECT
  (SELECT COUNT(*) FROM public.settings_public WHERE key = 'pricing') AS settings_public_rows,
  (SELECT COUNT(*) FROM public.settings_private WHERE key = 'pricing') AS settings_private_rows,
  (SELECT COUNT(*) FROM public.capability_registry) AS capability_rows,
  (SELECT COUNT(*) FROM public.capability_registry WHERE enabled = true) AS enabled_capabilities,
  (SELECT COUNT(*) FROM public.templates WHERE enabled = true) AS enabled_templates;
```

### Live Audit SQL Results (`mcp_supabase_execute_sql`)
- **Query 1 (Ledger per user):**
  `[{"user_id":"00000000-0000-0000-0000-000000000001","ledger_rows":169,"balance_points":"1917","balance_egp":"191.70"},{"user_id":"00000000-0000-0000-0000-000000000002","ledger_rows":33,"balance_points":"380","balance_egp":"38.00"}]`
- **Query 2 (Terminal jobs with unbalanced reserve/release):**
  `[]` (`0` rows)
- **Query 3 (UTC daily provider spend on 2026-10-13):**
  `[{"utc_day":"2026-10-13","spend_entries":3,"total_cost_usd":"0.0100","remaining_cap_usd":"0.7900"}]`
- **Query 4 (Seeded counts):**
  `[{"settings_public_rows":1,"settings_private_rows":1,"capability_rows":12,"enabled_capabilities":1,"enabled_templates":1}]`

---

## 4. Arabic Step-by-Step Owner Checklist for Magdy (Gates G3, G4, G5)

### أولاً: بوابة إعدادات الحسابات والبيئة وتنظيف بيانات الاختبار (Gate G4)
1. افتح لوحة تحكم **Supabase Dashboard** لمشروع `pfinlfaqwnytesedchik` وادخل إلى **Authentication -> URL Configuration**:
   - ضع `https://diger.tech` في خانة **Site URL**.
   - أضف الروابط التالية فقط في **Redirect URLs** (مقصورة على نطاق موقعك ومشروعك على Vercel فقط):
     - `https://diger.tech/**`
     - `https://*-iam-magdy.vercel.app/**`
2. من **Authentication -> Email Templates**، انسخ قوالب البريد العربية (تأكيد الحساب واستعادة كلمة المرور) الموجودة جاهزة في ملف `docs/CUTOVER.md`.
3. لإنشاء حساب الأدمن الخاص بك وتفعيله:
   - سجّل حسابك أولاً من صفحة `/register` على الموقع (أو من **Supabase Dashboard -> Authentication -> Users -> Add user** مع تفعيل **Auto Confirm User**).
   - افتح **SQL Editor** في Supabase ونفّذ أمر ترقية الحساب الموجود في `docs/CUTOVER.md` (القسم الرابع `UPDATE auth.users SET raw_app_meta_data = ...`).
   - سجّل الخروج ثم ادخل مرة أخرى من `/login` لتتحدث جلسة الدخول بصلاحية الأدمن وتفتح لك لوحة `/admin`.
4. لتحديد عنوان إنستاباي (`ipa@instapay`) الخاص باستقبال التحويلات:
   - يقرأ الكود (`src/app/dashboard/topup/page.tsx`) العنوان أولاً من جدول `public.settings_public` (`key = 'pricing'`, الحقل `value.ipa`)، ويمكنك تعديله مباشرة من لوحة الإدارة (`/admin/settings`) أو عبر أمر SQL في `docs/CUTOVER.md`، كما يقرأ الكود المتغير الاحتياطي `NEXT_PUBLIC_INSTAPAY_HANDLE` من Vercel إذا لم يكن الحقل مسجلاً في قاعدة البيانات.
5. لحماية رصيد Anthropic الشهري بجانب السقف اليومي المدمج في الكود (`$2.00` يومياً للنماذج و`$0.80` يومياً لمزود البيانات):
   - افتح `https://console.anthropic.com/settings/limits` وحدد سقف الإنفاق الشهري (**Monthly spend limit**) بالقيمة التي تناسبك (مثلاً `$15` أو `$20` شهرياً).
6. قبل الإطلاق الفعلي للجمهور، نفّذ معاملة تنظيف بيانات الاختبار وحذف دالة الاختبار المؤقتة `DROP FUNCTION IF EXISTS public.create_verify_fixture(TEXT, JSONB);` من ملف `docs/OWNER_SQL.md` داخل **Supabase SQL Editor**.
7. افتح لوحة تحكم **Vercel -> Project Settings -> Environment Variables** وتأكد من وجود المتغيرات الأساسية المطلوبة الموضحة في القسم السابع من `docs/CUTOVER.md`:
   - المتغيرات الإلزامية (`7` متغيرات): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `ANTHROPIC_API_KEY`, `TREG_TOKEN`, وعند الجاهزية للتشغيل الفعلي أضف `TREG_LIVE=true`.
   - المتغيرات الاختيارية (لها قيم افتراضية آمنة في الكود): `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_INSTAPAY_HANDLE`, `TREG_BASE_URL`, `LLM_ENABLED`, `LLM_PROVIDER`, `ANTHROPIC_MODEL`, `PROVIDER_DAILY_SPEND_CAP_USD`, `JOB_MAX_POINTS_CAP`.

### ثانياً: بوابة تجربة وظيفة حية مصغّرة (Gate G5 - اختياري قبل الإطلاق)
1. تم تجهيز سكريبت الفحص الحي المصغّر في `scripts/verify/run-tiny-live-preview.ts` وهو مقفل بحماية `CONFIRM_LIVE_PREVIEW=YES` ولم يتم تشغيله تلقائياً حفاظاً على رصيد المزود.
2. إذا أردت تشغيله لاختبار جلب حساب تيك توك واحد فقط (`1` وحدة بتكلفة `$0.001` أي `6` نقاط خصم فعلي من `7` نقاط محجوزة)، شغّل الأمر التالي من جهازك:
   ```powershell
   $env:CONFIRM_LIVE_PREVIEW="YES"; npx tsx --env-file=.env.local scripts/verify/run-tiny-live-preview.ts
   ```

### ثالثاً: بوابة الإطلاق النهائي ودمج الفرع (Gate G3)
1. راجع رابط المعاينة (Preview Deployment) الخاص بالطلب **PR #43** على Vercel وتأكد من فتح صفحة `/calculator` وصفحة تسجيل الدخول `/login` والمحادثة.
2. عند رضاك التام، اضغط **Merge Pull Request** لدمج الفرع `migrate/supabase` في `main`، وسيقوم Vercel بنشر النسخة الجديدة تلقائياً على `https://diger.tech` مع تفعيل كرون المراقبة اليومي المجاني (`0 0 * * *`).

