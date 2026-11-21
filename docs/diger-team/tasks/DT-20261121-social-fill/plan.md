# DT-20261121-social-fill Plan (D-0166)

## Overview & Background
Address social comment collection and multi-option planner issues for Facebook and YouTube under decision D-0166 (non-money, v4 narrow restore per Commander order):
1. **TikTok Scope Exclusion (D-0166):** TikTok pooling across parents remains strictly out of scope. Capped plans deliver 237, bill for 237 only at listed rate, with 0 extra parent calls.
2. **YouTube Terminal Empty Wrapper:** Endpoints returning `{ code: 200, data: { comments: null, continuation_token: null } }` are properly recognized as empty list responses (`rows: []`, `listStrategy: "list_path"`, `hasMore: false`) rather than misidentified as single-record objects.
3. **Multi-Option Probe Budgeting:** When multiple candidate endpoints exist, budget child option attempts evenly in `probeStep` so 3rd ranked tools are evaluated when prior tools return empty or terminal responses.
4. **Facebook Parent Continuation (Schedule-Gated):** When a total-only comment request (`fill_total_across_parents === true` and `per_parent_rows === undefined`) does not reach the planned volume from initial parents, `expandNextParent` fetches additional parent pages within the approved `executionFundingSchedule` and ledger caps. Numeric `per_parent_rows` plans (even with stale fill flags) execute 0 expansion calls.

## Implemented Points
- **Point 1 (`data/capabilities/provider-metadata.json`):** Added `nilMarkerPath: "data"` and `terminalFlag: { "path": "code", "equals": 200 }` to `tikhub.youtube.video.comments.missionPage`.
- **Point 2 (`src/lib/treg/shapeReader.ts`):** Added `terminalFlag` to `MissionPageMetadata` and introduced `evaluateReviewedPage` helper wired into `readList` and `readCursor`.
- **Point 3 (`src/lib/modelPlanner/digest.ts`):** Added `missionPageOf` lookup to `buildShapeDigest`, guarding `looksLikeOneRecord` behind `!missionPage`.
- **Point 4 (`agent/src/llmPlanner/planner.ts`):** Budgeted child option attempts in `probeStep` by `Math.floor(budget.left / (options.length - optIdx))` when `options.length > 2`.
- **Point 5 (`agent/src/items/ingest.ts`):** Added optional `targetRows` to `IngestOptions` for stage target calculation in `ingestLocked`.
- **Point 6 (`agent/src/engine/run.ts`):** Added `fundingSchedule` to `EngineDeps`, wired into `runEngine`, extracted `collectParentChildren`, and implemented `expandNextParent` gated strictly to `fill_total_across_parents === true && stage.per_parent_rows === undefined`.
- **Point 7 (`agent/src/runMission.ts`, `agent/src/stage2/liveSnapshot.ts`, `tests/stage2-live-equality.test.ts`):** Preserved expanded `deliver: false` parent rows using `s.deliver ? s.planned_rows : undefined`, and verified live snapshot vs workbook parity.
- **Point 8 (`tests/dt-20261121-social-fill.test.ts`):** Added comprehensive 14-test suite covering TikTok baseline replay, stale fill flag counter-cases, Facebook total-only expansion and exhaustion, funding/call limit bounds, YouTube terminal wrapper parsing, and multi-option probe budgeting.

## Verification
- Gate 1 cut check: GREEN (فزاع)
- All 14 tests in `tests/dt-20261121-social-fill.test.ts` pass cleanly.
