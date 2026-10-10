# Digr (دِقْر)

منصة تساعد الباحثين والمحللين وصنّاع القرار على طلب بيانات عامة، مراجعة خطة الجمع والاقتباس بالنقاط، ثم استلام ملفات موثقة ومراجعتها.

## البنية الحالية

- **تطبيق الويب**: Next.js 15 وReact 19 وTailwind CSS v4، مع مخرجات `standalone`.
- **مسار المحادثة**: `/api/chat` للتحقق من جلسة Appwrite وحدود الاستخدام، ثم تشغيل المساعد أو وضعه التجريبي.
- **الدوال الخلفية**: `create-job`, `job-worker`, `submit-topup`, `approve-topup`, `on-user-create`.
- **الخدمات الخلفية**: Appwrite Cloud على `https://fra.cloud.appwrite.io/v1`.
- **قاعدة البيانات**: `digr`.
- **حالة النشر**: النشر الحي السابق متحقق منه للقراءة فقط. التغييرات في الفروع وطلبات السحب غير منشورة حتى يدمجها المالك ويعتمد النشر.

## مخطط Appwrite المسجل في سكربت الإعداد

الجداول في قاعدة `digr`:

`templates`, `settings_public`, `profiles`, `credit_ledger`, `topups`, `jobs`, `job_events`, `conversations`, `messages`, `plans_quotes`, `artifact_versions`, `notes`, `capability_requests`, `templates_private`, `settings`, `job_calls`, `notifications`, `jobs_internal`, `capability_registry`, `llm_usage`.

حاويات التخزين:

| الحاوية | المحتوى المسموح |
|---|---|
| `results` | `xlsx`, `pdf`, `csv` فقط |
| `receipts` | `png`, `jpg`, `jpeg`, `pdf` |
| `partials` | `jsonl` |

لا تشغّل `scripts/setup-db.ts` على مشروع حي من جلسة التطوير. التغييرات المخططية تُراجع وتُعتمد من المالك أولاً. سكربت الإعداد تكراري لكنه قد يهيئ أكثر من جدول واحد.

## متغيرات البيئة

لا تحفظ أسراراً حقيقية في Git أو ملفات التوثيق. القيم الخاصة بالمتصفح فقط هي التي تبدأ بـ `NEXT_PUBLIC_`؛ كل المفاتيح والأسرار تبقى خادمية.

### تطبيق Next.js / Appwrite Sites

| المتغير | الوصف |
|---|---|
| `NEXT_PUBLIC_APPWRITE_ENDPOINT` | عنوان Appwrite؛ القيمة المعتمدة `https://fra.cloud.appwrite.io/v1` |
| `NEXT_PUBLIC_APPWRITE_PROJECT_ID` | معرّف المشروع المستخدم في الواجهة |
| `APP_URL` | الرابط الأساسي للتطبيق |
| `APPWRITE_API_KEY` | مفتاح خادمي محدود الصلاحيات، لا تستخدم بادئة `NEXT_PUBLIC_` |
| `LLM_PROVIDER` | `fake` للاختبار أو `openai` للتشغيل الحي؛ الافتراضي الآمن `fake` |
| `LLM_ENABLED` | مفتاح إيقاف المساعد؛ عيّنه `false` لتعطيل استدعاءات النموذج |
| `OPENAI_API_KEY` | سرّ خادمي مطلوب فقط عند اختيار `openai` |
| `OPENAI_MODEL` | معرّف النموذج؛ الافتراضي `gpt-6-luna` |
| `LLM_MAX_OUTPUT_TOKENS` | سقف المخرجات؛ الافتراضي `1500` والحد الأعلى في الكود `8000` |
| `LLM_CONVERSATION_MAX_TOKENS` | سقف سياق المحادثة التراكمي؛ الافتراضي `15000` والحد الأعلى `100000` |
| `LLM_DAILY_SPEND_CAP_USD` | سقف الاستخدام اليومي العام؛ الافتراضي `1.00` |
| `LLM_USER_DAILY_SPEND_CAP_USD` | سقف الاستخدام اليومي لكل مستخدم؛ الافتراضي `0.10` |
| `LLM_INPUT_COST_PER_MILLION_USD` | معدل داخلي لحساب استخدام الإدخال؛ الافتراضي `0.10` |
| `LLM_OUTPUT_COST_PER_MILLION_USD` | معدل داخلي لحساب استخدام الإخراج؛ الافتراضي `0.50` |
| `RESULT_REVIEW_MODEL_ENABLED` | مراجعة النتائج بالنموذج؛ معطل ما لم يُفعّل صراحةً |
| `RESULT_REVIEW_STORAGE_ENABLED` | تخزين حقائق ومراجعات النتيجة؛ اجعله `false` للتعطيل |
| `GOODWILL_ENABLED` | تفعيل قواعد حسن النية؛ لا تفعله قبل تجهيز جدول `notifications` |

### Appwrite Functions

تُضبط متغيرات Appwrite الحالية في كل دالة حسب الحاجة. مراجعة النتائج تنفذ داخل `job-worker`؛ لذلك عند تفعيلها اضبط له متغيرات النموذج والسقوف نفسها مع `RESULT_REVIEW_MODEL_ENABLED`. خزّن المفتاح في إعدادات الخادم فقط. راجع [دليل التشغيل الحي](docs/GO_LIVE.md) قبل أي تفعيل.

## التشغيل المحلي والاختبارات

المتطلبات: Node.js 22 وnpm.

```bash
npm install
```

ضع متغيرات Appwrite العامة فقط في `.env.local` للاختبارات المحلية؛ لا تستخدم مفتاح تشغيل حي. النمط الافتراضي للتطوير هو `fake`، وتستخدم الاختبارات مزودات وهمية وخوادم محلية ثابتة.

```env
NEXT_PUBLIC_APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1
NEXT_PUBLIC_APPWRITE_PROJECT_ID=your_project_id
LLM_PROVIDER=fake
LLM_ENABLED=true
LLM_LIVE=false
```

أوامر التطوير والتحقق:

```bash
npm run dev
LLM_LIVE=false npm test
npx tsc --noEmit
LLM_LIVE=false npm run build
npm run build:functions
```

`npm run build` يشغّل فحصاً يمنع تسرب أسرار الخادم إلى حزم العميل. لا تشغّل `scripts/eval-real-model.ts` أثناء الاختبارات؛ هو أداة تقييم اختيارية، ولا يتصل بنموذج حي إلا عند تمرير `--provider openai` صراحةً وبوجود موافقة تشغيلية مناسبة. راجع [docs/GO_LIVE.md](docs/GO_LIVE.md) لخطوات التفعيل والتراجع.
