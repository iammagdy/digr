# DT-20261125-people-search-admin: إضافة البحث العكسي الإداري عن الأشخاص (`treg.people.enrich`)

- **رقم المهمة:** `DT-20261125-people-search-admin` (`D-0212`)
- **المنفّذ (Tier A):** جوني (`ARCHITECT`) · **مراجعة البوابة الأولى (`Gate 1 GREEN`):** فزاع (`BUG HUNTER`)
- **الأساس:** `origin/main` (`4758df15`)
- **الفرع:** `team/DT-20261125-people-search-admin`
- **الخطة المعتمدة:** `PLAN v1.1` (خطة `v1` مع التعديلات `A1`–`A3`)

---

## ١. السبب والهدف

كان مسار البحث العكسي الإداري (`/admin/reverse-lookup`) يدعم فقط أرقام الهواتف والبريد الإلكتروني ولا يستفيد من خدمة `treg.people.enrich` المدرجة في الكتالوج لأن سياستها (`C3_professional_profile`) خارج قواعد البحث الحساس في `adminLookup.ts`، كما كان نموذج النتائج والسجل يفتقر إلى حقول الاتصال (`workEmail` و`personalEmail` و`phone`) ونوع مدخل رابط الملف الشخصي (`social_url`).

---

## ٢. التغييرات المنفّذة

1. **البيانات الوصفية (`data/capabilities/provider-metadata.json`) ومزامنة المزودات (`scripts/capabilities/sync-providers.ts`):**
   - إضافة قسم `treg.reverseLookup.adminOnly` وفيه تعريف `treg.people.enrich` لمدخلي `email` (`email`) و`social_url` (`linkedin_url` لنطاقات `linkedin.com` و`www.linkedin.com` ومسارات `/in/` فقط)، بسقف تكلفة `0.28` دولار و`waterfall: true` (مع تقييد التكلفة عبر `X-Treg-Route-Max-Cost <= confirmedUsd <= 0.28`).
   - الحفاظ على `treg.reverseLookup` في `sync-providers.ts` عند تحديث `baseline`.
2. **نموذج النتائج ومنطق البحث العكسي (`src/lib/adminLookupResult.ts` و`src/lib/server/adminLookup.ts`):**
   - توسيع `FIELD_KEYS` بإضافة `workEmail` و`personalEmail` و`phone`.
   - قراءة `treg.reverseLookup.adminOnly` من البيانات الوصفية فقط بدون أي أسماء مزودات أو روابط ثابتة داخل `src/`، وإدراجها في خطة البريد مباشرة بعد `EMAIL_REVERSE_ORDER` وقبل أي خدمات كتالوج إضافية (`others`) في حالة التأكيد (`confirm`)، وإفراد خطة `social_url` بها فقط، مع إبقاء الهاتف وملف `src/lib/treg/reverseOrder.ts` ومسارات العملاء دون أي تغيير.
3. **السجل والواجهة (`src/lib/server/adminLookupHistory.ts` و`src/app/api/admin/reverse-lookup/route.ts` و`src/app/admin/reverse-lookup/page.tsx`):**
   - دعم نوع `social_url` في `HistoryEntry` و`sanitizeEntry` و`loadLookupHistory`، مع بقاء النتيجة معروضة على الشاشة واقتصار `localStorage` على المدخل المُقنّع فقط (`fields: {}`) إذا فشل الحفظ على الخادم أو رفض الجدول قيمة `social_url`.
4. **الاختبارات (`tests/admin-reverse-lookup.test.ts` و`tests/phase5-admin-lookup-hardening.test.ts`):**
   - تغطية التعديلات `A1`–`A3` وملاحظات فزاع، وحدود الإنفاق اليومية (`$2`)، وتأكيد السعر (`0.28`)، والتدقيق المغلق عند الفشل، وعدم المساس بملفات §7 و`design-guards-allow.json`.

---

## ٣. قائمة الفحص للتحقق الحي (`QA Hard Cap: $1.00 USD`, بحد أقصى ٣ نداءات مدفوعة)

1. التحقق قبل البدء من بقاء رصيد اليوم يسمح بـ `spentTodayUsd + 0.84 <= 2.00`.
2. ٣ اختبارات سلبية مجانية (`0.00` دولار): `https://x.com/openai`، و`https://www.linkedin.com/company/openai`، و`hello`.
3. نداء مدفوع ١ (بريد عمل معروف، سقف `0.28` دولار): التحقق من ترتيب الخطة وتأكيد `treg.people.enrich` وتسجيل الحقول ومصادرها.
4. نداء مدفوع ٢ (رابط `/in/` معروف، سقف `0.28` دولار): التحقق من ظهور `treg.people.enrich` وحدها وتأكيدها والتحقق من الحقول المستخرجة.
5. نداء مدفوع ٣ (رابط `/in/` غير موجود، سقف `0.28` دولار): التحقق من حالة `لا بيانات` والتكلفة الحقيقية المسجلة.
6. فحص `localStorage` بعد الحفظ وإعادة التحميل للتأكد من إخفاء الرابط (`www.linkedin.com/***`) وخلو `fields` من البيانات.

---

## ٤. التراجع (`Rollback`)

- عكس طلب الدمج عبر `git revert <merge-sha>`؛ لا توجد أي تغييرات على قاعدة البيانات أو مفاتيح التشغيل.
