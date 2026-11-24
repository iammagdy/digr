# Unified Topic Decision, Honest Unspecified Count & Dead Widening Routes Guard (DT-20261123-x-account-rumors r8)

Task: DT-20261123-x-account-rumors r8 (Unified Judge for Planning & Execution, Honest Unspecified Count with Pre-Card Shortfall Question, Dead Routes Abandonment).
PR: #667 (branch `team/DT-20261123-x-account-rumors-r8`).
Base: `origin/main` (`00aba4cc`).
Architect: نفادي (DIGER ARCHITECT-2) with Commander Binding Amendments.
Plan Path: `/srv/diger-team/architect2/work/DT-20261123-x-account-rumors-r8-plan.md`
Implementer: هجرس (FAWAALY).
Authority: Night work D-0201, D-0081, D-0086, D-0198, D-0199.
Independent Reviews & Evidence:
- فزاع (BUG HUNTER — Money / Gate 2): VERDICT GREEN (`/srv/diger-team/bughunter/work/DT-20261123-x-account-rumors-r8-gate2.md`).
- أشرف (BUG HUNTER-2 — Non-Money / Gate 2): VERDICT GREEN (`/srv/diger-team/bughunter2/work/DT-20261124-x-account-rumors-r8-reconfirm-42957702.md`).
- مربوحة (QA): QA PASS 8/8 (`/srv/diger-team/qa/work/X-RUMORS-R8-QA.md`).
- الكبير (DIGER CTO): APPROVED.

---

## 1. Goal & Architecture Overview

Addressing the live mission failure on account timeline queries (where planning displayed 2 on-topic sample posts on the card, but execution rejected all 95 judged rows—including the same 2 sample posts—delivering 0):

1. **One Generic Judge for Planning and Execution:**
   - Replaced the hardcoded one-case prompt in `REVIEW_SYSTEM` with a 100% generic, topic-agnostic prompt (0 rumor or ministry examples, per D-0086 / D-0198).
   - Exported `formatJudgeRowText` in `agent/src/review.ts` formatting up to `AGENT_REVIEW_ROW_CHARS = 500` characters across key text fields (never truncating at 160 characters).
   - Unified `judgeSampleRows` in `agent/src/llmPlanner/planner.ts` to use the exact same `REVIEW_SYSTEM` + `reviewPrompt`.
   - Recorded planning-accepted row IDs on `stage.relevance.accepted_ids` so `ingest.ts` pre-accepts planning-approved rows at execution, guaranteeing parity (sample rows on the card are never rejected at execution).

2. **Honest Card Count & Pre-Card Shortfall Question:**
   - When the customer provides no count (`step.count.total === null`) and a timeline scan finds fewer on-topic rows than needed, planning no longer defaults to an arbitrary count (such as 20).
   - Planning emits an honest shortfall question (`res.kind === 'question'`, `res.scout === true`) before presenting any card.
   - Closed widening options are presented from catalog capabilities, each stating what it adds and its maximum points (e.g. deliver existing available, search whole platform, or add observed related accounts).
   - When delivering available, the card strictly sizes `planned_rows` to `timelineAcceptedCount` (e.g. 2, never 20 -> 0).

3. **Dead Routes Abandonment & Session Restriction Guard:**
   - Enforced `PLANNER_PROBE_TIMEOUT_MS = 30_000` (30 seconds) on planning probes.
   - Any endpoint that hangs or times out after 30s, or answers 5xx / 400-failed, is added to `refusedEndpoints`, never retried on `more_params`, allowing planning to advance immediately to the next catalog route.
   - Filtered out routes requiring missing sessions via `needsMissingSession` (checking declared required inputs and gateway `sessionRestriction`), avoiding calls to session-gated endpoints without credentials.

---

## 2. Changed Files

1. `agent/src/review.ts`: Replaced one-case `REVIEW_SYSTEM` with generic constraint/homonym/general-activity rules; exported `formatJudgeRowText` up to 500 chars.
2. `agent/src/items/ingest.ts`: Pre-accepts rows matching `stage.relevance.accepted_ids` (by: "model") without re-sending them to reviewer for rejection.
3. `agent/src/llmPlanner/planner.ts`: Unified judging using `REVIEW_SYSTEM` + `reviewPrompt`, recorded accepted IDs, triggered shortfall question on null count, extracted `observedRelatedAccounts`, passed code-priced options to `scoutQuestion`, enforced 30s timeout, and added `needsMissingSession`.
4. `tests/retrieval-state-machine.test.ts`: Updated `REVIEW_SYSTEM` assertions to verify generic prompt rules and zero hardcoded topic/entity words.
5. `tests/x-account-rumors-replay.test.ts`: Added Must-Pass cases 1–4 and counter-cases on real 98-row replay of `msn_8841e2aecc9989a391bf`.
*(Test updates for generic REVIEW_SYSTEM clauses: `tests/p0-research-query-retest3.test.ts`, `tests/p0-research-spec.test.ts`)*

---

## 3. Verification & Evidence Matrix

- **CI on Head 42957702:** GitHub Actions Run `45312148890` GREEN (Vitest SUCCESS, Typecheck SUCCESS).
- **Gate 2 Money (فزاع):** VERDICT GREEN (0 P0 blockers, card promise = hold = max points, minimum line preserved, social hold 752 pts invariant).
- **Gate 2 Non-Money (أشرف):** VERDICT GREEN (141/141 tests pass, 0 source modifications in fix commit, generic REVIEW_SYSTEM reconfirmed).
- **QA Verification (مربوحة):** QA PASS 8/8 on real 98-row replay (`msn_8841e2aecc9989a391bf`):
  1. One Judge Parity: PASS (Posts 1 & 2 preserved at execution, 96 off-topic rejected).
  2. Honest Count & Shortfall Question: PASS (Honest card sizing = 2, pre-card shortfall question asked).
  3. Dead Routes Abandonment: PASS (30s probe timeout, 5xx refuse, session-restricted endpoints filtered).
  4. Discrimination Against Off-Topic & Other Countries: PASS.
  5. All-On-Topic Account Timeline: PASS.
  6. Explicit Customer Count Invariant: PASS.
  7. Financial Invariance & Card Minimum Line: PASS.
  8. Social System Invariants & 752-Point Invariant: PASS.
