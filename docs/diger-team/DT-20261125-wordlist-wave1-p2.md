# DT-20261125-wordlist-wave1 Phase 2: validateInputShape Extraction

- **الهدف**: استخراج دالة `validateInputShape` إلى `src/lib/treg/inputShape.ts` مع إعادة تصديرها من `agent/src/tools.ts` بدون أي تغيير في السلوك.
- **السبب**: فك الارتباط المباشر بين المخطط و`tools.ts`، لتمهيد الطريق للمرحلة 4 لإلغاء استيراد `tools.ts` داخل المخطط مستقبلاً.
- **تطابق الكود**: متن الدالة مطابق بالبايت بنسبة 100% (byte-identical) بدون أي تعديل.
- **ما لم يتم تغييره عمداً (G2 / G3 Deferred)**:
  - حراس `UNFILTERED_ADMISSION` الخمسة وفلتر سطر 437 في `tools.ts` ظلت كما هي لحماية تسليم البيانات للعملاء (Zero Customer Risk).
  - رسالة `dearerWebProviderMessage` ووصف الأدوات الموجه للنموذج ("x", "youtube", "firecrawl") بقيت دون لمس.
  - عدم المساس بأي ملف داخل `agent/src/llmPlanner/*`.
- **طريقة التشغيل**:
  - `npx vitest run tests/treg-input-shape.test.ts tests/design-guards.test.ts tests/x-account-rumors-replay.test.ts`
  - `npm run agent:typecheck && npx tsc --noEmit`
- **Draft PR**: TBD
