# حارس صادرات صفحات ومخططات Next.js (DT-20261122-page-export-guard)

## الملخص (Summary)
معالجة مشكلة صادرات صفحات ومخططات مسارات Next.js (App Router) التي تسببت في فشل نشر الإنتاج على Vercel عند تصدير دوال مساعدة أو ثوابت داخلية من ملفات `page.tsx` أو `layout.tsx`:
1. **نقل دالة التوجيه من `src/app/admin/layout.tsx`:** تم نقل الدالة المساعدة `resolveAdminLayoutRedirect` إلى `src/lib/adminLayoutRedirect.ts` وإعادة استيرادها داخل `src/app/admin/layout.tsx` واختبار `tests/admin-export-access.test.ts`، لضمان عدم تصدير أي دوال غير مسموح بها من مخطط الإدارة.
2. **إنشاء اختبار حارس الصادرات (`tests/next-page-exports.test.ts`):** فحص كامل لمسارات `src/app/**` الخاصة بملفات `{page,layout,template,loading,error,not-found}.tsx|ts` باستخدام تحليل شجرة الصياغة المجردة (TypeScript AST)، ومنع أي تصدير مسمى خارج الحقول المعتمدة رسمياً من Next.js:
   - الحقول المسموحة: `default`, `metadata`, `generateMetadata`, `generateStaticParams`, `viewport`, `generateViewport`, `revalidate`, `dynamic`, `dynamicParams`, `fetchCache`, `runtime`, `preferredRegion`, `maxDuration`, `experimental_ppr`.
   - استثناء ملفات `route.ts` من هذا القيد لكونها تصدر معالجات دوال HTTP القياسية (`GET`, `POST`, إلخ).
3. **حالات التحقق المضادة (Counter-cases):**
   - التأكد من اكتشاف أي دالة مساعدة مصدرة في صفحة (مثل `export function helper()`) وتوليد خطأ باسم الدالة واسم الملف.
   - التأكد من كشف المتغيرات والكلاسات وإعادة التصدير غير المسموحة.
   - التأكد من سلامة وصلاحية كافة صادرات التهيئة الرسمية.

---

## الملفات المعدلة والمضافة (Scope & Files)
1. `src/lib/adminLayoutRedirect.ts` (جديد: نقل الدالة المساعدة).
2. `src/app/admin/layout.tsx` (تعديل: استيراد الدالة بدلاً من تصديرها).
3. `tests/admin-export-access.test.ts` (تعديل: تحديث مسار استيراد الدالة).
4. `tests/next-page-exports.test.ts` (جديد: اختبار حارس الصادرات).
5. `docs/diger-team/DT-20261122-page-export-guard.md` (توثيق المهمة).

---

## الفحوصات والتحقق (Verification)
- `npx vitest run tests/next-page-exports.test.ts tests/admin-export-access.test.ts`
- `npm run agent:typecheck`
- `npx tsc --noEmit`
- `npm run build` (Next.js production build & secret scan)
