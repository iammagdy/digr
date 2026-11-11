# Semantic integration v1 (PR-1.2, PR-1.3): the reading inside the real request contract

**Flag `semantic_normalization_v1`: OFF by default. Nothing in the repository, the database or the environment sets it. With it OFF the worker and the server read every request exactly as before (tested). Fixed for ordinary customers today: 0.**

## What is connected

```
customer message → privacy guards (guardRules.ts, #447; do not read the flag)
→ mission row (request_text stored as typed, never replaced)
→ worker runPlanning: settings read ONCE → flag → buildRequestContract(request, answer, { semantic })
   ├ platform decision / platform question / route (runMission.ts)
   └ planByCompiler({ semantic }) → buildAsk(..., { semantic }) → the plan: stages, engine params, price
→ plan_ready (the customer sees the plan and its price) → approval → execution runs the STORED plan
```

| Place | Change |
|---|---|
| `requestContract.ts` | `buildRequestContract(request, answer, { semantic })` and `buildRequestContractWithReport`. The ONE place the reading joins the contract. OFF: byte-for-byte as before. |
| `semantic/contractFill.ts` | The rule, **fill-only** (below). Pure. |
| `foundation/ask.ts` | `buildAsk(..., edits, { semantic })` passes it to the contract (the Ask is what the compiler reads). |
| `agent/src/runMission.ts` | Reads `agent_settings` once at the top of the planning run (the read that was lower down moved up, one read still), takes the flag with `readSemanticNormalizationFlag`, uses it for the three contract reads and hands it to the compiler. |
| `agent/src/compiled.ts` | `deps.semantic` → `buildAsk`. |
| `stage2/askEditAction.ts` | The server's «فهمنا طلبك» card re-derives the Ask from the words; it reads the SAME key with `readSemanticNormalizationFlagFromClient` so the card and the plan cannot disagree. |

Execution does not re-read the request: it runs the stored plan (platform and parameters are in it), so planning and execution cannot disagree about the flag. Only `askedTextOf` consumers (people nouns, contact lookups) read the text, and they are untouched.

## The fill-only rule (`contractFill.ts`)

* The parser stays authoritative: a value it produced is kept.
* **Fill** a field it left empty, only from an unambiguous reading: platform, comments, replies, parent kind, topic. Never from `ambiguous`, `multiple` or `none`.
* **Tighten** a topic it over-read: «السياحة والردود» → «السياحة», «السياحة بس استبعد …» → «السياحة» (an output field or an exclusion is never part of the topic). The topic also stops at the parser's own stop words (a country, a period, a language).
* **Clear** one wrong value: an X platform that only a bare «X» gave, when the words name it («مطعم اسمه X»).
* A disagreement keeps the parser's value and is reported by field name only (`report.disagreements`), never the customer's words.
* The topic keeps the customer's own letters and capitalization (`ChatGPT`). The stored request is never touched.

## Customer-visible effect (flag ON), verified through `runPlanning` over the stored live pages (no model, no provider, no network)

* «… تك توك …»: OFF the worker asks «من أنهي منصة؟». ON it plans the same plan (stages, parameters, price) as the stored «تيك توك» request.
* «… وهات الكومنتس والريبلايز»: OFF the comments and replies are **dropped silently** (a videos-only plan). ON the worker asks «كم تعليقًا تريد من كل فيديو؟» before any plan or price: a newly recognized stage never enters a plan, a price or a reservation without the customer's answer and approval.
* A request the parser already reads is planned identically ON and OFF.

## Measured on the 98 baseline scenarios, through the real contract and ask (`tests/semantic-contract-integration.test.ts`)

* Gaps before: **62**. **Fixed end to end with the flag ON: 23** (sa-01, sa-02, sa-03, sa-08, sb-09, pl-04, pl-05, pl-07, pl-11, pl-14, pl-16, pl-17, pl-22, pl-24, pl-25, cm-02, cm-05, cm-06, cm-09, ct-07, rt-04, rt-05, mt-09): every expected field of the case holds.
* **Partly improved: 4** (sa-04, sa-06: topic without a marker; pl-15: X has no comments stage in the contract; pl-23: the platform is read, the period is PR-1.3).
* **Unchanged: 34. Changed, still wrong: 1** (pl-21: the topic lost «in Egypt», the country gap remains).
* **Regressions: 0** (no scenario that was right OFF is wrong ON). **Fixed for ordinary customers while the flag is OFF: 0.**
* The 62 known gaps stay pinned for the OFF path (`semantic-paraphrases.test.ts` unchanged and green).

