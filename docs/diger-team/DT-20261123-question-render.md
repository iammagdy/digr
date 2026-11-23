# DT-20261123-question-render: Question Render Fix & Customer Request Text Whitelist (P0)

- **Task ID:** `DT-20261123-question-render`
- **Severity:** P0 (Customer test deadline 07:00Z)
- **Implementer:** سالم (DIGER FAWAALY-2)
- **RCA & Patch Author:** أشرف (DIGER BUG HUNTER-2)
- **Pre-Check Reviewer:** فزاع (DIGER BUG HUNTER)
- **Authority:** أمر الكبير (DIGER CTO)

## 1. السبب الجذري (Root Cause Analysis - RCA)

1. **غياب `request_text` في `SAFE_COLUMNS` (`src/lib/agentMission/customerActions.ts`):**
   - لم يكن حقل `request_text` ضمن الأعمدة الآمنة المسترجعة من قاعدة البيانات عند قراءة المهمة.
   - عند تمرير المهمة إلى واجهة العرض `guardViewText`، كانت النصوص الإنجليزية/اللاتينية التي كتبها العميل بنفسه في طلبه (مثل أسماء الحسابات والمعرفات `@SaudiMOH`) تُعامل ككلمات أجنبية غير مصرح بها لأنها لم تكن موجودة في نص الطلب المقروء.
   - نتج عن ذلك حجب نص السؤال بالكامل ومسحه (`blanking the question`).

2. **قراءة الحقل غير الدقيق في شاشة المحادثة (`src/app/dashboard/chat/page.tsx`):**
   - كانت الاستعلامات تقرأ `content` بدلاً من `content_ar` لرسائل العميل الأولى، مما أدى لعدم مطابقة النص العربي المعتمد.

3. **غياب بديل آمن عند تعذر عرض السؤال (`src/lib/agentMission/customerView.ts` & `AgentMissionCard.tsx`):**
   - في حال احتوى السؤال المولد بواسطة النموذج على كلمات لاتينية لم يكتبها العميل، كان السؤال يُفرغ دون تقديم بديل عربي محايد.
   - كذلك كانت بطاقة المهمة `AgentMissionCard` تشترط `v.phase === "question" && v.questionAr`، فإذا فرغ السؤال اختفت كتلة السؤال بالكامل، مما يربك العميل ويترك مرحلة السؤال بدون توجيه.

## 2. التأثير على العميل (Customer Effect)

- **السؤال لا يفرغ أبداً (A question is never blank):**
  - تضمن المنظومة الآن الحفاظ على الكلمات والمقابض والحسابات اللاتينية التي كتبها العميل في طلبه الأصلي داخل نص السؤال وخياراته.
  - إذا ظهرت كلمة لاتينية غير واردة في نص العميل، يتم الرجوع تلقائياً إلى السؤال المحايد المعتمد: `تحب نكمل إزاي في طلبك؟` (`NEUTRAL_QUESTION_AR`).
  - في مرحلة السؤال `phase === "question"`، تعرض بطاقة المهمة دائماً كتلة السؤال بوضوح مع خيارات الإجابة، ولا تظهر أي فقاعة سؤال فارغة إطلاقاً.
