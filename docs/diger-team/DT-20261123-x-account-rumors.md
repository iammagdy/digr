# Multi-Strategy Source Discovery & Bounded 400 Rewrite (DT-20261123-x-account-rumors)

Task: DT-20261123-x-account-rumors (Non-money, LLM planner / catalog discovery).
Branch: `team/DT-20261123-x-account-rumors` from `origin/main`.
Steps & Reference: `/srv/diger-team/architect2/work/x-account-rumors-plan.md` & `/srv/diger-team/architect2/work/DT-20261123-x-account-rumors.patch` by نفادي.
Gate 1 Review: GREEN by أشرف (`/srv/diger-team/bughunter2/work/x-account-rumors-G1.md`).
Order: الكبير (msg `d4294af8-d555-4954-8aea-036c4be37b4e`).

## Customer Impact

In production missions such as `msn_a1c91e5e53cf9cd0feb8` (rumors query targeting Saudi Ministry of Health `@SaudiMOH`), the mission degraded due to provider failures and brittle planning:
1. The planner repeatedly re-asked the customer for the account handle even though `@SaudiMOH` was explicitly provided in the request.
2. When providers returned 400 bad_input (due to complex boolean OR queries) or transient errors (502, 429, `all_providers_failed`), the planner treated this as a shortfall / exhausted data rather than retrying or rewriting.
3. Clarification questions were open-ended and blamed the customer's handle rather than offering concrete widening options.

With this change:
- **Resilient Discovery:** The planner now exposes multi-strategy candidate tools (timeline/posts retrieval alongside search) for accounts with topics, allowing higher yield without relying on a single narrow keyword search.
- **Transient Error Resilience:** 502, 429, and `all_providers_failed` errors flag `transient: true` and avoid premature `exhausted: true`.
- **Bounded 1-Shot Rewrite:** HTTP 400 `bad_input` triggers a single bounded parameter rewrite (`budget.left -= 1`) rather than failing or aborting.
- **Zero Redundant Questions:** When a handle is already resolved in the request or prior answers, the planner never re-prompts the customer for the handle.
- **Concrete Widening Options:** Clarification questions offer 4 dynamic catalog-derived widening choices (more platforms, related topic phrasings, related accounts, or public discourse) rather than blaming the customer.

## The 4 Root Causes Addressed

1. **Provider failures and bad-input 400s counted as shortfall:**
   Transient errors (502, 429, 500, `all_providers_failed`) and bad-input 400s previously marked tools as exhausted or returned premature shortfalls. The planner now distinguishes transient network/provider failures from true data exhaustion and supports parameter rewrite on 400.

2. **Provider input syntax constraints (boolean OR queries):**
   Upstream providers (e.g. crawl4ai, tikhub) reject complex nested boolean queries without an authenticated session, returning 400 `bad_input`. The 1-shot rewrite simplifies the query to fit single-account/timeline constraints.

3. **Handle resolution ignored in clarification loop:**
   Extracted account handles were not maintained as resolved entities during the prompt/clarify loop, causing the planner to ask the customer to re-confirm or re-send the account handle. The planner now recognizes the resolved handle state.

4. **Narrow search-only strategy for account topics:**
   When a user wanted topics from an account, the catalog previously only favored search tools with keyword filters, which failed or returned 1 row. By including timeline/posts tools in candidate selection, the planner can retrieve recent posts from the account and allow the LLM to filter for relevance.

## Changes Implemented

- `agent/src/llmPlanner/catalogView.ts`: Candidate selection includes timeline/posts alongside search tools when an account handle is present.
- `agent/src/llmPlanner/planner.ts`: Added bounded 1-shot rewrite logic on 400, transient error handling, and resolved-handle checks.
- `agent/src/llmPlanner/prompts.ts`: Clarification prompt updated to generate concrete widening options based on available catalog tools.
- `tests/x-account-rumors-replay.test.ts`: Added replay test verifying the `@SaudiMOH` mission flow without redundant questions and with proper retry/candidate selection.
- `tests/llm-catalog-generality.test.ts`: Generality tests ensuring catalog view respects model authority without hardcoded platform strings.

## Verification

The 5 required test suites, TypeScript compilation, and agent typecheck were run:
- `tests/x-account-rumors-replay.test.ts`
- `tests/llm-catalog-generality.test.ts`
- `tests/p0-x-account-contract.test.ts`
- `tests/llm-first-planner.test.ts`
- `tests/flags-off-byte-identical.test.ts`
- `npm run agent:typecheck`
- `npx tsc --noEmit`
