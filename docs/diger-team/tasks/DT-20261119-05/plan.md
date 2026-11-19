# DT-20261119-05 — the companies' count reaches the old path; «unserved» never replaces an estimate (Tier B, P0 live)

Plan v2 (Gate 1 YELLOW folded: /srv/diger-team/bughunter/work/DT-20261119-05-gate1.md). Base: main 74f76d2aecdcf26cddd0ef08f710895861706dd2. ORDER from الكبير. RCA: /srv/diger-team/bughunter/work/DT-20261119-01-rca-live2.md (F1, F2, must-pass 1-4, counter-cases a-f).
NEVER-TOUCH check (DIGER-TRUTH §7): no file below is on the list. No pricing, ledger, SQL, stage4, gateway or `text.ts` file changes. F1 prices through the EXISTING plan-check bound (plan.ts «bound»), not through any price rule. OWNER APPROVAL not required.
Customer-facing text: NONE added or changed (the new refusal sentence is for the planning model, English, never shown).
Files: 5 source + 2 test files = 7 (the ≤5 rule cannot hold: the count travels planner → hand-over → tool context → plan check; one concern).

## Problem (code, at 74f76d2a)
Live: «عايز شركتين صغيرتين في أسوان ومن كل شركة المديرين وإيميل وتليفون كل مدير» → card with 8 companies (price/hold for 8), no people stage.
1. The planner understood «2 companies», but the hand-over to the old agent path keeps only the PEOPLE part: `understoodPeopleOf` (childSources.ts:107) returns {noun_ar, parent_ar, per_parent, contact_kinds}; runMission.ts:556 passes only that.
2. The old path pins the customer's count with a CODE reader of the words: plan.ts:473 `bound0 = bindQuantityDetailed(…)`; plan.ts:517-526 forces expected_rows to it. The reader knows digits and number words next to a noun, NOT the dual «شركتين» (probe: null; with «٥ شركات» → 5). With no bound the agent's 8 becomes the target and the price.
3. The planner's own check handles the dual: the model cites its words in `people_of_companies.companies_text`; code checks they are in the message and say the number (`countWrittenIn`, numberWords.ts:145).
4. F2: plan.ts:821-838 accepts the model's «unserved» people reason once two serving sources were attempted, and never looks at `lookup.peopleEstimate` (DT-01): with an estimate available the agent may still declare the step unserved.

