# People-to-Company Binding & Runaway Paging Protection (DT-20261122-people-binding)

Task: DT-20261122-people-binding (Non-money, cost-protecting).
Branch: `team/DT-20261122-people-binding` from `origin/main` (`0775dc82`).
Steps: `/srv/diger-team/architect2/work/people-binding-steps.md` by نفادي.
Gate 1 Review: GREEN by أشرف (`/srv/diger-team/bughunter2/work/people-binding-G1.md`).
Order: الكبير (msg `546ec306-2046-467b-a01f-ba089782ba52`).

## Problem Summary

In live mission `msn_a3cb50bacff4aadf3b70` («مدير تسويق من كل شركة من ٣ شركات برمجيات في القاهرة»), the planner emitted a 2-step plan where step 2 (`blitzapi.people.search`) had `perItem: 1` but omitted a parameter reference binding to step 1 (`source: "prior_step"`).
1. `validatePlan` previously derived parents strictly from `refs.length > 0`. Because step 2 had no refs, it defaulted to `parents[1] = null` and was treated as an independent root step.
2. Because step 2 had token pagination (`cursor`), `runMissionChunk` executed 313 paid pages over 11 minutes searching for unconstrained people until budget exhaustion, delivering 0/3 people and rendering an empty unhelpful card.

## Changes Implemented

### 1. Child Entity & Parent Binding Validation (`src/lib/modelPlanner/`)
- In `types.ts`: Added `"missing_parent_binding"` to `ValidationIssue.code`.
- In `validate.ts`:
  - Exported `isChildEntity(child, parent)` using catalog metadata only (`entityOfEndpoint`), identifying `person` following `company` without keyword lists (strictly compliant with D-0086).
  - In `validatePlan`: Rejected non-root steps where `perItem > 0` or child entities lack a `prior_step` parameter binding with `issue("missing_parent_binding", ...)`.
  - Maintained full support for independent multi-root plans.

### 2. Runaway Paging Protection (`src/lib/modelPlanner/missionEngine.ts`)
- Added `BARREN_PAGES_LIMIT = 3` constant.
- Added `barrenPages` tracking counter to `StageState`. Increments on pages where provider returned rows but 0 rows passed relevance filtering; resets to 0 immediately when any row passes.
- When `barrenPages >= BARREN_PAGES_LIMIT`, halts the stage immediately with an honest Arabic explanation: `«توقفت مرحلة الجمع بعد توالي صفحات دون نتائج تطابق موضوع البحث.»`.

### 3. Customer Card Partial Delivery Honesty (`src/lib/agentMission/customerView.ts`)
- Allowed 0/candidate counts in `summaryMatchesCardNumbers` when `phase === "partial"` while strictly preventing fabricated numbers claiming > realDelivered or > realCharged.
- In `partialReasonAr`, inspected both `result` and `mission_note` events (extracting `textAr`), and provided a safe fallback: `«توقفت إحدى مراحل الجمع قبل استكمال العدد المطلوب بسبب استهلاك الحد المالي المخصص للطلب.»`.

---

## Verification

1. **Live Replay & Counter-Case Test Suite:**
   - `tests/people-binding-live-replay.test.ts` (9/9 passed):
     - `isChildEntity` correctly detects company -> person relationship.
     - Unbound child step with `perItem > 0` rejected.
     - Unbound people search after company search rejected.
     - Independent multi-root plans (e.g. news + videos) accepted without parent binding.
     - Properly bound people search (via `company_domain`) accepted.
     - Runaway paging halted at exactly 3 barren pages with `mission_stopped`.
     - Sparse matches reset counter and allow continuation.
     - Partial phase displays honest Arabic reason from `mission_note`.
     - Safe fallback rendered when no note event exists.
     - Hallucinated delivery numbers remain strictly blocked.

2. **Named Regression Suites:**
   - `tests/zero-delivery-reason.test.ts`: 9/9 passed.
   - `tests/model-planner-core.test.ts`: 26/26 passed.
   - `tests/plan-editor-card.test.ts`: 8/8 passed.
   - `tests/flags-off-byte-identical.test.ts`: 6/6 passed across all 5 pinned worlds.
   - `tests/stage3-flags-off.test.ts`: 2/2 passed.

3. **Compiler & Production Build:**
   - Root `tsc --noEmit`: 0 errors.
   - `npm run agent:typecheck`: 0 errors.
   - `npm run build`: 0 errors, static export clean, zero client bundle secrets.
