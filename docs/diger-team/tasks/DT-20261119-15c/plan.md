# DT-20261119-15c — ربط استعادة كروت الشركات والأشخاص بالقدرات المعتمدة وتثبيت المثنى المؤنث بالأسماء المصرحة

معالجة الأسباب الجذرية لرفض أو تعذر تخطيط كروت طلبات الشركات ومسؤوليها (Live People Requests)، عبر تثبيت قراءة المثنى المؤنث بالأسماء المصرحة في الملخص دون قوائم استثناءات أو تعابير عامة، والحفاظ على أهداف النموذج اللغوي عبر الردود التوضيحية، وربط مسارات الاسترداد بالقدرات المؤهلة فعلياً مع توفير سؤال توضيحي صادق عند غياب مصادر مؤهلة وتشخيصات إدارية منقحة.

## الأسباب الجذرية (Root Causes)
1. **رفض المثنى المؤنث «شركتين» في `validateBrief` (Case 1)**:
   - في `src/lib/agentMission/researchBrief.ts`، كانت الدالة `numbersWritten` تفحص الأرقام الصريحة وألفاظ العقود فقط، متجاهلة المثنى المؤنث لأسماء العناصر الواردة في الطلب. واستخدام تعبير نمطي عام للواحق (`FEMININE_DUAL_AR`) رُفض معمارياً وفق `D-0086` لخطئه في كلمات مثل «باكستان» و«أفغانستان» و«بساتين» و«حيتان».
   - الحل: تثبيت استخراج المثنى المؤنث (`<stem>تين`/`<stem>تان`) حصراً للأسماء المفردة المنتهية بتاء مربوطة والمذكورة نصاً في الملخص عبر `briefItemNouns`، دون أي قوائم استثناءات أو تعابير عامة.
2. **فقدان أهداف النموذج اللغوي المخزنة عبر قفزتين عند ورود إجابة توضيحية (Case 2)**:
   - **القفزة الأولى (`agent/src/main.ts`)**: كانت `readMissionBrief` تستعلم بـ `.limit(1)` فتصل لبطاقة الإجابة الجديدة الخالية من `researchBrief` بدلاً من بطاقة الملخص الأصلية. تم توسيع البحث إلى `.limit(20)`.
   - **القفزة الثانية (`agent/src/runMission.ts`)**: كانت `missionObjectivesBrief` تُرجع `null` فور وجود `answer_text`، مما يُسقط أهداف البحث المخزنة. تم دمج `decideTurn` مع التحقق الصارم للحفاظ على الأهداف أو تحديثها بصورة متسقة مع إجابة العميل.
3. **عدم مطابقة مسارات التعافي مع مراحل القدرات المعتمدة وتشخيصات الإدارة (P01 & P03–P05)**:
   - كانت `companyPeopleRecovery.ts` تعتمد مفاتيح ثابتة ولا تلزم ترشيح نقاط الاتصال بالقوائم المؤهلة في `capabilities.stages`، مما يقود لرفض الخطة في `planStageIssues`.
   - الحل: ربط مفاتيح المراحل (`rootStageKey`, `peopleStageKey`) والترشيح حصراً بالقوائم المؤهلة (`eligibleRootIds`, `eligiblePeopleIds`)، وتوجيه سؤال توضيحي صادق واحد عند عدم توفر مصادر مسؤولي شركات مؤهلة بدلاً من رسائل الفشل الداخلي («حد من جانبنا»)، وتمرير تشخيصات منقحة `cap_issues` للإدارة بدون تسريب نصوص عربية أو بيانات عملاء.

## محاور التنفيذ (Phases & Changes)
- **Phase 1**: إضافة حزمة الاختبارات الشاملة `tests/dt-0119-15c-capability-recovery.test.ts` والتحقق من سلوك fail-first (7 اختبارات تغطي Must-pass 1, 2A, 2B وحالات الانحدار والمثنى).
- **Phase 2**: تحديث `src/lib/agentMission/researchBrief.ts` بدوال `briefItemNouns` و `numbersWritten(raw, nouns)` وربطها في `validateBriefAsWritten` و `withPartCounts` و `briefNumbersAr`.
- **Phase 3**: تحديث `agent/src/main.ts` بـ `.limit(20)` وتحديث `agent/src/runMission.ts` لدعم استمرارية الملخص وتنسيق مهمة التخطيط `planMission` وتشخيصات `cap_issues`.
- **Phase 4**: تحديث `agent/src/companyPeopleRecovery.ts` لربط الاسترداد بالقدرات المؤهلة فعلياً مع السؤال التوضيحي الصادق ودالة تنقيح أسباب المشاكل `sanitizeCapIssuesForAdmin`.
- **Phase 5**: توثيق الخطة في `docs/diger-team/tasks/DT-20261119-15c/plan.md`.

## التحقق وضمان الجودة
- اختبارات المهمة المخصصة: 7/7 ناجح (`tests/dt-0119-15c-capability-recovery.test.ts`).
- الحزمة المستهدفة (5 ملفات / 137 اختباراً - ناجح):
  - `tests/dt-0119-15c-capability-recovery.test.ts` (7)
  - `tests/agent-understanding-units.test.ts` (37)
  - `tests/llm-first-objectives.test.ts` (28)
  - `tests/multi-objective-research.test.ts` (38)
  - `tests/unified-capability-discovery.test.ts` (27)
- التدقيق البرمجي للوكيل: `npm run agent:typecheck` خروج 0.
- التدقيق البرمجي العام: `npx tsc --noEmit` خروج 0.
- سلامة الشجرة والملفات: `src/lib/agentMission/capabilities/need.ts` لم يتم لمسه ومطابق تماماً للرئيسي.
- فحص التنسيق والمسافات: `git diff --check` خروج 0.
