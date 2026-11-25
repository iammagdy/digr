# DT-20261125-wordlist-p4 — Phase 4: Schema Companies & B2B Understanding

## 1. Overview
- **Authority:** Megz `D-0211` / Commander `go-P4-hagras.md`
- **Branch:** `team/DT-20261125-wordlist-p4-schema-companies`
- **Base Commit:** `origin/main` `3317eca8` (including Phase 3 `77fb5bc1`)

## 2. Key Implementation Points
1. **P01 Terminal Unserved Path & L2 Exception Safety (`agent/src/runMission.ts`):**
   - In `runLlmPlanning` error/throw path (`r === null`), terminates cleanly into unserved branch without falling back to legacy planner.
   - For all non-`handed_over` terminations (`r.detail !== "handed_over"`), terminates with approved customer text:
     `«تعذّر تجهيز الخطة الآن ولم يُخصم منك شيء. ابعت طلبك تاني بعد شوية.»`
   - B2B handover (`r.detail === "handed_over"`) proceeds to dedicated B2B planning workflow with `planning_llm_usd` recorded.
   - Zero financial rows or transactions recorded on unserved paths.
2. **P02 Schema Guard Stability (`tests/planner-schema-guard.test.ts`):**
   - Verified schema properties remain at baseline `474a8f5f` ceiling (`total: 39, optional: 15`).
   - Zero schema growth.
3. **P03 Company Count Binding Rules (`agent/src/llmPlanner/planner.ts`):**
   - Rewrote `withCheckedCompaniesCount` using the strict 3-condition rule:
     (1) `companies_text` matches `countWrittenIn(message, cited)`;
     (2) `companies_text` and `per_company_text` are not identical spans and neither contains the other;
     (3) When `companies_count === per_company`, the number must be written twice (`writtenElsewhere`).
   - Preserves `isCountOfOtherNoun` (pure grammar check on people title) without reliance on `isPeopleNoun` or `sameNounStem`.
4. **P04 Organization Regex (`src/lib/agentMission/people.ts`):**
   - Maintained `!/شرك/.test(String(c.title_ar ?? ""))` unchanged per P4-d.
5. **P05 Compile Plan / Regex Scanner (`src/lib/agentMission/foundation/compilePlan.ts`):**
   - Maintained `/الردود/` regex intact per Commander L3 (`-0 ar` delta).
6. **P06 Production B2B Requests Real-Model Test (`tests/b2b-understanding-real-model.test.ts`):**
   - In-repo fixture `tests/fixtures/b2b-real-requests.json` holding 8 real production request texts with expectations.
   - CI-safe: skips gracefully when `ANTHROPIC_API_KEY` is not present.
   - Validated 5/5 loops with `handsOverToB2B(u)` true for requests 1–7 and false for request 8.
