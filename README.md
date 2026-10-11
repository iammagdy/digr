# Digr (دِقْر) - منصة استخراج وتحليل البيانات للبحث الأكاديمي والاستقصائي

منصة متخصصة في مساعدة الباحثين، المحللين، وصناع القرار في استخراج وتحليل بيانات المنصات الرقمية وتقديمها في قوالب موثقة ومطابقة للأصول المنهجية (PDF, Excel, CSV, JSON).

---

## بنية النظام (Architecture Overview)

يتكون نظام Digr من جزأين رئيسيين:

1. **تطبيق الويب (Next.js 15 Web Application)**:
   - واجهة المستخدم التفاعلية (مساعد المحادثة الذكي، لوحة النتائج، إدارة الخطط، وسجل الطلبات).
   - مسار الخادم `/api/chat` لمعالجة المحادثات، التحقق من جلسات Appwrite، واستدعاء نموذج اللغة أو النموذج التجريبي.
   - يستضاف على خوادم **Appwrite Sites** (أو أي بيئة تشغيل تدعم Next.js Node.js Runtime).

2. **دوال الواجهة الخلفية (Appwrite Functions)**:
   - `create-job`: التحقق من الرصيد وحجز النقاط عند تأكيد الخطة.
   - `job-worker`: تنفيذ مهام السحب متعددة الخطوات، الاتصال بمزود البيانات (TREG)، وحفظ الملفات في سلة التخزين (Storage).
   - `approve-topup`: مراجعة طلبات شحن الرصيد من لوحة الإدارة وإضافة النقاط لدفتر الأستاذ.
   - `on-user-create`: إنشاء ملف المستخدم الافتراضي فور التسجيل.
   - `job-watchdog`: مراقبة المهام المعلقة واسترداد النقاط في حال تجاوز المهلة الزمنية.

---

## متغيرات البيئة (Environment Variables)

> **ملاحظة أمنية صارمة:** لا تقم أبدًا بتضمين قيم حقيقية أو سرية في هذا الملف أو في مستودع Git. يتم ضبط القيم في لوحة التحكم السحابية لكل خدمة بشكل منفصل.

### 1. تطبيق Next.js (Appwrite Sites / Server Hosting)

تُضبط هذه المتغيرات في لوحة إعدادات استضافة الموقع (Environment Variables):

| اسم المتغير | الوصف | الإلزامية |
| :--- | :--- | :--- |
| `NEXT_PUBLIC_APPWRITE_ENDPOINT` | عنوان واجهة برمجة التطبيقات لـ Appwrite (الواجهة الأمامية) | إلزامي |
| `NEXT_PUBLIC_APPWRITE_PROJECT_ID` | معرف مشروع Appwrite في الواجهة الأمامية | إلزامي |
| `APP_URL` | الرابط الأساسي للمنصة (مثل: `https://digr.thewise.cloud`) | إلزامي |
| `LLM_PROVIDER` | مزود نموذج المحادثة (`fake` للتطوير والاختبار، `anthropic` أو `openai` للنموذج الحقيقي) | إلزامي |
| `LLM_ENABLED` | تفعيل أو إيقاف المساعد الذكي (`true` / `false`) | إلزامي |
| `ANTHROPIC_API_KEY` | مفتاح واجهة برمجة التطبيقات لـ Anthropic (يقرأ على الخادم فقط) | اختياري (مطلوب عند `LLM_PROVIDER=anthropic`) |
| `ANTHROPIC_MODEL` | اسم نموذج Anthropic (الافتراضي: `claude-haiku-5-5`) | اختياري |
| `OPENAI_API_KEY` | مفتاح واجهة برمجة التطبيقات لـ OpenAI (يقرأ على الخادم فقط) | اختياري (مطلوب عند `LLM_PROVIDER=openai`) |
| `OPENAI_MODEL` | اسم نموذج OpenAI (مثل: `gpt-6-luna` أو `gpt-4o-mini`) | اختياري |
| `LLM_DAILY_SPEND_CAP_USD` | الحد اليومي الأقصى لتكلفة النموذج الحقيقي بالدولار | اختياري (افتراضي 5.00 USD) |

> **قاعدة أمان:** المتغيرات السرية (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) لا تبدأ بـ `NEXT_PUBLIC_` ويتم فحص حزم العميل تلقائيًا أثناء عملية البناء (`npm run build`) لمنع أي تسريب إلى المتصفح.

### 2. دوال الخلفية (Appwrite Functions)

تُضبط هذه المتغيرات في إعدادات كل دالة في لوحة تحكم Appwrite Console:

| اسم المتغير | الوصف | الدوال المعنية | الإلزامية |
| :--- | :--- | :--- | :--- |
| `APPWRITE_ENDPOINT` | رابط Appwrite API الداخلي | جميع الدوال | إلزامي |
| `APPWRITE_PROJECT_ID` | معرف مشروع Appwrite | جميع الدوال | إلزامي |
| `APPWRITE_API_KEY` | مفتاح API بصلاحيات إدارية محدودة للعمليات السحابية | جميع الدوال | إلزامي |
| `TREG_TOKEN` | الرمز السري لمزود البيانات TREG | `job-worker` فقط | إلزامي للتشغيل الحي |
| `TREG_BASE_URL` | عنوان واجهة برمجة TREG (افتراضي: `https://api.treg.to/v1`) | `job-worker` فقط | اختياري |

---

## التشغيل المحلي (Local Development)

1. تثبيت الحزم:
   ```bash
   npm install
   ```

2. إنشاء ملف `.env.local` محلي وضبط المتغيرات (الملف محمي في `.gitignore` ولا يرفع أبدًا):
   ```env
   NEXT_PUBLIC_APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1
   NEXT_PUBLIC_APPWRITE_PROJECT_ID=your_project_id
   LLM_PROVIDER=fake
   LLM_ENABLED=true
   ```

3. تشغيل خادم التطوير:
   ```bash
   npm run dev
   ```

4. فحص الأمان واختبارات الوحدة:
   ```bash
   npm test
   npm run build
   ```