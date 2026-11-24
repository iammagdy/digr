# Scout Answer Snapshot Reuse, Free-Text Answer & Catalog Noun Honesty (DT-20261123-x-account-rumors r10)

Task: DT-20261123-x-account-rumors r10 (Live verification fix for live mission failure reported in `/srv/diger-team/qa/work/LIVE-RUMORS-POST-668.md`).
Branch: `team/DT-20261123-x-account-rumors-r10`
Base: `origin/main` (`924ed4d6`)
Authority: Megz authority D-0081, D-0086, D-0197, D-0201
Implementer: هجرس (FAWAALY)

---

## 1. Problem & Root Causes

Live verification on `diger.tech` for PR #668 (`924ed4d6`) failed on Criterion 1:
- The shortfall question asked: `«وفحصت ٥٩ تغريدة ولقيت تغريدتين بس مطابقين...»` and option `«سلّمني الموجود فقط (تغريدتين، والحد الأدنى للطلب ٢٠٠ نقطة)»`.
- Upon clicking the option button, the plan card stated: `«طلبك: هتستلم ٣ تغريدات، والحد الأدنى للطلب ٢٠٠ نقطة»`.
- **Root Cause (Snapshot Discard on Option Click):**
  - In `agent/src/llmPlanner/run.ts`, `answeredLastScoutThisTurn` required:
    `state.scoutSnapshot.every((s) => !s.requestText || s.requestText === latestRequestWord || s.requestText === mission.request_text)`
  - When the customer clicked the option button, `latestRequestWord` became the clicked option text, diverging from `s.requestText` (the original customer request text).
  - Consequently, `answeredLastScoutThisTurn` evaluated to `false`, discarding the snapshot and triggering a fresh planning probe/judge cycle that evaluated another sample and found 3 tweets instead of 2.
- **Wording Bug (Platform Noun Leaking into Web Route):**
  - The web/news widening route option in r9 displayed: `«أضف الأخبار وصفحات الويب العامة (يضيف حتى ١٠ تغريدات، بحد أقصى ٢٠٠ نقطة)»`.
  - In `planner.ts`, `webNoun` fell back to `noun` (the main request platform noun, i.e. tweets on X) because `itemNounFromCapability` had no case for `news` or `web`.

---

## 2. Changes Made

1. **`agent/src/llmPlanner/run.ts`:**
   - Redefined `answeredLastScoutThisTurn` to hold when:
     - The last asked item is a scout question (`last.scout === true`),
     - The question was unanswered (`last.answer === null`),
     - This turn carries the customer's answer (`answer !== null` from `mission.answer_text`), and
     - `state.scoutSnapshot` is present and non-empty.
   - Removed the `requestText` equality check entirely so option button clicks and free-text answers both cleanly reuse the snapshot.
   - Preserved snapshot lifecycle: single-use (cleared immediately after turn consumption) and cleared when a turn has no answer (new/edited requests plan fresh).

2. **`agent/src/llmPlanner/planner.ts`:**
   - Updated `webNoun` resolution to read `itemNounFromCapability(webStep.capability, webStep.platform) ?? knownItemNoun("خبر") ?? knownItemNoun("مقال") ?? GENERIC_ITEM_NOUN`.
   - Never falls back to the parent platform's noun (`noun`).

3. **`src/lib/agentMission/itemNoun.ts`:**
   - Extended `itemNounFromCapability` to map catalog capabilities and platforms to their correct Arabic item nouns:
     - `news` / `google_news` -> `خبر`
     - `articles` -> `مقال`
     - `web` / `serp` -> `مقال`
   - Preserved existing social post and company mappings without hardcoded word lists.

4. **`tests/x-account-rumors-replay.test.ts`:**
   - Added r10 test suite replaying the exact flow:
     - Question stating 2 found -> Click `take_found` -> Card states 2, card max == option price == hold (200 pts).
     - Counter-case 1: Free-text answer (`«خد اللي لقيته»`) reuses snapshot and yields card count = 2.
     - Counter-case 2: New request without answer clears snapshot and triggers fresh probe.
     - Widening noun check: web/news option says `مقالات` or `أخبار`, never `تغريدة`/`تغريدات`.

---

## 3. Verification & Evidence

- Full test suite: `npx vitest run tests/x-account-rumors-replay.test.ts` (43 passed).
- Design guards: `npx vitest run tests/design-guards.test.ts` (7 passed, 0 violations).
- Typecheck: `npm run agent:typecheck && npx tsc --noEmit` (0 errors).
