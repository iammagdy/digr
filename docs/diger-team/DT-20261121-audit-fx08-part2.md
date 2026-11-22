# FX-08 Part 2: Pickup Gap & Universal Planning Restart (DT-20261121-audit-fx08-part2)

Task: DT-20261121-audit / FX-08 part 2 (Megz decision, Nafady specification in `/srv/diger-team/architect2/work/FX-08-part2-steps.md`, Ashraf G1 approval in `/srv/diger-team/bughunter2/work/FX-08-part2-G1.md`).
Branch: `team/DT-20261121-audit-fx08-part2` from `origin/main` (`74180326`).

## Summary of Changes

Addresses worker admission idle delays after mission completion and universalizes planning checkpoint/resume across all request types.

### 1. Worker Idle Recycle Condition (`agent/src/worker.ts`)
- Added `completedMissions = 0` counter inside `createWorker`.
- Incremented `completedMissions += 1` in `.finally()` handler upon mission completion.
- Updated `memoryBlocksAdmission()`: an idle worker (`active.size === 0`) above `AGENT_MEMORY_ADMIT_LIMIT_MB` now recycles after `recycleAfterMs` (2 minutes) once it has completed at least 1 mission (`completedMissions >= 1`), bypassing `recycleMinUptimeMs`.
- Fresh workers on boot (`completedMissions === 0`) still enforce `recycleMinUptimeMs` (15 minutes) to avoid restart loops.
- Active missions (`active.size > 0`) continue to block recycling unconditionally.

### 2. Universal Planning Checkpoint & Resume (`agent/src/runMission.ts`)
- Replaced `checkpointOn = socialRedesignActive(ctx)` with universal gate:
  `checkpointOn = (ctx.redesign !== undefined && anyRedesignFlag(ctx.redesign.flags, ctx.redesign.platformFlags)) || readCapabilityDiscoveryFlag(settings, mission.user_id);`
  Enabling planning state checkpointing (`planning_state.json`) and resume prompt injection for B2B requests (companies, people) under redesign or capability discovery flags.
- Deduplicated planning start system event text: emits `"استأنف الوكيل دراسة طلبك من حيث توقّف."` when `started.planningStarts > 1` instead of repeating `"بدأ الوكيل دراسة طلبك."`.
- Flags-off behavior remains 100% byte-for-byte identical (no state files written/read, normal start event emitted).

### 3. Test Suites & Verifications
- `tests/agent-stuck-mission-fix.test.ts`: Added test verifying idle worker recycling after 2 min 5s when `completedMissions >= 1`, claiming approved mission; added counter-case verifying active missions block recycling even after uptime elapsed.
- `tests/planning-resume.test.ts`: Added test verifying universal checkpointing and resume deduplication for non-social B2B requests, ensuring paid sample calls are not repeated on restart.
