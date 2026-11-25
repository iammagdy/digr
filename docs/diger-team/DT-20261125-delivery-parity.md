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

## 3. الحل المُنفَّذ (The Fix — F1 & F2)
- تم استبدال المنطق القديم بدالة نقية واحدة مُصدّرة `mapFixtureRowsToRecordedRows` في `scripts/full-flow-replay-runner.ts`:
  1. **F1 (بناء روابط فريدة عامة للروابط المكررة):**
     - تفحص الدالة الـ fixture وتعد تكرارات الروابط الصالحة.
     - الروابط الفريدة (`count === 1`) تبقى كما هي حرفيًا byte-for-byte.
     - الروابط المكررة في الفيكستشر (`count > 1`) يُبنى لها رابط فريد عام عن طريق تحليله بـ `new URL()` واستبدال آخر مقطع في المسار فقط بـ `encodeURIComponent(row id)` مع الحفاظ على البروتوكول والمضيف وباقي المسارات.
     - الرابط غير القابل للتحليل أو المفقود لا يُضاف له حقل `url` نهائيًا.
     - صفر فحوصات لكلمات مميزة (no marker-word check)، وصفر أسماء منصات أو مزودين.
  2. **F2 (اشتقاق المؤلف وإلغاء الثوابت):**
     - اشتقاق اسم المؤلف الافتراضي من أول مقطع في مسار الرابط `parsedUrl.pathname.split("/").filter(Boolean)[0]` عند غياب حقل المؤلف في الفيكستشر، بدون أي كتابة يدوية لاسم حساب أو منصة.
     - حقل `createdUtc` يُؤخذ من الفيكستشر إن وُجد، ويُترك الحقل خارج الكائن إن كان غائبًا.
  3. بقية أجزاء الرانر (مسار الـ live، الـ criteria، مفاتيح الـ gateway، والـ built-in fallback) بقيت بدون أي مساس.

## 4. نتائج الفحص والأدلة (Verification & Evidence)

### M3' & Counter-Cases (Unit Test: `tests/delivery-parity-runner.test.ts`):
- **M3':** 3 صفوف برابط مشترك + صفان بروابط فريدة + صف برابط غير صالح + صف بدون رابط: الروابط المشتركة أصبحت فريدة برقم الصف مع نفس المضيف، والفريدة بقيت بحالتها، وغير الصالحة حُذف حقل الرابط منها، والمؤلف اشتُق من المسار؛ وعند التمرير لـ `ingestRows` احتفظ بجميع العناصر كاملة بدون إسقاط (`duplicates_ignored: 0`). (PASS)
- **C1:** صفان بنفس الـ id يتم دمجهما إلى عنصر واحد مع احتساب التكرار الحقيقي (`duplicates_ignored: 1`, `items: 1`). (PASS)
- **C2:** الصفوف ذات الروابط الفريدة تحتفظ بروابطها حرفيًا byte-for-byte. (PASS)
- **C3:** مسار الـ built-in fallback يعطي نفس المخرجات تمامًا بدون ملفات QA خارجية. (PASS)

### M1': تشغيل مسجل 5 مرات لمهمة `msn_f91f7e220bbf60fd7c9c`:
- عدد الجولات: 5/5
- التكلفة: $0.000000 USD (Zero provider spend)
- نتيجة الجولات الخمس (الملف: `msn_f91f-5runs-v2.log`):
  - Run 1: examined=16, accepted=2, question=2, card=2, delivered=2, accepted_ids == delivered_ids == [1466135018154205187, recorded_tweet_12] (PASS)
  - Run 2: examined=16, accepted=2, question=2, card=2, delivered=2, accepted_ids == delivered_ids == [1466135018154205187, recorded_tweet_12] (PASS)
  - Run 3: examined=16, accepted=2, question=2, card=2, delivered=2, accepted_ids == delivered_ids == [1466135018154205187, recorded_tweet_12] (PASS)
  - Run 4: examined=16, accepted=2, question=2, card=2, delivered=2, accepted_ids == delivered_ids == [1466135018154205187, recorded_tweet_12] (PASS)
  - Run 5: examined=16, accepted=2, question=2, card=2, delivered=2, accepted_ids == delivered_ids == [1466135018154205187, recorded_tweet_12] (PASS)
- معايير D-0202 الأربعة:
  - Criterion 1 (Count Parity): PASS (5/5)
  - Criterion 2 (Price & Hold Parity): PASS (5/5)
  - Criterion 3 (Option Numbers): PASS (5/5)
  - Criterion 4 (No take_found when 0): PASS (5/5)
- الحكم العام: **PASS**

### M2': تشغيل مسجل 5 مرات لمهمة `msn_c41586cf9d40986250d0`:
- مقارنة مع الأساس على main `474d1aec` (الملف: `msn_c41586-5runs-main.log` مقابل `msn_c41586-5runs-v2.log`):
  - الأساس على main: 5/5 PASS (examined=40..41, found=0, card=0, delivered=0).
  - بعد التعديل (PR head): 5/5 PASS (examined=40, found=0, card=0, delivered=0).
  - Run 1..5: card=0, delivered=0, verdict PASS. فرع الـ PR مطابق للأساس على main وبدون أي تدهور.

### C4: حصر الملفات المعدلة:
- `git diff --stat origin/main...HEAD`:
  - `docs/diger-team/DT-20261125-delivery-parity.md`
  - `scripts/full-flow-replay-runner.ts`
  - `tests/delivery-parity-runner.test.ts`
  - بالتمام والكمال 3 ملفات فقط، مع خلو تام من أي تعديل لملفات المنتج أو design-guards.
