# DT-20261124-live672-fallback: Same-Feed Metadata Guard, Unique Examined Deduplication & Honest Widening Fallback

- **Task ID:** `DT-20261124-live672-fallback`
- **Decision:** `D-0204` (Megz approved as ONE PR) + `D-0202` (5/5 full-flow real-model replay gate)
- **Implementer:** هجرس (`FAWAALY` — brain files)
- **Base Commit:** `origin/main` (`e105cc9a1bf607ada242719f1bd3f4ac572c0d2f`)
- **Branch:** `team/DT-20261124-live672-fallback`
- **Scope:** 3 code files + 1 doc file (0 Tier A money files touched)

---

## 1. Problem & Root Causes (Live 672 Investigation)

During live full-flow runs of PR #672 on the `@SaudiMOH` rumors request:
1. **Redundant Same-Feed Probing:** After the first provider (`anyapi.x.user.posts`) probed 4 pages of the account timeline examining 78 tweets, `nextCandidates` tried a second provider of the exact same timeline (`tikhub.x.user.posts`), duplicating cost and time reading identical content.
2. **Double-Counted Examined Rows:** `totalExamined` simply accumulated `nextRows.length` across both providers, reporting 156 examined items instead of the 78 unique items.
3. **Rigid Scout Fallback:** When the model's scout response was rejected or unavailable, the fallback message had fixed wording that did not cite the unique examined count or recommend relevant widening options from the catalog.
4. **Number Guard vs. Option Prices:** Option prices were already stamped by code on options, but repeating or claiming customer targets required strict verification. Per الكبير's design amendment, the number guard allows examined (unique), found, sets, related-accounts count, and widening facts' `addable_rows` only (excluding prices from the message), rejecting unrequested customer targets (`«من ٢٠٠ طلبتهم»`) and foreign numbers.

---

## 2. Changes Made

### 1. `agent/src/llmPlanner/prompts.ts` (Phase 1)
- Updated `SCOUT_SYSTEM`:
  - Instructs the model to state the exact examined count from `facts.searches[].examined` when present.
  - Never invent a target count or say «طلبتهم» when the customer gave no count.
  - Recommends the best widening option from `facts.widening_options` for both `found > 0` and `found === 0`.
  - Tells the model never to repeat prices or write target counts the customer did not specify.

### 2. `agent/src/llmPlanner/planner.ts` (Phase 2)
- **Catalog-Only Same-Feed Detection:** Added `sourceParamValueOf` and `isSameSourceFeed(a, b, step)` to check matching `platform`, `capability`, and normalized source parameter value (e.g. handle) strictly using catalog metadata, with zero provider or endpoint name checks.
- **Candidate Filtering:** Filtered redundant same-feed options in `nextCandidates` while preserving fallback behavior when the first provider fails/empties/refuses, and allowing complementary capabilities (e.g. `x.search.posts`).
- **Unique Examined Deduplication:** Deduplicated `totalExamined` via `examinedKeys = new Set(sampleRows.map(rowKeyOf))` across primary and secondary pages.
- **Honest Fallback (`scoutFallbackAr`):** Updated fallback to include the unique examined count, source when known (`found === 0`), and ONE recommendation built from the first non-`take_found` widening fact (`label_ar`). Guarded `examinedClause` to print only when `examinedCount >= found`.
- **Amended Number Guard:** Allowed customer numbers, search findings (found, examined, sets, related-accounts), and widening facts' `addable_rows`. Rejected prices and foreign numbers from the message.

### 3. `tests/x-account-rumors-replay.test.ts` (Phase 3)
- Added `describe("DT-20261124-live672-fallback (D-0204): ...")`:
  - **Must-Pass 1:** Catalog metadata decides same-feed; skips 2nd provider after 4 pages (78 examined, never 156).
  - **Counter-Cases 1A & 1B:** When 1st provider fails, 2nd provider is tried; complementary search capability is allowed with deduplication.
  - **Must-Pass 2 & Counter-Case 2:** Guard allows `addable_rows` and actual search numbers, while rejecting prices (200) and foreign numbers (256).
  - **Must-Pass 3 & 3b:** `scoutFallbackAr` states unique examined count and recommendation from widening facts, and omits examined clause when `examinedCount < found`.

---

## 3. Verification & Evidence

- Targeted suites:
  - `tests/x-account-rumors-replay.test.ts`: 54/54 passed.
  - `tests/llm-first-planner.test.ts`: 36/36 passed.
  - `tests/retrieval-state-machine.test.ts`: 41/41 passed.
  - `tests/timeline-scan-acceptance.test.ts`: 4/4 passed.
  - `tests/dt09-leaks.test.ts`: 14/14 passed.
  - `tests/design-guards.test.ts`: 7/7 passed.
- Typecheck: `agent:typecheck` and `tsc --noEmit` clean (0 errors).
- D-0202 E2E Replay Gate (5/5 live runs on Anthropic):
  - 5/5 PASSED.
  - Count Parity: PASS.
  - Price & Hold Parity: PASS.
  - Code-Stamped Option Numbers: PASS.
  - Zero fallback lines / zero `llm_planner_scout_numbers`.
  - Log saved to `/tmp/e2e-674-live5.log`.
