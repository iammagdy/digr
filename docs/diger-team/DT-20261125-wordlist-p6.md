# DT-20261125-wordlist-p6 — Phase 6: Multi-Turn Chat Model Direct Intent, Account/Trust Copy & Safe Fallback

## 1. Overview
- **Authority:** Megz `D-0211` / Commander `go-P6-hagras.md` & `order-O12-ashraf-gate1-p5b-p6.md` (M1–M4) / Bug Hunter-2 أشرف Gate 1 GREEN (`/srv/diger-team/bughunter2/work/DT-20261125-wordlist-wave2-gate1-p5b-p6.md`)
- **Branch:** `team/DT-20261125-wordlist-p6-chat-turn`
- **Base Commit:** `origin/main` `4df9ffa9` (PR #687 Phase 5B)
- **Preceding PR Links:** [PR #686](https://github.com/iammagdy/digr/pull/686) (Phase 4) and [PR #687](https://github.com/iammagdy/digr/pull/687) (Phase 5B)
- **Current PR Link:** *Pending Draft PR Creation*

## 2. Scope & Implementation Points

1. **Elimination of Wordlist Regexes (-29 `arabic_regex`):**
   - `src/lib/agentMission/guardRules.ts`: Dropped 15 Arabic keyword regexes (`DATA_NOUN`, `CHANGE`, `NAME_OBJ`, `EMAIL_OBJ`, `PASSWORD_OBJ`, `DELETE_ASK`, `TOPUP_ASK`, `TOPUP_BARE`, `SHIPPING_CONTEXT`, `TRUST_BARE`, `TRUST_SELF`, `SUBJECT_OF`, `حسابات`, `تعليق|منشور`, `نسيت|ازاي`). Kept approved customer texts in `accountAnswerAr(topic)` and `TRUST_REPLY_AR`. Replaced keyword extractors with backwards-compatible stubs.
   - `src/lib/agentMission/openPlanFacts.ts`: Dropped 12 Arabic keyword regexes (`KINDS` × 7, `isExplicitCancel` × 3, `refersToOpenRequest` × 1, and count qualifier regex). Retained `planFollowUpAnswerAr`, `openPlanFactsOf`, and `unsupportedClaimIssues`.
   - `src/lib/agentMission/conversationModel.ts`: Dropped 2 regexes (`EDIT_START`, `TIME_OR_PERCENT`).

2. **LLM-First Chat Turn & Commander Corrections (M1–M4):**
   - **M1 (No Silent Defaults):** In `decideTurn`, if `account_topic` or `open_plan_question_kind` is absent or unknown, code strictly falls back to the model's guarded reply, else `OPEN_PLAN_FALLBACK_AR` / null. Never guesses `"name"` or `"price"`.
   - **M2 (Preserved Platform Tokens):** Tokens `"x"` and `"youtube"` remain intact in `conversationModel.ts:100` and `chatTurn.ts:835` (`-0 treg_tokens`).
   - **M3 (Explicit Intent for Plan Modifications):** Open plan cancellations (`cancel_open_request`) and edits (`edit_of_open_request`) strictly require the model's structured validated intent. Model failure (`keywordDecision`) defaults to `open_request_question` with `OPEN_PLAN_FALLBACK_AR` and never cancels or modifies an open plan.
   - **M4 (Pre-Model Keyword Filter Removed):** In `chatTurn.ts`, removed the pre-model keyword check (`preModelAnswer`), routing account and trust questions directly through `decideTurn` where canonical copy is served by code.

3. **Multi-Turn Real-Model Harness (`scripts/verify-chat-turns-real-model.ts`):**
   - Implemented real-model CLI evaluation tool testing 8 verbatim turns over 5 runs (40 turns total):
     1. Price facts question (`«طب التكلفة دي شاملة إيه بالظبط؟»`) -> PASS
     2. Columns question (`«إيه الأعمدة اللي هتكون في الملف؟»`) -> PASS
     3. Explicit cancel Arabic (`«طب لو سمحت كنسل الطلب ده خالص»`) -> PASS
     4. Explicit cancel English (`«cancel this request please»`) -> PASS
     5. Flight cancellation counter-case (`«عايز تغريدات عن إلغاء الرحلات الجوية وسعر التذاكر في السعودية»`) -> PASS (data_request)
     6. Account password question (`«كيف أغير كلمة المرور؟»`) -> PASS (account_question)
     7. Trust question (`«الموقع ده نصب ولا حقيقي وفلوسي مضمونة؟»`) -> PASS (trust_question)
     8. MOH handle account counter-case (`«عايز تغريدات حساب وزارة الصحة»`) -> PASS (data_request)
   - Evaluated on fixture `tests/fixtures/plan-ready-cfc0.json` copied from `/srv/diger-team/qa/work/e2e-fixtures/plan-ready-cfc0.json`.
   - Full 5/5 run completed with 100% PASS rate. Log saved at `/srv/diger-team/fawaaly/work/DT-20261125-wordlist-p6-realmodel.log`.

4. **Allow-List Policy Compliance:**
   - Allow-list was NOT synced prior to PR creation per Commander's explicit instruction (`allow-list sync only on my word`).
   - Design guards scan on current codebase passes without unexpected violations.
