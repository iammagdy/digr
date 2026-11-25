# DT-20261125-delivery-parity: Replay runner keeps distinct recorded rows when the fixture masks their links

## 1. تأكيد الإنتاج الحي (Live Confirmation — Not Reproduced Live)
- في الإنتاج الحقيقي (Live production)، كود التسليم سليم تمامًا ويعمل بنسبة 100%:
  - تم تشغيل 3 مهام حية بمسار `take_found` وسلّمت `card == delivered` بنسبة 2/2 بدون أي مشاكل.
  - فحص admin inspector للمهمة الحية `msn_4cdee6b85bbe2315276d` أكد سلامة التسليم ومطابقته.
  - السبب: المزود الحي (`anyapi.x.user.posts`) يرجع تغريدات حقيقية بروابط فعلية فريدة (`https://x.com/SaudiMOH/status/<numeric_id>`)، وبالتالي لا يحدث أي إسقاط في مرحلة Pass 1 deduplication.
  - بناءً عليه: لا يوجد أي تعديل على ملفات الإنتاج (`src/**` أو `agent/src/**`) في هذا العمل.

## 2. أصل المشكلة في الرانر (Root Cause in Replay Runner)
- في وضع التشغيل المسجل (`--providers=recorded`)، ملف الفيكستشر من QA (`e2e-fixtures/msn_f91f7e220bbf60fd7c9c.json`) يحتوي على 16 صف تم حجب روابطها لسياسات الخصوصية، بحيث أصبحت كل الروابط متطابقة حرفيًا:
  `https://x.com/SaudiMOH/status/[محجوب]`
- الكود القديم في `scripts/full-flow-replay-runner.ts:296` كان يمرر هذا الرابط كما هو:
  ```ts
  url: r.url ?? `https://x.com/SaudiMOH/status/${id}`
  ```
- عند تنفيذ التسليم في `ingestRows` (`agent/src/items/ingest.ts:265-270`):
  - الصف الأول يسجل الرابط المحجوب في `seenUrls`.
  - بقية الصفوف من 2 إلى 16 (بما في ذلك الصفوف المقبولة في التخطيط `1466135018154205187` و `recorded_tweet_12`) تُسقط فورًا في Pass 1 كـ `duplicates_ignored`!
  - الصف الأول فقط يصل إلى Pass 2 (التقييم)، وبما أنه لم يكن مقبولاً في التخطيط وبدون reviewer في وضع الـ recorded، لا يتم قبوله فتكون النتيجة `delivered = 0` رغم أن `card = 2` أو `1`، مما يُسقط فحص Criterion 1.

## 3. الحل المُنفَّذ (The Fix)
- تم استبدال المنطق القديم بدالة نقية واحدة مُصدّرة `mapFixtureRowsToRecordedRows` في `scripts/full-flow-replay-runner.ts`:
  1. **E1 (حفظ الروابط الفريدة فقط):** تفحص الدالة الـ fixture بالكامل وتعد تكرارات كل رابط غير فارغ؛ الصف يحتفظ بحقل `url` فقط إذا كان الرابط موجودًا وفريدًا (count === 1). إذا تكرر الرابط بين صفين أو أكثر (بسبب الحجب مثل `[محجوب]`)، يُحذف حقل `url` تمامًا من الصف المسجل، ويُترك التمييز لـ `id` الصف الفريد، وهو ما يقوم `ingestRows` بالـ dedup عليه أصلًا.
  2. **E2 (إلغاء الكلمات الدلالية والروابط الوهمية):** صفر فحوصات لكلمات مميزة (no marker-word check)، صفر أسماء منصات أو مزودين، وتم حذف الـ fallback URL القديم المكتوب فيه handle ثابت (`https://x.com/SaudiMOH/status/${id}`).
  3. **E3 (دالة نقية مُصدّرة):** الدالة تأخذ مصفوفة صفوف الفيكستشر وتُخرج الصفوف المسجلة، وهي مستقلة تمامًا وقابلة للاختبار المعزول في CI بدون مسارات `/srv`.
  4. بقية أجزاء الرانر (مسار الـ live، الـ criteria، مفاتيح الـ gateway، والـ built-in fallback) بقيت بدون أي مساس.

## 4. نتائج الفحص والأدلة (Verification & Evidence)

### M3 & Counter-Cases (Unit Test: `tests/delivery-parity-runner.test.ts`):
- **M3:** 3 صفوف برابط مشترك + صفان بروابط فريدة -> 5 صفوف مسجلة؛ الثلاثة بدون url والاثنان بروابطهما؛ عند التمرير لـ `ingestRows` احتفظ بجميع الـ 5 عناصر كاملة (`duplicates_ignored: 0`). (PASS)
- **C1:** صفان بنفس الـ id يتم دمجهما إلى عنصر واحد مع احتساب التكرار الحقيقي (`duplicates_ignored: 1`, `items: 1`). (PASS)
- **C2:** الصفوف ذات الروابط الفريدة تحتفظ بروابطها حرفيًا byte-for-byte. (PASS)
- **C3:** مسار الـ built-in fallback يعطي نفس المخرجات تمامًا بدون ملفات QA خارجية. (PASS)

### M1: تشغيل مسجل 5 مرات لمهمة `msn_f91f7e220bbf60fd7c9c`:
- عدد الجولات: 5/5
- التكلفة: $0.000000 USD (Zero provider spend)
- نتيجة الجولات الخمس:
  - Run 1: card=1, delivered=1, delivered_ids=[1466135018154205187] == accepted_ids (PASS)
  - Run 2: card=1, delivered=1, delivered_ids=[1466135018154205187] == accepted_ids (PASS)
  - Run 3: card=1, delivered=1, delivered_ids=[1466135018154205187] == accepted_ids (PASS)
  - Run 4: card=1, delivered=1, delivered_ids=[1466135018154205187] == accepted_ids (PASS)
  - Run 5: card=1, delivered=1, delivered_ids=[1466135018154205187] == accepted_ids (PASS)
- معايير D-0202 الأربعة:
  - Criterion 1 (Count Parity): PASS (5/5)
  - Criterion 2 (Price & Hold Parity): PASS (5/5)
  - Criterion 3 (Option Numbers): PASS (5/5)
  - Criterion 4 (No take_found when 0): PASS (5/5)
- الحكم العام: **PASS**

### M2: تشغيل مسجل 5 مرات لمهمة `msn_c41586cf9d40986250d0`:
- مقارنة مع الأساس على main `e571dd2f`:
  - الأساس على main: 5/5 PASS (found=0, card=0, delivered=0).
  - بعد التعديل: 5/5 PASS (found=0, card=0, delivered=0).
  - Run 1..5: card=0, delivered=0, verdict PASS. لم يتدهور أي تشغيل عن main.

### C4: حصر الملفات المعدلة:
- `git diff --stat origin/main...HEAD`:
  - `docs/diger-team/DT-20261125-delivery-parity.md`
  - `scripts/full-flow-replay-runner.ts`
  - `tests/delivery-parity-runner.test.ts`
  - بالتمام والكمال 3 ملفات فقط، مع خلو تام من أي تعديل لملفات المنتج أو design-guards.
