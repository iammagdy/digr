# DT-20261119-02b — إصلاح migration الـ welcome email (Tier A، SQL)

**القرار:** D-0148 (ميجز). الـ merge لميجز بس. مفيش دخول للإنتاج ولا أي سر في الملفات.

## المشكلة
`supabase/migrations/20261013170000_welcome_email_on_confirm.sql` كانت بتقع في أول جملة بعد `pg_net`: `create extension if not exists "vault" ...` ← «extension "vault" is not available». الإضافة اسمها الحقيقي **`supabase_vault`** (الإنتاج عنده supabase_vault 0.3.1 وpg_net 0.20.4). النتيجة: فحص «Supabase Preview» أحمر، والإنتاج PARTIAL ١ من ٥ (مفيش `send_welcome_email()` ولا الـ trigger ولا الصلاحيات).

## تغيير التصميم بعد Gate 2 الجولة ١ (P0 من فزاع، قرار COMMANDER، يتعمل بدل التصميم الأول)
**ليه:** التصميم الأول كان بيقرا مفتاح `service_role` كامل من الـ Vault ويبعته في header `Authorization` عبر `pg_net`. `pg_net` بيكتب الـ headers والـ body في `net.http_request_queue` (و`net._http_response`) قبل الإرسال، وده الجدول عليه ACL = `arwdDxtm` لـ PUBLIC (اتأكّد من الإنتاج للقراءة فقط)، فأي role متصل بالـ DB يقدر يقرا المفتاح الكامل وإيميل العميل. مش قابل للإصلاح بتغيير صلاحيات جدول إضافة على Supabase.

**التصميم الحالي:** الطابور بيشيل **حاجتين بس**: header `x-welcome-key` (مفتاح عشوائي مخصّص مش بيعمل أي حاجة غير طلب welcome) وbody `{"welcomeUserId":"<uuid>"}`. مفيش مفتاح service_role ولا إيميل ولا اسم ولا template.
- **الـ trigger** (`send_welcome_email()`): نفس شروط الانتقال (INSERT مؤكَّد أو UPDATE من null لـ set)، مفيش إيميل = مفيش نداء، المستخدم موجود في `welcome_email_log` = مفيش نداء، المفتاح من Vault **بالاسم** `send-email-welcome-key` (مفقود/فاضي = مفيش نداء)، وكل خطأ عادي مبلوع (`exception when others`؛ إلغاء الاستعلام وfailures الـ assert بره WHEN OTHERS) فالـ INSERT/UPDATE على `auth.users` بيتأكّد دايمًا. `search_path=''` والـ grants (service_role بس) من غير تغيير.
- **جدول `public.welcome_email_log`** (`user_id` PK → `auth.users` on delete cascade، `sent_at`، `resend_id`): RLS مفعّل من غير policies، `revoke all` من public/anon/authenticated، وgrant لـ `service_role` (select/insert/update/delete). **انحراف صغير عن الأمر:** أضفت `update` (الأمر قال select/insert/delete) لأن تسجيل `resend_id` بعد الإرسال محتاج PATCH.
- **`send-email`** (`index.ts` + `welcomeTrigger.ts` جديد): لو الـ header `x-welcome-key` موجود → مسار الـ welcome **بس**، ومستحيل يقع على مسار service-role: المفتاح بيتقارن بـ `WELCOME_TRIGGER_KEY` بمقارنة ثابتة الزمن (السر مفقود/فاضي = 401 للكل، غلط = 401)؛ الـ body لازم يكون بالظبط `{welcomeUserId:<uuid>}` (أي حاجة تانية، حتى `template/to/vars` = 400)؛ الدالة بتدوّر على المستخدم بمفتاح service الخاص بيها (admin GET user)؛ مش موجود/من غير إيميل/مش مؤكَّد = 200 `skipped` من غير إرسال؛ بعدها «claim» بـ insert في `welcome_email_log` (`ignore-duplicates`) — مفيش صف اتضاف = `already_sent` من غير إرسال؛ الإرسال لإيميل المستخدم نفسه بقالب `welcome`، الاسم `full_name` ← `name` ← جزء الإيميل قبل `@` (من السيرفر)، و`Idempotency-Key = welcome-<id>`؛ فشل Resend ← بيتمسح صف الـ claim و502 (عشان تأكيد لاحق يحاول تاني)؛ النجاح ← بيتسجّل `resend_id`. **مسار service-role من غير أي تغيير.**
- **اللي المفتاح المسرَّب يقدر يعمله:** يطلب welcome مرة تانية لمستخدم حقيقي مؤكَّد ولسه ما خدش welcome. مفيش template تاني ولا إيميل تاني ولا قراءة بيانات.

