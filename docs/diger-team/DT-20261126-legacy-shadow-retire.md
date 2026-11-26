# DT-20261126-legacy-shadow-retire — إزالة نظام مقارنة الظل الإداري (D-0224)

## 1. ملخص التغيير والسبب
- **التكليف والمرجعية:** قرار ميجز المعتمد `D-0224` (إزالة نظام مقارنة الظل الإداري المعزول `admin shadow compare`) وتكليف الكبير `DT-20261126-wordlist-wave3/O16`.
- **الأساس والفرع:** `team/DT-20261126-legacy-shadow-retire` انطلاقاً من `origin/main` (`a37cf3a2`).
- **لماذا:** نظام مقارنة الظل (`ShadowPanel` و`agentMission/shadow/**` ومسار `/api/admin/shadow`) كان أداة إدارية داخلية غير متصلة بالإنتاج، أُنشئت في 14 نوفمبر 2026 للمقارنة غير الحية للطلبات مع سلوك الوكيل المقترح. أثبت فحص التبعيات (`BFS Liveness`) خلو النظام من أي مستخدمين أو عملاء (أثر العميل = 0، وأثر مالي = 0)، وتم تقاعده بأمان لتقليص الكود القديم وخفض قيود حراس التصميم.

## 2. ما تم حذفه وتعديله
1. **حذف 13 ملفاً معزولاً بنسبة 100%:**
   - مسار الإدارة والمكون: `src/app/api/admin/shadow/route.ts` و`src/components/admin/ShadowPanel.tsx`.
   - حزمة الظل البرمجية بالكامل: `src/lib/agentMission/shadow/**` (8 ملفات: `auditScenarios.ts`, `compare.ts`, `context.ts`, `corpus.ts`, `labels.ts`, `redact.ts`, `types.ts`, `understanding.ts`).
   - ملف الاختبارات: `tests/shadow-phase7.test.ts` (حذف 63 اختباراً خاصاً بالظل).
   - ملف البيانات وسكربت البناء: `data/shadow/corpus.json` و`scripts/shadow/build-corpus.ts`.
2. **تعديل واجهات وإعدادات الإدارة:**
   - تنظيف `src/app/admin/agent/page.tsx` بإزالة استيراد وعرض المكون، مع الحفاظ التام على لوحة `AcceptancePanel` وسجل `contract-events`.
   - تنظيف `next.config.mjs` بإزالة سطر تتبع مسار `/api/admin/shadow` مع الإبقاء على تتبع باقي المسارات وملف `registry.json`.
   - تمديد `tests/acceptance-panel.test.tsx` باختبار يضمن عدم عودة `ShadowPanel` وسلامة بقية المكونات.
3. **مزامنة قائمة استثناءات حراس التصميم (`design-guards-allow.json`):**
   - خفض قيود `arabic_regex` بمقدار **-9 قيود** (من 1375 إلى 1366).
   - خفض قيود `treg_tokens` بمقدار **-6 قيود** (من 450 إلى 444).
   - إجمالي الخفض: **-15 قيداً** بنجاح كامل (`0 unallowed / 0 stale`).
4. **تحديث التوثيق التاريخي:**
   - إضافة إشعار التقاعد المؤرخ في `docs/HANDOFF.md` و`docs/intelligence/PHASE-7-SHADOW-EVALUATION.md`.

## 3. نتائج التحقق والبوابة الهندسية (D-0220 Gate)
- خلو المستودع تماماً من أي مراجع للظل (`0 hits` عبر `src/ agent/ tests/ scripts/ next.config.mjs package.json .github`).
- خلو المسارات من أي مراجع للمسار القديم (`0 hits` لـ `/api/admin/shadow`).
- اجتياز اختبارات `golden-quote-parity` (7/7) واختبارات حراس التصميم `design-guards` (7/7) واختبارات `acceptance-panel` (11/11).
- فحص استثناءات حراس التصميم: خروج 0 (`0 unallowed, 0 stale`؛ `arabic_regex`=1366, `treg_tokens`=444, `srv_paths`=0, `fallback_lists`=2).
- بوابة الجودة الشاملة D-0220 تحت القفل الثقيل (`heavy.lock`):
  - **Vitest full suite**: اجتياز 1,163 ملف اختبار (22 تخطٍ من أصل 1,185)، ونجاح 16,969 اختباراً (47 expected fail، 288 skipped، 21 todo) بنسبة فشل 0.
  - **فارق عدد الاختبارات عن main**: انخفاض بمقدار 62 اختباراً بالضبط (-63 لحذف `tests/shadow-phase7.test.ts` + 1 لاختبار منع الانحدار في `tests/acceptance-panel.test.tsx`).
  - **فحص الأنواع الجذري (Root TypeScript)**: خروج 0 (`NODE_OPTIONS="--max-old-space-size=6144" npx tsc --noEmit`).
  - **فحص أنواع الوكيل (Agent TypeScript)**: خروج 0 (`npm run agent:typecheck`).
  - **بناء النكست (Next Build)**: خروج 0، صفر أسرار في الحزم الثابتة، ظهور مسار `/admin/agent` وغياب مسار `/api/admin/shadow`.
