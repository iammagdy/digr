# DT-20261121-audit-fx-cat-ph3: /services Page Redesign Spec & Visual Components

- **Task ID:** `DT-20261121-audit-fx-cat-ph3` (`FX-CAT Ph3`)
- **PR Branch:** `team/DT-20261121-audit-fx-cat-ph3`
- **Base:** `team/DT-20261121-audit-fx-cat-ph2` (PR #641, head `0fbcf8e5`) -> `origin/main`
- **Implementer:** سالم (DIGER FAWAALY-2)
- **Reviewer:** أشرف (DIGER BUG HUNTER-2)
- **Designer:** حزلقوم (DIGER DESIGNER)
- **Authority:** أمر الكبير (DIGER CTO) وقرارات Megz (D-0086, D-0106, D-0121, D-0151, D-0155, D-0195).
- **Spec:** `/srv/diger-team/designer/work/FX-CAT-Ph3-spec.md` (حزلقوم).

## 1. ملخص التغييرات (Summary of Changes)

تهدف هذه المرحلة إلى إكمال إعادة تصميم صفحة الخدمات (`/services`) بالكامل لتعكس بدقة ما يبيعه وينفذه ديجر فعلياً من واقع كتالوج القدرات المدعومة الحية المنقى في المرحلة Ph2 (999 خدمة موزعة على 10 مجموعات وظيفية)، بتجربة مستخدم عصرية وسلسة باللغة العربية الفصحى المعاصرة:

1. **عقد البيانات الموحد وإفصاح محتويات الملف (Data Contract & Deliverables):**
   - تحديث `src/lib/servicesCatalogView.ts` بدالة `defaultColumnsForSector(sectorId)` لتزويد كل بطاقة بقائمة الأعمدة المعتمدة التي يستلمها العميل في ملف النتائج (مثل: اسم المنشأة، المدينة والمحافظة، الموقع الرسمي، اسم المسؤول، المسمى الوظيفي، البريد المهني، هاتف العمل) خالية تماماً من الكلمات الأجنبية وتجتاز فحص `checkCustomerText` بصفر ملاحظات.
   - تضمين شارة التمييز لخدمات صناع القرار الأساسية (`badgeAr: service.core ? "صناع القرار" : undefined`).

2. **مكونات الواجهة وتجربة المستخدم (UI & UX Components):**
   - `src/components/services/CapabilityCard.tsx`:
     - بطاقة خدمة متجاوبة تعرض العنوان والنبذة والبادج وتفاصيل أعمدة ملف النتائج المعتمدة مع إمكانية التوسيع والإغلاق (`+ X أعمدة أخرى`).
     - إظهار وحدة الاحتساب المستمدة من تسعير البطاقة (`pricingUnitLabelAr` أو «حسب خطة الطلب»).
     - مسار مباشر وسلس لزر «اطلب الآن» ينقل العميل لمحادثة المساعد الذكي مع استعلام مرمز مسبقاً (`/dashboard/chat?prompt=...`).
   - `src/components/services/ServicesSkeleton.tsx`:
     - هيكل رمادي نابض خفيف الحجم وسريع التحميل يحاكي شريط البحث وكبسولات الأقسام وشبكة البطاقات مع وسوم الإتاحة (`role="status"`, `aria-label="جارٍ تحميل الكتالوج"`).
   - `src/components/services/CatalogDynamicView.tsx`:
     - مكون تفاعلي للبحث الفوري والتصفية باللغة العربية عبر `normalizeArabicSearch` مع شريط تنقل سريع لاصق (Sticky Pills Nav).
     - شبكة بطاقات متجاوبة تدعم التصفية الآنية، مع حالة بحث فارغ نظيفة وموجهة للمساعد الذكي في حال عدم العثور على نتائج.
     - اعتماد المعالجة الهيكلية أثناء التصيير الأولي على الخادم (SSR) عبر `ServicesSkeleton` لضمان سرعة الصفحة وصغر حجم شجرة DOM الأولية بما يتوافق بدقة مع فحوصات الأداء في `tests/services-catalog-page.test.tsx`.

3. **تكامل صفحة الخدمات (Page Integration):**
   - تحديث `src/app/services/page.tsx` لدمج `CatalogDynamicView` مع الحفاظ التام على الأقسام والوسوم المعتمدة (`request-groups`, `catalog-all`, `services-counts`, `decision-makers-line`, `core-b2b`, `services-status-line`, `services-bottom-cta`) والـ metadata الثابتة.

4. **جناح الاختبارات والتحقق الشامل (Test Suite & Verification):**
   - إنشاء جناح اختبارات متكامل `tests/fx-cat-ph3-services-redesign.test.tsx` (9 فحوصات تغطي عقد البيانات، خلو النصوص من الإنجليزية والرموز المحظورة والمزودين، عمل البطاقات وإفصاح الأعمدة، والتصفية التفاعلية، والتجاوب مع شاشات الموبايل 390px).
   - اجتياز جميع أجنحة الخدمات الستة (59/59 فحصاً ناجحاً).

## 2. الحدود الصارمة ومكافحة الانجراف (Invariants & Constraints)

- **Zero DB / Migration / Pricing Touch:** عدم المساس بأسعار النظام، الليدجر، الحجوزات، التسويات، أو قواعد البيانات.
- **Zero Provider Names:** حظر تام لأي اسم مزود باطني (Apollo, Firecrawl, TREG, Context.dev, Apify...) ومطابقة كاملة لـ `PROVIDER_NAME_PATTERN`.
- **Zero English & Banned Words:** خلو الصفحة وكافة نصوصها من الحروف اللاتينية والرموز التعبيرية والكلمات المحظورة.
- **SSR Size Limit:** الحفاظ على عدد عناصر الصفحة الأولية أقل من 1399 عنصراً كما تشترطه الفحوصات عبر التحميل الهيكلي الأولي.
- **Mobile 390px Compliance:** ملاءمة تامة لشاشات الهواتف المحمولة وتوجيه RTL وأهداف لمس مريحة (Touch targets ≥ 44px).
