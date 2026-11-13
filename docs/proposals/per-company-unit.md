# Proposal (owner decision, NOT applied): price a companies plan per company

**Status:** proposal only. Nothing in this file is implemented. It changes the billable unit, so it needs the owner's explicit financial authorization before any code or SQL is touched.

## Today (approved contract, unchanged)

* **The unit is every delivered item of every delivered step** (`missionPricing.ts`, `price.ts`, `settle_job_atomic` via `delivered_units`).
* **13 Nov plan:** 20 companies plus the contact rows of about 12 of them = 32 units at 10.144 points.
  * Most it can charge: 325 points; hold: 374.
  * A delivery of 19 companies and 11 contact rows is charged `ceil(30 × 10.144…)` = 305.
* **Since round 58 the customer sees this plainly:**
  * the card says «٢٠ شركة» and «والمجموع ٣٢ عنصرًا محسوبًا في السعر، وعدد الشركات فيها ٢٠ فقط»;
  * the contact rows are never called companies.

## The option

For a plan with one top step of companies and steps that only describe them, the unit becomes the delivered company:

* `volume` = the companies step's planned rows (not the sum of steps);
* `costPerRowUsd` = the plan's whole measured cost ÷ planned companies, so the contacts' cost is inside the company's price;
* `delivered_units` = companies delivered (the contact rows are not counted);
* reserve, minimum and cap rules are unchanged in form.

## What it touches (each line is a money line)

* `src/lib/agentMission/price.ts` / `plan.ts` (`stagePriceInputs`, `deliveredRows`): the volume and the cost per unit.
* `agent/src/runMission.ts` settlement: `delivered_units` for such plans.
* `settle_job_atomic` is unchanged: it charges `ceil(delivered × unit) ≤ reserve`. Only the number passed changes.
* Card, notice, wallet line and file sentences: the unit noun becomes «شركة» for these plans.
* Tests: the money assertions of every companies replay (G1/G2 and the people worlds) and the byte-identical digests (ledger section) change by design.

## Effect, worked on the 13 Nov plan

* Same measured cost, 20 units: unit ≈ 16.2 points, most charged ≈ 325, hold ≈ 374. The full-delivery price is the same.
* What changes is the partial delivery. 19 companies with 11 contact rows:
  * per company: ≈ 309;
  * per item (today): 305.
* A company with no published contacts costs the customer the same as one with contacts.

## Risks

* A company with no contacts is billed at the full company price, though nothing was found for it.
* Mixed plans (companies and their people) need a rule for when people are the requested unit.
* Every historical mission keeps its stored unit, so the two kinds must never be compared in one report without saying which.

## Decision needed

Keep per item (as now, explained on the card) or move companies plans to per company. If the latter, a separate PR with the money tests changed on purpose, reviewed line by line.
