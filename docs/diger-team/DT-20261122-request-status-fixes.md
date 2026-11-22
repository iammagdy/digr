# Request Status & Hydration Fixes (DT-20261122-request-status-fixes)

Task: DT-20261122-request-status-fixes (From QA report `FX-08-LIVE.md`, ordered by الكبير).
Branch: `team/DT-20261122-request-status-fixes` from `origin/main` (`be55e304`).

## Summary of Changes

This task resolves two customer-facing defects identified during the live run check of small requests on diger.tech:

### 1. Request Detail Header Live Status Synchronization (Bug 1)
- **Problem:**
  When a customer opened a running request's detail page (`/dashboard/requests/[id]`), the top facts header retained the initial state `«قيد التنفيذ · وصل ٠ من ٦»` even after the mission completed or made progress, while the mission card body below showed `«تم تسليم ٦ عناصر من ٦ عناصر»` and the actual charge. A manual browser reload was required to update the header.
- **Root Cause:**
  1. `src/app/dashboard/requests/[id]/page.tsx` read facts from `sessionStorage` into initial state. In the Supabase fetch handler, line 90 used `stateAr: prev?.stateAr || ...`, which prioritized the stale cached state over the freshly loaded database status.
  2. When opened with a `missionId`, the initial query looked for `jobs` matching `id = missionId`, which returned null, leaving `kind` null.
  3. `AgentMissionCard` polled `/api/missions/[id]` every 2–3s and received live `ApprovalCardView` updates, but had no callback to notify the parent page.
- **Fix:**
  - Added `onViewChange?: (view: ApprovalCardView) => void` prop to `AgentMissionCard` and invoked it in `read()` upon applying `json.view`.
  - Exported `stateLabelFromPhase(phase: string)` in `src/lib/jobs/requestStatus.ts` to map `CustomerPhase` values (`done` → `مكتمل`, `partial` → `مكتمل جزئيًا`, `unserved` → `لم تُنفَّذ`, `failed` → `فشلت`, `cancelled` → `أُلغيت`, `running` → `قيد التنفيذ`).
  - Implemented `handleViewChange` in `RequestDetailsPage` to update `stateAr`, `delivered`, and `requested` in real time as the card receives updates.
  - Added `handleSettled` connected to `onSettled` on `AgentMissionCard` to re-fetch the database record when a mission settles, picking up final credits and billable units.
  - Enhanced Supabase query to query `jobs` by `mission.job_id` if initial query by ID returned null, and resolved state using `jobViewWithMission`.
  - Counter-case preserved: Running missions actively update live collection progress (e.g. `وصل X من Y`).

### 2. React Hydration Error #418 Fix (Bug 2)
- **Problem:**
  React console error `Uncaught Error: Minified React error #418` occurred on `/dashboard/requests`.
- **Root Cause:**
  SSR in Node.js runs in `UTC` while the user's browser runs in `Africa/Cairo` (UTC+2 / UTC+3). `formatTime` and `dayLabel` used `Intl.DateTimeFormat` without pinning `timeZone`, causing 16:30 UTC to render as `اليوم ٠٤:٣٠ م` on the server and `اليوم ٠٦:٣٠ م` on the client, triggering a hydration text mismatch.
- **Fix:**
  - Updated `formatDate` and `formatTime` in `src/lib/honestDisplay.ts` to default `timeZone: "Africa/Cairo"` (consistent with `customerDates.ts` and `walletView.ts`).
  - Updated `dayLabel` in `src/lib/dayLabel.ts` to calculate calendar day differences using Cairo day boundaries (`en-CA` locale with `Africa/Cairo`) and format output consistently in Cairo time across both server and client.
  - Added `suppressHydrationWarning` on date rendering elements in:
    - `src/components/mission/OpenMissionsList.tsx`
    - `src/app/dashboard/requests/page.tsx`
    - `src/app/dashboard/requests/[id]/page.tsx`

---

## Verification

1. **Automated Unit & Regression Tests:**
   - `tests/request-status-fixes.test.tsx` (10/10 passed):
     - Deterministic `dayLabel` and `formatTime` formatting in Cairo time.
     - Yesterday and older day boundary calculations in Cairo time.
     - `suppressHydrationWarning` integration check.
     - `stateLabelFromPhase` mapping for all customer phases.
     - Header facts synchronization for `done`, `partial`, `unserved`, and live `running` progress counter.
   - `tests/requests-page-replay.test.ts` (26/26 passed).
   - `tests/honest-display.test.ts` (28/28 passed).

2. **Typecheck & Build (under heavy.lock):**
   - `tsc --noEmit` + `npm run agent:typecheck`: 0 errors.
   - `npm run build`: 0 errors, static export generated cleanly.