## اللي اتغيّر في الـ migration (O1) وبقى جزء من نفس الملف
الإضافة `supabase_vault` (بلوك `do` بيتخطّى لو موجودة، وبيجرّب من غير `with schema`، ولو فشلت بيطلّع warning بس) وسطر `pg_net` زي ما هو؛ الدالة كلها جوه بلوك `exception`؛ `set search_path = ''`؛ مستخدم مؤكَّد من غير إيميل = مفيش نداء.

## إضافة O1a: سطور نص الـ welcome (حزلقوم + قرار COMMANDER)
في `supabase/functions/send-email/templates.ts` (الـ welcome بس): (١) العنوان `أهلًا {{ .Name }}، حسابك على ديجر جاهز` (فاصلة بدل «—»)؛ (٢) الفقرة `ديجر يحوّل طلبك إلى ملفات بيانات جاهزة للتحليل. هكذا تبدأ:`؛ (٣) الملاحظة `النقطة الواحدة = ٠٫١٠ ج.م.`. الخطوة ٣ من غير تغيير.
- **تغيير عقد متعمَّد:** `tests/email-base-layout.test.ts` — الـ welcome اتشال من قايمة «القوالب اللي بتتكلم عن حجز مؤقت مُحرَّر» (`["refund","job-done"]`)، واتضاف اختبار بيثبّت السطور التلاتة. وسطر الـ inventory اللي كان بيقرا `jsonb_build_object('Name', v_name)` من الـ migration بقى بيتأكّد إن `index.ts` بيبعت `vars: { Name: name }` (الاسم بقى بيتحط على السيرفر).
- **انحراف عن الأمر:** `tests/email-templates.test.ts:46` ما اتغيّرش: الاختبار بيرندر النسخة القديمة `src/functions/shared/emailTemplates.ts` (خارج النطاق) وفيها «—» لسه.

## نتايج الحالات المطلوبة
| الحالة | النتيجة | الدليل |
|---|---|---|
| A. قاعدة فاضية (Supabase Preview على الـ PR) | **لم تُجرَّب على Supabase** — فحص «Supabase Preview» في الـ PR هو إثبات A | — |
| B. قاعدة فيها الـ ٢ من ٥ | تتطبّق وتنتهي بـ ٥ من ٥ (دالة + service_role بس + trigger مفعّل)، وجدول اللوج بـ RLS ومن غير policies ومن غير صلاحيات لـ anon/authenticated | PGlite |
| C. تشغيل الملف مرتين | بدون خطأ، دالة واحدة وtrigger واحد | PGlite |
| D. السر مفقود أو فاضي (أو الاسم القديم `send-email-service-role-key` بس) | الـ UPDATE بينجح، مفيش http | PGlite |
| E. `http_post` أو قراءة الـ Vault بيفشلوا (وmetadata غريبة) | الـ UPDATE/INSERT بيتأكّد | PGlite |
| F. حالات من غير رسالة | `old.email_confirmed_at` مسجّل أصلًا (دخول تاني، تعديل metadata، set→set)، وINSERT بـ null، وبدون إيميل | PGlite |
| G. حالات بالرسالة | تأكيد بالرابط = نداء واحد؛ OAuth INSERT مؤكَّد = نداء واحد؛ الطابور فيه `x-welcome-key` و`{welcomeUserId}` بس: مفيش Authorization ولا إيميل ولا اسم ولا template | PGlite |
| R. إعادة التأكيد | مستخدم موجود في `welcome_email_log` وبيتأكّد تاني = الـ trigger مبيبعتش؛ ومستخدم مش في اللوج بيتبعت له طلب والـ claim في الدالة بيقرّر | PGlite + اختبارات الدالة |
| H. مفيش سر في الـ diff | الاختبارات بتمنع `eyJ…` و`sb_secret_` و`sbp_` وأي `Bearer` أو `create_secret` | الاختبار |

