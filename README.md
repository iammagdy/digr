# Diger (ديجر) - منصة استخراج وتحليل البيانات للبحث الأكاديمي والاستقصائي

منصة متخصصة في مساعدة الباحثين، المحللين، وصناع القرار في استخراج وتحليل بيانات المنصات الرقمية العامة وتقديمها في قوالب موثقة ومطابقة للأصول المنهجية والأكاديمية (Excel RTL متعدد الأوراق، CSV بترميز UTF-8 BOM، PDF عربي منسق، وJSON).

---

## بنية النظام (Architecture Overview)

يعتمد نظام Diger على بنية سحابية حديثة:

1. **تطبيق الويب وخادم الواجهة (Next.js 15 Web Application)**:
   - واجهة مستخدم تفاعلية مبنية بـ React 19 وTailwind CSS v4 وTypeScript.
   - دعم كامل للغة العربية والاتجاه من اليمين لليسار (RTL) مع خطوط معتمدة (IBM Plex Sans Arabic).
   - مساعد بحث استشاري ذكي للمحادثة وتوسيع الاستراتيجية وبناء خطط استخراج قابلة للتعديل.
   - استضافة سحابية على منصة Vercel مع معالجة غير متزامنة للمهام عبر Serverless Functions.

2. **قاعدة البيانات والخدمات السحابية (Supabase)**:
   - **قاعدة بيانات PostgreSQL**: تشمل جداول المستخدمين، القوالب، الإعدادات العامة والخاصة، دفتر الأستاذ المالي، سجل المهام، والأحداث.
   - **الدوال الذرية (Atomic RPC Functions)**:
     - `accept_quote_atomic`: حجز النقاط وإنشاء المهمة في معاملة ذرية متوافقة مع معايير ACID.
     - `release_job_atomic`: استرداد كامل النقاط المحجوزة في حال فشل أو إلغاء المهمة.
     - `settle_job_atomic`: تسوية مالية دقيقة وفق مبدأ (Release-First) واحتساب التكلفة للوحدات المنجزة فقط.
     - `approve_topup_atomic`: اعتماد شحن الرصيد من لوحة الإدارة وتسجيل حركة الإيداع.
   - **Supabase Storage**: سلال تخزين خاصة لإيصالات الدفع (`receipts`)، ملفات المخرجات النهائية (`results`)، والبيانات الجزئية (`partials`).
   - **Supabase Auth**: إدارة هويات المستخدمين عبر جلسات آمنة ورموز JWT.

3. **محرك الذكاء الاصطناعي (Claude & TREG Catalog)**:
   - نموذج Anthropic Claude (مع إمكانية التبديل إلى OpenAI أو النموذج التجريبي الصارم `fake`).
   - استكشاف حي لدليل إمكانيات البيانات (TREG Unified Data Catalog) ومطابقة متطلبات الباحث بالأدوات المتاحة.

---

## متغيرات البيئة (Environment Variables)

> **ملاحظة أمنية صارمة:** لا تقم أبدًا بتضمين قيم حقيقية أو سرية في هذا الملف أو في مستودع Git. يتم ضبط القيم في لوحة التحكم السحابية لكل بيئة بشكل منفصل.

| اسم المتغير | الوصف | الإلزامية |
| :--- | :--- | :--- |
| `NEXT_PUBLIC_SUPABASE_URL` | عنوان مشروع Supabase السحابي | إلزامي |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | المفتاح العام المجهول لـ Supabase للواجهة الأمامية | إلزامي |
| `SUPABASE_SERVICE_ROLE_KEY` | المفتاح الإداري السري لـ Supabase (يقرأ على الخادم فقط) | إلزامي |
| `APP_URL` | الرابط الأساسي للمنصة (مثل: `https://diger.tech`) | إلزامي |
| `LLM_PROVIDER` | مزود نموذج المحادثة (`fake` للتطوير والاختبار، `anthropic` أو `openai` للنموذج الحقيقي) | إلزامي |
| `LLM_ENABLED` | تفعيل أو إيقاف المساعد الذكي (`true` / `false`) | إلزامي |
| `ANTHROPIC_API_KEY` | مفتاح واجهة برمجة التطبيقات لـ Anthropic (يقرأ على الخادم فقط) | مطلوب عند تفعيل Anthropic |
| `ANTHROPIC_MODEL` | اسم نموذج Anthropic (الافتراضي: `claude-haiku-5-5`) | اختياري |
| `OPENAI_API_KEY` | مفتاح واجهة برمجة التطبيقات لـ OpenAI (يقرأ على الخادم فقط) | مطلوب عند تفعيل OpenAI |
| `OPENAI_MODEL` | اسم نموذج OpenAI (مثل: `gpt-6-luna` أو `gpt-4o-mini`) | اختياري |
| `TREG_TOKEN` | الرمز السري لمزود البيانات TREG (يقرأ على الخادم فقط) | إلزامي للتشغيل الحي |
| `TREG_BASE_URL` | عنوان واجهة برمجة TREG (افتراضي: `https://treg.to`) | اختياري |
| `TREG_LIVE` | تفعيل الاتصال الحقيقي بمزود البيانات (`true` / `false`) | إلزامي للتشغيل الحي |

---

## الهوية البصرية (Brand)

- ملفات اللوجو الرسمية في `public/brand/`، والـ favicon والأيقونات و`site.webmanifest` في جذر `public/`.
- استخدم `<Logo />` و`<LogoMark />` من `src/components/Brand.tsx` لعرض الشعار.
- يعرض الشعار العربي «ديجر» افتراضيًا (`lang="ar"`)، ويبدل للنسخة البيضاء تلقائيًا في الوضع الداكن.
- الألوان: حبر `#0E3B43`، ذهبي العدسة `#C8963E`، داكن `#0A2A30`، ورقي `#F3F1EA`.

---

## التشغيل المحلي (Local Development)

1. تثبيت الحزم:
   ```bash
   npm install
   ```

2. ضبط ملف البيئة المحلي `.env.local`:
   ```env
   NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
   SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
   LLM_PROVIDER=fake
   LLM_ENABLED=true
   ```

3. تشغيل خادم التطوير:
   ```bash
   npm run dev
   ```

4. فحص الأمان واختبارات الجودة:
   ```bash
   npm test
   npm run check:secrets
   npm run build
   ```