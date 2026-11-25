# DT-20261125-wordlist-wave1 Phase 1A: Dead Files & Importers Pruning

- **الهدف**: حذف 7 ملفات كود ميتة وأداتي سكريبت و5 ملفات اختبارات غير مستخدمة، وتنظيف 5 اختبارات مختلطة، كجزء من Wave 1.
- **الملفات المحذوفة (14 ملفاً)**:
  - كود مصدري (7): `src/lib/requestUnderstanding.ts`، `src/functions/shared/understandingRequests.ts`، `src/functions/shared/exampleTemplates.ts`، `src/lib/server/multiStepOrchestrator.ts`، `src/lib/server/queryExpansion.ts`، `src/lib/newsSources.ts`، `src/lib/coverageDoc.ts`.
  - أدوات وسكريبتات (2): `scripts/evaluate-understanding.ts`، `scripts/generate-coverage-doc.ts`.
  - اختبارات ميتة بالكامل (5): `tests/request-understanding.test.ts`، `tests/understanding-vague.test.ts`، `tests/multi-step-orchestrator.test.ts`، `tests/query-expansion.test.ts`، `tests/news-sources.test.ts`.
- **إثبات عدم وجود مستوردين (Dead Proof)**:
  - فحص `git grep` شامل في `src/`، `agent/`، `scripts/`، `tests/`، `supabase/`، `package.json` أثبت انعدام أي استيراد نشط لجميع الملفات المحذوفة.
- **الاختبارات المختلطة المنظفة (5 ملفات)**:
  - `tests/large-counts.test.ts` (21 passed): حذف كتلة اختبار `understandRequest`.
  - `tests/understanding-requests.test.ts` (2 passed): حذف كتل اختبار `classifyUnderstandingRequest`.
  - `tests/example-templates-phase5.test.ts` (1 passed): الإبقاء على اختبار واجهة البدء المباشر.
  - `tests/offline-acceptance-scenarios.test.ts` (2 passed): الإبقاء على السيناريوهين D وE لتقييم نوايا البحث.
  - `tests/coverage-doc.test.ts` (3 passed): الإبقاء على فحوصات الجداول وحذف مقارنة البناء التوليدي.
- **Allow-List Shrink**:
  - انخفاض بمقدار `-64 arabic_regex` و`-5 treg_tokens` (إجمالي `-69` مدخلاً).
  - سيتم تحديث `ALLOW_LIST_CEILING` بعد دمج Phase 0 (أو في PR مسودة مستقل).
- **Draft PR**: TBD