**إثبات Postgres حقيقي:** Docker مش متاح على السيرفر، فاستخدمنا **PGlite** (Postgres نفسه بـ WASM، offline). الملف بيتشغّل **حرفيًا** ما عدا جملة `create extension pg_net` (مش موجودة في PGlite؛ اتعمل schema `net` بدالة `http_post` بتسجّل النداء). `auth.users` والأدوار و view `vault.decrypted_secrets` stubs. الأمر: `cd architect/scratch/pgproof && node proof.mjs <path>/supabase/migrations/20261013170000_welcome_email_on_confirm.sql` ← **29 passed, 0 failed** (`architect/work/DT-20261119-02b/pg-proof-output.txt`، السكريبت `pg-proof.mjs`؛ مش في الـ repo لأن `@electric-sql/pglite` مش dependency). نفس السكريبت على الملف القديم بيقع في `extension "vault" is not available`.

## الاختبارات
- `tests/dt-0119-02b-welcome-email-migration.test.ts` (٩ اختبارات static): `supabase_vault` ومفيش `vault`، كل `create extension` فيها `if not exists`، `exception when others` حوالين كل حاجة، المفتاح المخصّص `send-email-welcome-key` بالاسم، الطابور = `x-welcome-key` + `welcomeUserId` بس (من غير Authorization/service key/`new.email`/اسم)، جدول اللوج (RLS، من غير policies، revokes، grants)، الانتقال بس، re-run safe، ومفيش سر.
- `tests/dt-0119-02b-welcome-trigger.test.ts` (٢٠ اختبار، fakes بس): مفتاح غلط/فاضي/سر الدالة مفقود ← 401؛ حقول زيادة/template/to/vars/غير-uuid ← 400؛ غير مؤكَّد/من غير إيميل/غير موجود/اللوج فيه المستخدم ← skipped و٠ إرسال؛ نجاح ← إرسال واحد بالظبط لإيميل المستخدم + صف اللوج + `resend_id`؛ فشل Resend ← مسح الـ claim؛ الـ router: مفتاح welcome مزوَّر عمره ما يوقع على مسار service-role ومسار service-role من غير تغيير.
- fail-first على كود الـ commit اللي قبله: `fail-first-O4.log` (٦ اختبارات بتفشل + ملف الـ welcome-path كله مش بيتحمّل). كل اختبارات الإيميل (٢٢ ملف، ٣٣٦ اختبار) و`tsc --noEmit` نضاف.

## خطوات COMMANDER قبل الـ merge وبعده (D-0147 اتغيّر)
1. **قبل الـ merge**، في pipeline واحد من غير ما المفتاح يتطبع أو يتكتب في أي مكان: ولّد مفتاح عشوائي طويل وخزّنه في **مكانين**: Vault بالاسم `send-email-welcome-key` **و** secret الدالة `WELCOME_TRIGGER_KEY`. السر القديم `send-email-service-role-key` **مش بيتعمل**.
2. **بعد الـ merge** (الـ integration بيطبّق الـ migration على الإنتاج): redeploy لـ `send-email` (D-0146) عشان مسار الـ welcome الجديد والنص الجديد يشتغلوا. من غير الـ redeploy الـ trigger هيبعت لدالة قديمة بترد 401 (مفيش welcome، والتسجيل مش بيتأثّر).

## ما لم يتم التحقق منه
- التطبيق على Supabase نفسه (A) وعلى الإنتاج: فحص «Supabase Preview» وبعد الـ merge.
- `pg_net` و`supabase_vault` الحقيقيين (stubs في PGlite)، وصلاحية `service_role` الحقيقية، وإن PostgREST بيعرض `welcome_email_log` (بيعتمد على schema `public` المعروض) وإن `Prefer: resolution=ignore-duplicates` بيرجّع `[]` عند التكرار كما نفترض.
- إن الرسالة بتتبعت فعلًا من send-email (مفيش نداء حي ولا Resend حقيقي)، وإن الـ admin GET user بيرجّع `email_confirmed_at` و`user_metadata` بالشكل اللي الاختبارات بتحاكيه.
- ملاحظة متابعة (خارج النطاق): `docs/diger-team/tasks/DT-20261119-02/01_verify_readonly.sql` سطر ٩٣ بيفحص إن جسم الدالة فيه `send-email-service-role-key`؛ بعد الـ migration ده هيطلع false (الاسم بقى `send-email-welcome-key`). محتاج تعديل منفصل.

## Rollback
```sql
drop trigger if exists on_email_confirmed_send_welcome on auth.users;
drop function if exists public.send_welcome_email();
-- اختياري: drop table if exists public.welcome_email_log;
```
وبيتشال سر الـ Vault وسر الدالة `WELCOME_TRIGGER_KEY` لو اتعملوا.
