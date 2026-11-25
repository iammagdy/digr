# DT-20261125-wordlist-p4 — Phase 4: Schema Companies & B2B Understanding

## 1. Overview
- **Authority:** Megz `D-0211` / Commander `go-P4-hagras.md` & `fix-P4-hagras.md`
- **Branch:** `team/DT-20261125-wordlist-p4-schema-companies`
- **Base Commit:** `origin/main` `3317eca8` (including Phase 3 `77fb5bc1`)

## 2. Scope & Implementation Points
1. **P01 Terminal Unserved Path & Exception Safety (`agent/src/runMission.ts`):**
   - Scope: Honest terminal status only.
   - In `runLlmPlanning` error/throw path (`r === null`), terminates cleanly into unserved branch without falling back to legacy planner.
   - For all non-`handed_over` terminations (`r.detail !== "handed_over"`), terminates with approved customer text:
     `«تعذّر تجهيز الخطة الآن ولم يُخصم منك شيء. ابعت طلبك تاني بعد شوية.»`
   - B2B handover (`r.detail === "handed_over"`) proceeds to dedicated B2B planning workflow with `planning_llm_usd` recorded.
   - Zero financial rows or transactions recorded on unserved paths.
2. **P02 Schema Guard Stability (`tests/planner-schema-guard.test.ts`):**
   - Verified schema properties remain at baseline `474a8f5f` ceiling (`total: 39, optional: 15`).
   - Zero schema growth.
3. **P03 Company Count Binding Rules Deferred (`agent/src/llmPlanner/planner.ts`):**
   - Restored `withCheckedCompaniesCount` and its imports in `agent/src/llmPlanner/planner.ts` EXACTLY as on `main` (`git diff origin/main -- agent/src/llmPlanner/planner.ts` is empty).
   - Reason: Preserves live fixes DT-20261119-05 FIX1/FIX2 pinned by `tests/dt-0119-05-companies-count.test.ts` (e.g. people citations like «٨ مديرين» or «٥٠ موظف» with generic title must not bind; same «شركتين» in both fields must bind).
   - Word-list removal for companies-count is deferred to a future LLM-structured design.
4. **P04 Organization Regex (`src/lib/agentMission/people.ts`):**
   - Maintained `!/شرك/.test(String(c.title_ar ?? ""))` unchanged per P4-d.
5. **P05 Compile Plan / Regex Scanner (`src/lib/agentMission/foundation/compilePlan.ts`):**
   - Maintained `/الردود/` regex intact per Commander L3 (`-0 ar` delta).
6. **P06 Production B2B Requests Real-Model Test (`tests/b2b-understanding-real-model.test.ts`):**
   - In-repo fixture `tests/fixtures/b2b-real-requests.json` holding 8 real production request texts with expectations.
   - CI-safe: skips gracefully when `ANTHROPIC_API_KEY` is not present.
   - Validated 5/5 loops with `handsOverToB2B(u)` true for requests 1–7 and false for request 8.
7. **P07 Allow-list Unchanged:**
   - Allow-list counts unchanged at `1398/597/0/2`.
8. **P08 Test Assertions Updated for Honest Terminal (`tests/dt-0119-03-no-question.test.ts`):**
   - In `P1-2: a model that keeps asking (ask_refused)`: updated old-path driver assertion to honest terminal (`mission.status === "unserved"`, `summary_ar` contains `«لم يُخصم منك شيء»`, no driver `ask_question`).
   - In `P1-3: a bad first answer then an ask-without-missing`: updated old-path driver assertion to honest terminal (`mission.status === "unserved"`, `summary_ar` contains `«لم يُخصم منك شيء»`, no driver `ask_question`).
   - In `the planner RAN but could not be read at all`: updated old-path driver assertion to honest terminal (`mission.status === "unserved"`, `summary_ar` contains `«لم يُخصم منك شيء»`, no driver `ask_question`).
