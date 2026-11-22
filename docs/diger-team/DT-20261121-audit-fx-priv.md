# DT-20261121-audit-fx-priv: إزالة قيود الخصوصية والتصنيف الحساس (Remove All Privacy Refusals & Sensitive Gating)

- **المهمة (Task ID):** `DT-20261121-audit-fx-priv` (`FX-PRIV`)
- **المرجعية والسلطة (Authority):** قرارات Megz (`D-0184 + D-0185 + D-0186`) عبر DIGER COMMANDER (الكبير).
- **المنفذ (Implementer):** سالم (DIGER FAWAALY-2)
- **الفرع (Branch):** `team/DT-20261121-audit-fx-priv`
- **الالتزام الأساسي (Base Commit):** `9bca6ad762f01242337d12f1bb7694f4751f8910` (`origin/main`)
- **المراجعة والاعتماد (Review Gate):** خطوات نفادي (ARCHITECT-2) ومراجعة أشرف (BUG HUNTER-2).

---

## 1. المشكلة وجذرها التقني (Problem Statement & Root Cause)

وفق قرارات Megz الحاسمة (`D-0184` و`D-0185` و`D-0186`)، كان النظام يرفض طلبات جمع البيانات الخاصة أو الشخصية (مثل أرقام الحسابات البنكية، أرقام الهواتف الشخصية، الأرقام القومية، إيميلات وتليفونات المعلقين، عناوين السكن) عبر طبقات متعددة من الرفض المسبق والحراسة:
1. قواعد رفض الخصوصية التي أضيفت في PR #619 في موجهات المحادثة والمخطط (`prompts.ts` و`conversationModel.ts` و`chatTurn.ts`).
2. حراسة الكلمات والتعبيرات النمطية في `guardRules.ts` (`PERSONAL_CONTACT`, `PRIVATE_EXPLICIT`, `HARVEST_CONTACT`, `preModelAnswer`, `sensitiveRequestRefusalAr`).
3. حراسة القدرات الخاصة `PRIVATE_CAPABILITY` في `registry.ts` و`selection.ts` و`providerDrift.ts` و`tools.ts` و`companyPeopleRecovery.ts`.
4. تصنيف نقاط النهاية الحساسة `sensitive` في `dataPolicy.ts` وبوابات التدقيق والتحقق.

المطلوب: إزالة كافة قيود الخصوصية وبوابات التصنيف الحساس عبر كامل المنظومة بحيث يتم تخطيط وتنفيذ جميع طلبات البيانات (أفراد، حسابات بنكية، أرقام قومية، هواتف) بشكل طبيعي ودون أي رفض خصوصية.

---

## 2. قواعد التصميم والحدود الصارمة (Never-Touch Boundaries & Constraints)

- **الالتزام الصارم بقائمة الملفات المحظورة (NEVER-TOUCH List):**
  - صفر تعديل على `agent/src/gateway.ts` و`agent/src/webGateway.ts`.
  - صفر تعديل على `src/lib/agentMission/price.ts` و`src/lib/missionPricing.ts`.
  - صفر تعديل على `src/lib/agentMission/text.ts` و`src/lib/agentMission/eventText.ts`.
  - صفر تعديل على `src/middleware.ts` و`next.config.mjs` وملفات الترحيل SQL ومجلد `supabase/migrations`.
  - صفر تعديل على `data/treg/data_policy.json` (تم تحويل التصنيف برمجياً في `src/lib/treg/dataPolicy.ts`).
- **الحفاظ التام على حظر العمليات المحظورة فعلياً (Counter-cases Preserved):**
  - استمرار حظر عمليات الكتابة (`write_action` مثل `openmart.deny-rules.create`).
  - استمرار حظر نقاط الحساب الخاص (`own_account`).
  - استمرار حظر المزودين المتوقفين (`paused_provider`: `apollo`, `datagma`).
  - استمرار حظر روابط المراسلة المباشرة الخاصة (`B3_private_message_deep_link`).
  - استمرار إجابة أسئلة الحساب والثقة في `preModelAnswer` دون إنشاء مهمة.
- **التدقيق المالي والمحاسبي:**
  - المحاسبة على التسليم الفعلي فقط (`chargedPoints === 0` عند تسليم 0 صفوف).
  - الحفاظ على تدقيق استعلامات المسؤول (`sensitive_lookup_audit`) في `src/lib/server/sensitiveAccess.ts` مع حد الـ $2 اليومي عند تمرير `requireAudit: true`.

---

## 3. التعديلات البرمجية المنفذة (Changes Implemented)

### المرحلة 1: التراجع عن PR #619 في موجهات المحادثة والمخطط
- تنظيف `agent/src/llmPlanner/prompts.ts` من فقرات `PRIVATE PERSONAL DATA RULE`.
- تنظيف `src/lib/agentMission/conversationModel.ts` من نوع `privacy_refusal` وقواعد رفض البيانات الخاصة.
- تنظيف `src/lib/agentMission/chatTurn.ts` من معالجة `privacy_refusal`.

### المرحلة 2: إزالة حراسة الخصوصية في `guardRules.ts` والمستدعين
- تفريغ التعبيرات النمطية للخصوصية في `guardRules.ts` وجعل دوال التحقق تعيد دائماً `"allow"` أو `false` أو `null`.
- الإبقاء فقط على أسئلة الحساب (`account`) وأسئلة الثقة (`trust`) في `preModelAnswer`.
- إزالة استدعاءات حراسة الخصوصية من `customerActions.ts` و`researchBrief.ts` و`capabilities/need.ts`.

### المرحلة 3: إزالة بوابة `PRIVATE_CAPABILITY`
- إزالة تصنيف `PRIVATE_CAPABILITY` ودالة `isPrivateCapabilityString` من `registry.ts`.
- تنظيف `selection.ts` و`providerDrift.ts` و`tools.ts` و`companyPeopleRecovery.ts`.
- إعادة توليد ونشر `data/capabilities/registry.json`.

### المرحلة 4: تحويل `sensitive` إلى `public` في `dataPolicy.ts` وتحديث الاختبارات
- في `src/lib/treg/dataPolicy.ts`: تحويل التصنيف الحساس الخام إلى `public`، مما يجعل `policyVerdict` تسمح بجميع نقاط النهاية غير المحظورة لكافة المستخدمين.
- في `src/lib/server/sensitiveAccess.ts`: استمرار تسجيل التدقيق عند `requireAudit: true` لحسابات المسؤول وحد الـ $2 اليومي.
- تحديث وتوافق كافة حزم الاختبارات مع السلوك الجديد للخصوصية وإزالة التوقعات القديمة.
- تحديث جدول مقارنة إعادة التشغيل `docs/proposals/agent-loop/REPLAY_COMPARISON.md`.

---

## 4. نتائج التحقق (Verification Results)

1. **فحص الأنواع (Typecheck):**
   - جذر المشروع: `tsc --noEmit` -> نجاح كامل (Exit code 0).
   - الوكيل: `npm run agent:typecheck` -> نجاح كامل (Exit code 0).
2. **فحص الملفات المحظورة (NEVER-TOUCH):**
   - `git diff origin/main` عبر كافة الملفات المحظورة = 0 بايت فارغ تماماً.
3. **فحص الاختبارات المرتبطة (Vitest Related):**
   - تشغيل الاختبارات المرتبطة على الملفات المعدلة -> نجاح 100%.
