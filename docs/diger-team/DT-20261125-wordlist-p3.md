# DT-20261125-wordlist-p3: نقل أسماء عناصر الكتالوج والتذكير والتأنيث للـ Metadata Overlay

## الهدف (Goal)
تنفيذ المرحلة 3 من موجة تنظيف قوائم الكلمات (Wave 2 Phase 3) بنقل أسماء العناصر العربية (`item_noun_ar`) وقيود الجلسات والمدخلات الإضافية من الكود المكتوب في ملفات TypeScript إلى ملف بيانات مخصص `data/treg/endpoint_metadata_overlay.json` يغطي كافة الـ 3,306 endpoints المتاحة في الكتالوج، مع الحفاظ الكامل على توافق البوابة وتطابق الأسعار ومطابقة نصوص الإعادة.

## التغييرات الرئيسية (Key Changes)
1. **ملف الـ Overlay الجديد (`data/treg/endpoint_metadata_overlay.json`):**
   - يحتوي على تعريف `item_noun_ar` لجميع الـ 3,306 endpoints (صيغ عربية خالصة: المفرد، المثنى المرفوع، المثنى المجرور، الجمع، التمييز، وحقل التأنيث `feminine` كقيمة منطقية `boolean`).
   - نقل `DECLARED_EXTRA_INPUTS` و `DECLARED_INPUT_SHAPES` من `catalog.ts` إلى ملف الـ overlay.
   - نقل قيود الجلسات `session_restriction` لمسارات `crawl4ai`.

2. **دمج الـ Overlay وتوافق الكتالوج (`catalog.ts` و `sources.ts`):**
   - دمج الـ overlay ديناميكياً في `loadTregPriceBaseline` مع الحفاظ على هاش الكتالوج الثابت وسلامة أسعار `DECLARED_PRICE_CORRECTIONS`.
   - تحميل `SESSION_RESTRICTED_SOURCES` و `sessionRestriction` ديناميكياً من الـ overlay مع الحفاظ التام على توقيع الدالة وتوافق `gateway.ts`.

3. **دوال أسماء العناصر النقية وأمان المتصفح (`itemNoun.ts`):**
   - إزالة أي تفريع كودي بحسب المنصة أو القدرة في `itemNounFromCapability`؛ الدالة أصبحت تعيد حصرياً `coerceItemNoun(itemNounAr)`.
   - دالة `coerceItemNoun` تتحقق من وجود جميع الصيغ العربية الخمس وكون `feminine` قيمة منطقية، وترفض أي حروف لاتينية دون استدعاء جدول `KNOWN`.
   - بقاء `itemNoun.ts` آمناً للـ browser bundle (صفر استيراد لـ `fs` أو ملفات الكتالوج).

4. **تكامل المخطط وعرض الكتالوج (`catalogView.ts`, `planner.ts`, `plan.ts`):**
   - تزويد نقاط الويب والـ multi-provider بالاسم العربي `item_noun_ar` من الـ overlay.
   - إزالة الفولباك الصلب لـ `خبر/مقال` والاعتماد على `GENERIC_ITEM_NOUN` مع توفير الأسماء الصحيحة للويب.
   - ربط `item_noun_ar` في مراحل الخطة المسعرة بـ `plan.ts` مع ثبات وحيادية الأسعار تماماً.

## الاختبارات (Tests)
- `tests/item-noun-wave2.test.ts`: اختبارات شاملة للتحقق من صحة `coerceItemNoun`، تطابق المفاتيح (Key Parity) مع `knownItemNoun`، تطابق نصوص الإعادة للعينات المسجلة بدون أي «عنصر»، وحيادية التسعير التامة (`stagePriceInputs`).
- `tests/dt-0120-emails.test.ts`: تحديث استدعاءات الاختبار لتمرير كائنات الأسماء العربية مع الحفاظ على كافة التأكيدات دون تغيير.
- `tests/x-account-rumors-replay.test.ts` و `tests/treg-catalog-data.test.ts`: اجتياز كامل 100%.

## القرارات والروابط
- القرارات: Megz `D-0086`, `D-0199`, `D-0211`
- الفرع: `team/DT-20261125-wordlist-p3-catalog-item-noun`
- طلب السحب (PR): [PR #684](https://github.com/iammagdy/digr/pull/684)
