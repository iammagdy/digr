# Add Alatra (FAWAALY-3) to Office Canvas and Feed Updater (DT-20261122-office-alatra)

Task: DT-20261122-office-alatra (Megz decision D-0194, Hazalqom specification in `/srv/diger-team/designer/work/office-alatra-steps.md`).
Branch: `team/DT-20261122-office-alatra` from `origin/main` (`74180326`).

## Summary of Changes

Adds العترة (`alatra` / FAWAALY-3) to the interactive office dashboard (`diger.tech/office`) and the backend feed updater. Increases total canonical bot count from 9 to 10 across all office subsystems and test suites.

### 1. Feed Updater (`scripts/office-feed-updater.mjs`)
- Added `alatra` to `CANONICAL_BOTS` array (`['elkebir', 'johnny', 'nafady', 'hagras', 'salem', 'alatra', 'fazza', 'ashraf', 'marbouha', 'hazalqom']`).
- Added role mapping in `BOT_ROLES`: `alatra: "المنفّذ التالت"`.
- Added default work dir in `DEFAULT_BOT_WORK_DIRS`: `alatra: "/srv/diger-team/fawaaly3/work/digr"`.
- Added Arabic name in `BOT_ARABIC_NAMES`: `alatra: "العترة"`.
- Added generic activity description mapping in `resolveActivityType`: `alatra: "تطوير وكتابة كود"`, sanitizing internal paths, branch names, and task IDs.

### 2. Canvas Board UI (`public/office/index.html`)
- **Avatar Asset:** Embedded WebP base64 asset for Alatra (`/srv/diger-team/designer/work/alatra.webp`) into `AVATAR_SRC.alatra`.
- **Bot Configuration:** Added `alatra` desk configuration in `BOTS`:
  - `deskX: 548, deskY: 236, deskW: 76, deskH: 36`
  - `homeX: 586, homeY: 260`
  - `type: "dev"`
  - `prop: "protein_shaker"`
- **Hazalqom Waypoints:** Updated `BOTS.hazalqom.waypoints` from `x: 520` to `x: 616` to clear Alatra's desk during walking routines.
- **Desk Prop Rendering:** Added rendering for `protein_shaker` in `drawDeskProp(bot, x, y)`:
  - Shaker body (`#059669`), lid (`#047857`), and flip-top cap (`#34d399`).
- **Cheer Banter:** Added Alatra's cheer reply in `CHEER_REPLIES`:
  - `alatra: "عاش يا رجالة، الحديد بيتنى والشغل بيخلص 💪🏋️"`
- **Pairwise Banter:** Added pairs `["salem", "alatra"]` and `["hazalqom", "alatra"]` to `startChat` pool.
- **Conference Seats:** Added 10th chair in `MEETING_SEATS` at `{ x: 450, y: 530 }` and adjusted Marbouha to `{ x: 418, y: 526 }` and Hazalqom to `{ x: 482, y: 526 }` with equal spacing around the conference table.
- **Team Meeting Dialogue:** Added Alatra's line in `TEAM_MEETING_SCRIPT`:
  - `{ botId: 'alatra', text: 'الكود طالع سخن من تحت إيدي 💪' }`

### 3. Test Suites
- `tests/office-page.test.ts`: Updated `EXPECTED_ROLES` to include `alatra: "المنفّذ التالت"` and updated suite title to assert 10 Arabic roles.
- `tests/office-board.test.ts`: Updated Must-Pass 4 to verify `botKeys.length === 10` and `CHEER_REPLIES` for all 10 bots, and updated conference table comments.
- All 4 office test files pass cleanly (78/78 tests passing).

## Verification
- Vitest: 78/78 passed across all office test files.
- Dry Run: `node scripts/office-feed-updater.mjs --dry-run` outputs all 10 bots, Alatra at 90% working, with 0 data/path leaks.
- TypeScript (`tsc --noEmit`): Exit code 0, 0 errors.
