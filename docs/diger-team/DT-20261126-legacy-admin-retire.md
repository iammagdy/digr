# توثيق تقاعد فحص المخطط وبذور الوصفات وتتبع السلاسل القديمة (DT-20261126-legacy-admin-retire)

**المعرف:** DT-20261126-legacy-admin-retire / O23  
**المرجع:** قرار ميجز المعتمد D-0225  
**المنفذ:** العترة (FAWAALY-3)  
**المصمم:** نفادي (ARCHITECT-2)  
**التاريخ:** 26 نوفمبر 2026  
**طبيعة التكليف:** تنظيف وتقاعد كود إداري قديم معزول بنسبة 100% — أثر العميل = 0، وأثر مالي = 0 (Non-money, admin-only).

---

## 1. ملخص التغييرات المعتمدة

تم تنفيذ قرار ميجز D-0225 بحذف المكونات الإدارية القديمة المعزولة التي لم تعد مستخدمة في النظام الإنتاجي بعد نضوج مسارات الوكيل وقارئ المخرجات وقوائم المزودين:

### أ. الملفات المحذوفة (11 ملفاً):
1. `src/app/admin/planner-selftest/page.tsx` — صفحة فحص المخطط القديمة للمشرفين.
2. `src/app/api/admin/planner-selftest/route.ts` — نقطة نهاية مسار فحص المخطط.
3. `src/lib/modelPlanner/selfTest.ts` — حالات ومنطق الاختبار الذاتي للمخطط القديم.
4. `src/lib/modelPlanner/selfTestCsv.ts` — تصدير نتائج الفحص الذاتي إلى ملف CSV.
5. `src/lib/modelPlanner/health.ts` — فحص سلامة المخطط القديم.
6. `src/app/api/admin/recipes-seed/route.ts` — مسار زر تحميل الوصفات المثبتة.
7. `src/lib/modelPlanner/recipeSeeds.ts` — بذور الوصفات القديمة ومنطق إدخالها المسبق.
8. `src/components/admin/RoutingTracePanel.tsx` — لوحة تتبع سلاسل المزودين القديمة في صفحة المهام.
9. `src/app/api/admin/job-trace/route.ts` — نقطة نهاية تتبع السلاسل للمشرفين.
10. `tests/model-planner-admin-selftest.test.ts` — اختبارات صفحة ومسار فحص المخطط (-20 اختباراً).
11. `tests/recipe-seeds-constraints.test.ts` — اختبارات قيود بذور الوصفات القديمة (-8 اختبارات).

### ب. الملفات المعدلة لتنظيف المراجع (11 ملفاً):
1. `src/app/admin/jobs/page.tsx` — إزالة استيراد واستدعاء `RoutingTracePanel` مع الإبقاء الكامل على `JobDiagnosticPanel` وأعمدة الجدول.
2. `src/components/admin/nav.ts` — إزالة فحص المخطط من قسم الوكيل وقاموس معلومات الصفحات والمسارات القديمة.
3. `src/components/admin/icons.tsx` — إزالة أيقونة ونوع `planner-selftest` من شريط تنقل الإدارة.
4. `next.config.mjs` — إزالة تتبع مساري `/api/admin/planner-selftest` و`/api/admin/recipes-seed`.
5. `tests/admin-navigation.test.tsx` — إزالة مسار فحص المخطط من مصفوفة المسارات القديمة.
6. `tests/model-planner-standalone.test.ts` — إزالة مسار فحص المخطط من حلقة مسارات فحص الكتالوج.
7. `tests/multi-provider-trace.test.ts` — إزالة استيراد واختبار مسار `job-trace` المحذوف (-1 اختبار) مع بقاء اختبارات السلاسل والتتبع الحية (25 اختباراً).
8. `tests/phase2-mission-manager.test.ts` — إزالة استيراد واختباري بذور الوصفات (-2 اختباران) مع بقاء كافة اختبارات مدير المهام (36 اختباراً).
9. `tests/admin-dashboard-truth.test.ts` — إضافة اختبار عدم انحدار للتأكد من خلو صفحة المهام من لوحة التتبع ومسارها.
10. `docs/admin-reorg/README.md` — تحديث جدول أقسام لوحة الإدارة.
11. `tests/fixtures/design-guards-allow.json` — مزامنة قيود حراس التصميم وإزالة قيود الملفات المحذوفة.

---

## 2. ما تم الإبقاء عليه وحمايته (Counter-Cases)

- **زر الفحص السريع:** الإبقاء التام على زر ومسار فحص المزودين `api/admin/smoke` وملف `functions/shared/smokeTest.ts` لفحص المزودين الحي.
- **زر إعادة التجربة:** الإبقاء التام على زر ومسار إعادة تجربة الطلبات الفاشلة `api/admin/failures/retry` وملف `src/lib/modelPlanner/retryRequest.ts`.
- **ملفات التتبع والنقل الحية:** بقاء `transport.ts` و`trace.ts` و`traceStore.ts` و`paidPaths.ts` مطابقة بالبايت للإنتاج.
- **قواعد البيانات والمالية:** جدول `recipes` سليم دون أي مساس، صفر تعديل على جداول SQL أو الترحيلات، وصفر مساس بالأسعار أو الأرصدة أو تجربة العملاء.

---

## 3. مؤشرات الحراس والاختبارات

- **قيود حراس التصميم (Allow-list):**
  - `arabic_regex`: 1366 → 1365 (-1).
  - `treg_tokens`: 444 → 428 (-16).
  - `srv_paths`: 0 (لا تغيير).
  - `fallback_lists`: 2 (لا تغيير).
  - **صافي الانخفاض:** -17 قيداً، ونتيجة الفحص `0 unallowed / 0 stale`.
- **فارق الاختبارات:**
  - انخفاض صافي بمقدار -31 اختباراً (-28 في الملفين المحذوفين و-3 في الملفين المعدلين).
  - انخفاض عدد ملفات الاختبارات بمقدار -2 ملفين.
