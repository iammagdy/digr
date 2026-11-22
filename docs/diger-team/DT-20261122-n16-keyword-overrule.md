# Model Decision Authority & Removal of Keyword Overrules (DT-20261122-n16-keyword-overrule)

Task: DT-20261122-n16-keyword-overrule (Non-money, architecture / LLM routing per D-0086 / N16).
Branch: `team/DT-20261122-n16-keyword-overrule` from `origin/main` (`8d207ff2`).
Steps: `/srv/diger-team/architect2/work/n16-steps.md` by نفادي.
Gate 1 Review: GREEN by أشرف (`/srv/diger-team/bughunter2/work/n16-G1.md`).
Order: الكبير (msg `15a0a7e2-4d1d-46b8-89ff-5cbf8658196d`).

## Summary

This change removes the hardcoded keyword overrule mechanism and platform regex lists in `src/lib/agentMission/conversationModel.ts` and `src/lib/agentMission/messageType.ts`. Per D-0086, primary classification authority belongs to the LLM; code must never use regex or keyword matching to overrule the model's classification. Keyword rules now serve strictly as a fallback when the model call fails.

## Changes Implemented

1. **`src/lib/agentMission/conversationModel.ts`**:
   - Removed unused import `namesCollectibleData`.
   - Removed the `standalone` and `overruled` computation block that forced `type = "data_request"` over model decisions.
   - Restored `model_` decision object to pure model attributes without `{ overruled: true }`.

2. **`src/lib/agentMission/messageType.ts`**:
   - Removed platform names (`tiktok`, `تيك توك`, `انستجرام`, `فيسبوك`, `يوتيوب`, `twitter`, etc.) from `STRONG_NOUN_RE`.
   - Completely deleted `PLATFORM_NAME_RE`.
   - Updated `classifyMessage` fallback logic to no longer require `PLATFORM_NAME_RE`.

3. **`tests/helpers/chatCorpus.ts`**:
   - Added sample `["هات ٣٠٠ تغريدة عن محمد صلاح", "data_request"]` for chat model mock corpus.

4. **`tests/round22-chat-model.test.ts` & `tests/llm-quality-fixes.test.ts`**:
   - Updated test cases that previously asserted keyword overrides to assert model authority per D-0086.

5. **`tests/n16-keyword-overrule.test.ts` (NEW)**:
   - Added 5 comprehensive tests verifying model decision authority, platform handling without regex lists, keyword fallback upon model failure, and pricing/account counter-cases.

## Verification

- **Vitest Suites:**
  - `tests/n16-keyword-overrule.test.ts`: 5/5 passed
  - `tests/p0-x-account-contract.test.ts`: 34/34 passed
  - `tests/round22-chat-model.test.ts`: 153/153 passed
  - `tests/money7e-isolation.test.ts`: 36/36 passed
  - `tests/llm-quality-fixes.test.ts`: 50/50 passed
  - `tests/p0-x-literal-search.test.ts`: 22/22 passed
  - `tests/mission-13-replay.test.ts`: 13/13 passed
  - `tests/flags-off-byte-identical.test.ts`: 6/6 passed
  - `tests/stage3-flags-off.test.ts`: 2/2 passed
- **Design Grep:** Zero added regex/Set/array keyword or platform lists in `src/`.
- **Typecheck & Build:** Root `tsc --noEmit` and `npm run build` cleanly passed under `heavy.lock`.
