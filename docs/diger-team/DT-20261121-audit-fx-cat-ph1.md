# DT-20261121-audit-fx-cat-ph1: Catalog-Driven Selection & Endpoint Discovery (FX-CAT Ph1)

- **Task ID:** `DT-20261121-audit-fx-cat-ph1` (`FX-CAT Ph1`)
- **PR:** #632 (`team/DT-20261121-audit-fx-cat-ph1`)
- **Implementer:** العترة (DIGER FAWAALY-3)
- **Reviewer:** أشرف (DIGER BUG HUNTER-2)
- **Authority:** أمر الكبير (DIGER CTO) وقرارات Megz (D-0086, D-0106).

## نطاق العمل (Scope)

1. فتح إمكانية الاختيار عبر كامل كتالوج نقاط النهاية القابلة للبيع (3,276 endpoints) في `llmPlanner` و`catalogView`.
2. استنتاج هياكل الاستجابة للبيانات غير المعروفة (`inferred_list`, `single_object`, `root_object`) في `shapeReader.ts`.
3. دعم نقاط النهاية غير المتزامنة (`async_config`) عبر تقديم الطلب والاستطلاع الدوري للنتائج.
4. نقل مصادر الويب إلى كتالوج `JSON` وتنظيف `system.md` و`webAvailability`.
5. مواءمة سجل القدرات مع خط الأساس للموردين (`provider-metadata.json`) لاجتياز اختبارات الانجراف (`provider-drift-phase6`).

## ملاحظة حول N16 (Note on N16)

N16 (إزالة PLATFORM_NAME_RE) خارج Ph1 بعد رفض التصميم؛ اتنقل للمرحلة الجاية.
