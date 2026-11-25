# DT-20261126-wordlist-wave3-5a — المرحلة 5A: إزالة القيم الثابتة في `finderStats` و`reverseOrder` مع حفظ تطابق التسعير

## 1. ملخص التغيير والسبب
- **التكليف والمرجعية:** قرار مجز `D-0221` (تنفيذ المرحلة المالية `5A` بواسطة `جوني`)، خطة `tierA-v1.3-frozen.md` مع التعديلات `A1–A6` والتعديل `B1` (`amendment-B1-5A.md`).
- **الفرع والأساس:** `team/DT-20261126-wordlist-5a` فوق `origin/main` (`73036bd6`).
- **لماذا:** إزالة أسماء المزودين ومعرّفات الـ `endpoints` الثابتة من ملفات التسعير والبحث العكسي (`finderStats.ts` و`reverseOrder.ts`) ونقلها إلى طبقات البيانات (`endpoint_metadata_overlay.json` و`provider-metadata.json`)، مع إلغاء حد `0.01` الوهمي في `finderHitRate` وتثبيت تطابق التسعير وسعة المحفظة بالبايت عبر اختبار خط الأساس الذهبي.

## 2. ما تم تنفيذه (مع تقليص النطاق `B1`)
1. **خط الأساس الذهبي وحارس المتصفح (`5A-P01`, `5A-P02`):**
   - توليد `tests/fixtures/golden-quote-parity-baseline.json` مباشرة من `origin/main` (`73036bd6`) نظيف.
   - إنشاء `tests/golden-quote-parity.test.ts` لتثبيت تسعير المهام المسجّلة، ومعدلات الإصابة، واقتباس `B2B`، وقدرات القائمة الثابتة، وسعة المحفظة، وقوائم البحث العكسي، ومسارات `ROUTE_DEFS`، وحارس `A1/B1` لمنع أي ملف `"use client"` من استيراد `finderStats.ts` أو `reverseOrder.ts` أو `provider-metadata.json` ومنع `routes.ts` من استيراد `provider-metadata.json`.
2. **قياسات `finderStats.ts` من الكتالوج (`5A-P03`..`5A-P06`):**
   - إضافة قياسات `observed.diger_calls` و`diger_hits` لـ 14 مصدر اتصال داخل `data/treg/endpoint_metadata_overlay.json` ودمجها داخل `applyEndpointMetadataOverlay` في `src/lib/treg/catalog.ts` دون المساس ببصمة `treg_catalog_sellable.json`.
   - تحويل `finderHitRate` و`pooledHitRate` في `src/lib/agentMission/finderStats.ts` للحساب الديناميكي من الكتالوج مع تحميل كسول (`Proxy`، تعديل `A6`) وإلغاء حد `0.01`، مع اختبارات الفشل الأولي في `tests/contact-budget-measured.test.ts`.
3. **قوائم البحث العكسي من البيانات (`5A-P07`, `5A-P09`):**
   - إضافة `emailOrder`, `phoneOrder`, `noWaterfall`, `companyDomainOnly`, `usOnlyPhone` داخل `treg.reverseLookup` في `data/capabilities/provider-metadata.json` بجانب `adminOnly`.
   - قراءة القوائم في `src/lib/treg/reverseOrder.ts` عبر `readReverseLookupConfig` مع فشل صريح يذكر اسم المفتاح المفقود (`A4`).
4. **تعديل `B1` ومزامنة الحراسة (`5A-P11`):**
   - استبعاد `src/lib/multiProvider/routes.ts` (`5A-P10`) وكتلة `multiProvider` و`sync-providers.ts` (`5A-P08`) لوجود سلاسل استيراد عميل سابقة في `main`، وتأجيلها لـ `BACKLOG`.
   - مزامنة `tests/fixtures/design-guards-allow.json` (`treg_tokens: 503 -> 461`, `-42`، مع بقاء إشارة الخاصية `providerMetadata.treg` في `reverseOrder.ts` كمرجع مفتاح JSON فقط).

## 3. الإثبات
- اجتياز `tests/golden-quote-parity.test.ts` (7/7)، و`tests/design-guards.test.ts`، و`npx tsx scripts/sync-design-guards-allow.ts --check` (`0 unallowed`, `0 stale`).
- استيفاء بوابة `D-0220` الكاملة (`vitest`، `tsc --noEmit`، `agent:typecheck`، `npm run build`) على الـ `HEAD` الدقيق قبل الدفع وفتح مسودة الـ `PR`.
