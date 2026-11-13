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

## Measured with the real model (production configuration, `evals/customer-journey`, 20 cases)

| main `196942d` (24 turns) | this round (48 turns, 2 repeats) |
|---|---|
| 4 / 24 shown replies with an unsupported claim (dedupe offer, «أيوه السعر بيقل», «خانة للتحقق», «ترتفع الجودة») | 0 / 48 (1 model reply replaced by the guard) |
| objective checks 24 / 24 (after correcting two mention patterns that missed «عشرون» and «لا أستطيع أن أضمن») | 48 / 48 |

* **Manual read:** no invented capability, count or saving remains. Two replies say «تدفع فقط مقابل ما يُسلَّم»; that is accurate. The minimum raises the job's unit (`missionPricing.ts` `priceByRule`), a partial delivery pays `ceil(delivered × job unit)`, and nothing is charged for zero rows.
* **Spend:** a separate budget folder capped at $0.15 for this round. Spent $0.0496 over 74 attempts (cumulative for all rounds: $0.0880 + $0.0496 = $0.1376).

## Not changed (owner decision): what a unit of the price is

The price counts every delivered item of every step. That is the approved contract (`missionPricing.ts`):

* reserve = max(minimum, ceil(items × rule unit × 1.15));
* job unit = max(rule unit, minimum ÷ items);
* charge = ceil(delivered × job unit), never above the reserve, and 0 for nothing delivered.

 So 20 companies with 12 contact rows is 32 units. The card now says so; the contact rows are no longer called companies anywhere. Making the company the unit needs a financial change and is set out, not applied, in `docs/proposals/per-company-unit.md`.

## Not verified

* **Authenticated customer journey and a real delivery:** the session has no test-account login (see the final report). No mission was approved and no point was spent.
