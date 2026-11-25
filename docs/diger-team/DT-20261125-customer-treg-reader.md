# DT-20261125-customer-treg-reader: قراءة استجابات TREG routed من output فقط لمسار العملاء

- **رقم المهمة:** `DT-20261125-customer-treg-reader` (`D-0218`)
- **المنفّذ (Tier B):** العترة (`FAWAALY-3`) · **المعماري:** جوني (`ARCHITECT`)
- **الأساس:** `origin/main` (`fec6de75`)
- **الفرع:** `team/DT-20261125-customer-treg-reader`
- **طلب الدمج:** Draft PR #688

---

## ١. السبب والهدف (Root Cause & Objective)

تبيّن من التشغيل الحي ومراجعة المعماري أن استجابات TREG الموجهة (`kind: "routed"`) التي تعود في مغلّف `{ output, raw, _treg }` كانت تعاني من مشكلتين رئيسيتين على مسار العملاء:
1. دالة `hintsOf(endpoint)` لم تكن تمرر `routedOutputOnly: true` عند كون النقطة موجهة، مما جعل `readShape` يستدل أحيانًا على القوائم من `_treg.tried` أو `raw` عند غياب `list_path`.
2. دالة `readRoutedOutput` كانت تقع في رديف كائن مفرد `[output]` عند كون `output` كائنًا فارغًا أو يحوي حقولًا فارغة فقط (مثل Shape A لتعليقات يوتيوب `{ output: { comments: null, next_cursor: null } }` أو Shape B لمنشورات فيسبوك `{ output: { posts: null, next_cursor: null } }`)، مما ينتج صفًا وهميًا `single_object` بدلًا من `0` صفوف.
3. دالة `readCursor` كانت تبحث عن المؤشر داخل `raw` و`_treg` حتى لو كانت الاستجابة موجهة، مما يؤدي لتسريب مؤشرات داخلية.
4. خصائص خطوات الخطة `StepFacts` و`StepAlternate` و`ReaderFacts` كانت تفتقر إلى حقل `routedOutputOnly`، فلم تكن الحقيقة تنتقل للمنفّذ أثناء القراءة الفعلية للخطوة.

---

## ٢. التغييرات المنفّذة (Exact Changes)

1. **توحيد قاعدة النقاط الموجهة في قارئ الأشكال (`src/lib/treg/shapeReader.ts`):**
   - إضافة تفعيل تلقائي لخيار `routedOutputOnly: true` داخل `hintsOf(endpoint)` عند `endpoint.kind === "routed"`.
   - تعريف حاويات الترقيم المشتركة `PAGINATION_CONTAINER_KEYS` (`pagination` و`meta` و`paging`) واستخدامها في `cursorAtCommonKeys` وفي حارس الكائنات الفارغة.
   - إضافة دالة `hasNonEmptyValue` ودالة `isEmptyOrErrorRoutedObject` لحماية الكائنات الفارغة من التحول إلى كائن مفرد عند خلو حقول البيانات من أي قيم حقيقية.
   - عزل استخراج المؤشر `readCursor` للمغلفات الموجهة في فرع مستقل يبحث داخل `output` فقط.
2. **تبسيط مسار الإدارة (`src/lib/server/adminLookup.ts`):**
   - حذف التمرير اليدوي `...(endpoint.kind === "routed" ? { routedOutputOnly: true } : {})` والاعتماد التام على `hintsOf(endpoint)`.
3. **تمرير الحقيقة عبر مخطط النموذج (`src/lib/modelPlanner/*`):**
   - تحديث `buildShapeDigest` و`digestFromCatalogExample` في `digest.ts` لقبول `endpoint.kind`.
   - إضافة `routedOutputOnly?: boolean` إلى `StepFacts` و`StepAlternate` في `types.ts`.
   - تمرير الخاصية داخل `factsOf` و`alternatesOf` في `validate.ts`.
   - إدراج الخاصية داخل `ReaderFacts` وتمريرها في `stepReaderHints` في `reader.ts`.
4. **دعم المغلفات الموجهة في مشغّل الإعادة (`scripts/full-flow-replay-runner.ts`):**
   - تعريف واجهة `RoutedRecordedSpec` ودعم تشغيل مهام الإعادة الموجهة عبر `buildShapeDigest`.
   - إضافة تسجيلات إعادة موجهة اصطناعية مبنية داخليًا للمهمتين `msn_24fd8dc0470a2c990cc0` (٥ منشورات) و`msn_2e341874060213f94110` (٠ تعليقات).
5. **الاختبارات الشاملة (`tests/treg-shape-reader.test.ts` و`tests/customer-treg-routed-reader.test.ts`):**
   - تغطية الأشكال الاصطناعية `M1`–`M7` و`K1`–`K3` و`D5` ومطابقة القيود التصميمية.
   - إثبات عدم خصم أي نقاط مالية وإطلاق الحجز كاملًا عند عودة صفوف فارغة (`K4 money/charge proof`).
   - التحقق من توافق كافة مستدعي مسار العملاء (`gateway` و`modelPlanner` و`toolProfile` و`asyncTreg`).

---

## ٣. نتائج الفحص والتوثيق المطلوب (Documented Findings)

1. **فحص `providerRows.ts`:**
   - تبيّن أن دالتي `findProviderResultList` و`findProviderNextCursor` لا تقرآن `_treg.tried` في الأشكال A–G، لكنهما تحتفظان بمسار رديف يفحص `raw` عند غياب المسار؛ تقرر إبقاء هذا المسار لمهمة متابعة مستقلة لعدم التأثير على تكامل المزودين الآخرين.
2. **فحص `Shape F`:**
   - تبيّن أن حالة `rootObjectIsRow: true` في `buildShapeDigest` تخص كائنات الملفات الشخصية المفردة المباشرة وليست مسار تسليم متعدد للعملاء، لذا بقيت دون تغيير.
3. **ثبات `ROUTED_RECORD_KEYS`:**
   - تم الحفاظ على مصفوفة المفاتيح مطابقة للأصل حرفيًا، وتُترك توسعتها لمهمة لاحقة تعتمد على عقود التوجيه `routing.contract.output`.

---

## ٤. أوامر التحقق وإثبات الإعادة (Replay Proof Commands)

```bash
# تشغيل اختبارات قارئ الأشكال واختبارات حراس التصميم
npx vitest run tests/treg-shape-reader.test.ts tests/design-guards.test.ts

# تشغيل اختبارات مسار العملاء الشاملة
npx vitest run tests/customer-treg-routed-reader.test.ts

# تشغيل الفحص الذاتي لمشغل الإعادة
npx tsx scripts/full-flow-replay-runner.ts --self-test
```

---

## ٥. التراجع (Rollback)

- يتم التراجع عن التعديل بالكامل عبر عكس طلب الدمج: `git revert <merge-sha>`. لا توجد أي هجرات لقاعدة البيانات ولا تعديلات على الجداول المالية أو أسرار النظام.


## ٦. تدقيق الاستدعاءات الحية المتنازل عنها (Waived Audit Numbers)
- راجعنا 32 استدعاء موجه حقيقي (routed calls) متوزعين على 14 مهمة إنتاجية مختلفة.
- لقينا حالتين فانتوم بس يوم 2026-10-29 (استكشاف تخطيط يوتيوب `msn_2e341874060213f94110` وفيسبوك `msn_cc3b401a9efbe854c824`).
- النتيجة: 0 صفوف اتسلمت و0 خصم فلوس أو نقط، والحجز المؤقت اتفك بالكامل.
