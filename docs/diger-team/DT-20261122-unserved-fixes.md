# Non-Money Unserved Fixes (DT-20261122-unserved-fixes)

Task: DT-20261122-unserved-fixes (From Ashraf RCA `LIVE-unserved-RCA.md`, steps by نفادي `unserved-fixes-steps.md`, Gate 1 GREEN by أشرف `unserved-fixes-G1.md`, ordered by الكبير).
Branch: `team/DT-20261122-unserved-fixes` from `origin/main` (`58b41d3c0d35605812ab97d022813ff59316894d`).

## Summary of Changes

This task resolves root causes identified in live mission `msn_45713605a6be965d142b` (B2B SaaS software companies in Cairo) which completed as `unserved` with `0` delivered and no visible diagnostic explanation on the customer card:

### 1. Candidate Company Relevance Routing to Model Review (Fix 1)
- **Problem:**
  Candidate company names (e.g. "Breadfast", "Robusta", "Fawry") retrieved by search do not contain literal sector words like "برمجيات" or "software" in their titles. The rule-based pre-filter in `agent/src/companyPeopleRecovery.ts` rejected 100% of candidate companies with `status: "no_term"`, completely bypassing model review.
- **Root Cause:**
  `buildRelevanceSpec` for candidate company recovery lacked `entity: true`, and `text_columns` was hardcoded to `["name", "industry"]` instead of inspecting all available descriptive fields.
- **Fix:**
  - In `agent/src/companyPeopleRecovery.ts` (lines 816–828 and 1171–1183):
    - Added `entity: true` to the relevance spec so candidate companies without explicit query terms route to model review as `uncertain` instead of deterministic hard-exclusion.
    - Dynamically populated `text_columns` from existing non-empty candidate fields across `["name", "industry", "title", "description", "category", "about"]`.

### 2. English Filter Values via Prompt & Model-Proposed Broader Variant (Fix 2.2)
- **Problem:**
  The LLM planner issued structured B2B tool calls using Arabic filter values (e.g. `location: "القاهرة"`, `industry: "برمجيات"`), which returned 0 rows from English-indexed provider databases.
- **Root Cause & Architectural Decision:**
  Per Megz architectural decision D-0086, hardcoded code word maps are strictly forbidden. The model must be guided via prompt instructions to provide English filter values for B2B tools, and must be able to broaden parameters when an initial attempt returns 0 rows.
- **Fix:**
  - In `agent/src/llmPlanner/prompts.ts`:
    - Updated `TOOL_CHOICE_SYSTEM` with explicit instructions: structured B2B provider tools expect English filter values (e.g. "Cairo" / "Egypt", "Software" / "Technology" / "SaaS") unless notes state otherwise.
  - In `agent/src/llmPlanner/planner.ts`:
    - In `probeStep`, when an initial probe returns 0 rows and budget remains (`budget.left > 0 && !option.parent`), the planner invokes `propose_broader` via model call to propose a single broader variant (e.g., generalizing industry or country), executes one fallback probe, and logs the diagnostic step.

### 3. Preserving Honest Arabic Summary on Unserved Card (Fix 3)
- **Problem:**
  The live mission determined an honest diagnostic summary (`فحص التسليم راجع ٢٠ شركة مرشحة...`), but on the customer card it showed generic fallback text, and the summary was stripped.
- **Root Cause:**
  1. `summaryMatchesCardNumbers` in `src/lib/agentMission/customerView.ts` rejected any summary containing numbers that did not match `delivered`, `charged`, `reserved`, or `requested`. In an unserved mission with 0 delivered, a diagnostic count of inspected candidates (e.g. `20`) triggered a mismatch rejection.
  2. `AgentMissionCard.tsx` only rendered `resultSummaryAr` when `finished && !headlineAr`, and unserved cards did not render the summary if `phase === "unserved"`.
- **Fix:**
  - In `src/lib/agentMission/customerView.ts`:
    - For `phase === "unserved"`, allowed diagnostic counts while strictly verifying that delivery and charge numbers remain 0, preventing any hallucinated delivery claims.
  - In `src/components/mission/AgentMissionCard.tsx`:
    - Allowed `resultSummaryAr` rendering when `(finished || v.phase === "unserved") && !headlineAr && v.resultSummaryAr && v.resultSummaryAr !== v.endLineAr`.

---

## Verification

1. **Reproduction & Live Replay Tests:**
   - `tests/unserved-fixes-live-replay.test.ts` (5/5 passed):
     - Verified deterministic `no_term` exclusion reproduction without `entity: true`.
     - Verified candidate companies route to model review with `entity: true` and dynamic `text_columns`.
     - Verified English filter guidance in `TOOL_CHOICE_SYSTEM`.
     - Verified `summaryMatchesCardNumbers` accepts honest diagnostic count for `phase === "unserved"` while blocking hallucinated delivery counts.
     - Verified `AgentMissionCard` preserves and renders `resultSummaryAr` for unserved phase.

2. **Named Regression Suites:**
   - `tests/flags-off-byte-identical.test.ts`: 6/6 passed across all 5 pinned worlds.
   - `tests/zero-delivery-reason.test.ts`: 9/9 passed.
   - `tests/plan-editor-card.test.ts`: 8/8 passed.

3. **Typecheck & Build (under heavy.lock):**
   - `npm run agent:typecheck`: 0 errors (clean).
   - `tsc --noEmit`: 0 errors.
   - `npm run build`: 0 errors, static export generated cleanly.
