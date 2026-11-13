# Round 59: research credibility and execution cost safety (13 Nov 2026)

Production before this round: `d3e7c4f` (GitHub, Vercel, Heroku worker).

Evidence: the authenticated mission `msn_088cfef00f92a8ff1ea9`.
* 13 billable units delivered.
* Reserve 310, release 310, charge 195.
* Balance 3,086.

**No paid call was made in this round.** Everything below comes from recorded rows (read-only SQL) and offline tests.

## 1. Cost: why execution cost 4.1× the plan's provider estimate

Read from `mission_calls`, pinned in `tests/cost-audit-r59.test.ts` with `tests/fixtures/msn-088c-calls.json`.

* **Plan estimate:** $0.0229, one $0.00254 page per planned contact row.
* **Execution:** 40 calls, 37 paid, $0.09398.
* **Empty paid calls:** 16, costing $0.04064. Context.dev bills the page fetch whether or not the parser finds an e-mail or a phone. The record is correct (`cost_basis: reported`).
* **Failed calls:** 3 (unreachable sites), costing $0.
* **Repeats:**
  * No call repeated the same parser and page.
  * But 37 paid reads covered only **13 distinct pages**. 24 re-reads cost $0.06096: the same home or contact page was bought by `emails`, `phone-numbers`, `links` and then `scrape`.
  * The `parse_page` tool description itself prescribes one parser per call.
* **A company not delivered:** first-cosmetics.com, after the 9 companies were saved. 5 calls, $0.0127.
* **Cheaper valid alternative:** one read per page, with e-mails and phones taken from the saved text by code.
  * The same 13 pages would have cost $0.0330.
  * The 11 pages of delivered companies would have cost $0.0279.
* **Did a check fail open?**
  * Provider calls: **no.** The ceiling (40% of the hold's value, $0.2255) is checked before every call. It counts calls in flight and counts an unknown cost at its estimate.
  * But no code knows the owner's API authorization, and this mission's ceiling alone was above what was left of it.
* **Other gaps (documented, not changed):**
  * the model's execution budget is given per round (up to 3 × $0.10 per mission);
  * the SDK checks it after a turn;
  * website chat replies are not in `llm_usage`;
  * an unpriced catalog endpoint is budgeted at a flat $0.01.
* **Design of a hard pre-call gate:** `docs/proposals/execution-spend-gate.md`. It covers atomic durable reservations, an owner authorization ceiling, upper-bound reservations for uncertain cost, bounded retries, one paid fetch per page, no reads for unsaved parents, and one model budget per mission. **Not applied:** it needs a new SQL function and table, and a spending-authorization decision.

## 2. Data quality: deterministic company checks (applied, no money line)

`src/lib/agentMission/companyQuality.ts` works on a **copy** of the rows the file is written from. The settlement's rows are never touched. It removes, replaces or invents nothing.

* **Identity.** A company whose own description or LinkedIn page names another company is flagged «الهوية غير مؤكدة».
  * Live: BOBANA, whose description and LinkedIn name «vision cosmetics».
  * Live: yolo-cosmetics.com, whose description names «cosmotrade».
  * A side with no distinctive word («hk trade») proves nothing and is not flagged.
* **Name that is only a domain.** Said: «الاسم في المصدر هو عنوان الموقع فقط».
* **Unusable address.** «31.25» (no letters) is left out of the cell and said in the row and in the summary.
* **Place written twice.** «Giza Giza» is said once, in Arabic («الجيزة»). This is done both when a row is saved (`places.ts`) and for rows saved before this round.
* **Possible branch or copy.** The same site, or the same distinctive name, is flagged on the later row and never removed.
* **Missing contacts per company.** «لا توجد لها بيانات في «…»» on each company with no detail row (5 of 9 live).
* **Source links.**
  * The companies sheet has no source link per record. The data come from a company database, and the «website» is the company's site as stated, not a page the record was read from.
  * The file now says so. No link is invented.
* **What was not verified.** The summary states that consistency was checked but no company site was visited.

## 3. Delivery contract (what the customer reads)

* **Excel:** a «ملاحظات التحقق» column on the companies sheet, plus new lines in «حدود هذا التسليم»:
  * the uncertain identities by name;
  * the address left out;
  * no source link per record;
  * the consistency check without site visits.
* **CSV zip:** the same column and lines. It is derived from the Excel.
* **With the delivery:** a code-written line, «تنبيه عن جودة البيانات: هوية شركتين من ٩ غير مؤكدة … لم نحذف شيئًا ولم نستبدله…». It appears only when an identity is uncertain or a row may be a copy.
* **Unchanged:** billing, the delivered count, the count sentence («تم تسليم ١٣ من ١٨ عنصرًا…») and the settlement.

## 4. Tests

* `tests/company-quality-r59.test.ts` (14). It uses msn_088c's own delivered rows and plan, rebuilding the Excel and CSV package.
* `tests/cost-audit-r59.test.ts` (12). It covers the recorded calls, the empty paid calls, page re-reads, the orphan company, the estimate gap, the budget's fail-closed behaviour, the per-round model budget gap, and the gateway's handling of empty and repeated reads.
* **Re-pinned with notes:**
  * `flags-off-digests.json`: the workbook digests of g1/g2 only;
  * `stage3-flags-off.json`: the three file digests only.
  * Plan, rows, mission, ledger, notices and provider-call digests are unchanged.
  * `people-delivery-evidence.test.ts`: the limits row now carries the company-check lines.

## Owner decisions (not applied)

* The spend gate: SQL function and table, owner authorization ceiling, mission multiple, one paid fetch per page. See `docs/proposals/execution-spend-gate.md`.
* An honest per-page estimate moves customer prices, so it is a pricing decision.
* Per-company billing (`docs/proposals/per-company-unit.md`) and PDF pricing remain separate decisions.
