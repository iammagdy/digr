# Platform Display Preservation, Judge Diagnostics, and Minimum Price Card (DT-20261123-x-account-rumors r7)

Task: DT-20261123-x-account-rumors r7 (Platform Display Names, Admin Judge Diagnostics, Plumbing Safety, Price Card Minimum Display).
Branch: `team/DT-20261123-x-account-rumors-r7` from `origin/main` (`57b1a97a`).
Architect: نفادي (DIGER ARCHITECT-2) with Commander Binding Amendments.
Order: الكبير (msg `2b5555f5-1734-47c0-8373-0317b956e794`).
Independent Reviews:
- أشرف (BUG HUNTER-2): Gate 1 on Groups A + B.2 + B.3 (`/srv/diger-team/bughunter2/work/DT-20261123-x-account-rumors-r7-gate1.md`).
- فزاع (BUG HUNTER): Gate 1 on Group B.4 (`/srv/diger-team/bughunter/work/DT-20261123-x-rumors-r7-G1.md`).

---

## 1. Summary of Changes

### Group A: Universal Platform Display Name Preservation (Non-Money)
- **Problem:** When internal platform names were generated (e.g. «في إكس»), `withoutUnwrittenLabels` in `guardViewText` replaced them with neutral «المصدر» because the customer didn't explicitly type the platform name.
- **Solution:** Arabic platform display names (`إكس`, `فيسبوك`, `تيك توك`, `إنستجرام`, `يوتيوب`, `لينكدإن`, `خرائط جوجل`, `أخبار جوجل`) are product information that the customer must see to make informed choices.
  - In `src/lib/agentMission/customerView.ts`: Removed label masking choke point in `guardViewText` (`const t = t0;`), removed `withoutUnwrittenLabels` import.
  - In `src/lib/agentMission/shownWords.ts`: Deprecated `withoutUnwrittenLabels` to a direct pass-through.
  - In `agent/src/llmPlanner/planner.ts`: Simplified `platformAr` to always return the Arabic platform display name; simplified `customerSafe` and cleaned up dead `allowPlatformNames` call sites.
  - Internal endpoint IDs (`anyapi.x.search.posts`, `apify`, etc.) and unwritten Latin words remain strictly blocked by `foreignLatinIn`.

### Group B.1: Amendment 1 — Deferred to TREG P3 (Point 3.2)
- **Status:** Deferred to TREG Playbook Phase 3 point 3.2 (`timelineScanner.ts`).
- **Rationale:** Deep account reading requires the P3 timeline scanner engine. The scout guard in r7 remains completely untouched.

### Group B.2: Admin Inspector Judged Rows Diagnostics & Generic Criterion Contract
- **Problem:** QA and developers lacked per-row visibility into the judge's input, criterion, verdict, or reason. Moreover, hardcoding customer words, regexes, or word lists violates D-0086 / D-0198.
- **Solution:**
  - In `agent/src/runMission.ts`: Exported `JudgedRowDiagnostic` interface with `{ entity: string; country: string; topic: string; brief?: string }`. In `recordChecks`, collected all judged row decisions for stages with `judge === "model"` and persisted to `admin/judge_diagnostics.json` in storage bucket `agent-missions` (`AGENT_BUCKET`). If any criterion field is missing, it stays empty (`""`) and `brief` is provided instead—never defaulting to any hardcoded ministry or country.
  - In `src/lib/server/adminMissionInspector.ts`: In `loadInspection`, safely read `admin/judge_diagnostics.json`, redacted all strings with `redactText`, and exposed under `judgedRows: Array<{ title: string; url: string | null; criterion: string; verdict: 1 | 0; reason: string }>`. Enforced `assertNoSecrets(body)` to guarantee zero secrets or customer PII leakage.
  - In `src/lib/agentMission/foundation/compilePlan.ts`: Generic derivation of `criterion: { entity, country, topic, brief }` directly from the model's structured step output (`s.entity`, `s.country`, `s.topic`, `u.understanding_ar`) or `Ask`, with zero word lists, zero regexes, and zero hardcoded domain strings.
  - In `agent/src/llmPlanner/prompts.ts` and `planner.ts`: Added `entity` to `UnderstoodStep` and `UNDERSTAND_SCHEMA` so the LLM populates it directly from customer messages.

### Group B.3: Deterministic Plumbing Tests & Safe Model Judge Exclusion
- **Problem:** If a model judge failed or unreviewed rows remained, legacy fallback paths could deliver unjudged rows to the customer.
- **Solution:**
  - In `agent/src/items/ingest.ts`: For any stage where `stage.relevance?.judge === "model"`, candidate rows are never accepted by keyword rule matching (`by: "rule"`), and unreviewed or failed review rows (`reviewStop === "failed"`) are marked `state: "excluded"`, `reason: "review_failed"` and never delivered as matched items.
  - In `tests/x-account-rumors-replay.test.ts`:
    - Test (a): R6 stage fixture carries model-produced entity, country, and topic.
    - Test (b): Generic request (e.g. Egyptian telecom company) carries its own criterion without R6 coupling.
    - Test (c): Missing fields stay empty and pass brief without default values.
    - Real R6 fixture data (`okaz.com.sa` Row 1, `youlyou.com` Row 2) verifies exclusion of non-qualifying rows (`review_no`) and unreviewed rows on failure (`review_failed`).

### Group B.4: Price Card Minimum Charge Display (Megz D-0196) — Tier A Review
- **Problem:** When delivered rows cost less than `min_charge_points`, the card did not explain the minimum charge before customer approval.
- **Solution:**
  - In `src/lib/agentMission/customerView.ts`:
    - `headlineCountArOf`: When `min_charge_points > 0` and delivered rows at unit price would cost less than `min_charge_points`, plain Arabic headline displays `هتستلم [عدد] [عنصر]، والحد الأدنى للطلب [نقطة]`.
    - Counter-case: When delivered rows meet or exceed the minimum charge, standard count is displayed without the minimum charge note.
    - Widening options are sorted first in shortfall questions when minimum charge applies.
  - Zero modifications to settlement math, pricing calculations, holds, or wallet balances.

---

## 2. Test Verification Matrix

| Suite | Tests Passed | Status |
| :--- | :--- | :--- |
| `tests/x-account-rumors-replay.test.ts` | 31/31 | PASSED |
| `tests/dt09-leaks.test.ts` | 14/14 | PASSED |
| `tests/dt09-fix1-card.test.ts` | 12/12 | PASSED |
| **Total Targeted Suites** | **57/57** | **ALL GREEN** |
