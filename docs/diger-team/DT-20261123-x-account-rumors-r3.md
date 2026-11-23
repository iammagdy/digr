# LLM Planner Breadth-First Probing, Timeline Paging & Quality Fixes (DT-20261123-x-account-rumors r3)

Task: DT-20261123-x-account-rumors r3 (Non-money, LLM planning / execution quality).
Branch: `team/DT-20261123-x-account-rumors-r3` from `origin/main` (`d3260770`).
Steps & Patch: `/srv/diger-team/architect2/work/x-rumors-r3.patch` by نفادي.
Order: الكبير (msg `1c573344-af25-4a40-b239-d83d823f85e7`).

## Live r2 Root Cause

Following the deployment of r2 (`d3260770`), live testing revealed remaining planner quality gaps:
1. **Probe Budget Exhaustion on Single-Endpoint Phrasings:** In r2, candidate probing concentrated on query phrasings of a single candidate endpoint rather than exploring breadth-first across diverse endpoints and providers.
2. **Missing Multi-Page Timeline Paging under Topic Judge:** When page 1 of an account timeline contained zero topic matches (e.g., recent daily routine announcements), the probe stopped immediately and treated the step as dry, rather than following pagination cursors across the time window to evaluate subsequent pages with the model judge.
3. **Un-decremented Failed Candidate Probe Budget:** In `planner.ts:762-767`, failed or empty candidate probes did not decrement `altBudgetLeft`, leading to probe budget runaway across candidates.
4. **Platform Name Masking in Clarification Options:** Clarification questions with dynamic widening options had Arabic platform names (such as فيسبوك، تيك توك، يوتيوب) sanitized by `customerSafe` into the generic word «المصدر» because they were not explicitly written in the user's initial query.

## What Changes in r3

1. **Breadth-First Candidate Probing:**
   - Candidate parsing (`checkOptions`) accepts up to 8 candidate endpoints from `tool_choice`, prioritizing provider and capability diversity across the catalog.
2. **Strict Candidate Probe Budgeting with Failed Decrement:**
   - Each candidate is probed with `{ left: Math.min(altBudgetLeft, 2) }`.
   - On candidate failure, refusal, or empty return, `altBudgetLeft` decrements by the actual calls made (`Math.max(1, startLeft - budgetForCandidate.left)`), bounding total planning latency and external calls.
3. **Timeline Paging with Model Judge:**
   - If an account timeline endpoint yields zero topic matches on its first page, the planner advances through pagination (`has_more`, `next_cursor`), evaluating sample rows with `judge_sample` until on-topic rows are proven or the budget is exhausted.
4. **Platform Name Preservation in Question Options:**
   - `customerSafe` accepts an option `{ allowPlatformNames: boolean }`.
   - Dynamic question options (`options_ar`) preserve Arabic platform labels (e.g., إكس، فيسبوك، تيك توك، يوتيوب) from `PLATFORM_AR` so customers receive clear, actionable widening suggestions.
5. **Arabic Platform Labels in Catalog Platform Index:**
   - `platformIndex` annotates platform headers with their Arabic display names from `PLATFORM_AR`, improving the model's awareness during plan and question generation.

## Verification

Full suite of planner-importing test files, catalog reach, regression guards, and TypeScript checks:
- All 31 test files importing `llmPlanner/planner.ts` or `catalogView.ts`
- `tests/release-text.test.ts`
- `tests/planner-web-and-engines.test.ts`
- `tests/flags-off-byte-identical.test.ts`
- `npm run agent:typecheck`
- `npx tsc -p tsconfig.json --noEmit`
