# Round 58: the company count of a plan is its companies (13 Nov 2026)

Main before this round: `196942d` (PRs #469–#472). The acceptance request:
«عايز ٣٢ شركة مستحضرات تجميل في مصر، ومع كل شركة موقعها الرسمي، والتليفون والإيميل المنشورين ورابط مصدر المعلومات. لو معلومة مش موجودة سيبها فاضية، ومش عايز شركات خارج المجال.»

## What was verified before changing anything

* **The planner already binds «٣٢ شركة» to the companies step** (`plan.ts` quantity contract, `bindQuantityDetailed`). Run end to end through `validateAndPricePlan`:
  * The planner proposes 20 companies with no reason: the companies step becomes 32, and the contacts follow it (32 + 19 = 51 priced items).
  * It proposes 20 with a reason: the plan keeps `quantity = {requested: 32, target: 20}`, and the card shows the reason.
* **The 13 Nov original request named no number.** «٣٢» came from the card: 20 companies (the default) plus the contacts of about 12 of them, priced as 32 items.

## Defects found and fixed (no price, hold, charge, ledger or settlement line)

1. **A contact step titled with the companies' noun made the whole plan count as «شركة»** (`itemNoun.ts`). Titles the planner writes, such as «بيانات تواصل الشركات», «إيميلات الشركات وتليفوناتها» or «مواقع الشركات الرسمية», all read as «شركة». So 20 companies plus 12 contact rows became «٣٢ شركة» on the card, in the notice, in the wallet line, in the file's first sentence and in the methodology PDF.
   * **Fix:** a delivered step that hangs on another delivered step makes the total «عنصر».
   * On the card, a step whose noun repeats its parent's noun counts its rows as «عنصر» (it said «١٢ شركة»).
2. **A revision with a new number was planned at the old number** (`plan.ts`). The revised request is «… ٢٠ شركة … تعديل العميل على نفس الطلب: عايز ٣٢ شركة مش ٢٠». The quantity was read from the first number, 20.
   * **Fix:** the latest change that names a quantity is read first (`revisionText.ts`).
3. **The card said only the priced total.** It now says three things (`entityCount.ts`):
   * the companies («هتستلم: ٢٠ شركة»);
   * the details with their expected coverage («ومعها «بيانات التواصل…» لحوالي ١٢ منها؛ وهذا عدد مستهدف وليس مضمونًا»);
   * the priced total as items («والمجموع ٣٢ عنصرًا محسوبًا في السعر، وعدد الشركات فيها ٢٠ فقط، لا ٣٢»).

   When the plan targets fewer than asked, the card states both numbers before approval: «طلبتَ ٣٢ شركة، وهذه الخطة تستهدف ٢٠ فقط … اعتمادها يعني قبول هذا العدد». «المجموع في ملفك» still shows the file's real item total.
4. **The file** (`workbook.ts`): «تم تسليم ٣٠ من ٣٢ عنصرًا. منها ١٩ شركة، و١١ من «بيانات التواصل…».»
   * The per-step summary table is unchanged.
   * CSV has no count sentence. The methodology PDF takes its noun from the same function, so it is fixed by item 1.
5. **Plan editor headline:** a stale headline after an edit is rewritten in companies («تجمع لك ١٠ شركات، ومعها تفاصيلها كما في الخطة…»), never in the priced total.
6. **Chat** (`openPlanFacts.ts`, `conversationModel.ts`):
   * The chat model's facts now carry the companies' count, the requested-vs-target pair, «a column is not a saving», and «dropping a step drops what it collects».
   * Code answers two new questions when the model is down:
     * «يعني ٣٢ شركة؟» (count): 20 companies; 32 is the priced total;
     * «ممكن تتكرر؟» (duplicates): the plan does not state de-duplication.
   * **A deterministic reply guard** rejects five kinds of model reply about the open plan, and the code's own answer is shown instead:
     * the priced total said as companies;
     * «yes, the price drops» for a removed column;
     * a de-duplication the plan does not state;
     * an unstated capability («خانة للتحقق», «ترتفع الجودة»);
     * a guarantee of coverage.
     The patterns are the real model's own replies on main `196942d`.

## Plan editing while the worker is planning (the round-57 deferred race, inspected again)

* **No website path cancels a mission in `planning`, `approved` or `executing`.** Every cancel is a compare-and-set on waiting statuses: customer (`queued, needs_input, plan_ready`), chat replace/withdraw (the same), admin (the same), expiry (`needs_input, plan_ready`), add-on (`plan_ready`), free re-run (`queued`). So a late planner run cannot write a cancelled mission back to `plan_ready` today. The worker fence (compare-and-set on every worker write) stays unbuilt: it changes the byte-identical worker replays and a deliberate policy, and nothing needs it now.
* **Pinned:** `tests/no-planning-cancel-r58.test.ts` reads every website `status: "cancelled"` write and fails if one could match a running status (mutation-checked: adding `planning` to the customer's list fails it). Adding such a path needs the worker fence first.
* **What the customer reads** when they type a change while the plan is prepared: the change is NOT applied yet, and they should send it again once the plan shows, or use the card («خطة طلبك ما زالت قيد التجهيز، ولم يُطبَّق عليها تعديلك بعد…»). Before, the reply implied the change would be applied.
* **Custom columns:** the card's editor toggles only the columns the plan has. A column the plan lacks («ضيف صفحة الفيسبوك») is a chat revision: the whole request is planned again with the change (round 57, `C2`/`B1` in the eval). Required source links stay, because the revision keeps the original words.

## Measured with the real model (production configuration, `evals/customer-journey`, 20 cases)

| main `196942d` (24 turns) | this round (48 turns, 2 repeats) |
|---|---|
| 4 / 24 shown replies with an unsupported claim (dedupe offer, «أيوه السعر بيقل», «خانة للتحقق», «ترتفع الجودة») | 0 / 48 (1 model reply replaced by the guard) |
| objective checks 24 / 24 (after correcting two mention patterns that missed «عشرون» and «لا أستطيع أن أضمن») | 48 / 48 |

* **Manual read:** no invented capability, count or saving remains. Two replies say «تدفع فقط مقابل ما يُسلَّم»; that is accurate. The minimum raises the job's unit (`missionPricing.ts` `priceByRule`), a partial delivery pays `ceil(delivered × job unit)`, and nothing is charged for zero rows.
* **Spend:** a separate budget folder capped at $0.15 for this round. Spent $0.0496 over 74 attempts (cumulative for all rounds: $0.0880 + $0.0496 = $0.1376).

## After the merge of #473 (`99acb4f`): numbers written in words

* **Production:** Heroku v182 «Deploy 99acb4fa» with the worker reporting `started (99acb4f)` at 14:54 UTC. The card chunk diger.tech serves (`1747-d3d5800366f1fe84.js`) is byte-identical to a local build of `99acb4f` and contains `agent-count-explain`, which exists only in #473. The Vercel connector was disconnected, so the production deployment SHA was not read from Vercel itself.
* **Real model on merged main** (24 turns, $0.0171): every objective check passed except one wording miss on N3 («لا أستطيع ضمان»).
* **New defect found by reading the replies:** N1 answered «الرقم ثلاثة وثلاثون هو مجموع العناصر» for the plan's 32. The reply guard checked digits only, so the wrong number in words got through.
* **Fix** (`numberWords.ts`): numbers above ten written in words are held to the same allowed numbers as digits. Small numbers of ordinary speech («مرة واحدة», «خطوتين») are not checked.
  * Replayed over all 94 real model replies of this round: it flags exactly that reply and no other.
  * When it blocks, the code's count answer is shown instead.
* **Tests:** `tests/number-words-r58.test.ts` (9).

## Authenticated production journey (13 Nov 2026, 15:56–16:06 UTC, production `2bd4b28`)

A real customer journey on diger.tech with the dedicated test account (not an admin; `app_metadata.role` empty). The login was the normal `/login` page (Supabase password sign-in) in a headless browser. Credentials were never printed, committed or logged.

* **Request** (a small labelled scenario, not the 32-company acceptance): «عايز ١٢ شركة مستحضرات تجميل في مصر، ومع كل شركة موقعها الرسمي، والتليفون والإيميل المنشورين ورابط مصدر المعلومات…».
* **Plan** `msn_088cfef00f92a8ff1ea9`: 12 companies (Tomba company search) and 12 contact rows (Context.dev page parse). The card said «هتستلم ١٢ شركة» and «… وعدد الشركات فيها ١٢ فقط، لا ٢٤». Most charged 312, hold 359.
* **Methodology questions** (real chat model): sources and relevance answered from the plan, no invented capability. «يعني هستلم ١٢ شركة ولا ٢٤؟» was answered «هتستلم ١٢ شركة. الرقم ٢٤ … مجموع العناصر».
* **Plan edit** (card editor, no paid call): 12 → 10 → 9, so the hold stayed within the 325-point limit. At 9: most 270, hold 310.
* **Approval → execution → delivery:**
  * approved 16:01:16, completed 16:06:04;
  * 9 companies + 4 contact rows delivered (13 of 18 planned items);
  * Excel (summary, methodology, 2 sheets) and a CSV zip (one file per step + methodology), both UTF-8 with BOM;
  * the file's first sentence: «تم تسليم ١٣ من ١٨ عنصرًا. منها ٩ شركات، و٤ من «…»».
* **Data quality:**
  * 9 distinct Egyptian cosmetics companies; 9 duplicates removed, 1 rejected as off-topic;
  * all 6 delivered contact values (3 e-mails, 3 phones) were found on the cited public contact pages;
  * of the 9 company websites: 5 confirmed live cosmetics sites, 2 unreachable, 2 inconclusive;
  * issues: two possible identity mismatches (BOBANA described and linked as «Vision Cosmetics»; «yolo-cosmetics.com» described as «Cosmotrade»), one junk address («31.25»), one «Giza Giza»;
  * the companies sheet has no source-link column (company data comes from a company database; only the contact rows carry a public link);
  * contacts were found for 4 of 9 companies.
* **Money:**
  * ledger: reserve −310, release +310, charge −195;
  * 195 = ceil(13 × 14.970984), at most the 270 shown;
  * balance 3,281 → 3,086. No other row.
* **Notices:** «بدأ تنفيذ مهمتك» and the partial-delivery notice. «طلباتي» shows the mission.
* **Phone** (iPhone 13 emulation): no horizontal scroll; the card, the files and «طلباتي» are readable.
* **Fixed after the journey (#475):** five customer-facing wording defects.
  * The card line «تُجمع المنشورات…» («المنشورين», published, read as «posts»).
  * The headline «٩ شركة» after an edit.
  * The file and notice names «١٣/١٨ إيميل والتليفون…» for 9 companies.
  * The shortfall reason «عليها منشورات أقل».
  * «طلباتي» falling back to «سجل».
* **External API spend:**
  * this mission: $0.1452 (providers $0.1045 including 11 empty Context.dev parses at $0.00254 each; model $0.0407);
  * evals of this round: $0.0735;
  * chat replies: under $0.005, not recorded in `llm_usage`.
  * The round's total is about $0.22, **over the $0.20 authorization by about $0.02**. Execution cost three times the plan's provider estimate ($0.0305), and an executing mission cannot be stopped by the customer.

## Not changed (owner decision): what a unit of the price is

The price counts every delivered item of every step. That is the approved contract (`missionPricing.ts`):

* reserve = max(minimum, ceil(items × rule unit × 1.15));
* job unit = max(rule unit, minimum ÷ items);
* charge = ceil(delivered × job unit), never above the reserve, and 0 for nothing delivered.

 So 20 companies with 12 contact rows is 32 units. The card now says so; the contact rows are no longer called companies anywhere. Making the company the unit needs a financial change and is set out, not applied, in `docs/proposals/per-company-unit.md`.

## Not verified

* **Authenticated customer journey and a real delivery:** the session has no test-account login (see the final report). No mission was approved and no point was spent.
