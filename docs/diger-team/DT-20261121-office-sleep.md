# DT-20261121-office-sleep: Hazalqom Wandering Designer Sleep Mechanics

- **Task ID:** DT-20261121-office-sleep
- **Implementer:** هجرس (DIGER FAWAALY)
- **Branch:** team/DT-20261121-office-sleep

## Problem Statement
On the live office view (`diger.tech/office`), حزلقوم (hazalqom, `baseWander: true`) was showing the «💤 نايم» label and Zzz animation while actively walking around the office.

## Root Causes
1. `updateWorld()` wander loop did not check `!bot.isSleeping`, allowing sleeping wanderers to continue route progress.
2. `checkBotSleep()` marked the bot as `isSleeping = true` after 30 minutes of idle status regardless of whether the bot was away from his desk.
3. `applyLiveFeed()` reset `bot.wander = (status === 'idle')` on each poll, re-enabling wandering for a sleeping bot.
4. Agent status card showed «💤 نايم على مكتبه» even when the bot was away from his desk.

## Invariant Enforced
`isSleeping ⇒ !isMoving AND bot within 8px of home`

## Changes Applied
1. **Wander Loop (`updateWorld`)**:
   - Added `&& !bot.isSleeping` to the wander loop condition.
   - When skipped because asleep, set `bot.isMoving = false`.
2. **Sleep Check (`checkBotSleep`)**:
   - When the 30-min idle threshold is reached: if `bot.baseWander` and distance from home > 6px, route the bot back to desk (`bot.wander = false`, `bot.returningHome = true`, `setBotRoute(bot, bot.homeX, bot.homeY)`), keep `bot.isSleeping = false`, and return `false`.
   - Only once the bot arrives at his desk does `checkBotSleep` set `bot.isMoving = false` and `bot.isSleeping = true`.
3. **Feed Apply (`applyLiveFeed`)**:
   - Do not re-enable wander while `bot.isSleeping` is true (`bot.wander = (status === 'idle') && !bot.isSleeping`).
   - Wake bot immediately when incoming status changes to non-idle.
4. **Wake-Up Mechanic (`wakeUpBot`)**:
   - Upon waking a `baseWander` bot whose feed status is `'idle'`, re-enable wandering (`bot.wander = true`).
5. **Card Rendering (`renderAgentCard`)**:
   - Only display «💤 نايم على مكتبه» when `bot.isSleeping` AND the bot is within desk bounds (`<= 8px`).

## Verification & Must-Pass Test Cases
All 7 must-pass cases verified in `tests/office-board.test.ts`:
- (a) Hazalqom idle < 30 min → wanders, label «☕ متاح», `isSleeping: false`.
- (b) Hazalqom idle ≥ 30 min while away from desk → walks home with label «☕ متاح» (`!isSleeping`), sleeps once at desk.
- (c) Successive feed polls while asleep → stays asleep at desk without resuming wander.
- (d) Tap/click to wake → awake, wanders again; respects 10-min awake cooldown.
- (e) Incoming working feed → wakes, goes to desk.
- (f) Standard desk bots (`baseWander: false`) → sleep at desk as before.
- (g) Team meeting → wakes, walks to meeting room, no sleep during meeting.

Test counts across suites:
- `tests/office-board.test.ts`: 29 passed (29)
- `tests/office-feed-updater.test.ts`: 14 passed (14)
- `tests/office-feed-function.test.ts`: 18 passed (18)
- `tests/office-page.test.ts`: 4 passed (4)
- **Total: 65 passed (65)**. TypeScript check (`npx tsc --noEmit`) clean (0 errors).