## Not fixed here, and why

* Dates, countries, languages (L4) were NOT fixed by PR-1.2: they are PR-1.3 (below). E-mail wording (L6), pre-filter false positives (W1-W6) and message-type routing (L7): separate stages, not vocabulary.
* «١٠٠ كومنت» (a number in front of a Latin or Arabizi «comments» word): the per-parent count is read by Arabic «تعليق» patterns, so the worker asks how many (a visible question), it does not guess.
* X has no comments stage in the contract: «تعليقات X» keeps meaning no comments stage (existing behavior for an explicit X, now also reachable for «Twitter» spelled with a capital).
* The chat model and the keyword classifier (`classifyMessage`) decide whether a message is a data request BEFORE any of this; they are not changed.

## Safety

* PR #447 untouched: `guardRules.ts`, `chatTurn.ts`, `customerActions.ts`, `messageType.ts` do not read the flag or import this layer (tested). The guard runs first and independently; the reading cannot override a refusal. The personal-contact rule is still enforced in the chat only (as before).
* No money, pricing, ledger, provider, TREG, schema, auth or deployment change. No test-account mode: the server card has no verified test-account signal, so the flag is a single global switch read by one reader on both sides; enabling it is an owner action in `agent_settings`.


---

# PR-1.3: dates, countries and languages (same flag, same OFF default)

**Flag `semantic_normalization_v1`: still OFF everywhere; nothing sets it. With it OFF the parser, the Ask and the plan are exactly as before (tested: contract, Ask and every one of the 98 scenarios are identical; fixed for ordinary customers: 0).**

## What is connected

```
request (+ the customer's answer) → privacy guard (unchanged, independent)
→ buildRequestContract(request, answer, { semantic })      the contract says WHETHER a period / a country / a language was asked
→ buildAsk(request, answer, createdAt, edits, { semantic, conditionsAnswer })   the Ask holds the VALUES (Cairo days, ISO country, content language) or a clarification
→ planInner (agent/src/compiled.ts): an open clarification is asked BEFORE any read, plan, price or reservation
→ compiler (unchanged): the same filters, inputs, statements and price the same words typed the old way would get
→ plan_ready → approval → the stored plan executes (it never re-reads the request)
```

| Place | Change |
|---|---|
| `semantic/conditions.ts` (new) | `readConditions(request, answer, nowMs)`: the period, the country, the language. Pure; the reference moment is an argument; every day is a Cairo day (`cairoDayOf`). |
| `semantic/contractFill.ts` | `topicWithoutConditions` (a period / language / country phrase at the end of the topic is cut off it) and `FillReport.corrected`. |
| `requestContract.ts` | the three `asked` flags (period, country, language) come from the reader too; the language flag is DECIDED by the reader when the words carry a language word (the old regex could not tell the data's language from the report's). |
| `foundation/ask.ts` | `Ask.period/country/language` from the reader (flag on); new optional `Ask.reportLanguage` and `Ask.clarify`. |
| `agent/src/compiled.ts` | an open `clarify` returns `{ kind: "question", why: "conditions" }` before anything is read; after three questions the request ends honestly (`conditions_unclear`). |
| `agent/src/runMission.ts`, `runState.ts`, `countChoice.ts` | the answer is kept with the run's choices (`conditionsAnswer`, `pending: "conditions"`) because a later question's answer replaces `answer_text`; the answer's words are never part of the request. |
| `stage2/askCard.ts` | the «فهمنا طلبك» card says «نحتاج توضيح … قبل الخطة» for an open clarification; a card edit of the field answers it. |
| `foundation/compilePlan.ts` | one honest note when the customer asked the REPORT in English («ملف النتائج وملخصه بالعربية حاليًا»). No stage, no price. |

## The rules

