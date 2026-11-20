# DT-20261119-02b — إصلاح migration الـ welcome email (Tier A، SQL)

**القرار:** D-0148 (ميجز). الـ merge لميجز بس. مفيش دخول للإنتاج ولا أي سر في الملف.

## المشكلة
`supabase/migrations/20261013170000_welcome_email_on_confirm.sql` كانت بتقع في أول جملة بعد `pg_net`: `create extension if not exists "vault" with schema "vault"` ← «extension "vault" is not available». الإضافة اسمها الحقيقي **`supabase_vault`** (الإنتاج عنده supabase_vault 0.3.1 وpg_net 0.20.4). النتيجة: فحص «Supabase Preview» أحمر، والإنتاج حالته PARTIAL ١ من ٥ (مفيش `send_welcome_email()` ولا الـ trigger ولا الصلاحيات).

## اللي اتغيّر (الملف ده بس + اختبار واحد + الوثيقة دي)
1. **الإضافة:** `create extension if not exists "supabase_vault" with schema "vault"` جوه بلوك `do` بيتخطّى لو الإضافة موجودة (`supabase_vault` أو `vault`)، وبيجرّب من غير `with schema` لو الأولى فشلت، ولو الاتنين فشلوا بيطلّع `warning` ويكمّل (من غير Vault الـ trigger مبيبعتش حاجة). سطر `pg_net` زي ما هو (idempotent).
2. **الدالة:** الجسم كله (فحص الانتقال، قراءة الـ Vault، بناء الـ payload، `net.http_post`) جوه بلوك واحد بـ `exception when others then return new` — **أي فشل ما بيوقّفش كتابة `auth.users`**. المفتاح بيتقرا من `vault.decrypted_secrets` **بالاسم** (`send-email-service-role-key`)؛ فاضي أو مش موجود = `return new` من غير نداء.
3. **`idempotencyKey`:** `'welcome-' || new.id::text` في الـ payload، فمستخدم واحد عمره ما ياخد رسالتين (يطابق `^[A-Za-z0-9._:-]{1,256}$`).
4. **`set search_path = ''`** (الدالة `security definer`): كل المراجع مكتوبة بالاسم الكامل (`vault.decrypted_secrets`، `net.http_post`)، فمفيش اعتماد على search_path.
5. إضافة صغيرة: مستخدم مأكَّد من غير إيميل (تسجيل بتليفون) → مفيش نداء (`to` كان هيبقى null).
6. من غير تغيير: `create or replace function`، الـ revoke/grant (service_role بس)، `drop trigger if exists` + `create trigger` (آمن لو اتشغّل مرتين).

## نتايج الحالات المطلوبة
| الحالة | النتيجة | الدليل |
|---|---|---|
| A. قاعدة فاضية (Supabase Preview على الـ PR) | **لم تُجرَّب على Supabase** — فحص «Supabase Preview» في الـ PR هو إثبات A | — |
| B. قاعدة فيها الـ ٢ من ٥ | تتطبّق وتنتهي بـ ٥ من ٥ (دالة + صلاحيات service_role بس + trigger مفعّل `tgenabled='O'`؛ جسم الدالة فيه اسم السر والـ idempotencyKey) | Postgres حقيقي (PGlite)، تحت |
| C. تشغيل الملف مرتين | بدون خطأ، دالة واحدة وtrigger واحد | PGlite |
| D. السر مفقود أو فاضي | الـ UPDATE بينجح، مفيش http | PGlite |
| E. `http_post` أو قراءة الـ Vault بيفشلوا (وكمان metadata غريبة) | الـ UPDATE/INSERT بيتأكّد (`email_confirmed_at` متسجّل) | PGlite |
| F. حالات من غير رسالة | `old.email_confirmed_at` مسجّل أصلًا (دخول تاني، تعديل metadata، set→set)، وINSERT بـ null، وبدون إيميل: مفيش نداء | PGlite |
| G. حالات بالرسالة | تأكيد بالرابط (UPDATE null→set) = نداء واحد؛ OAuth INSERT بإيميل مؤكَّد = نداء واحد؛ الـ payload فيه template وto وvars.Name وidempotencyKey | PGlite |
| H. مفيش سر في الـ diff | اختبار Vitest بيمنع `eyJ…` و`sb_secret_` و`sbp_` وأي `Bearer` حرفي | الاختبار |

**إثبات Postgres حقيقي:** Docker مش متاح على السيرفر (permission denied)، فاستخدمنا **PGlite** (Postgres نفسه مترجم لـ WASM، بيشتغل offline). الملف بيتشغّل **حرفيًا** ما عدا جملة `create extension pg_net` الوحيدة (pg_net مش موجود في PGlite) واتعمل مكانها schema `net` بدالة `http_post` تسجّل النداء. جدول `auth.users` ودور `anon/authenticated/service_role` وview `vault.decrypted_secrets` عملناهم كـ stubs. الأمر:
```
cd /srv/diger-team/architect/scratch/pgproof && node proof.mjs <path>/supabase/migrations/20261013170000_welcome_email_on_confirm.sql
```
النتيجة على الملف الجديد: **23 passed, 0 failed** (`architect/work/DT-20261119-02b/pg-proof-output.txt`، والسكريبت `pg-proof.mjs`؛ مش في الـ repo لأن `@electric-sql/pglite` مش dependency). نفس السكريبت على الملف القديم بيقع في `extension "vault" is not available` (`pg-proof-OLD-file-output.txt`).

## الاختبار
`tests/dt-0119-02b-welcome-email-migration.test.ts` (٨ اختبارات static): اسم الإضافة `supabase_vault` ومفيش `vault`، كل `create extension` فيها `if not exists`، الـ `exception when others` حوالين كل حاجة، السر بالاسم، الـ idempotencyKey، الانتقال بس، re-run safe والـ grants، ومفيش سر. على الملف القديم: ٥ من ٨ بيفشلوا (`fail-first-old-file.log`)؛ على الجديد ٨ من ٨. وكمان `tests/email-base-layout.test.ts` (٨٥ اختبار، بيقرا الملف ده) بيعدّي. `tsc --noEmit` نضيف.

## ما لم يتم التحقق منه
- التطبيق على Supabase نفسه (A) وعلى الإنتاج: فحص «Supabase Preview» وبعد الـ merge.
- `pg_net` و`supabase_vault` الحقيقيين (في PGlite stubs)، وصلاحية الـ `service_role` الحقيقية، وإن السر `send-email-service-role-key` موجود في Vault الإنتاج (COMMANDER بيعمله قبل الـ merge، D-0147).
- إن الرسالة بتتبعت فعلًا من send-email (مفيش نداء حي).

## Rollback
```sql
drop trigger if exists on_email_confirmed_send_welcome on auth.users;
drop function if exists public.send_welcome_email();
```
(الإضافات بتفضل؛ الـ welcome بيقف من غير ما أي حاجة تانية تتأثر.)
