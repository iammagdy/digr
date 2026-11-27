# DT-20261127-shape-delivery-files — تشكيل ملفات التسليم لمهام الوكيل (D-0258)

## 1. السبب والتشخيص
- كانت ملفات التسليم لمهام الوكيل (`agent-mission`) غير قابلة لإعادة التشكيل والتنسيق المخصص (`file shaping`) في المحادثة أو عبر مسار التنزيل:
  1. استعلام وظائف المحادثة في `conversationJobs.ts` لم يكن يجد مهام الوكيل، لأن معرف المهمة مخزن كـ `plan.agentMissionId` في كارت المساعد وليس كـ `quoteId`.
  2. قارئ الأعمدة `loadLatestResultColumns` في `savedResultColumns.ts` ومسار البيانات لا يقرأ سوى ملفات `data.json` للوظائف القديمة.
  3. مسار التنزيل `api/jobs/[id]/download/route.ts` كان يرد بـ 400 على أي طلب يحمل معلمة التنسيق `spec` لوظائف مهام الوكيل.
  4. النتيجة للعميل: عند طلب إعادة التنسيق (مثل «رتب حسب اسم الشركة»)، كان الطلب يُوجّه للوكيل كمهمة بحث جديدة بدلاً من تشكيل الملف المسلّم.

## 2. التعديلات المنفذة
- **P1 (`src/lib/server/conversationJobs.ts`)**:
  - استخراج `plan.agentMissionId` المطابق لنمط المعرفات `/^msn_[a-z0-9]{8,40}$/`.
  - استعلام جدول `missions` لربط معرف المهمة بمعرف الوظيفة `job_id`، مع حصر الاستعلام بـ `user_id` الخاص بالعميل.
  - استبعاد مهام الإضافات (`addon`) تلقائيًا عبر `hasAddonMarker`.
  - إضافة اختبار `tests/shape-delivery-lookup.test.ts` (T1).
- **P2 (`src/lib/agentMission/deliveredWorkbook.ts`)**:
  - دالة `readDeliveredWorkbook(client, { job })` للتحقق من بوابات الإفراج (`resultsReleasable` و`!deliveredNothing`).
  - قراءة وصف ملف الإكسل الأصلي للتسليم من `agent-missions`، والتحقق الصارم من التوقيع والتجزئة (`sha256`) للمصنفات المغلقة (`isSealedWorkbook`) ومطابقتها قبل قراءة المصنف، مع فرض سقف الحجم (15 ميجابايت).
  - إضافة اختبار `tests/shape-delivery-workbook.test.ts` (T2) والتأكد من التكافؤ مع `customerCsvFile`.
- **P3 (`src/lib/agentMission/deliveredTable.ts`)**:
  - قراءة أول شيت بيانات مسلّم (الشيت الثاني بعد الملخص) بدون إزالة التكرار للمحافظة على أعداد السجلات المسلمة.
  - دوال بناء الملفات المشكلة `deliveredShapedXlsx` و`deliveredShapedCsv` مع تطبيق `withoutProviderHosts` وعزل الصيغ الخطرة والروابط وسقف 20,000 صف.
  - إضافة اختبار `tests/shape-delivery-table.test.ts` (T3) واختبار أداء 20k صف في 2.4 ثانية.
- **P5 (`src/lib/server/shapeDeliveredDownload.ts` و `api/jobs/[id]/download/route.ts`)**:
  - تنفيذ `shapedDeliveryResponse` وتوصيل المسار بـ 5 أسطر فقط دون لمس فرع إيصال التسليم.
  - إضافة اختبار `tests/shape-delivery-download.test.ts` (T5) والتأكد من عدم استدعاء محلل الإكسل عند عدم تطابق التجزئة.
- **P4 (`src/lib/server/savedResultColumns.ts`)**:
  - تحديث `loadLatestResultColumns` لقراءة أعمدة التسليم لمهام الوكيل بدون `data.json`.
  - إضافة اختبار `tests/shape-delivery-columns.test.ts` (T4).
- **P7 (`tests/shape-delivery-chat.test.ts`)**:
  - اختبارات تكامل المحادثة لتدفق التشكيل عبر `ChatHandler`.

## 3. الإثبات
- اجتياز اختبارات T1 و T2 و T3 و T5 و T4 و T7.
- استيفاء فحص قيود التصميم `sync-design-guards-allow.ts --check` (0 unallowed hits, 0 stale entries).
- اجتياز بوابات D-0220 الكاملة (`vitest`, `tsc --noEmit`, `agent:typecheck`, `build`).