**Dates** (`آخر ٣ شهور`, `اخر تلات شهور`, `آخر 30 يوم`, `الشهر اللي فات`, `من ١ لـ ١٥ أكتوبر`, `من يناير لحد مارس`, `من أول السنة`, `from January to March`, `آخر أسبوعين`, `امبارح`, `السنة اللي فاتت`):
* Arabic and Western digits; Egyptian number words (تلات، خمس، ست، عشر، عشرين، تلاتين …).
* A range is read as written (never the whole month, never the first month only). A day is kept. A start with a day and no end («من ١٥ أكتوبر», «من أول السنة») runs to today and the plan's sentence states both days.
* «آخر N يوم/أسبوع» is exactly N days / 7N days (today included). OFF read it one day longer (a silent widening). «آخر N شهر/سنة» keeps the product's calendar rule (same day N months earlier), unchanged.
* **Never guessed, asked:** a month or range with no year that lies wholly in the future; a range that crosses a year with no year at all; a day that does not exist («٣٠ فبراير»); two different periods in one request. A year on ONE end of a crossing range fixes the other by the order of the months («من نوفمبر لحد فبراير ٢٠٢٦» is Nov 2025 to Feb 2026). A range that starts in the past and ends later this year is this year's.
* Reference: the mission's creation moment, Africa/Cairo days. Nothing reads the machine's clock or zone (the reader holds no `Date.now()`, `process.env` or network; tested).

**Countries:** a geographic target only after a locative word (في, من, داخل, بـ/فـ fused, in, from, within). «عن مصر» is the topic, never a filter. A city is never its country («في مصر الجديدة» is a district). Arabic spelling variants (ه/ة, hamza, fused ف/ب, the long names) and English names. Two countries are a question, not the first of them. A nationality word («مصرية») is not a country. The reader creates no capability: the compiler states, as before, what a source cannot enforce.

**Languages:** three different things. The language of the COLLECTED CONTENT («تعليقات بالعربي», «English posts») is the only filter. A REPORT language («التقرير بالإنجليزي») is not a filter (and the plan says the report stays Arabic). A CHAT language («رد علي بالعربي») is nothing. The language the request is written in never sets a filter. A language the product cannot filter by («بالفرنسي») is a question (OFF silently made it Arabic). «عربي» alone, «الشركات العربية», «الوطن العربي» name no language.

**When the parser was demonstrably wrong the explicit words replace it** (PR-1.3's one deliberate departure from fill-only, narrow and reported by field name in `FillReport.corrected`): a month range read as its first month, a day range read as the whole month, `آخر 30 يوم` read as 31 days, a report language read as a data filter, French read as Arabic, the first of two countries. Everything else the parser read stays.

## Measured on the 98 scenarios (flag ON, through the real contract and Ask; `tests/semantic-conditions.test.ts`)

* **Fixed: 37 of 62** (the 23 of PR-1.2, all still fixed, plus 14): dt-02, dt-04, dt-07, dt-08, dt-09, dt-10, dt-11, ct-04, ct-05, ct-10, pl-21, pl-23, sb-01, sb-02.
* **Partly improved: 3** (sa-04, sa-06: topic with no marker; pl-15: X has no comments stage). **Untouched: 21.** **Changed, still wrong: 1** (pf-02: its topic is now «السياحة»; the template-placeholder pre-filter, W1, is another stage). **Regressions: 0.** **Fixed for ordinary customers while the flag is OFF: 0.**
* **How far each is end to end.** Through the worker's compiled planning (`runPlanning` over stored live pages, provider inputs, stated period, price, the question): dt-*, ct-04, ct-05, ct-07, ct-10, pl-21, pl-23 (the TikTok/X compiled path). **sb-01 and sb-02 are contract-and-Ask only**: they have no platform, so they take the model-planned legacy path, where the contract's `country` flag now makes the gate require the plan to carry or state it; the coded companies path (`stage3/b2bAsk.ts`, behind its own flag, test accounts) already read «فمصر» and «in Egypt» with its own reader and is untouched.

## Not fixed here, and why

* A city or district as a geographic target (no city filter exists; the old reading still takes «في مصر الجديدة» as Egypt on the OFF path, and the ON path leaves it as the old parser read it).
* «الأسبوع الماضي» (a week's start is a product decision: Saturday or Monday): not read, the contract still flags it as an unvalued period exactly as today.
* English «last month» / «last year» with no number are read like the Arabic «آخر شهر / سنة» (the rolling rule), not as the previous calendar month; the plan states the two days.
* Topics with no marker (cm-08, sa-04, sa-06), e-mail wording, the pre-filter false positives, routing and message type: later stages.
* Report language: only stated (the file stays Arabic). No translation was added.
