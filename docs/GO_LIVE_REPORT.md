# Diger Go-Live Mission Report (`diger.tech`)

- **Branch:** `migrate/supabase` (PR #43 remains OPEN and UNMERGED per Gate G3)
- **Supabase Project:** `pfinlfaqwnytesedchik`
- **Applied Migrations:** `19` total (latest: `20261012200628_seed_initial_configuration`)
- **Test Suite Status:** `59` test files, `473` tests passed (`0` failures)
- **Production Build & Bundle Scan:** `82` client-side static chunks scanned in `.next/static/` — `0` secret strings, `0` `appwrite` references

---

## 1. Phase-by-Phase Execution Summary

| Phase | Commit | Summary |
|---|---|---|
| **Phase A: Verification-Round Fixes & Tests** | `6bfaa2d` | Aligned pricing constants (`55 / 10 / 0.10`, `5,500` pts/USD), Eastern Arabic-Indic digits (`٠-٩`) in all RPC error messages, per-user `try/catch` isolation in account purge with profile anonymization (`deleted_<id>@purged.local`, `مستخدم محذوف`) + auth ban while keeping all `RESTRICT` financial tables intact, added `POST /api/account/cancel-deletion`, and expanded route-handler unit tests for worker, watchdog, nudge, and account deletion. |
| **Phase B: Seed Data Migration** | `0b6d8a4` | Applied migration `20261012200628_seed_initial_configuration.sql` seeding `settings_public` (`1` row), `settings_private` (`1` row), `capability_registry` (`12` rows; only `tiktok-profile` enabled at `6` base pts / `7` buffered pts), and `templates` (`6` rows). `get_advisors` returned `0` new security or performance warnings. |
| **Phase C: Appwrite Decoupling** | `4bd9a4d` | Created `GET /api/jobs/[id]/download` (300s signed URL from private `results` bucket after ownership verification), ported all remaining dashboard/admin UI pages and API routes from Appwrite SDK to Supabase, and updated `docs/review/appwrite-inventory-raw.md` proving `0` active Appwrite imports in `src/app/**`, `src/components/**`, and `src/hooks/**`. |
| **Phase D: Public `/calculator` Page** | `e818bad` | Built `/calculator` (`src/app/calculator/page.tsx` + `src/lib/calculatorPricing.ts`) calling the exact same `calculateQuote` and `calculateFinalSettlement` pricing functions used by `createAndSaveManagedQuote`. Added `tests/public-calculator-phase-d.test.ts` proving exact numerical equality across capabilities and volumes. |
| **Phase E: Production Readiness Runbook** | `3ccf07e` | Updated `docs/CUTOVER.md` with Supabase Auth settings, 3 Arabic RTL HTML email templates (Confirm Signup, Reset Password, Magic Link), Vercel Hobby daily cron (`0 0 * * *`), Vercel environment variable table, and step-by-step cutover runbook. |
| **Phase F: Tiny Real Job Script & Final Report** | *(HEAD)* | Prepared `scripts/verify/run-tiny-live-preview.ts` guarded by `CONFIRM_LIVE_PREVIEW=YES` (Gate G5: prepared and NOT executed). Updated `docs/MEGA_LOG.md` and compiled this `docs/GO_LIVE_REPORT.md`. |

---

## 2. Final Pricing Table (`55` EGP/USD, `10x` Markup, `0.10` EGP/Point = `5,500` Points/USD)

Formula:
- `unitPricePoints = max(1, ceil(providerUsdPerUnit * 55 * 10 / 0.10))` = `max(1, ceil(providerUsdPerUnit * 5500))`
- `rawPoints = max(1, ceil(plannedUnits * unitPricePoints))`
- `reservedPoints (with 15% buffer) = max(1, ceil(rawPoints * 1.15))`
- `actualChargePoints (settlement) = min(reservedPoints, ceil(deliveredUnits * unitPricePoints))` (`0` if `deliveredUnits = 0`)

| Capability ID | Arabic Label | Billing Unit | Provider USD / Unit | Unit Price (Points / EGP) | 1 Unit Reserve (15% Buffer) | 10 Units Base | 10 Units Reserve (15% Buffer) | Enabled in Seed |
|---|---|---|---:|---:|---:|---:|---:|:---:|
| `tiktok-profile` | بيانات حساب تيك توك | حساب (`profile`) | `$0.001` | `6` pts (`0.60` ج.م) | `7` pts (`0.70` ج.م) | `60` pts (`6.00` ج.م) | `69` pts (`6.90` ج.م) | Yes |
| `tiktok-Feed` | منشورات حساب تيك توك | منشور (`post`) | `$0.001` | `6` pts (`0.60` ج.م) | `7` pts (`0.70` ج.م) | `60` pts (`6.00` ج.م) | `69` pts (`6.90` ج.م) | No |
| `tiktok-comments` | تعليقات فيديو تيك توك | صفحة تعليقات (`page`) | `$0.001` | `6` pts (`0.60` ج.م) | `7` pts (`0.70` ج.م) | `60` pts (`6.00` ج.م) | `69` pts (`6.90` ج.م) | No |
| `tiktok-search` | بحث فيديوهات تيك توك | صفحة نتائج (`page`) | `$0.001` | `6` pts (`0.60` ج.م) | `7` pts (`0.70` ج.م) | `60` pts (`6.00` ج.م) | `69` pts (`6.90` ج.م) | No |
| `instagram-profile` | بيانات حساب انستجرام | حساب (`profile`) | `$0.001` | `6` pts (`0.60` ج.م) | `7` pts (`0.70` ج.م) | `60` pts (`6.00` ج.م) | `69` pts (`6.90` ج.م) | No |
| `instagram-posts` | منشورات حساب انستجرام | طلب (`request`) | `$0.002` | `11` pts (`1.10` ج.م) | `13` pts (`1.30` ج.م) | `110` pts (`11.00` ج.م) | `127` pts (`12.70` ج.م) | No |
| `instagram-reels` | ريلز انستجرام | طلب (`request`) | `$0.002` | `11` pts (`1.10` ج.م) | `13` pts (`1.30` ج.م) | `110` pts (`11.00` ج.م) | `127` pts (`12.70` ج.م) | No |
| `instagram-comments` | تعليقات منشور انستجرام | طلب (`request`) | `$0.002` | `11` pts (`1.10` ج.م) | `13` pts (`1.30` ج.م) | `110` pts (`11.00` ج.م) | `127` pts (`12.70` ج.م) | No |
| `twitter-tweet` | تفاصيل تغريدة إكس (تويتر) | تغريدة (`tweet`) | `$0.001` | `6` pts (`0.60` ج.م) | `7` pts (`0.70` ج.م) | `60` pts (`6.00` ج.م) | `69` pts (`6.90` ج.م) | No |
| `youtube-channel` | بيانات قناة يوتيوب | قناة (`channel`) | `$0.001` | `6` pts (`0.60` ج.م) | `7` pts (`0.70` ج.م) | `60` pts (`6.00` ج.م) | `69` pts (`6.90` ج.م) | No |
| `youtube-comments` | تعليقات فيديو يوتيوب | طلب (`request`) | `$0.001` | `6` pts (`0.60` ج.م) | `7` pts (`0.70` ج.م) | `60` pts (`6.00` ج.م) | `69` pts (`6.90` ج.م) | No |
| `google-maps-search` | بحث خرائط جوجل (أنشطة تجارية) | صفحة نتائج (`page`) | `$0.002` | `11` pts (`1.10` ج.م) | `13` pts (`1.30` ج.م) | `110` pts (`11.00` ج.م) | `127` pts (`12.70` ج.م) | No |

---

## 3. Read-Only Post-Launch Audit SQL Queries

Run any of these read-only queries in the Supabase SQL Editor to verify financial and operational integrity:

```sql
-- 1. Ledger reconciliation per user (no negative balances, deterministic prefixes)
SELECT
  user_id,
  COUNT(*) AS ledger_rows,
  SUM(delta) AS current_balance_points,
  ROUND(SUM(delta) * 0.10, 2) AS current_balance_egp
FROM public.credit_ledger
GROUP BY user_id
ORDER BY user_id;

-- 2. Verify every terminal job (completed/failed) has balanced reserve & release rows
SELECT
  j.id AS job_id,
  j.status,
  j.reserved_points,
  j.actual_points,
  j.delivered_units,
  j.unit_price_points,
  COALESCE(SUM(CASE WHEN l.type = 'reserve' THEN l.delta ELSE 0 END), 0) AS reserve_delta,
  COALESCE(SUM(CASE WHEN l.type = 'release' THEN l.delta ELSE 0 END), 0) AS release_delta,
  COALESCE(SUM(CASE WHEN l.type = 'charge' THEN l.delta ELSE 0 END), 0) AS charge_delta
FROM public.jobs j
LEFT JOIN public.credit_ledger l ON l.job_id = j.id
WHERE j.status IN ('completed', 'failed')
GROUP BY j.id, j.status, j.reserved_points, j.actual_points, j.delivered_units, j.unit_price_points
HAVING
  COALESCE(SUM(CASE WHEN l.type = 'reserve' THEN l.delta ELSE 0 END), 0) +
  COALESCE(SUM(CASE WHEN l.type = 'release' THEN l.delta ELSE 0 END), 0) <> 0;

-- 3. Check today's UTC provider spend against the $0.80 daily cap
SELECT
  (now() AT TIME ZONE 'utc')::date AS utc_day,
  COUNT(*) AS spend_entries,
  COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
  0.80 - COALESCE(SUM(cost_usd), 0) AS remaining_cap_usd
FROM public.provider_costs
WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'utc');

-- 4. Verify seeded configuration tables
SELECT
  (SELECT COUNT(*) FROM public.settings_public) AS settings_public_rows,
  (SELECT COUNT(*) FROM public.settings_private) AS settings_private_rows,
  (SELECT COUNT(*) FROM public.capability_registry) AS capability_rows,
  (SELECT COUNT(*) FROM public.capability_registry WHERE is_enabled = true) AS enabled_capabilities,
  (SELECT COUNT(*) FROM public.templates WHERE is_active = true) AS active_templates;
```

---

## 4. Arabic Step-by-Step Owner Checklist for Magdy (Gates G3, G4, G5)

### أولاً: بوابة إعدادات الحسابات والبيئة (Gate G4)
1. افتح لوحة تحكم **Supabase Dashboard** لمشروع `pfinlfaqwnytesedchik` وادخل إلى **Authentication -> URL Configuration**:
   - ضع `https://diger.tech` في خانة **Site URL**.
   - أضف الروابط التالية في **Redirect URLs**:
     - `https://diger.tech/auth/callback`
     - `https://diger.tech/reset`
     - `https://diger.tech/verify`
     - `https://*.vercel.app/auth/callback`
2. من **Authentication -> Email Templates**، انسخ قوالب البريد العربية الثلاثة (تأكيد الحساب، استعادة كلمة المرور، الرابط السحري) الموجودة جاهزة في ملف `docs/CUTOVER.md`.
3. لتفعيل صلاحية الأدمن لحسابك الشخصي على Supabase بعد تسجيل الدخول، نفّذ أمر SQL الموجود في `docs/CUTOVER.md` (قسم تعيين صلاحية الأدمن `raw_app_meta_data`).
4. افتح لوحة تحكم **Vercel -> Project Settings -> Environment Variables** وأضف متغيرات البيئة الموضحة في جدول `docs/CUTOVER.md` (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `ANTHROPIC_API_KEY`, `SCRAPECREATORS_API_KEY`, `INSTAPAY_HANDLE`, `NEXT_PUBLIC_SITE_URL`).

### ثانياً: بوابة تجربة وظيفة حية مصغّرة (Gate G5 - اختياري قبل الإطلاق)
1. تم تجهيز سكريبت الفحص الحي المصغّر في `scripts/verify/run-tiny-live-preview.ts` وهو مقفل بحماية `CONFIRM_LIVE_PREVIEW=YES` ولم يتم تشغيله تلقائياً حفاظاً على رصيد المزود.
2. إذا أردت تشغيله لاختبار جلب حساب تيك توك واحد فقط (`1` وحدة بتكلفة `$0.001` أي `6` نقاط خصم فعلي من `7` نقاط محجوزة)، شغّل الأمر التالي من جهازك:
   ```powershell
   $env:CONFIRM_LIVE_PREVIEW="YES"; npx tsx scripts/verify/run-tiny-live-preview.ts
   ```

### ثالثاً: بوابة الإطلاق النهائي ودمج الفرع (Gate G3)
1. راجع رابط المعاينة (Preview Deployment) الخاص بالطلب **PR #43** على Vercel وتأكد من فتح صفحة `/calculator` وصفحة تسجيل الدخول `/login`.
2. عند رضاك التام، اضغط **Merge Pull Request** لدمج الفرع `migrate/supabase` في `main`، وسيقوم Vercel بنشر النسخة الجديدة تلقائياً على `https://diger.tech` مع تفعيل كرون المراقبة اليومي المجاني (`0 0 * * *`).

---

## 5. تقارير المراحل بالعامية المصرية للمالك (٥ سطور لكل مرحلة)

### المرحلة A (إصلاحات المراجعة وتوحيد التسعير والاختبارات — Commit `6bfaa2d`)
تم توحيد معادلة التسعير في كل ملفات الكود على سعر صرف ٥٥ جنيه ومضاعف ١٠ مرات وقيمة نقطة ٠.١٠ جنيه يعني ٥٥٠٠ نقطة لكل دولار تكلفة.
عدّلنا رسائل أخطاء قاعدة البيانات عشان تظهر كلها بالعربي الواضح وبأرقام عربية مشرقية لكل حالات الرصيد والحد اليومي والحجز.
ظبطنا مسار حذف الحساب بعد مهلة ٣٠ يوم بحيث يمسح البيانات غير المالية والملفات بس ويعمل إخفاء لبيانات البروفايل وحظر للحساب من غير ما يلمس أي سجل مالي.
أضفنا مسار إلغاء طلب حذف الحساب في أي وقت خلال فترة السماح عشان المستخدم يقدر يرجع في قراره بسهولة.
شغّلنا اختبارات مسارات العامل والكرون وحذف الحساب الفعلي وتأكدنا من نجاح ٤٧١ اختبار بالكامل بدون أي أخطاء.

### المرحلة B (تغذية البيانات الأساسية والقدرات والقوالب — Commit `0b6d8a4`)
طبّقنا هجرة تغذية الإعدادات العامة والخاصة في قاعدة بيانات سوبابيس بالسعر المعتمد ٥٥ جنيه للدولار والحد الأقصى ٦٠٠ نقطة للطلب و٠.٨٠ دولار يومياً.
سجّلنا ١٢ قدرة بحثية في جدول القدرات بالأسعار الدقيقة وفعلنا قدرة حسابات تيك توك بس بـ ٦ نقاط للوحدة مع قفل باقي القدرات لحد اختبارها.
أضفنا ٦ قوالب بحثية عربية جاهزة في جدول القوالب عشان تظهر للمستخدمين وتسهّل عليهم بدء الطلبات.
راجعنا فاحص الأمان والأداء في سوبابيس بعد الهجرة وتأكدنا من عدم ظهور أي تحذيرات جديدة في الجداول أو السياسات.
تأكدنا إن دفتر الأستاذ المالي وباقي الجداول المالية لم يتم لمسها نهائياً وإن أرصدة حسابات الاختبار ثابتة ومطابقة.

### المرحلة C (فصل الكود الحي والواجهات عن أبرايت — Commit `4bd9a4d`)
أنشأنا مسار تحميل آمن للنتائج بيتأكد من هوية المستخدم وملكية الطلب قبل إصدار رابط تحميل مؤقت لمدة ٣٠٠ ثانية من سوبابيس.
حوّلنا صفحات لوحة التحكم والطلبات والمحادثة وشحن الرصيد ولوحة الأدمن عشان تقرأ وتكتب مباشرة من سوبابيس بدون أي اعتماد على أبرايت.
حدّثنا مسارات البيانات والمنهجية والملفات ورفع إيصالات إنستاباي عشان تشتغل بالكامل على جداول ومساحات تخزين سوبابيس الخاصة.
عملنا جرد شامل لكل ملفات المشروع وتأكدنا من اختفاء أي استدعاء لأبرايت في كل الصفحات والمكونات النشطة.
بنينا نسخة الإنتاج وفحصنا ٨٢ ملف جافاسكريبت خاص بالمتصفح وتأكدنا من خلوها تماماً من أي مفاتيح سرية أو مكتبات أبرايت.

### المرحلة D (صفحة حاسبة الأسعار العامة `/calculator` — Commit `e818bad`)
بنينا صفحة حاسبة الأسعار العامة على مسار `/calculator` بتصميم عربي كامل من اليمين لليسار ومن غير الحاجة لتسجيل دخول.
ربطنا الحاسبة بنفس دالة التسعير اللي بتكتب عروض الأسعار في المحادثة عشان يطلع نفس الرقم بالمللي في المكانين.
عرضنا التكلفة بالنقاط وبالجنيه المصري بس وبأرقام عربية مشرقية ومن غير أي ذكر للدولار أو أسماء المزودين أو كلمة تقريبي.
وضحنا في الصفحة بشكل صريح إن الحجز يشمل هامش أمان ١٥ بالمئة وإن الخصم النهائي بيكون على الوحدات المستلمة فعلياً والباقي بيرجع تلقائياً.
أضفنا اختبارات آلية بتقارن نتائج صفحة الحاسبة مع نتائج كاتب عروض الأسعار لكل القدرات والأحجام ونجحت كلها بالكامل.

### المرحلة E (دليل الإطلاق وقوالب البريد وإعدادات فيرسل — Commit `3ccf07e`)
راجعنا ملف إعدادات فيرسل وتأكدنا من وجود مهمة كرون يومية واحدة بس متوافقة مع الخطة المجانية Hobby ومفيش أي كرون بيتكرر كل دقيقة.
جهزنا في ملف `docs/CUTOVER.md` ثلاث قوالب بريد إلكتروني عربية جاهزة للنسخ واللصق لتأكيد الحساب واستعادة كلمة السر والرابط السحري.
وثّقنا كل روابط التحويل المطلوبة في سوبابيس وجدول متغيرات البيئة المطلوب إضافته في فيرسل قبل الدمج.
كتبنا خطوات منح صلاحية الأدمن لحسابك بالخطوات والأوامر الجاهزة مع خطة رجوع سريعة في حال احتجت أي تعديل.
رتبنا خطوات الإطلاق النهائي خطوة بخطوة عشان تقدر تنفذها بنفسك بسهولة وأمان تام.

### المرحلة F (سكريبت الفحص الحي المصغّر والتقرير النهائي)
جهزنا سكريبت فحص حي مصغّر في `scripts/verify/run-tiny-live-preview.ts` لاختبار وحدة واحدة من تيك توك وقفلناه بشرط تأكيد يدوي عشان ما يسحبش سنت واحد بدون إذنك.
شغّلنا حزمة الاختبارات الكاملة للمشروع ونجح ٥٩ ملف اختبار بإجمالي ٤٧٣ اختبار بدون ولا غلطة واحدة.
شغّلنا بناء الإنتاج النهائي وفحصنا كل ملفات المتصفح وتأكدنا من عدم تسريب أي سر أو مفتاح خاص.
سجّلنا كل تفاصيل المراحل وأرقام الكوميت وجدول الأسعار النهائي واستعلامات المراجعة المالية في ملف `docs/GO_LIVE_REPORT.md`.
المشروع دلوقتي جاهز للإطلاق على فرع `migrate/supabase` والطلب رقم ٤٣ مفتوح ومستني مراجعتك وموافقتك النهائية للدمج.
