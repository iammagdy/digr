# DT-20261121-office-v2: Office Page v2, Meeting Room & Feed Updater

## Overview
Implementation of the office page v2 and feed updater per specification `/var/lib/openbot/OpenBot/Shared/diger-office/office-v2-spec.md` and DIGER CTO (الكبير) orders.

This release revamps the office canvas with dedicated rooms, meeting mechanics, interactive employee gags, and updates the repository feed generator to strictly respect explicit bot states and data privacy.

---

## Deliverables & Changes

### 1. Feed Updater (`scripts/office-feed-updater.mjs`)
- **Explicit State Extraction:** Effective state (`waiting`, `working`, `stuck`, `idle`) is derived strictly from explicit `state:` in task `status.md` or bot `.jsonl`. Keyword heuristics across step texts are abolished.
- **Waiting vs. Stuck:** Bots waiting on CI or review (e.g. `state: "waiting"`) remain in `waiting` state regardless of inactivity duration (e.g. 2+ hours). Only `working` bots with no activity > 45 minutes transition to `stuck`.
- **Real Percentages:** Exact percentage from CTO status file is preserved (e.g. 72%), without inventing or clamping when not working.
- **Privacy Abstraction:** Redacts internal task IDs (`DT-...`, `O6-...`), internal file paths (`/srv/...`), code file names (`*.ts`), branch refs, and secrets from public output.
- **Dry-Run CLI Mode:** Supports `--dry-run` flag to print generated feed JSON to stdout and exit 0 without network upload. Fails loudly with non-zero exit when run without flag and missing upload credentials.
- **Location Independence:** Implemented directly in repo (`scripts/office-feed-updater.mjs`), with no dependencies on external runtime folders.

### 2. Office Page v2 Layout (`public/office/index.html`)
- **Developer Desks (Bullpen 0..510, 45..315):**
  - Row 1 (`y = 130`): Hagras (75, 130), Nafady (205, 130), Ashraf (335, 130).
  - Row 2 (`y = 225`): Salem (40, 225), Marbouha (150, 225), Johnny (260, 225), Fazza (370, 225).
  - Hazalqom design desk at `(404, 252)`.
  - All 7 bullpen desks feature dual monitors, brass nameplates, keyboards, and coffee mugs.
- **Partitions & Walls:**
  - Bullpen wall at `pwy = 315` with entrance doorway gap at `x: 350..374`.
  - Vertical glass partition at `x = 240` (Games Corner / Meeting Room).
  - Vertical glass partition at `x = 485` (Meeting Room / Coffee Corner).
- **Meeting Room (`x: 240..485, y: 315..540`):**
  - Floor: slate tile grid with dark navy conference rug and gold corner brackets (`drawMeetingFloor`).
  - Presentation screen on top wall (`325, 322, 74x32`) with animated sprint charts and flow diagrams.
  - Large oval conference table (`cx = 362, cy = 425`) with green leather desk pad and speakerphone.
  - 8 conference chairs around table perimeter.
  - Team Meeting Button (`#meeting-btn`) in `.stage-controls`: smoothly moves all 9 bots to `MEETING_SEATS`, runs dialogue sequence (`TEAM_MEETING_SCRIPT`), and returns everyone to their desks.
- **Games Corner & Lounge (`x: 0..240, y: 315..540`):**
  - Floor: teal lounge rug with geometric accents (`drawLoungeFloor`).
  - Wall TV (`22, 322, 86x42`): generic pixel sports car driving on night city asphalt road with skyline, window lights, radar, and energy bar.
  - Zero commercial/trademarked terms in code, alt text, or comments.
  - Console unit with controller cables, bean bag cushions, sofa, coffee table, and retro arcade cabinet at `x = 185`.
- **Coffee Corner & Kitchen (`x: 485..800, y: 315..540`):**
  - Floor: checkered terracotta & cream cafe tiles (`drawCheckeredFloor`).
  - Counter with espresso machine, grinder, pastries, and pendant lamps.
  - 3 bar stools (`x: 550, 630, 710, y: 390`) where bots sit when taking a coffee break.
  - Chalkboard menu and dining table.
- **Sleep Gag (`checkBotSleep` & `wakeUpBot`):**
  - Bots idle > 30 minutes enter sleep (`isSleeping = true`, slump posture, `💤 نايم` badge, floating Zzz).
  - Working and waiting bots never enter sleep.
  - Tap / click on sleeping bot intercepts the click: triggers jump + 360 spin animation with humorous apology bubble without opening agent modal. Next click opens modal.
- **Cheer Button (`CHEER_REPLIES`):**
  - Character-specific Egyptian banter replies for all 9 bots.
  - Zero network requests (100% page-local).

---

## Verification & Must-Pass Evidence

### 1. Test Execution
```bash
npx vitest run tests/office-feed-updater.test.ts tests/office-feed-function.test.ts tests/office-board.test.ts tests/office-page.test.ts
```
**Result:** 46 / 46 tests passed (100% pass rate).
- `tests/office-feed-updater.test.ts`: 4 passed
- `tests/office-feed-function.test.ts`: 18 passed
- `tests/office-board.test.ts`: 20 passed (including all 7 must-pass criteria)
- `tests/office-page.test.ts`: 4 passed

### 2. TypeScript Typecheck
```bash
npx tsc --noEmit
```
**Result:** 0 errors (clean exit code 0).

### 3. Forbidden Words Audit
Verified 0 occurrences of commercial game or platform names across repository diff.

### 4. DOM Security Audit
Verified zero use of `innerHTML` for dynamic feed data; all modal attributes populated via `textContent`.
