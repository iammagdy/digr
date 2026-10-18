# Preview customer-flow test — PR #81

## Run identity and limits

- Tested Preview commit before fixes: `f4e647323aed3ac57a42f030d14f5df827173565`; reported READY deployment: `dpl_xPj9mRfyMq8rLAm6w18BqnGBeZp1` at `https://diger-bi99mjhcj-iam-magdy.vercel.app`.
- Nine requested messages were submitted in separate conversations as the logged-in test customer. No password was entered or read. No database write was issued directly, no migration was applied, no merge was made, and no provider endpoint was called directly.
- The nine conversations were not approved. The only execution observed was the permitted one-company quote described below. I did not intentionally press its approval button; the shared Preview session nevertheless reached `accepted` and created a job. Database evidence cannot identify who caused that transition, so I did not repeat it.
- Timings use `performance.now()` from the browser action to the first visible assistant content and plan card. They are unrounded observations, not server timings. Case **b** timing is invalid because the observer captured the “replying” placeholder, not assistant text.

## Requests a–i

### a. `عايز ٥ شركات كهرباء في مصر`

**Assistant reply, exactly as shown:**

> أعددت لك خطة الاستخراج وعرض السعر بالنقاط:
> - الهدف: خطة من خطوة واحدة: البحث عن حتى ٥ شركات تعمل في قطاع الكهرباء في مصر، مع بيانات التعريف ومعلومات التواصل المتاحة لكل شركة، وتسليمها في ملف منظم.
> - الحد الأقصى: حتى ٥ سجل
> - التكلفة المتوقعة: ١٥ نقطة

**Plan card:** مصر; الكهرباء والطاقة الكهربائية; حتى ٥ سجل; ملف Excel; steps: extract records, check relevance, deduplicate and review available contact data, prepare the files and methodology; ١٥ points; reserve ١٨ points in `plans_quotes`; no cap note. Expected price is ٥ × ٣ = ١٥, so price matches. The card showed “ملف Excel” in English.

**Judgment: PASS** capability, country, count, price, and polite concise tone. **FAIL** strict Arabic-script requirement for the file-format label. No provider names or USD appeared.

Timing: first assistant content **661.3007999993861 ms**; card **15838.268200000748 ms**. [Screenshot](preview-test/a.png)

### b. `عايز ٣ مديرين في شركات الطاقة في السعودية مع إيميلاتهم وأرقام مكاتبهم`

**Assistant reply, exactly as shown:**

> قبل إعداد الخطة، أحتاج معلومة واحدة حتى تكون مطابقة لطلبك.
>
> سؤال توضيحي
>
> ما المجال أو الشركة التي تريد صناع القرار منها؟

No plan card, quote, or price was produced. The request already supplies “شركات الطاقة” and السعودية, so the question repeats a supplied scope. The captured **737.7772999983281 ms** was the UI’s “replying” placeholder and is **not a valid assistant-response timing**; plan timing: not applicable.

**Judgment: FAIL**: intent was recognized as decision makers but discovery falsely asked for the company sector. Likely cause: `getDeterministicDiscoveryQuestion` and the later people-plan validation recognized `في شركة` but not plural `في شركات`. No provider names, USD, or English appeared. [Screenshot](preview-test/b.png)

### c. `هات ١٠ كومنتس على فيديوهات تيك توك عن كرة السلة في مصر`

**Assistant reply, exactly as shown:**

> أعددت لك خطة الاستخراج وعرض السعر بالنقاط:
> - الهدف: سحب التعليقات من فيديوهات تيك توك عن «كرة السلة»، بحد أقصى ١٠ تعليقاً من كل فيديو
> - الحد الأقصى: حتى ١٠ سجل
> - التكلفة المتوقعة: ٦٠ نقطة

**Plan card:** country: “يلزم تحديد الدولة”; subject: “تعليقات تيك توك عن كرة السلة في مصر”; count: حتى ١٠ سجل; format: ملف Excel; steps searched videos around the whole phrase “تعليقات تيك توك عن كرة السلة في مصر”, then relevance review, dedupe and file preparation; ٦٠ points; reserve ٦٩ points; no cap note. Price is ١٠ × ٦ = ٦٠ and matches the calculator. Quote data contained `query = كرة السلة`, but no country/region. The reply says “١٠ لكل فيديو” while the plan caps the whole result at ١٠, so it overstates the total. Format label is English.

**Judgment: FAIL** country omitted; subject/steps include task words instead of the basketball topic; per-video wording conflicts with the ten-row total; file label is English. Likely causes: social canonical parameters omitted a region for keyword comments, and the plan renderer used the conversation title/model summary rather than a clean customer topic. No provider names or USD. Timing: first assistant **12320.31770000048 ms**; card **12329.63069999963 ms**. [Screenshot](preview-test/c.png)

### d. `عايز ١٠ فيديوهات ترند على تيك توك في مصر`

**Assistant reply, exactly as shown:**

