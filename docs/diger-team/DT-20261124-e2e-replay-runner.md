# DT-20261124-e2e-replay-runner: مشغل إعادة المسار الكامل (Full-Flow E2E Replay Runner)

أداة لاختبار مسار العميل كاملاً (Full customer flow replay) من أول الرد أو السؤال (First reply / question) واختيار العميل (Customer choice) لحد كارت الخطة والحجز (Plan card + hold) والتسليم الفعلي (Delivery). التشغيل بيتم بالنموذج الحقيقي (Real model) في الذاكرة (In-memory) مع صفر كتابة في قواعد البيانات أو المحفظة أو الدفتر (Zero DB / wallet / ledger writes)، والأداة للأدمن والاختبارات ومش مستخدمة في الموقع.

## أنماط التشغيل (Modes)
- **recorded (الافتراضي):** بيستخدم بيانات مسجلة مسبقاً (Fixtures)، بدون أي استدعاءات للمزودين ($0 provider spend)، وتكلفة التوكنز للنموذج فقط. أي قيمة غير معروفة للـ flag بترجع تلقائياً للوضع ده.
- **live (اختياري وصريح):** بيشغّل مزودات حقيقية فقط لو اتمرر صراحة `--providers=live`.
- **حد الصرف (`--max-usd`):** سقف أقصى افتراضي 0.50 USD لمجموع كل الجولات للمزودات (مش شامل توكنز النموذج).

## أوامر التشغيل (Run Commands)
- تشغيل افتراضي مسجل (Recorded smoke):
  `ANTHROPIC_API_KEY=<key> npx tsx scripts/full-flow-replay-runner.ts --runs 1`
- تشغيل مباشر (Live mode):
  `ANTHROPIC_API_KEY=<key> PROVIDER_KEY=<key> npx tsx scripts/full-flow-replay-runner.ts --providers=live --runs 1`
- تطبيق قاعدة D-0202 (تشغيل 5 جولات متتالية 5/5 قبل دمج أي تعديل):
  `ANTHROPIC_API_KEY=<key> npx tsx scripts/full-flow-replay-runner.ts --providers=live --runs 5`

## معايير النجاح (Pass Criteria)
1. **المطابقة العددية (Count Match):** تطابق أعداد السؤال والكارت والتسليم (`question count == card count == delivered count`).
2. **تطابق الأسعار والحجز (Price & Hold):** تطابق حد الكارت وسعر الخيار ومبلغ الحجز (`card max == option price == hold`).
3. **أرقام الخيارات (Code-stamped Numbers):** كل خيار يحمل أرقامه المختومة كودياً بدون تأليف.
4. **منع الأخذ عند الصفر (Zero Found Guard):** عدم ظهور خيار أخذ الموجود لو كان `found == 0`.

## الروابط والقرارات
- **Pull Request:** PR #671
- **Gate File:** PR-671-GATE.md
- **Decisions:** D-0202 (قاعدة 5/5 بالنموذج الحقيقي قبل الدمج) و D-0206 (الوضع الافتراضي recorded).
