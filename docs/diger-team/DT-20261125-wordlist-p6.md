# DT-20261125-wordlist-p6 — Phase 6: Multi-Turn Chat Model Direct Intent, Account/Trust Copy & Safe Fallback

## 1. Overview
- **Authority:** Megz `D-0211` / Commander `go-P6-hagras.md` & `order-O12-ashraf-gate1-p5b-p6.md` (M1–M4) / Bug Hunter-2 أشرف Gate 1 GREEN (`/srv/diger-team/bughunter2/work/DT-20261125-wordlist-wave2-gate1-p5b-p6.md`)
- **Branch:** `team/DT-20261125-wordlist-p6-chat-turn`
- **Base Commit:** `origin/main` `4df9ffa9` (PR #687 Phase 5B)
- **Preceding PR Links:** [PR #686](https://github.com/iammagdy/digr/pull/686) (Phase 4) and [PR #687](https://github.com/iammagdy/digr/pull/687) (Phase 5B)
- **Current PR Link:** [PR #689](https://github.com/iammagdy/digr/pull/689) (Draft)

## 2. Scope & Shrunk Implementation Points

1. **Shrunk Scope & Restoration of `openPlanFacts.ts`:**
   - Following Commander's review and design check, `src/lib/agentMission/openPlanFacts.ts` was restored **verbatim to `origin/main`** (`git diff origin/main -- src/lib/agentMission/openPlanFacts.ts` is empty).
   - The removal of `KINDS`, `isExplicitCancel`, and `refersToOpenRequest` readers is **deferred** to a dedicated future task (requires joint model intent + code-validated cancel flow to prevent customer cancellation loops).
   - In `src/lib/agentMission/guardRules.ts`: eliminated `DATA_NOUN`, `CHANGE`, `NAME_OBJ`, `EMAIL_OBJ`, `PASSWORD_OBJ`, `DELETE_ASK`, `TOPUP_ASK`, `TOPUP_BARE`, `SHIPPING_CONTEXT`, `TRUST_BARE`, `TRUST_SELF`, `SUBJECT_OF`, `حسابات`, `تعليق|منشور`, `نسيت|ازاي` (-15 `arabic_regex`). Completely removed obsolete functions `accountTopicOf`, `isTrustQuestion`, and `preModelAnswer` (no empty stubs).
   - In `src/lib/agentMission/conversationModel.ts`: removed `EDIT_START` and `TIME_OR_PERCENT` (-2 `arabic_regex`).
   - Net elimination across Phase 6: **-17 `arabic_regex`**, **-0 `treg_tokens`**.

2. **LLM-First Chat Turn & Commander Invariants (M1–M4):**
   - **M1 (No Silent Defaults):** In `decideTurn`, if `account_topic` or `open_plan_question_kind` is absent or unknown, code strictly falls back to the model's guarded reply, else null. It never guesses `"name"` or `"price"`.
   - **M2 (Preserved Platform Tokens):** Tokens `"x"` and `"youtube"` remain intact in `conversationModel.ts:100` and `chatTurn.ts:835` (`-0 treg_tokens`).
   - **M3 (Explicit Intent & Model-Down Preservation):** Open plan cancellations (`cancel_open_request`) and edits (`edit_of_open_request`) strictly require the model's structured validated intent. Model failure (`keywordDecision`) returns `reply: null` without regex guessing, and in every open state the open plan is preserved with `OPEN_KEPT_AR` (or `PLAN_NOT_READY_AR`), never edited or cancelled.
   - **M4 (Pre-Model Filter Removed):** In `chatTurn.ts`, removed `preModelAnswer` keyword pre-filter. Account and trust intents route through `decideTurn`, where canonical approved copy is served by code (`accountAnswerAr(topic)` and `TRUST_REPLY_AR`).
   - **T4 Trade-off:** When the model is down and there is NO open plan, a message like «ممكن أغير اسمي في الحساب؟» falls back to `classifyMessage` (as main does); verified invariant: zero points held or charged.

3. **Multi-Turn Real-Model Harness (`scripts/verify-chat-turns-real-model.ts`):**
   - Implemented real-model CLI evaluation tool testing 38 verbatim turns across 5 runs (190 runs total):
     - 8 baseline open-plan turns (price facts, columns question, explicit cancel in dialect and English, flight cancellation counter-case, account password, trust, MOH handle request).
     - 14 additional account-topic turns (`name`, `email`, `password`, `delete`, `topup`).
     - 10 additional trust-question turns.
     - 6 research counter-cases from `tests/chat-prefilter-false-positives.test.ts`.
   - Evaluated on fixture `tests/fixtures/plan-ready-cfc0.json`: 100% PASS (5/5, 38/38 turns green).
   - Log recorded outside repository at `/srv/diger-team/fawaaly/work/DT-20261125-wordlist-p6-realmodel.log`.

4. **Allow-List Synchronization & Monotonic Ceiling:**
   - Synced via `npx tsx scripts/sync-design-guards-allow.ts --files src/lib/agentMission/guardRules.ts src/lib/agentMission/conversationModel.ts`.
   - `arabic_regex`: 1398 -> 1381 (-17)
   - `treg_tokens`: 503 -> 503 (-0)
   - Stale entries: 0
   - Updated `ALLOW_LIST_CEILING.arabic_regex` in `tests/design-guards-allow-monotonic.test.ts` to 1381; suite passes 2/2.