## Design (smallest change)
F1 — ONE validated number travels with the people hand-over. Binding rule (Gate 1 P1-1): the handed count is bound ONLY when the CITED words (`companies_text`) are in the customer's message, SAY n (`countWrittenIn(message, cited) === n`), contain a noun word (≥4 letters, not a number word) and count a noun that is NOT the people's (`isCountOfOtherNoun`, the planner's own positive test). The model's `total` is NOT a route (it can copy a year, «3M», a phone number or the per-company «٣ مديرين»). Digits and number words («٥ شركات») are already bound by the word reader (`bound0`); the handed count is needed for the dual. No people title (ask title and people step title both empty) → not bound (the people noun cannot be told from the companies' noun). A per-company number copied as the companies' count is rejected (`n === per && !writtenElsewhere`). Probed with the repo's own functions on 74f76d2a: live «شركتين» → 2; «٣ شركات» → 3; «اتنين شركات» → 2; cited 2010, «3M», a phone number, «٣ مديرين», «اتنين مديرين», a cited span not in the message → none; «٣ شركات ومن كل شركة ٣ مديرين» → 3.
- `Understanding.companies_count?: number` (planner.ts), set by code only (`withCheckedCompaniesCount`), after `withCheckedPerCompany`.
- `UnderstoodPeople.companies?: number` (childSources.ts) ← `understoodPeopleOf(steps, ask, companies?)`; carried in `ToolContext.understoodPeople` (tools.ts:118, passed whole to the plan lookup at tools.ts:719) and `PlanLookup.understoodPeople` (plan.ts:180).
- plan.ts: only when `bound0` is null and no per-source bound exists, the handed count is the bound of the companies stage (the root stage that has a stage under it, else the first root). `named:false` (delivery of stages unchanged). A count read from the words ALWAYS wins.
F2 —
(a) plan.ts: while `lookup.peopleEstimate` exists and the unserved step is a people step (`isPeopleNoun`), the reason is refused with the way out (the people stage with `measured_by: []` on one of the estimate's sources).
(b) Gate 1 + الكبير: tried = ATTEMPTED sources (answered or failed), as today; «answered» matters only for `works` (a source that gave rows). In the code that is ALREADY so (`endpointsCalled` gives rows only for `ok` calls), so (b) needs NO code change: it is pinned by a test (one source answered empty + the others failed + no estimate → accepted, honest card; the loop of v1's «answered only» rule is not introduced). Reported to الكبير: «count only answered calls» was dropped because it re-opens the no-card end; the corner (a) closes is the one that mattered (estimate available).

## Changes (order: types/helpers before callers; each step type-checks)
1. src/lib/agentMission/childSources.ts
   - line 105 `UnderstoodPeople`: add `companies?: number` with comment «the companies' count the planner understood and the customer's words support (DT-20261119-05); absent when none».
   - `understoodPeopleOf(steps, ask?, companies?: number | null)`: both `return {…}` objects get `...(typeof companies === "number" && Number.isInteger(companies) && companies >= 1 ? { companies } : {})` after `...extra`.
2. agent/src/llmPlanner/planner.ts
   - import line 14: add `tokensOf, wordNumbersIn` to the numberWords import (`isCountOfOtherNoun`, `writtenElsewhere`, `countWrittenIn` are already imported).
   - `Understanding` (line ~78): add `companies_count?: number` with the comment «the companies' count the customer's own words support, set by code (withCheckedCompaniesCount); never the model's total».
   - New exported function right after `withCheckedPerCompany` (algorithmic, so the body is given):
```ts
export function withCheckedCompaniesCount(u: Understanding, said: ReadonlyArray<string>): Understanding {
  const ask = u.people_of_companies;
  const peopleStep = u.steps.find((s) => s.parent !== null && isPeopleOfCompanyStep(s));
  if (ask?.asked !== true && !peopleStep) return u;
  const cited = ask?.companies_text ?? "";
  const title = ask?.title_ar || peopleStep?.title_ar || "";
  if (cited === "" || title === "") return u;
  const message = said.join("\n");
  const n = countWrittenIn(message, cited);
  if (n === null || n < 1) return u;
  if (!tokensOf(cited).some((t) => /^\p{L}{4,}$/u.test(t) && wordNumbersIn(t, 1).length === 0)) return u;
  if (!isCountOfOtherNoun(message, cited, n, title)) return u;
  const per = ask && ask.per_company !== null ? ask.per_company : (peopleStep?.count.per_parent ?? null);
  if (per !== null && n === per && !writtenElsewhere(message, ask?.per_company_text ?? "", n)) return u;
  return { ...u, companies_count: n };
}
```
   (a doc comment above it: why `total` is not a route, in 3-4 lines.)
   - `understandRequest`: compute `const said = customerSaidOf(input);` once; line 498 → `return { ok: true, value: withCheckedCompaniesCount(withCheckedPerCompany(withKeptPeopleAsk(checked.value, refusedAsk), said), said) };` the two `ask_refused` returns (lines 495-496) → `understanding: withCheckedCompaniesCount(refusedAsk, said)`.
3. agent/src/runMission.ts line 556 → `understoodPeople = understoodPeopleOf(r.understanding.steps, r.understanding.people_of_companies, r.understanding.companies_count);`
4. src/lib/agentMission/plan.ts
   - `PlanLookup.understoodPeople` type (line 180): add `companies?: number`.
   - F1, right after line 478 (`const bound = …`): turn it into `const bound = bound0 ?? (<the existing perSourceAsk expression, unchanged>) ?? (handedStage >= 0 ? { index: handedStage, value: handed!, named: false } : null);` with, before it: `const handed = lookup.understoodPeople?.companies ?? null;` `const rootIndexes = stagesIn.flatMap((st, i) => (isRecord(st) && (st.parent_key === null || st.parent_key === undefined || st.parent_key === "") ? [i] : []));` `const handedStage = handed === null ? -1 : (rootIndexes.find((i) => stagesIn.some((c) => isRecord(c) && c.parent_key === (stagesIn[i] as Record<string, unknown>).key)) ?? rootIndexes[0] ?? -1);` (+ a 3-line comment). Lines 517-526 are NOT touched: they pin the stage (the model's 8 becomes 2, `rowScale` scales the people stage; a reason-backed shorter target keeps its path = counter e).
   - F2(a): in the `missingAsks.forEach` block, FIRST thing inside it after `const serving = …` is computed or before it (anywhere before the `serving.length > 0` block): `if (reason && lookup.peopleEstimate !== undefined && isPeopleNoun(q.noun ?? "")) { issues.push(\`the step «${what}» is priced by an ESTIMATE and cannot be declared unserved: the people sources you sampled answered empty and the catalog still has sources for it. Add the people stage (parent_key = the companies' stage, deliver true, per_parent_rows ${q.value}) with measured_by [] and no sample_rows, endpoint_id one of ${lookup.peopleEstimate.endpointIds.slice(0, 6).join(", ")}, and drop unserved_steps for it\`); return; }`
   - F2(b): NO code change.
5. agent/src/tools.ts line 118 inline type: add `; companies?: number`. Nothing else.

## Tests (each written first; «fails on main» noted)
T1 `tests/dt-0119-05-companies-count.test.ts` (NEW). Copy `sequence`, `askAnswer`, `planAnswer`, `companiesStep`, `peopleStep`, `depsOf`, `understood()` from tests/dt-0119-04-people-ask-kept.test.ts (let `peopleAsk` take `companies_text`, `title_ar` «المديرين»). LIVE = «عايز شركتين صغيرتين ومن كل شركة المديرين وإيميل وتليفون كل مدير». Helper `U(steps, ask)` builds an Understanding.
 MUST BIND (fails on main: no export):
 a. LIVE, cited «شركتين» → `companies_count` 2 (also with total 8 written by the model, and with total null / steps [] / decision cannot).
 b. «عايز ٣ شركات ومن كل شركة المديرين», cited «٣ شركات» → 3; «اتنين شركات» → 2.
 c. «عايز ٣ شركات ومن كل شركة ٣ مديرين», cited «٣ شركات», per 3 with per_company_text «٣ مديرين» → 3 (written twice).
 MUST NOT BIND (Gate 1 P1-1; all `companies_count` undefined):
 d. a year: message «شركات تأسست من 2010 ومن كل شركة المديرين», model total 2010, cited «» → none; and cited «2010» → none.
 e. «3M»: message «شركات زي 3M ومن كل شركة المديرين», total 3, cited «» → none; cited «3M» → none.
 f. a phone number: message with «01001234567», total 1001234567, cited «» → none; cited the number → none.
 g. the per-company number: message «عايز شركات في أسوان ومن كل شركة ٣ مديرين», total 3, per_company null, cited «» → none; cited «٣ مديرين» → none. Cited «اتنين مديرين» (message «… ومن كل شركة اتنين مديرين») → none.
 h. cited not in the message («شركتان» for LIVE) → none; empty cited → none; no people ask and no people step → none (counter c); no people title anywhere (ask title «» and no people step) with cited «شركتين» → none.
 i. total 8 invented with cited «» for LIVE → none (must-pass 3).
 THROUGH THE PLANNER:
 j. `understandRequest` (scripted model, LIVE as words, plan answer with people asked and cited «شركتين») → `value.companies_count` 2 and `understoodPeopleOf(value.steps, value.people_of_companies, value.companies_count)` has `companies: 2`; first answer a refused ask (RCA5 flow) then a plan → still 2; ask refused twice → `understanding.companies_count` 2.
 k. `understoodPeopleOf(steps, ask)` and `(…, null)` and `(…, 0)` → `toEqual` today's shape (no `companies` key); with 2 → `companies: 2`.
 l. E2E (must-pass 1+2): copy `planFlow`, `answers`, `execution`, `world` from tests/dt-0119-01-estimate-card.test.ts; request = «عايز شركتين مصريتين في قطاع الكهروميكانيكا ومن كل شركة المديرين وإيميل وتليفون كل مدير»; the scripted understanding: companies `count.total: 2`, `companies_text: "شركتين"`, `title_ar: "المديرين"`; the model's propose_plan keeps `expected_rows: 5` for the companies → `companies.planned_rows` 2, reserve equals the run where the model wrote 2, the card text has no «٥ شركات»; control in the same file: `companies_text: ""` → the plan stays at what the model wrote (an unsupported count is never bound). [fails on main: planned_rows 5]
T2 `tests/people-step-implied.test.ts` (APPEND inside `describe("the plan check…")`, before line 158 `});`, using its local `companies`, `people`, `lookupOf`, `catalog`, `allowed`). `handed = (c?: number): PlanLookup => ({ ...lookupOf([["aviato.companies.employees", 2]]), requestText: LIVE, endpointCapability: (id) => catalog.byId.get(id)?.capability ?? null, understoodPeople: { noun_ar: "الأشخاص", parent_ar: "الشركات", per_parent: null, ...(c ? { companies: c } : {}) }, childStepSources: () => peopleSourcesForCompanies(catalog, allowed) })`.
 F1: 1) companies expected_rows 8 + people, `handed(2)`: ok, companies planned_rows 2, people planned_rows = 2 × per_parent_rows, deliveredRows consistent, reserve below the `handed()` run's; control `handed()`: companies planned_rows 8 (documents the old behaviour). [fails on main]  2) counter a: requestText «عايز ٥ شركات ومن كل شركة المديرين», expected_rows 8, `handed(2)` → 5.  3) live card shape: [companies expected_rows 8] + `unserved_steps` with two attempted calls of rows 0, `handed(2)` → ok, planned_rows 2, 1 unserved.  4) counter e: expected_rows 1 + valid `target_reason_ar` (no number), `handed(2)` → plan `quantity` = {requested 2, target 1, reason}.  5) counter d: requestText «عايز شركات ومن كل شركة المديرين», `handed()` → rows as written.  6) M19 two roots: stages [{ …companies, key: "other", title_ar: "عناصر أخرى", expected_rows: 3, deliver: false }, companies (8), people], `handed(2)` → companies planned_rows 2 AND "other" stays 3 (the bound goes to the root that has a child, not to index 0). If the plan check refuses this fixture, change the FIXTURE and say so; do not drop the test.  7) M18: companies stage given `deliver: false`, `handed(2)` → stage `deliver` is not changed by the bound (named:false). If the check forces delivery by another rule, prove it with the failing assertion text and report M18 as equivalent with that evidence.
 F2: 8) `peopleEstimate: { endpointIds: ["limadata.people.employees.search"], costPerPersonUsd: 0.0005, ceilingPersonUsd: 0.001 }` + understoodPeople + [companies] + unserved_steps + two attempted calls → NOT ok, issues match /priced by an ESTIMATE/ and contain that endpoint id; control without `peopleEstimate` → ok. [fails on main]  9) the loop corner: no estimate, `endpointsCalled` = two attempted people sources with rows 0 (one «answered empty», one «failed»: both are rows 0 in this map), → ok with 1 unserved (honest card, not a re-refusal); comment says why.  10) one attempted source only, no estimate → NOT ok (today's rule unchanged).
Targeted run (no whole suite): `npx vitest run tests/dt-0119-05-companies-count.test.ts tests/people-step-implied.test.ts tests/dt-0119-04-people-ask-kept.test.ts tests/dt-0119-03-no-question.test.ts tests/dt-0119-03-agent-no-ask.test.ts tests/dt-0119-01-estimate-card.test.ts tests/dt09-people-question.test.ts tests/dt08-people-of-companies.test.ts tests/dt08-fix2-people-count-card.test.ts tests/dt05-rca2-people-structure.test.ts tests/large-counts.test.ts tests/request-understanding.test.ts tests/understanding-vague.test.ts` (the first two are the files this PR edits/adds; the next eight are every file that references `understandRequest`, `withCheckedPerCompany` or `understoodPeopleOf` (large-counts, request-understanding, understanding-vague, dt05-rca2, dt08-people, dt08-fix2, dt-0119-03-no-question, dt-0119-04) plus the DT-01/DT-09/R2 files that share the people path), then `npx tsc --noEmit` (NODE_OPTIONS=--max-old-space-size=6144) and `npm run agent:typecheck`. GitHub CI runs the whole suite.
Fixtures that may deep-compare an Understanding and see `companies_count` (it appears only when the cited words hold a noun of ≥4 letters AND the message says it): the cards of tests/dt08-fix2-people-count-card.test.ts (lines 70, 83, 97, 126, 186, 190 cite «شركتين» with people asked) are the candidates; the others cite «٥»/empty or are direct `withCheckedPerCompany` calls (unchanged function). Expected: none breaks. If one `toEqual`s an Understanding/understoodPeople, add `companies_count`/`companies` to ITS expected value only (no assertion loosened) and list the file in the PR body.

## Mutants (each must fail at least one test; list the result in the PR body)
M1 skip `countWrittenIn`/use the model's total → d, e, f, i. M2 drop the noun-token test → d, e, f. M3 drop `isCountOfOtherNoun` → g. M4 drop the per-company guard (`n === per …`) → c/g with per filled. M5 drop the title requirement → h. M6 drop `hasPeople` guard → h. M7 `bound` = handed before `bound0` → T2-2. M8 `understoodPeopleOf` ignores `companies` → k. M9 runMission drops the 3rd argument → l. M10 an `ask_refused` return unwrapped → j. M11 F2(a) removed → 8. M12 F2(a) wrong endpoint ids in the hint → 8 (id asserted). M13 handedStage = always index 0 → 6. M14 `named:false` → `named:true` → 7 (or proven equivalent). M15 handed applied when `bound0` exists → 2. M16 a failed/attempted source stops counting as tried (the v1 loop) → 9. M17 F2(a) `isPeopleNoun` guard removed → NOT covered (a non-people unserved ask with an estimate present needs a two-ask request; rare; said in the PR body).

## Acceptance (QA)
1. Live sentence → card with 2 companies, price/hold from 2, nothing about 8; people stage or the honest «خطوة لم تُضَف…» block as before.
2. «٥ شركات + مديرين» stays 5. No number → the default and the «لم تحدد عدد» line; «عايز شركات» still gets one question. Company phones only: unchanged.
3. People source answered empty + model gives unserved → refused with the estimate hint, then the estimated card (DT-01). Sources that never answered → the honest unserved line stays.
4. RCA5 cases and DT-01's estimate card unchanged (their test files pass).

## Out of scope / next PRs
- P1-2 (Gate 1, existing gap): «عايز ٥ شركات … تعديل العميل: خليها شركتين» stays 5 (bound0 from the earlier text wins over the handed 2). Next PR: when the latest revision change holds a supported handed count, it wins over `bound0` from the earlier text.
- The dual-with-no-cited-words case (the model leaves `companies_text` empty): not bound, by design.
- Companies-only requests with a dual (no people → no hand-over); dual-noun morphology in quantity.ts; the source cross-check; RCA6; why the companies source gave no website; any pricing/ledger/SQL file.
## Not verified
Live model behaviour (does it fill `companies_text` for a dual); the stored plan of chat 62df…; rendered pages.
## Rollback
Revert the PR (no switch, no SQL).

## FIX1 (Gate 2 + QA)
The cited noun must match the COMPANIES' own noun (a word of the companies step's title, or the fixed label «الشركات» when the step has no usable title; ownTitleWords + sameNounStem, structural); the per-company guard was removed: after the noun check it was redundant, and in the only inputs where it fired (a per-company 2 the customer never wrote, with a correct «شركتين») it blocked a correct bind (proved on a grid of 3,959 combinations: every blocked case was a correct bind); two pins: understoodPeopleOf carries companies on the steps path; one answered-with-no-row + one failed people source and no estimate → the honest unserved card (through tools.ts endpointsCalled).
