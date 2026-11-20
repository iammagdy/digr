# دالة رفع بث مكتب ديجر (`DT-20261120-office` / `D-0157`)

## السبب والقرار
صفحة `/office` شغّالة على الموقع (#602)، لكن مينفعش مفتاح `service_role` يتحط على السيرفر عشان كل البوتات على نفس المستخدم بدون صلاحية `root`. طبقًا للقرار `D-0157`، اتعملت دالة (`Edge Function`) صغيرة باسم `office-feed` بتاخد توكن مخصّص (`OFFICE_FEED_TOKEN`) دوره الوحيد استبدال ملف حالة الفريق `office-status/status.json`، وبتنفّذ الرفع من جوه `Supabase` بمفتاح الخدمة بتاعها هي.

## الملفات في طلب الدمج
- `supabase/functions/office-feed/handler.ts`: منطق التحقق من الطريقة (`POST`) والتوكن بمقارنة ثابتة الزمن (`constantTimeEqual`)، وحد الحجم (`65,536` بايت)، وصحة الـ `JSON` و`version === 1`، والرفع لمسار ثابت (`office-status/status.json`) بـ `contentType: application/json` و`cacheControl: 15`، ومن غير أي تسريب للتوكن أو المفتاح أو جسم الطلب في الردود أو السجلات.
- `supabase/functions/office-feed/index.ts`: نقطة تشغيل `Deno.serve` للدالة.
- النشر بأمر --no-verify-jwt (من غير ملف config.toml)
- `tests/office-feed-function.test.ts`: اختبارات وحدة بعميل تخزين مزيف (`fake`) بتغطي الحالات من 1 إلى 6 والحالات العكسية.

## الحالات العكسية والأمان
- بدون تعديل على `scripts/office-feed-updater.mjs` أو `public/office/index.html` أو `src/` أو `send-email` أو `package.json`.
- أي سر مفقود بيرجع `500`، وأي توكن غلط/ناقص بيرجع `401`، وأي حجم أكبر من `65,536` بايت بيرجع `413`، ومفيش أي مدخل في الطلب يقدر يغيّر الـ bucket أو اسم الملف.

## طلب الدمج
- PR: (يُضاف رقم ورابط طلب الدمج بعد الإنشاء)
