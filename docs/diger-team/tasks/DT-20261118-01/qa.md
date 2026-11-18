# نتيجة الجودة لمهمة اختبارات حماية الفلوس (DT-20261118-01)

النتيجة: مستنية مراجعة الجودة (QA). المدقّق بيكمّل الملف ده.

## شروط القبول
- [ ] شرط (AC1): `npx vitest run tests/sql/money-invariants.replica.test.ts` ← `21 passed | 1 skipped (22)` محليًا.
- [ ] شرط (AC2): `npx vitest run tests/sql/money-reconciliation.replica.test.ts` ← `29 passed (29)`.
- [ ] شرط (AC3): `npx vitest run tests/sql/money-properties.replica.test.ts` ← `6 passed (6)`.
- [ ] شرط (AC4): مع `CI=true` ومن غير (PostgreSQL) ← اختبار الحارس يقع (`1 failed`).
- [ ] شرط (AC5): سجل (CI) في الـ (PR) فيه التلات ملفات شغالين (passed) مش متخطّيين (skipped).
- [ ] شرط (AC6): `npx tsc --noEmit` ← من غير أخطاء.
- [ ] شرط (AC7): `git diff --diff-filter=M --name-only origin/main...HEAD` ← فاضي (مفيش ملف قديم اتغيّر).
- [ ] شرط (AC8): بصمة (sha256) ملف الكشف = `6db35be9fbff7c5c047eb9cad95c0288ea6ff82bed8c0f6a102b006ea7808705`.
- [ ] شرط (AC9): كل ملف اختبار بيخلص في أقل من ١٢٠ ثانية.
- [ ] شرط (AC10): المالك يلزق ملف الكشف في (Supabase) مرة: ٢٩ صف وآخرهم (ALL).

## روابط
- رابط تشغيل (CI): (يتكتب بعد فتح الـ PR)
- أول تشغيل للكشف على الإنتاج (baseline): (المالك يبعت صورة للقائد؛ أي ✗ في R07 أو R12 أو R15 ممكن تكون صفوف قديمة)
