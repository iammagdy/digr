# تقرير الإصلاح العاجل: إصلاح فشل بناء Vercel (DT-20261122-hotfix-build)

## المشكلة
فشل بناء تطبيق Next.js في بيئة الإنتاج على Vercel منذ الالتزام `943eb6f7` و`2707f991` و`106e3cd3`، مما أوقف نشر التحديثات الحية على `1de8035b`.
السبب هو وجود دالة مصدرة بالاسم (`named export`):
`export function extractDraftFromQuery` داخل ملف الصفحة `src/app/dashboard/chat/page.tsx`، حيث تمنع قواعد Next.js App Router تصدير أي دوال أو متغيرات من ملفات `page.tsx` بخلاف المكون الافتراضي (`default export`) وخصائص الضبط الخاصة بـ Next.js.

## الحل
1. نقل دالة `extractDraftFromQuery` حرفيًا دون أي تغيير في السلوك أو البنية إلى ملف مستقل: `src/lib/chat/extractDraftFromQuery.ts`.
2. استيراد الدالة في `src/app/dashboard/chat/page.tsx` مع الإبقاء على المكون الافتراضي فقط كتصدير للملف.
3. تحديث مسار الاستيراد في الاختبار `tests/fx02-requests-expiry.test.tsx` لاستيراد الدالة من `@/lib/chat/extractDraftFromQuery`.
4. التحقق من نجاح فحص الأنواع (`tsc`)، ونجاح الاختبار، ونجاح البناء الكامل لـ Next.js بدون أي أخطاء.
