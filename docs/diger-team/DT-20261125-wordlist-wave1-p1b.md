# DT-20261125-wordlist-wave1 Phase 1B: Dead Files Deletion

- **الهدف**: حذف 6 ملفات كود مصدر وسكربت واختبار ميتين بالكامل (dead/unreachable code) ضمن خطة Wave 1 (Megz D-0209).
- **الملفات المحذوفة وإثبات موتها (8 ملفات)**:
  - `src/lib/facebookReport/cost.ts`: صفر استيراد إنتاجي (مجرد تعليق مرجعي واختبارات معزولة).
  - `src/lib/agentMission/allChildren.ts`: دالة تقدير تم فك الاعتماد عليها وحذف اختباراتها المعزولة.
  - `src/lib/server/extractionBenchmark.ts` و`extractionBenchmarkReport.ts`: أداة benchmark قديمة غير مستخدمة.
  - `src/lib/server/measurementReport.ts`: استعلامات قياس قديمة استبدلت بـ measurementPlan.
  - `src/components/pricing/CapacityCalculator.tsx`: مكون حاسبة لم يعد مستخدماً في صفحة الأسعار.
  - `scripts/extraction-benchmark.ts` و`tests/extraction-benchmark.test.ts`: سكربت واختبار الـ benchmark الميت.
- **الملفات الثلاثة المحفوظة وسبب الإبقاء عليها (G1 Preserved)**:
  - `providerDrift.ts`: مستخدم في أداة العمليات الحية `scripts/capabilities/sync-providers.ts`.
  - `spendGate/paidPaths.ts`: حارس أمان المصروفات المفروض باختبار Test Q في `tests/spend-campaign.test.ts`.
  - `promptTokenBreakdown.ts`: مستورد من `scripts/measure-llm-cost.ts` المفحوص في اختبارات spend-safety.
- **تحديث قائمة المسموحات (Allow-List)**:
  - مؤجل للـ fix push التابع لدمج #679 (تسلسل المزامنة): سينخفض 5 arabic_regex و 2 treg_tokens (إجمالي 7 مداخل).
- **الاختبارات والتحقق**:
  - فحص الاختبارات: `tests/methodology-section.test.ts`, `tests/facebook-report-modules.test.ts`, `tests/s1-customer-text.test.ts`, `tests/all-comments.test.ts`, `tests/measurement-plan.test.ts`, `tests/pricing-page.test.tsx`, `tests/spend-campaign.test.ts`
  - فحص الأنواع: `npx tsc --noEmit` و `npm run agent:typecheck`
- **Draft PR**: TBD
