# DT-20261121-office-busy: Busy Bots Never Wander, 20s Coffee With Countdown

- **Task ID:** DT-20261121-office-busy
- **Implementer:** سالم (DIGER FAWAALY-2)
- **Branch:** team/DT-20261121-office-busy

## Problem Statement
On the live office view (`diger.tech/office`), bots with active work (`feedStatus !== 'idle'`, e.g. أشرف, مربوحة) were wandering the office for coffee breaks or standups while working. Furthermore, coffee and lounge breaks had short, randomized durations (4.2–6.6s) with static bubble text and no indication of remaining break time or progress, and arrival banter previously masked the wait-phase countdown.

## Root Causes
1. `updateCoffeeTrip()` auto-break candidate selection only checked `b.status !== 'stuck'` and did not verify `b.feedStatus === 'idle'`.
2. `sendBotOnBreak()` did not reject bots with `bot.feedStatus !== 'idle'`.
3. `startStandup()` and `startHelp()` did not filter candidates to idle bots.
4. `applyLiveFeed()` did not cancel an in-flight break or trip when an incoming feed status changed a bot to working/waiting/stuck.
5. Break dwell time was randomized between 4200ms and 6600ms instead of a deterministic 20 seconds.
6. Wait bubble rendered static text instead of a live countdown with a filling progress bar, and arrival banter previously suppressed the countdown for the first 3.2s.
7. Agent card coffee button initiated trips for busy bots rather than displaying a busy response.

## Invariants Enforced
1. `bot.onTrip ⇒ bot.feedStatus === 'idle' || teamMeetingActive`
2. `bot.tripPhase === 'wait' ⇒ bot.tripWait starts at BREAK_DWELL_MS (20000ms)`
3. Break bubble during wait phase displays Arabic countdown text (`☕ بيشرب القهوة · ١٥ث` / `🎮 استراحة · ١٥ث`) and a progress bar (0% → 100%) visible for the full 20s without being obscured by arrival banter.
4. If a bot turns busy mid-trip (`status !== 'idle'`), the trip is cancelled immediately, any referenced interaction (standup/help) is cleanly concluded, and the bot routes home (`returningHome = true`, `onTrip = false`, `tripBot = null`).
5. Help interactions allow busy/stuck helpees (who stay at their desk), but require idle helpers.

## Changes Applied
1. **Dwell Time & Countdown Helpers**:
   - Defined `const BREAK_DWELL_MS = 20000;`.
   - Added `toArabicIndic(n)` to convert numbers to Arabic-Indic digits (`٠١٢٣٤٥٦٧٨٩`).
   - Added `getBreakCountdownText(bot)` and `getBreakProgress(bot)` calculating remaining seconds (`ceil(tripWait/1000)`) and progress ratio.
2. **Bubble & Progress Bar Rendering (`drawBotBubble`)**:
   - Displayed countdown text dynamically via `getBreakCountdownText(bot)`.
   - Rendered a progress bar under the bubble filling 0% → 100% over the 20s dwell window.
   - Cleared arrival banter on transition to `wait` phase so countdown displays immediately for the full 20 seconds.
3. **Break Guard (`sendBotOnBreak`)**:
   - Enforced `bot.feedStatus === 'idle'` and `bot.status !== 'meeting'`.
4. **Auto Breaks & Dwell Initialization (`updateCoffeeTrip`)**:
   - Filtered candidate pool by `b.feedStatus === 'idle' && b.status !== 'meeting'`.
   - Set wait duration to exactly `BREAK_DWELL_MS` (20000ms).
   - Removed arrival banter (`chatText`/`chatUntil`), setting `chatUntil = 0; chatText = ''` so countdown is visible immediately upon arrival.
   - Added mid-trip check cancelling the trip if feed status changes to non-idle.
5. **Standup & Help Interactions (`startStandup`, `startHelp`)**:
   - Standup members restricted to `b.feedStatus === 'idle'`.
   - Help interaction requires helper to have `b.feedStatus === 'idle'`; helpee may be busy/stuck and remains at their desk.
6. **Live Feed Handler (`applyLiveFeed`)**:
   - Immediately cancels active trip if an incoming feed payload turns a bot non-idle (`status !== 'idle'`), routing them straight home, resetting `tripBot`, and cleanly concluding any active standup or help interaction referencing them.
7. **Agent Card Coffee Action (`renderAgentCard`)**:
   - If `bot.feedStatus !== 'idle'`, shows `«عندي شغل، أخلّص وأروح ☕»` and prevents movement.

## Verification & Must-Pass Test Cases
Fail-first proof on base commit (`d9de1241`): 7 failures across test cases a–f and countdown/progress logic.

Post-fix verification:
- `tests/office-board.test.ts`: 38 passed (38)
  - case a: auto break never picks working / waiting / stuck / meeting bots; picks idle bot when available.
  - case b: startStandup / startHelp never set onTrip/route on busy bots; help with busy helpee + idle helper routes helper only.
  - case c: wait phase = exactly 20000 ms for coffee and lounge.
  - case c2: right after arrival the bubble text is the countdown «… · ٢٠ث» without being hidden by banter.
  - case d: countdown text shows remaining seconds (20, 15, 1s); progress bar at 0%, 50%, 100%.
  - case e: feed turns bot busy mid-trip (go and wait) → onTrip false, returningHome true, tripBot null.
  - case e2: feed turns standup/help participant busy → cancels interaction cleanly without stuck state.
  - case f: card button on busy bot shows busy bubble; on idle bot starts trip; stuck message preserved.
  - counter-cases: idle breaks, team meetings gather all, sleep/wander mechanics unchanged, desk chats allowed when busy.
- `tests/office-feed-updater.test.ts`: 14 passed (14)
- `tests/office-feed-function.test.ts`: 18 passed (18)
- `tests/office-page.test.ts`: 4 passed (4)
- **Total: 74 tests passed (74)**.
- **TypeScript (`flock /srv/diger-team/shared/heavy.lock npx tsc --noEmit`)**: 0 errors.
