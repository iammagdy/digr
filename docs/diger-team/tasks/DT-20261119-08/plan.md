إصلاح مسار التخطيط وفحص المدخلات للطلب المباشر رقم 1 (`DT-20261119-08b`) بدون أي تعديل على مسارات الفلوس أو البوابات المالية أو كود لوحة المشرف المدمج في `#587`.

## السبب الجذري
1. عند إعلان مرحلة الأشخاص (`people`) غير مخدومة (`unserved_steps`) مع وجود نداءات أشخاص ناجحة محفوظة، لم يكن `validateAndPricePlan` يذكر معرفات النداءات المحفوظة (`call_xxxx`) أو خطوات `run_code` / `yield_from` المطلوبة.
2. بعد دمج التقدير (#584)، بقيت تعليمات `agent/prompts/system.md` و`propose_plan` تصف القاعدة القديمة، ولم يكن هناك حد أعلى لتكرار رفض `unserved_steps` فكان المخطط يدور 10 مرات حتى `plan_invalid_after_10_rejections`.
3. صيغة المفرد «من كل شركة مدير» كانت تسقط في `withCheckedPerCompany` و`plan.ts` فتتحول للافتراضي 2 بدل 1.
4. طلب `blitzapi.people.search` أرسل `company.linkedin_url` كقيمة نصية بدل مصفوفة لأن metadata المدخلات في `treg_catalog_sellable.json` (المثبت بـ SHA-256) لم تُعرّف الحقول المتداخلة ولم يوجد فحص شكل عام قبل الإرسال.

## التقسيم على commit 1 و commit 2 (بعد #587)
- `c1`: إصلاح حلقة المخطط (`numberWords.ts`, `plan.ts`, `planner.ts`, `prompts.ts`, `system.md`, `tools.ts`, `runMission.ts` أسطر 891–899 فقط) بإرجاع معرفات النداءات المحفوظة، حد أقصى لإعادة المحاولة (`UNSERVED_PEOPLE_REPAIR_MAX`)، تسجيل فئات وأعداد الرفض الآمنة على حدث المشرف، والحفاظ على `1` لكل شركة لصيغة المفرد.
- `c2`: تعريف `DECLARED_INPUT_SHAPES` كـ metadata في `src/lib/treg/catalog.ts` (مرجعها وثيقة `company` + خطأ 422 الفعلي `company.linkedin_url: Expected an array, got a string`) وعرضها في `src/lib/modelPlanner/tools.ts` مع فحص شكل المدخلات العام (`validateInputShape`) في `agent/src/tools.ts` بدون أي أسماء مزوّدين أو نقاط نهاية في المنطق (`D-0086`) وبدون لمس `tregClient.ts` أو `bounds.ts` أو `sourceRanking.ts` أو `gateway.ts`.
