# DT-20261125-wordlist-wave1 Phase 0: Allow-List Sync Script & Monotonic Guard

- **الهدف**: تجهيز البنية التحتية لـ Wave 1 عبر أداة CLI متزامنة واختبار حارس تنازلي وتنظيف الـ 71 مدخلاً قديماً (stale).
- **أداة المزامنة**: إضافة `scripts/sync-design-guards-allow.ts` تدعم فحص الانتهاكات (`--check`)، ومزامنة ملفات محددة (`--files`)، وتنظيف كافة المداخل الميتة (`--prune-all-stale`).
- **حارس التراجع (Monotonic Guard)**: إضافة `tests/design-guards-allow-monotonic.test.ts` لمنع أي زيادة في سقف المسموحات وضمان خلو الملف من أي stale entries.
- **تحديث Allow-List**:
  - الإجمالي: انخفض من `2,155` إلى `2,084` مدخلاً (-71).
  - التفصيل: `treg_tokens` انخفض من `683` إلى `612` (حذف 64 treg، 5 x، 1 youtube، 1 firecrawl)، مع ثبات `arabic_regex=1470`، `srv_paths=0`، `fallback_lists=2`.
- **القاعدة الإلزامية (Standing Rule)**:
  - أي مرحلة لاحقة في Wave 1 تقوم بحذف مداخل مسموحة ملزمة بتخفيض أرقام `ALLOW_LIST_CEILING` في نفس الـ PR.
  - تشغيل `npx tsx scripts/sync-design-guards-allow.ts --files <files...>` بعد أي rebase لتحديث `tests/fixtures/design-guards-allow.json` تلقائياً.
- **طريقة التشغيل**:
  - الفحص: `npx tsx scripts/sync-design-guards-allow.ts --check`
  - الاختبارات: `npx vitest run tests/design-guards.test.ts tests/design-guards-allow-monotonic.test.ts`
- **Draft PR**: TBD
