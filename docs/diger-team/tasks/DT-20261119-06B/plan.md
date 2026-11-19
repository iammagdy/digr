# DT-20261119-06 PART B — a delivered person is charged only if a contact the customer asked for reached the file (Tier A money, Megz D-0117, D-0118, D-0119, D-0126)

Plan source: /srv/diger-team/architect/work/DT-20261119-06-partB-plan.md (v3) and the Gate 1 / Gate 2 verdicts of فزاع. Base: origin/main (7e8cc484, rebased on the merge of DT-07 B). No SQL, no price, no hold change.

## Rule
When the customer asked for the contacts of the people (the plan carries person-level contact steps, one per asked kind), a DELIVERED person counts for the CHARGE only if a cell of an asked kind holds a value of the right SHAPE. The row is still delivered (file, delivered count and hold unchanged: «verification decides a cell, never a person»). Nothing asked → every named person is charged as today; companies-only and company-level contacts unchanged; the charge is never above today's.

## Settlement (no SQL)
`settle_job_atomic` charges `ceil(jobs.delivered_units × unit)` and `settle_job_by_stage_atomic` needs `base + estimated = jobs.delivered_units`. `runMission.settleExecution` hands the existing functions the BILLABLE count (`billableRows.billedUnits`), computed before `ensureOwned`, in a variable still named `stageCounts`.
- D-0126 (supersedes the card-minimum clause of D-0119): the customer pays ONLY for billable delivered rows, through the existing functions, and is never padded up to the 200-point minimum. A card of 2 rows at 100 points with 1 billable row delivered charges 100 (also when 2 are delivered and 1 is billable).
- No billable row → 0 units → nothing is charged, the whole hold is released, the file stays, the release reason is the honest sentence (`noBillableReasonAr`).
- The customer's line «لم يُحتسب عليك N من الأشخاص لأنه لم يظهر لهم …» is added before the final summary whenever delivered − billable > 0 (`unbilledLineAr`).

## One shape rule (D-0119: dates, ids and junk are not contacts)
`src/lib/agentMission/contactShape.ts`: `phoneShape` (a leading «+», «(» or digit, then digits and the separators a phone is written with, 7 to 15 digits, not a date or a decimal; an optional `tel:` scheme) and `emailShape` (one «@», a dot in the domain, no space, no «*»). It is applied (a) at ingest BEFORE a native contact cell is normalised (`agent/src/items/ingest.ts`: a date or a labelled id is never turned into a «phone» by digit-stripping) and (b) at settlement (`billableRows.hasContact`). Plain digits in a phone COLUMN are a phone by the column's provenance. After DT-07 B the engine's own `phoneShape` (contactFinders.ts) is this function (one rule).

## Screens that read the job row
The job's `delivered_units` is now the billable count and a delivery with nothing to charge marks the job `failed` (release). The customer's «طلباتي» list and the admin failure board read the MISSION's delivered count and status (`jobViewWithMission`; precedent walletLine.ts); an add-on row is never a research request (money7e fence).

## Files
Source: `src/lib/agentMission/billableRows.ts` (new), `src/lib/agentMission/contactShape.ts` (new), `agent/src/runMission.ts`, `agent/src/items/ingest.ts`, `src/lib/jobs/requestStatus.ts`, `src/lib/requests/buildIndex.ts`, `src/lib/server/failureBoard.ts`. Tests: `dt-0119-06-billable-rows`, `-billable-settle`, `-requests-list`, `-contact-shape` (new) and the guard fixtures the decision moves (listed in the PR body).

## Rollback
Revert the PR (no switch, no SQL; settled jobs keep what they were charged).