> أعددت لك خطة الاستخراج وعرض السعر بالنقاط:
> - الهدف: سحب الفيديوهات الرائجة على تيك توك
> - الحد الأقصى: حتى ١٠ سجل
> - التكلفة المتوقعة: ٦٠ نقطة

**Plan card:** country: “يلزم تحديد الدولة”; subject: “في مصر”; count: حتى ١٠ سجل; format: ملف Excel; steps used “في مصر” as the subject; ٦٠ points; reserve ٦٩ points; no cap note. Quote data already contained `region = EG`; the display extractor did not read the region. Price is ١٠ × ٦ = ٦٠.

**Judgment: FAIL** country is present in saved quote but hidden by the card; country text was mistaken for the subject; English format label. Likely cause: `extractInterpretedParameters` ignored social `region`, and title parsing retained country-only text. Timing: first assistant **10173.882500000298 ms**; card **10182.465500000864 ms**. [Screenshot](preview-test/d.png)

### e. `اجمع ١٠ دراسات أكاديمية عن الطاقة الشمسية في ألمانيا خلال آخر شهر`

**Assistant reply, exactly as shown:**

> أعددت لك خطة الاستخراج وعرض السعر بالنقاط:
> - الهدف: خطة من خطوة واحدة: جمع حتى ١٠ نتائج أكاديمية ومواد بحثية عن الطاقة الشمسية في ألمانيا خلال آخر شهر، مع عنوان ورابط ومصدر ومستخلص لكل نتيجة. الحد الأقصى لهذه الخطة ١٠ سجلات، والسعر النهائي يحسبه الخادم عند عرض العرض.
> - الحد الأقصى: حتى ١٠ سجل
> - التكلفة المتوقعة: ٣٩٠ نقطة

**Plan card:** ألمانيا; الطاقة الشمسية والمتجددة; حتى ١٠ سجل; ملف Excel; steps: gather records, review relevance, deduplicate, prepare files/methodology; ٣٩٠ points; reserve ٤٤٩ points; no cap note. Price matches the catalog calculation, ١٠ × ٣٩ = ٣٩٠.

**Judgment: PASS** capability, scope, time window, count and price. **FAIL** the reply exposes an internal “السعر النهائي يحسبه الخادم” sentence and uses the English label “Excel”. Timing: first assistant **10445.5625 ms**; card **10476.604399999604 ms**. [Screenshot](preview-test/e.png)

### f. `مساء الخير`

**Assistant reply, exactly as shown:**

> أهلًا codex test، رصيدك المتاح ٨٠٨ نقطة. كيف أساعدك اليوم؟

No research UI or plan. **Judgment: PASS** greeting-only behavior and real profile name/balance. Timing: first assistant **4444.585099998862 ms**; no card. [Screenshot](preview-test/f.png)

### g. `عايز كومنتس فيديوهات منتخب مصر في كأس العالم ٢٠٢٦ من قناة فيفا الرسمية`

**Assistant reply and choices, exactly as shown:**

> قبل إعداد الخطة، أحتاج معلومة واحدة حتى تكون مطابقة لطلبك.
>
> سؤال توضيحي
>
> على أي منصة تريد البحث؟
> تيك توك
> منصة X
> يوتيوب
> الويب العام
> أخرى
> السابق
> إجابة ومتابعة
> تخطّي السؤال

No plan/quote. **Judgment: PASS** one platform question, Arabic, no refusal or unrelated-source suggestion. The question is reasonable because an official channel could refer to multiple platforms. Timing: first assistant **4024.9802999999374 ms**; no card. [Screenshot](preview-test/g.png)

### h. `إنت مين؟`

**Assistant reply, exactly as shown:**

> أنا مساعد Diger، مساعد بحث وجمع بيانات من الإنترنت. أساعدك تحدد احتياجك، أقترح خطة جمع واضحة قابلة للتعديل، وبعد موافقتك أجمع البيانات وأسلمك ملفات Excel وCSV وPDF منظمة مع منهجية مختصرة. رصيدك الحالي ٨٠٨ نقطة، وتقدر تقول لي النهارده عايز تجمع بيانات عن إيه.

No research UI or plan. **Judgment: FAIL** not matched to the deterministic identity path and includes Latin brand/file names. It does identify the product as an AI/research assistant in substance without naming a model or provider. Likely cause: Egyptian “إنت مين؟” was absent from `isGreetingOrGeneralQuestion`, leaving the answer to the live model. Timing: first assistant **6872.862299999222 ms**; no card. [Screenshot](preview-test/h.png)

### i. `هات تغريدات عن كرة السلة`

**Assistant reply and choices, exactly as shown:**

> نحتاج تحديد الدولة أو الفترة الزمنية المطلوبة، وهل تريد عينة صغيرة أو أكبر، لنجهز خطة مناسبة.
>
> سؤال توضيحي
>
> هل تريد التغريدات من دولة محددة؟
> مصر
> السعودية
> الإمارات
> كل الدول
> أخرى
> السابق
> إجابة ومتابعة
> تخطّي السؤال

