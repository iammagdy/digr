مهمة DT-20261119-07 PR-B (PR #586) — حفظ وتصنيف أرقام التليفون وتقديم المحاولة الأولى وعلامة الإخفاق المؤكد

الطلب: [PR #586](https://github.com/iammagdy/digr/pull/586) على فرع `team/DT-20261119-07b` فوق `origin/main` (`7e8cc484`، بعد دمج PR #585).

## الملخص والتنفيذ
- تصنيف وحفظ أرقام الهواتف في `src/lib/agentMission/contactFinders.ts` (`foundContactDetailIn`): التمييز بين الهاتف الشخصي، خط الشركة أو المكتب (`officeLine` بما فيها `{office:{number}}`)، والفاكس (`PHONE_TYPE_FAX_AR = "فاكس"`), مع مسح الأشكال الاحتياطي تحت المفاتيح الهاتفية فقط واستبعاد الأرقام غير الهاتفية (التواريخ، المعرفات، الأسعار، أرقام التسجيل)، وتسجيل عدد القيم المرفوضة والرقمية والقص.
- تنفيذ خطوات الاتصال على جولتين في `agent/src/engine/contacts.ts`: إتمام المحاولة الأولى لكل الأشخاص قبل استخدام البدائل، والاحتفاظ بالفاكس أو خط الشركة في خانة الحالة عند وجود هاتف شخصي في نفس الإجابة أو في جولة لاحقة، وتخطي التحقق المدفوع لخطوط الشركة والفاكس، وكتابة «غير متوفر» فقط عند استنفاد السلسلة بإجابات مقروءة غير مقطوعة (`scanTruncated` يُعامل كـ «لم يكتمل البحث»).
- إضافة بدائل الإيميل المخزنة في `agent/src/tools.ts` (`contactAids`) و`src/lib/agentMission/stage3/b2bEngine.ts` (`contactColumnsOf`)، وتوحيد ثابت `B2B_NOT_SEARCHED_AR` في `src/lib/agentMission/taskContracts.ts` للحفاظ على عزل وحدات Stage 3 (`tests/stage3-isolation.test.ts`).
- تحديث تنسيق ملف الإكسل في `agent/src/workbook.ts`: الحفاظ على أعمدة الاتصال الفارغة ذات علامة «غير متوفر»، ومنع إصلاح الوالدين من حقن إيميل الشركة مكان خلايا الأشخاص، وضبط `readingOrder: "rtl"` لملاحظات الإيميل الشخصي المسبوقة بعلامة `U+200E`.

## الدليل والاختبارات
- فشل أولي للـ FIX1 على `aa5500cc`: ٣ فشل في `tests/dt-0119-07b-contacts.test.ts` (الفاكس بجانب الموبايل، `{office:{number}}`، و`scanTruncated`) + ٤ فشل CI في `tests/stage3-isolation.test.ts`، `tests/stage3-planning-wiring.test.ts`، و`tests/stage3-flags-off.test.ts`.
- بعد الإصلاح (FIX1): نجاح كامل لحالات `tests/dt-0119-07b-contacts.test.ts`، ونجاح ملفات Stage 3 الأربعة، وتحديث بصمات `tests/fixtures/stage3-flags-off.json` لبدائل الإيميل وعلامات «غير متوفر» مع ثبات `completed:15:2234:` دون تغيير أي تسوية أو تسعير.
- التراجع: عكس PR #586 (`git revert`)؛ لا توجد هجرات SQL أو مفاتيح تشغيل.
