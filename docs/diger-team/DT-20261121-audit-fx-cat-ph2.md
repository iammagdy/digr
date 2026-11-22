# DT-20261121-audit-fx-cat-ph2: /services from Live Catalog (3,276 Endpoints)

- **Task ID:** `DT-20261121-audit-fx-cat-ph2` (`FX-CAT Ph2`)
- **PR Branch:** `team/DT-20261121-audit-fx-cat-ph2`
- **Base:** `origin/main` (`8d207ff2bdcc19ebfacc7d8ec5d8452b4857718a`, post-PR #632 merge)
- **Implementer:** العترة (DIGER FAWAALY-3)
- **Reviewer:** أشرف (DIGER BUG HUNTER-2)
- **Authority:** أمر الكبير (DIGER CTO) وقرارات Megz (D-0086, D-0106).
- **Spec:** `/srv/diger-team/architect2/work/FX-CAT-Ph2-steps.md` (نفادي, G1 GREEN + v1.1).

## 1. ملخص التغييرات (Summary of Changes)

تهدف هذه المرحلة إلى جعل صفحات `/services` ومكون `CatalogBrowser` وقوائم الخدمات ومخطط الموقع (`sitemap`) تقرأ مباشرة وديناميكياً من كتالوج نقاط النهاية الحية القابلة للبيع (`treg_catalog_sellable.json` الذي يضم 3,276 نقطة نهاية)، بدلاً من الاعتماد على مصفوفة ثابتة محدودة بـ 28 خدمة:

1. **Phase 1 (Tests):**
   - إضافة `tests/fx-cat-ph2-live-services.test.tsx` لاختبار شمولية الكتالوج واستبعاد الموردين المتوقفين واستبعاد نقاط النهاية المحظورة/حسابات العميل الخاصة والتعامل مع نقاط النهاية المجانية (`usd === 0`) وفق قرارات v1.1 والتأكد من إضافة أي نقطة نهاية جديدة تلقائياً دون تعديل برمجي.
2. **Phase 2 (Live Catalog Builder):**
   - إنشاء `src/lib/liveServicesCatalog.ts` مع التخزين المؤقت عبر `WeakMap` ودوال:
     - `getLiveServicesCatalog()`
     - `buildLiveServicesCatalog()`
     - `isLiveCatalogEndpoint()`
     - `liveServiceUnitPoints()`
   - توليد نصوص عربية تركيبية نقية متوافقة 100% مع `checkCustomerText` بدون أي إنجليزية وبدون أسماء موردين.
3. **Phase 3A (View Wiring & Data Contract):**
   - ربط `src/lib/servicesCatalogView.ts` بمصدر الحقيقة الحي `getLiveServicesCatalog()`.
   - تصدير عقد بيانات المرحلة الثالثة (Ph3 view contract): `SellableCapabilityItem`, `SellableCapabilityGroup`, `SellableCatalogViewData`, `getSellableCatalogView()`.
   - تحديث `src/app/sitemap.ts` ومكون `src/components/landing/Overview.tsx` ودوال الإتاحة في `src/lib/servicesAvailability.ts`.
4. **Phase 3B (UI Components & Pages):**
   - تحديث `src/components/services/CatalogBrowser.tsx` لاستقبال بيانات القطاعات (`sectors`) عبر الـ props كـ Client Component دون استيراد أي ملفات خادم أو JSON في حزمة المتصفح.
   - تحديث صفحات السيرفر `src/app/services/page.tsx` و `src/app/services/[platform]/page.tsx` لتمرير بيانات الكتالوج الحي مباشرة.
5. **Phase 4 (Decoupling & Test Alignment):**
   - فصل `platformHref` إلى `src/lib/servicesCatalogText.ts` النظيف للمتصفح لمنع تسريب استيرادات الخادم.
   - مواءمة الاختبارات القائمة واجتياز جميع أجنحة الفحص.

## 2. الحدود الصارمة ومكافحة الانجراف (Invariants & Constraints)

- **Zero DB / Migration / Pricing Touch:** عدم تعديل أي ملف في `src/lib/agentMission/price.ts` أو قواعد البيانات أو بوابات الدفع والليدجر.
- **D-0086 Compliance:** صفر قوائم كلمات مخصصة وصفر أسماء موردين داخل الكود.
- **Client Bundle Clean:** فحص حزم الكلاينت للتأكد من خلوها من أي أسرار أو تسريبات لوحدات الخادم.