No plan/quote. **Judgment: PASS** asks one country question, does not restrict topics or substitute platforms. The introductory sentence mentions other optional scope dimensions, but only one question is asked. Timing: first assistant **6977.735200000927 ms**; no card. [Screenshot](preview-test/i.png)

## One permitted tiny execution

The exact one-company variant was `عايز ١ شركة كهرباء في مصر`. Before it ran, a read-only query showed ٠٫٠٠٧٣ USD daily TREG spend, ٠٫٧٩٢٧ USD remaining of the ٠٫٨٠ cap, and ٨٠٨ points balance. The quote displayed ٣ points; the saved quote reserved ٤ points (`ceil(3 × 1.15) = 4`), below the ٢٠-point limit. No other scenario was approved.

The shared session then showed this job accepted. I did not intentionally press approval, and cannot determine from the read-only rows whether another action in the shared session caused acceptance. I stopped and did not retry.

**Raw `jobs` row (selected fields):**

```json
{"id":"job_quote_4c9fed076a196c7cded1ea7573904592","status":"failed","attempt_count":4,"endpoint_id":"icypeas.companies.search","target_volume_max":1,"reserved_credits":"4","charged_credits":"0","delivered_units":0,"error_message":"تعذر بدء البحث بعد عدة محاولات. أُعيدت النقاط المحجوزة إلى رصيدك.","accumulated_cost_usd":"0","result_file_id":null,"next_attempt_at":"2026-10-17 21:01:53.867704+00"}
```

**Raw ledger SELECT output:**

```json
[{"id":"res_job_quote_4c9fed076a196c7cded1ea7573904592","job_id":"job_quote_4c9fed076a196c7cded1ea7573904592","type":"reserve","delta":"-4","created_at":"2026-10-17 20:59:07.80574+00"},{"id":"rel_job_quote_4c9fed076a196c7cded1ea7573904592","job_id":"job_quote_4c9fed076a196c7cded1ea7573904592","type":"release","delta":"4","created_at":"2026-10-17 21:00:34.172349+00"}]
```

Arithmetic: reserve −٤ + release ٤ = net ٠ points; charged ٠; balance returned to ٨٠٨. **Raw provider-cost SELECT output:** `[]`. The job record shows accumulated cost 0 and no result file. Total spend recorded for this job is ٠ USD; the job made no provider-cost entries. No Excel download was possible. [Screenshot of completed attempt and release](preview-test/tiny-one.png)

Current read-only daily budget query output: `spent_usd=0.0073`, `remaining_daily_budget_usd=0.7927`, `daily_cap_usd=0.80`, `balance_points=808`.

## Catalog `/services`

- No provider names were visible in the Arabic catalog.
- Visible point prices matched the code-backed catalog rates observed in the rendered cards: companies ٣/record; decision makers ٨٣/person plus ٥٥/work email and ٥٥/office phone; TikTok comments ٦; YouTube comments ٩; Facebook comments ١١; TikTok videos ٦; YouTube videos ٥; Facebook posts ١١; X posts ٥; TikTok profile ٦. Topic/news/academic search says the server calculates after matching a service rather than showing a hand-entered price.
- The two future entries are “بحث وجمع صفحات الويب المتقدمة” and “بحث سياقي موسّع”, both marked “قريباً”.
- RTL is set and DOM geometry measured `innerWidth=1070`, `scrollWidth=1065` (no horizontal overflow). The saved full-page screenshot is visually clipped at an edge by the capture, so it is not reliable evidence of mobile layout. This run did not measure a mobile viewport.
- [Catalog screenshot](preview-test/services.png)

## Fixes on this branch

- People discovery now recognizes the explicit scope phrase `في شركات ...` in both the early question gate and quote validation, preventing the redundant sector question in request **b**.
- Social search parameters keep a country region for display when the user specified one; the plan country extractor also recognizes stored region codes. Social titles use the subject tokens from the request, and comment summaries state both the per-video cap and the overall quoted comment count.
- Social plans no longer prepend unconstrained model prose to the deterministic price/plan reply. The identity matcher recognizes Egyptian `إنت مين؟` and uses deterministic Arabic copy. Customer-facing format names use Arabic script.
- The system prompt now instructs Arabic-script customer text and Arabic-Indic numbers.

Focused tests: **٦٠ passed in ٤ files**. Full suite after fixes: **١٢٢٠ passed in ١٤٥ files**. `npm run build`: **PASS**. `npx tsc --noEmit`: **PASS** when run after the build finished. An initial parallel `tsc` attempt raced Next's `.next/types` generation and failed with missing generated type paths; the sequential rerun passed.

## Remaining verification

- These live-model replies are sample-dependent. The social summary, country display, discovery fix and identity answer require a fresh model-backed Preview retest after the new deployment is READY.
- The job's automatic attempt count reached four and then released the reserve. Its failure reason is shown in the job; no provider cost or delivered file is recorded. Provider credentials/routes were not tested directly.
- No production merge, migrations, or direct database writes occurred.
