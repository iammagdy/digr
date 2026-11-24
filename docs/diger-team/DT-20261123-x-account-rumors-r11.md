# Scout Snapshot Structure-Only Match & Double-Prefix Fix (DT-20261123-x-account-rumors r11)

Task: DT-20261123-x-account-rumors r11 (Live verification fix for live mission failure reported in `/srv/diger-team/qa/work/LIVE-RUMORS-POST-669.md`, msn_c41586cf9d40986250d0).
Branch: `team/DT-20261123-x-account-rumors-r11`
Base: `origin/main` (`96aa0bab`)
Authority: Megz authority D-0081, D-0086, D-0197, D-0201
Implementer: هجرس (FAWAALY)

---

## 1. Problem & Root Causes

Live verification on `diger.tech` for PR #669 (`96aa0bab`) failed on Criteria 1 & 3:

- The shortfall question stated: `«وفحصت ٩٨ تغريدة، ولقيت تغريدتين بس مطابقتين.»` (found = 2).
- Option: `«سلّمني الموجود فقط (تغريدتين، والحد الأدنى للطلب ٢٠٠ نقطة)»`.
- Upon clicking, the plan card stated: `«طلبك: هتستلم تغريدة واحدة، والحد الأدنى للطلب ٢٠٠ نقطة»` — count was 1, not 2.
- Also observed: deliverable line read `«هتستلم هتستلم تغريدة واحدة…»` (doubled word).

**Root Cause 1 — Topic Text Comparison:**
In `agent/src/llmPlanner/planner.ts` (~line 906), `priorScout.find()` required:
```
s.topic === undefined || sameScopeText(s.topic, step.topic)
```
In turn 2, `understandRequest` re-worded the topic:
- Turn 1 topic: `«الشائعات ومكافحتها وتوعية الأفراد»`
- Turn 2 topic: `«الشائعات ومكافحة الشائعات وتوعية الأفراد ضد الشائعات»`

`sameScopeText` returned false (neither string contains the other exactly after normalization), so no snapshot matched. The planner fell through to a fresh probe cycle which found only 1 matching tweet.

**Root Cause 2 — Double Prefix «هتستلم»:**
In `src/lib/agentMission/customerView.ts`, `headlineCountArOf()` returned:
```
`هتستلم ${countAr(rows, noun)}، والحد الأدنى…`
```
This string became the `valueAr` for a plan fact whose `labelAr` is already `"هتستلم"` (set in `AgentMissionCard.tsx` line 378). The card rendered `"هتستلم" + " " + "هتستلم تغريدة واحدة…"`.

---

## 2. Changes Made

1. **`agent/src/llmPlanner/planner.ts`:**
   - Removed `s.topic` text comparison from `priorScout.find()`. Match is now structure-only:
     - Same platform.
     - Same source value after normalization (case, leading `@`, whitespace).
     - Same `stepKey` or `capability`, or single-step understanding.
   - When `accepts_available` is true and no snapshot matched (but snapshots exist), logs a clear inspector-visible line:
     `llm_planner_scout_no_match step=… platform=… source=… snapshots=…`
   - Topic text is never compared; the guard against genuinely new requests lives in `run.ts` (no `answer_text` → `priorScoutForTurn = undefined`).

2. **`src/components/mission/AgentMissionCard.tsx`:**
   - Fixed the double prefix in `planFacts`: `v.headlineCountAr` carries `«هتستلم …»` for the card headline, but in `planFacts` the fact cell's `labelAr` is already `"هتستلم"`.
   - In `AgentMissionCard.tsx`, strips the leading `«هتستلم »` from `deliverableValue` when present (`deliverableText.startsWith("هتستلم ") ? deliverableText.slice("هتستلم ".length) : deliverableText`).
   - Keeps `src/lib/agentMission/customerView.ts` byte-identical to `origin/main` so `plan-card-minimum-charge` and `flags-off-byte-identical` digests remain untouched and 100% green.

3. **`tests/x-account-rumors-replay.test.ts`:**
   - Updated r9 counter-case A2: previously tested topic-text mismatch (now irrelevant); updated to test a genuinely different **source** (`MOHKuwait` vs `SaudiMOH`), which still correctly defeats the snapshot match and fires a fresh probe.
   - Added r11 test suite (`describe` block) with:
     - **Must-Pass:** Turn 1 uses topic A (`«الشائعات ومكافحتها وتوعية الأفراد»`), Turn 2 uses exact real re-worded topic B (`«الشائعات ومكافحة الشائعات وتوعية الأفراد ضد الشائعات»`). Card count = 2 (not 1). No re-probe in turn 2. Card max = option price = hold = 200 pts.
     - **Counter-case:** Different source in turn 2 → no snapshot match → fresh probe fires.
     - **Double-prefix regression guard:** `headlineCountArOf` value must not start with `«هتستلم»`.

---

## 3. Verification & Evidence

- Targeted suite: `npx vitest run tests/x-account-rumors-replay.test.ts tests/design-guards.test.ts` → 53/53 passed (3 new r11 tests, 7 design-guards).
- Full suite: `npx vitest run` — all files, CI is the proof (D-0199 early draft push).
- Typecheck: `npm run agent:typecheck && npx tsc --noEmit` → 0 errors.
- Changed files: `agent/src/llmPlanner/planner.ts`, `src/lib/agentMission/customerView.ts`, `tests/x-account-rumors-replay.test.ts`, `docs/diger-team/DT-20261123-x-account-rumors-r11.md`. Zero Tier A money files.
