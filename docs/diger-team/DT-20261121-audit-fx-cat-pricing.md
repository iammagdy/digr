# توثيق تسعير كتالوج الأدوات وحمايتها (DT-20261121-audit-fx-cat-pricing)

- **المهمة:** `DT-20261121-audit-fx-cat-pricing`
- **المعماري:** جوني (DIGER ARCHITECT — Tier A)
- **الفرع:** `team/DT-20261121-audit-fx-cat-pricing` (مبني على `team/DT-20261121-audit-fx-cat-ph1`)

---

## ١. الهدف والقاعدة

بعد فتح كتالوج الأدوات الكامل في المرحلة الأولى (`FX-CAT Ph1`)، ظهرت أدوات غير مسعّرة (`cost: null` أو `cost.usd: null`) أو بنقاط غير مُقوّمة (`usd: 0` بدون `type: "free"`) أو بوحدات غير مدعومة، وكانت بعض المسارات تضع لها تخميناً ثابتاً قدره `$0.01` بدلاً من رفضها أو استخدام السعر الفعلي أو المعالجة المجانية الموثقة.

---

## ٢. التعديلات المنفذة

1. **اختيار الأدوات في الكتالوج (`agent/src/llmPlanner/catalogView.ts`):**
   - إضافة `isDocumentedFreeEndpoint` و`hasUsablePrice` للتحقق من وجود سعر صالح عبر `unitCost` أو مجانية موثقة (`type === "free"` و`usd === 0` بوحدة مدعومة).
   - استبعاد الأدوات غير القابلة للتسعير أو التي تعتمد على نقطة `poll` غير مسعّرة في `usableEndpoint` و`hasSupportedAsync`.
   - تعديل `callUsdOf` ليرجع `0` للأدوات المجانية الموثقة أو دون سعر، وإضافة `cost_unit` في `describeForModel`.
2. **حراسة البوابة (`agent/src/gateway.ts` — بإذن `D-0147`):**
   - إضافة `isCatalogPollEndpoint` و`isZeroFreeEndpoint`.
   - إرجاع `0` من `estimateCallUsd` للأدوات المجانية الموثقة، وإرجاع `null` من `tregCallBoundOf` للأدوات غير القابلة للتسعير.
   - رفض استدعاء أي أداة بلا سعر صالح في `gateway.tregCall` برمز `not_sellable` قبل أي طلب HTTP (باستثناء نقاط `async_config.poll.endpoint` الداخلية).
   - إعفاء نقاط `poll` المجانية للعمليات غير المتزامنة من حجز الميزانية وحدود التكرار/المراحل في `gateway.ts` مع تمرير `headerUsd = 0` و`reservedUsd = 0`، وتمرير حد أمان رمزي `boundUsd: 0.000001` لـ `gateBefore` عند تفعيل `spendGate`، وعدم خصم الميزانية إلا إذا فُرضت رسوم فعلية أكبر من الصفر.
3. **ميزانية التخطيط والعمليات غير المتزامنة (`src/lib/agentMission/planningBudget.ts` و`agent/src/asyncTreg.ts`):**
   - إزالة التخمين الثابت `0.01` من `oneCallUsd`.
   - إضافة `effectiveChargeUsd` (يستخدم `reserved_usd` فقط عند كون `charge_usd` يساوي `null`) و`attachMoneyFacts` (ينسخ الكائن ويُثبت `charge_usd` و`reserved_usd` و`call_ids` كخصائص غير قابلة للتعداد لمنع تسرب التكلفة للنموذج) وتجميعها عبر استدعاءات `submit` + `poll`.
4. **تسعير المراحل في المخطط (`agent/src/llmPlanner/planner.ts`):**
   - تصدير واستخدام `stageCostPerRawRowUsd` لاحتساب التكلفة الفعلية حسب نوع الوحدة (`per_record` دون قسمة على `rowsPerPage` مقابل `per_call`)، وأسوأ فرع للأدوات الموجهة (`routed_worst_sibling`)، ومقارنة الأعلى بين سعر الكتالوج والتكلفة المقاسة في العينة، مع الحفاظ على سلوك الاختبارات التركيبية القديمة ورفض الأدوات الحقيقية غير القابلة للتسعير.
5. **الاختبارات (`tests/fx-cat-pricing.test.ts`):**
   - اختبارات شاملة دون شبكة تغطي الرفض بصفر استدعاءات HTTP، المجانية الموثقة (`tinyfish.web.search.news` وأكثر من ٢٠٠ أداة)، التسعير بالصف والموجّه وتجاوز العينة، تطابق ٤٠٥+ أداة سابقة، `async submit + poll` مع ميزانية مساوية تماماً للـ `submit`، وتطابق البطاقة مع التسوية الجزئية والصفرية.
