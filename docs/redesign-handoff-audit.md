# Digr Redesign Handoff Audit

**Audit date:** 2026-10-11
**Repository:** `iammagdy/digr`
**Branch:** `chore/digr-design-handoff-audit`
**Base:** `origin/main` at `67e0d367052620fcbdfc15906f8fa89acc328360`
**Scope:** Inspection and documentation only. No application, database, permission, provider, or production changes were made.

## Executive summary

The current application already has a functional Arabic research flow, server-side quote acceptance, ledger-backed points, job tracking and downloads, Appwrite top-ups, and admin top-up review. The supplied redesign covers materially more product surface: new brand and theme treatment, a new landing experience, verification/recovery, a wider wallet and user shell, settings/legal/notifications, and a multi-page admin dashboard.

The design files are references, not working production behavior. Their HTML prototypes contain sample records and simulated actions. They are not evidence that a production endpoint, data source, or state exists. The most significant proposed work is backend/infrastructure work (schema changes, admin analytics, environment-variable management, notifications, audit history, provider cost logging, and deletion scheduling) and needs separate owner approval. Financial calculations and ledger code were not changed.

## A — Source inventory

### Files found in `New UI/design_handoff_digr_redesign`

| File | Found | Read/inspected | Notes |
|---|---:|---:|---|
| `README.md` | Yes | Yes, complete | Design tokens, typography, screens, states, responsive and motion requirements. |
| `WIRING.md` | Yes | Yes, complete | 154 lines; all 17 actual `[تحقق]` mapping rows were checked against repository code. The remaining `[تحقق]` occurrence is the document's definition of the marker, not a screen mapping. |
| `PROMPT.md` | Yes | Yes, complete | Brief; corroborates reference-only, screen-switcher, approval, and staged-PR instructions. |
| `design/Digr Final.html` | Yes | Static source inspection | 1.5 MB bundled prototype. Its source declares eight preview tabs and a scenario switch. **It was not rendered in a browser.** |
| `design/source/Digr V7 Still Lens.dc.html` | Yes | Yes, source inspected | Readable user app template; includes landing, auth, chat, requests, wallet, settings, legal, and user-state prototypes. |
| `design/source/Digr Admin.dc.html` | Yes | Yes, source inspected | Readable admin template; includes desktop/mobile shell and admin-page prototypes. |
| `design/source/support.js` | Yes | Yes, runtime source inspected | Generated design-prototype runtime, not application code. |
| `brand/digr-wordmark.svg` | Yes | Yes, SVG source opened | Approved supplied light wordmark. |
| `brand/digr-wordmark-white.svg` | Yes | Yes, SVG source opened | Approved supplied dark wordmark. |
| `brand/digr-mark.svg` | Yes | Yes, SVG source opened | Approved supplied light mark. |
| `brand/digr-mark-white.svg` | Yes | Yes, SVG source opened | Approved supplied dark mark. |
| `brand/digr-app-icon.svg` | Yes | Yes, SVG source opened | Approved supplied app icon. |
| `brand/favicon.svg` | Yes | Yes, SVG source opened | Approved supplied favicon. |

### Missing / access limits

- `design_handoff_digr_redesign.zip` was **not found** under the design directory. The expected `README.md`, `WIRING.md`, source HTML, and brand assets were present outside the archive.
- `Digr Final.html` could not be opened in the browser. The browser tool rejected the local `file://` URL under its security policy and explicitly prohibited workarounds. The HTML was inspected statically; no browser-rendered visual or interactive verification was possible. No screenshot was generated.
- `New UI/Digr Final.html` also exists as an extra local copy outside the named handoff directory. It is untracked user data and was left untouched and uncommitted.
- The original handoff directory and brand assets were not modified.

## B — Current application baseline

### Repository and versions

| Item | Verified value |
|---|---|
| Repository | `https://github.com/iammagdy/digr` (`origin`) |
| Base branch | `main` |
| Latest verified base commit | `67e0d367052620fcbdfc15906f8fa89acc328360` (merge PR #39, 2026-10-11) |
| Framework | Next.js `15.4.8`, App Router |
| React / React DOM | `19.1.2` / `19.1.2` |
| TypeScript | `5.9.3` |
| Tailwind CSS | `4.1.11` |
| Appwrite browser SDK | `18.1.1` |
| Appwrite server SDK | `node-appwrite 29.2.0` |
| Test runner | Vitest `5.0.3` |
| Package manager / lock | npm / `package-lock.json`; `npm ci` completed |
| Appwrite function runtime in repo config | Node.js 22 (`appwrite.json`) |

The local history contains the earlier redesign merge and later work through PR #39. This audit was based on freshly fetched latest `origin/main`; it did not reuse the starting feature branch. The `docs/HANDOFF.md` says Next.js 15, React 19, Tailwind v4 and Appwrite Sites SSR, matching the source configuration at the level inspected.

### Styling and brand architecture

- Tailwind is CSS-first v4: `src/app/globals.css` imports `tailwindcss` and declares design values in `@theme`; `postcss.config.mjs` uses `@tailwindcss/postcss`.
- There is **no** `tailwind.config.*` in the repository. Future token work belongs in the CSS-first architecture unless inspection of a later baseline establishes otherwise.
- Current typography is IBM Plex Sans Arabic (Google CSS import and local font assets in `src/assets/fonts`). The supplied design calls for Vazirmatn for UI/body and Markazi Text for display headings.
- Current palette uses `sand`, `ink`, `pine`, and `accent` tokens and does not implement the reference `[data-theme]` light/dark token sets.
- The app currently renders a text mark/wordmark treatment in React rather than using supplied SVGs. There is no `public/brand` or `app/icon` route in the inspected tree.

### Existing routes

**Pages:** `/`, `/login`, `/register`, `/dashboard`, `/dashboard/chat`, `/dashboard/order`, `/dashboard/jobs`, `/dashboard/topup`, `/admin/topups`, and `/_not-found`.

**API routes:**

- `/api/chat`, `/api/chat/metadata`, `/api/chat/edit-plan`, `/api/chat/accept-quote`
- `/api/jobs/[id]/data`, `/api/jobs/[id]/methodology`, `/api/jobs/[id]/artifacts`
- `/api/onboarding`
- `/api/admin/llm-status`, `/api/admin/provider-balance`, `/api/admin/smoke`

There is no route in the repository for `/dashboard/requests`, `/dashboard/settings`, `/legal/terms`, `/legal/privacy`, `/verify`, `/reset`, `/forgot-password`, or the proposed admin pages other than `/admin/topups`. Chat is a single route with conversation state in the page; there is no `/dashboard/chat/[id]` route.

### Existing shared components and feature code

- Authentication: `src/components/AuthLayout.tsx`, `src/hooks/useUser.tsx`, `/login`, `/register`.
- User shell: `src/app/dashboard/layout.tsx`; dedicated research-chat sidebar: `src/app/dashboard/chat/components/ChatSidebar.tsx`.
- Discovery and quote: `DiscoveryCard.tsx`, `discoveryQuestions.ts`, `PlanQuoteCard.tsx`, `/api/chat/edit-plan`, `/api/chat/accept-quote`.
- Job activity/results: `ActivityTimeline.tsx`, `ResultsCanvas.tsx`, `/dashboard/jobs`, `/api/jobs/[id]/*`.
- Reusable UI: `src/components/ui.tsx`.
- Honest display/status helpers: `src/lib/honestDisplay.ts`.

### Appwrite tables, buckets, and functions referenced by code

Repository definitions and call sites include `profiles`, `settings_public`, `topups`, `credit_ledger`, `jobs`, `job_events`, `job_calls`, `capability_registry`, `templates`, `templates_private`, `settings`, `conversations`, `messages`, `plans_quotes`, `llm_usage`, and `artifact_versions`. Schema definitions are in `scripts/setup-db.ts`; **that setup script was inspected but not run**. Appwrite cloud schema and deployed permissions were not queried as infrastructure changes/inspection were outside this local audit.

Storage code uses `receipts`, `results`, and `job_data`. `appwrite.json` defines five functions: `on-user-create`, `submit-topup`, `approve-topup`, `create-job`, and scheduled `job-worker`. The handoff's separate mention of `job-watchdog` was not present in `appwrite.json` or `src/functions/`; the current job-worker has recovery/settlement code in shared modules.

### Authentication, authorization, and data ownership

- `useUser` calls Appwrite `account.get`, `createEmailPasswordSession`, `account.create`, and `deleteSession('current')`. Signup immediately logs in. No verification, recovery, or verified-email gate was found.
- The dashboard redirects missing users client-side. The admin layout also redirects/blocks client-side based on the `admin` label; it is not a server layout.
- Admin API routes (`llm-status`, `provider-balance`, `smoke`) validate the Appwrite user and `labels.includes('admin')` server-side. The `approve-topup` function independently checks the caller's label server-side.
- User-facing direct Appwrite reads rely on row/document permissions. `submit-topup` sets owner/admin read permissions for receipts/top-ups and derives owner from the Appwrite invocation header.
- `scripts/setup-db.ts` describes owner-row-security for private tables, read-only public `settings_public`, unique top-up reference/receipt indexes, and owner/admin ledger permissions. Those definitions establish repository intent, not current deployed state.

### Existing APIs and financial invariants

- Chat calls use Appwrite JWTs and server API routes. Plan editing calls `/api/chat/edit-plan`; quote acceptance calls `/api/chat/accept-quote`, which invokes `create-job` after server-side quote verification.
- `src/functions/shared/quoteAccept.ts` and `src/functions/create-job/src/main.ts` bind jobs to valid quotes/plans, calculate/reserve on the server, and use the deterministic ledger functions.
- `src/functions/shared/ledger.ts` uses deterministic IDs (`res_`, `rel_`, `chg_`, and `top_`), paginates when calculating balances, releases before charging, caps charges at reserved credits, and makes top-up ledger rows append-only by convention/permissions.
- `src/app/dashboard/layout.tsx`, `src/app/dashboard/chat/page.tsx`, and wallet reads sum every ledger page and show an explicit error state on read failure. The net ledger balance already reflects reserve/release/charge deltas; subtracting held amounts a second time would be incorrect.
- `approve-topup` calculates credits on the server from the `settings_public/pricing` row (with existing fallback), credits through `applyTopup`, and requires admin authorization. It supports approve/reject and optional `confirmedAmountEgp`; rejection currently has no reason field.
- No work was done on financial calculations, authorization, permissions, provider calls, or jobs.

## C — Design coverage

The main reference exposes eight preview tabs: landing, auth, chat, requests, wallet, settings, legal, and administration. The admin reference describes eight pages/sections: overview, users, top-ups, jobs, revenue, providers, settings, and operation log. Counting the overlapping admin overview tab once gives **15 distinct page/screen families**. Auth, chat, wallet, and admin also have multiple state variations described in `README.md` and `WIRING.md`.

| Design screen | Exists in Digr? | Current state and difference |
|---|---|---|
| Landing `/` | Yes | Existing Arabic marketing page, workflow sections, example templates, FAQ, and a clearly labeled simulated dossier demo. Layout/copy/tokens differ from approved floating glass header, lens hero, chips, fanning files, slider, and supplied copy. The hero demo has decorative “start/extract/ready” states; it is labeled simulation and does not launch a real job. |
| Auth: register/login | Yes | Working create-account/login forms with validation, error states, and `AuthLayout`. Current layout/copy differs; no saved question, verification, forgot-password, reset, resend timer, or email-verification gate. |
| Research chat | Yes | Existing conversation list/search, assistant chat, discovery cards, editable plan, server quote/approval, job events, result canvas and artifact editing. Current visual organization differs from the single-document four-step reference. No reference design layout, theme, offline banner, or all designed empty/failure/expired/low-balance states. |
| Requests (`/dashboard/requests`) | Partial equivalent | `/dashboard/jobs` lists jobs with loading/empty/error, filters, activity history, retry-by-reorder, and downloads. Path, visual layout, filters/labels and job detail behavior differ. Stored status set is `queued/running/done/failed/cancelled`; there is no `refunded` job status. |
| Wallet/top-up | Yes | `/dashboard/topup` shows ledger-backed current balance, pricing, presets, payment destination where configured, optional receipt upload, reference, prior ledger and top-up data. Design differs substantially; sender name/phone are absent, receipt is optional, and the three-step success and rejection-reason state are absent. Current settings schema only defines `creditValueEgp`, not the design's IPA/admin settings. |
| Settings | No | No user settings route/API for name/password/preferences/theme/account deletion. Account name/email and logout are shown in the shell. |
| Legal terms/privacy | No | No legal routes; design text is explicitly a draft and requires lawyer review before publishing. |
| Admin overview | No | No dashboard/analytics page or stats API. |
| Admin users | No | No user search/pagination/detail page or aggregate endpoint. |
| Admin top-ups | Yes, partial | `/admin/topups` supports pending/approved/rejected/all filters, reload, receipt link, approve, reject and result/error messaging. It has no design sheet, sender/phone data, mismatch warning, selection/CSV, custom confirmed amount field, reject reason, pinned actions, or design visual system. |
| Admin jobs | No | No admin job list/detail page. |
| Admin revenue/profit | No | No revenue view/API, monthly roll-up, or source-backed profit report. Current per-call cost records are not the proposed comprehensive `provider_costs` series. |
| Admin providers | Read-only fragments | Admin-protected endpoints expose LLM status, provider balance, and smoke-test results. No settings UI, provider toggles, model/key changes, safe last-four key workflow, TREG controls, or system settings UI. A smoke endpoint can cause provider activity and was not called. |
| Admin settings | No | `settings_public/pricing` is read by top-up and approve code, but no settings UI. In `setup-db.ts`, its schema contains only `key`, `creditValueEgp`, and `updatedAt`; no IPA, pending cap, or admin-team settings. |
| Admin operation log | No | No `admin_audit_log` collection or page found. |

### State coverage

- **Existing production states:** auth loading/error; dashboard loading; truthful balance loading/failed; chat message loading/error/retry and onboarding; quote affordability/edit/expiry indication; job queued/running/done/failed/cancelled; job event loading; result/download errors; wallet/top-up loading and errors; admin top-up loading/empty/error and action result.
- **Design states not fully implemented:** offline prevention/banner; simplified AI-off banner in the designed form; explicit quote-expired refresh path in the designed layout; designed insufficient-balance return-to-chat action; new-account welcome/zero-balance view; top-up submission success progression/rejection reason; notifications; settings/legal; verification/recovery; provider/system controls; admin analytics/empty/loading states.
- The design's “حالة” selector, sample user/job/top-up figures, simulated completion, and preview navigation are reference tooling/sample data. They must not ship to production.

### Per-screen wiring matrix

The requested A–H classifications are used below; a screen can have more than one because its current function may exist while the approved presentation or added behavior does not.

- **A — already implemented correctly** for the behavior/data contract under inspection.
- **B — exists but needs visual changes** to match the approved reference.
- **C — exists but needs functional wiring** to complete the reference behavior.
- **D — missing; safe UI implementation** when it only presents already-authorized behavior.
- **E — requires backend changes.**
- **F — requires database or permission changes.**
- **G — blocked pending owner approval** for money, permissions, infrastructure, secrets, deletion, external calls, or legal publication.
- **H — unknown / needs further investigation**, including deployed cloud state not verifiable from local source.

| Design screen / behavior | Existing React route/component | Current handler/API and Appwrite data | Auth / authorization | Existing states and classification / action |
|---|---|---|---|---|
| Landing and hero | `src/app/page.tsx`, `DossierDemo` | Links to `/login`, `/register`, `/dashboard/chat?prompt=…`; demo state is local React state only. Example templates come from `exampleTemplates.ts`. | Public. Demo action does not reach a production job API. | Existing page/demo; new approved visual and safe ask/chip UI. **B + D**. Replace demo presentation with approved copy without wiring fake steps as real jobs. |
| Auth register/login | `src/app/register/page.tsx`, `src/app/login/page.tsx`, `AuthLayout`, `useUser` | `account.create`, `createEmailPasswordSession`, `account.get`, `deleteSession`; no dedicated auth API route. | Appwrite account session; signup/login have no server-side email-verification gate. | Loading/errors and current validation exist. **B** for visual; verification/recovery are **D + E**; enforce gate in protected behavior only after approved. |
| Verify/resend/recovery/reset | No route/component | Appwrite Account methods in design are not called by current app. No verification/recovery API route. | Would require session/token callback handling and verified-user checks. | Entire flow absent. **D + E**; verify mail callback configuration before rollout. |
| User app shell / sidebar | `src/app/dashboard/layout.tsx`, `ChatSidebar.tsx` (chat route renders its own full-screen workspace) | Navigation links, `onNewChat`, `onSelectConversation`; profile/account read; paginated `credit_ledger`; current chat reads `conversations`. | Dashboard redirects client-side when signed out; user-owned reads depend on Appwrite row permissions. | Drawer/loading/balance failed/no conversations exist. **B**; route/menu composition changes are UI wiring, not new data permissions. |
| Research chat / discovery / plan | `src/app/dashboard/chat/page.tsx`, `DiscoveryCard`, `PlanQuoteCard` | POST `/api/chat`, `/api/chat/edit-plan`, `/api/chat/accept-quote`; reads `conversations`, `messages`, `profiles`, `plans_quotes`, `jobs`, `job_events`, `credit_ledger`; calls `create-job`. | Authenticated Appwrite JWT; quote/job ownership and quote/hash/expiry verified server-side; explicit user approval starts job. | Existing loading/error/clarification/edit/quote/low-balance/start paths. Designed document layout and some scenario UI are **B + D**; keep server price and start logic **A**. |
| Activity / failed job / results | `ActivityTimeline.tsx`, `ResultsCanvas.tsx`, `src/app/dashboard/jobs/page.tsx` | Appwrite job/events reads; `/api/jobs/[id]/data`, `/artifacts`, `/methodology`; Storage download from `results`. | Authenticated user; API job ownership checks and bucket permissions apply. | Polling, activity, failure/release display, download states exist. Realtime is absent; no new refund action. **B** for design and transport expectation; existing release/download behavior **A**. |
| Wallet / top-up | `src/app/dashboard/topup/page.tsx` | Reads pricing, ledger and user's top-ups; browser uploads receipt to `receipts`; calls Appwrite `submit-topup`; `approve-topup` later writes ledger/status. | User session; Function sets user ID/status, checks receipt ownership, pending cap and reference; approval Function verifies admin. | Existing loading/read failure/submit errors/success and history. Design style **B**; proposed sender fields/required receipt/reason **E + F + G**. Keep current contract unchanged. |
| Requests | `src/app/dashboard/jobs/page.tsx` | Reads `jobs` and `job_events`; Storage result download; retry action creates a new order/chat path. | Authenticated owner; collection permissions and job API ownership. | Existing loading/empty/failure/filters/download error. Design route/content mapping **B**; no 90-day retention evidence (**H** remote policy unknown). |
| Settings | No route/component | `account.updateName/updatePassword/updatePrefs` are not called; no user settings API. | Session required; deletion would require a separately authorized server-side operation. | Missing UI and server behavior. Preferences/profile UI **D**; deletion scheduler **E + F + G**. |
| Legal terms/privacy | No route/component | No application endpoint/data source. Design source has draft copy. | Public read; legal acceptance would require a separate explicit flow if ever added. | Missing. **D + G** until lawyer review and owner publication approval. |
| Admin shell | `src/app/admin/layout.tsx` | `/admin/topups` and dashboard link. Browser `useUser` checks `labels`. | Client-only route gate; it is not the security boundary. Admin APIs and Function independently check `admin`. | Existing loading/denied states and simple shell. **B**; new protected pages must add server checks. |
| Admin top-ups | `src/app/admin/topups/page.tsx` | Browser lists `topups`; receipt reads from `receipts`; approve/reject calls Appwrite `approve-topup`, which queries `settings_public/pricing` and writes `topups` + `credit_ledger`. The Function already accepts optional `confirmedAmountEgp`, but current UI does not expose it. | UI depends on Appwrite table permissions; Function server-verifies admin. | Existing filters/loading/empty/errors/action success. Visual pass **B**; a custom confirmed amount affordance touches financial approval and is **G** even though the existing server parameter exists. Sender/rejection fields are **E + F + G**. |
| Admin overview/users/jobs/revenue | No page or admin aggregate API | Would need Appwrite Users, `profiles`, `topups`, `jobs`, `job_events`, `credit_ledger`, and reconciled usage/cost sources; no current handler. | Must be server-side `admin` checked, with bounded queries and no user exposure of internal cost. | Missing pages/states. **D + E + F + G**; metric definitions also need investigation before implementation. |
| Admin providers | No settings UI; API routes `src/app/api/admin/{llm-status,provider-balance,smoke}/route.ts` | Status/balance endpoints read environment/runtime and existing usage/providerSpend sources; smoke endpoint invokes `runSmokeTests`. | Existing three API routes check authenticated user `admin` label server-side. | Read/status only; no write/toggle/key UI. New controls **D + E + F + G**. Smoke behavior is **H** until separately reviewed per test and must not be called without explicit capped authorization. |
| Admin settings and operation log | No pages | Pricing row exists; `submit-topup` hardcodes a maximum of three pending requests. No mutable pending-cap, IPA/admin-team setting handler, or `admin_audit_log` exists in the inspected schema/code. | Future reads/writes must be server-authorized; append-only log must be server-only for writes. | Missing. **D + E + F + G**. Changing the pending cap affects a financial workflow and needs approval. Do not infer current cloud configuration from the seed script. |

## D — Wiring verification

All 17 `[تحقق]` screen mappings were investigated in source. Status means the mapping was resolved against the local repository; it does not assert that cloud configuration was live-verified.

| Design element / expected behavior | Actual code and evidence | Status | Required action |
|---|---|---|---|
| Theme toggle: `data-theme`, persistence, system default | No `data-theme`, theme preference store, `prefers-color-scheme` theme handler, or theme control in `src/app`, `src/components`, or `src/lib`. Tailwind token values are fixed in `globals.css`. | **D — missing safe UI** | Add reference tokens and theme persistence in the dedicated design-system PR. |
| Landing login/register destinations | Both `/login` and `/register` exist; `/login/page.tsx` links to register and `/register/page.tsx` links to login. | **A — destinations exist** | Restyle header and preserve these route destinations. |
| Signup form / `AuthLayout` | The named `AuthLayout` exists at `src/components/AuthLayout.tsx`; signup uses it and `useUser.register()` runs `account.create()` followed by login. | **B — exists, visual/flow gap** | Restyle; separately plan verification and saved-question handling. Do not equate account creation with email verification. |
| New research conversation / `ChatSidebar` | `ChatSidebar.tsx` exists and is used by `/dashboard/chat`; it receives `onNewChat`, selects conversations, filters local list, and shows balance/persona. Conversation routing is held in page state/query rather than `/dashboard/chat/[id]`. | **B — exists, different navigation model** | Restyle and retain existing callback/data flow; do not invent route IDs. |
| Available balance / `credit_ledger` | Chat, dashboard and wallet paginate ledger reads by 100 records and sum `delta`; errors do not become fake zero. Reserve rows are negative, releases positive, and charges negative, so the net equals available points. No `balances` table appears in code/schema definitions. | **A — ledger-backed balance exists** | Preserve complete pagination and truthful failed/loading state. Do not subtract holds twice. Any new aggregates should be server-authoritative if permissions/scale require it. |
| Account row/menu, admin label, logout | `useUser` loads `account.get()` and `logout()` calls `deleteSession('current')`; dashboard/chat shells show account details and logout. Admin layout checks `user.labels` client-side. There is no reference account dropdown menu or reference conditional admin menu in the user shell. | **B — primitives exist, menu absent** | Restyle existing account display/logout. Keep admin authorization server-side for protected operations. |
| Quote calculation / `PlanQuoteCard` | `PlanQuoteCard.tsx` renders a server response and expiry/affordability; chat plan editing calls `/api/chat/edit-plan`, whose handler recalculates through shared quote logic. | **A — server quote path exists** | Reuse API response and server pricing. Design's calculator is illustrative only; never replace the real quote with the `0.085` example formula. |
| Start job / `approve`, `hold` | Chat calls `/api/chat/accept-quote`; server route verifies quote ID/hash, then invokes `create-job`/shared `acceptQuote`, which reserves ledger points and starts a job only after explicit user action. | **A — real approval/start exists** | Keep same server-side quote validation, explicit approval and ledger sequence. |
| Activity timeline / job updates | `ActivityTimeline.tsx` derives status/progress from supplied events; chat/job pages read `job_events` from Appwrite. `dashboard/jobs` refreshes through polling. No Appwrite Realtime subscription was found for the timeline. | **B — event display exists, transport differs** | Match appearance using current actual event reads. Realtime would be a separate technical decision; do not claim it is present. |
| Failed job / `refund` | Worker/shared `ledger.ts` use release-first settlement and refund a failed/cancelled job by releasing the reservation. Failure status and ledger entries are present; no separate `refund` transaction type or retry-in-place control was found. Jobs page has “إعادة الطلب” behavior. | **B — settlement exists, labels/actions differ** | Render actual failed status and release outcome. Do not add an additional refund write or double-refund. |
| Excel/PDF/CSV downloads | `/dashboard/jobs` downloads Appwrite `results` files; chat ResultsCanvas calls app code using `storage.getFileDownload` and protected job artifact/data APIs. This is authorized Appwrite download access, not a pre-existing signed-URL feature as the handoff labels it. | **A — real download path exists** | Keep ownership/bucket permission rules and existing download error handling; map real available formats only. |
| Wallet amount presets | `src/app/dashboard/topup/page.tsx` uses `PRESET_AMOUNTS`, updates the amount on click, and loads `creditValueEgp` from `settings_public/pricing`. | **A — preset interaction exists** | Check actual preset constants against the design; preserve server credit calculation at approval. |
| Instapay destination / `settings_public.ipa` | The design's suggested `ipa` field is not in `setup-db.ts`'s `settings_public` attributes. The current top-up page reads existing runtime configuration via helper/constants and displays a configured/unavailable state; no editable IPA setting exists in the schema. | **C — display configuration exists; mapping is stale** | Keep existing configured-state behavior. Any new public settings field or admin editor needs database/permission approval. |
| Wallet ledger type names/filters | `ledger.ts` defines `topup`, `reserve`, `release`, `charge`; `setup-db.ts` also lists `promo`, `adjust`. Wallet groups movements and maps current types to customer-readable Arabic. | **A — real type set confirmed** | Map reference categories to real types; handle unknown/future types without hiding entries. There is no stored `refund` type. |
| Jobs collection name/status filter | `jobs` is used in `dashboard/jobs`, `create-job`, and setup schema. Real statuses are `queued`, `running`, `done`, `failed`, `cancelled`, not the design's exact three customer filters. | **A — collection confirmed; design mapping needs translation** | Derive filters from actual statuses; do not add a `refunded` status absent a separately approved schema/behavior change. |
| Job details / `deliveredCount` and `requestedCount` | Schema and job code use `rowsCollected`, `reservedCredits`, `chargedCredits`, `estCredits`, `templateSlug`, `params`, plus status/timestamps/results. No `deliveredCount` or `requestedCount` attribute was found in setup schema; requested volume can be encoded in `params`/plan data. | **C — collection exists; field mapping is stale/partial** | Calculate/display only from validated stored fields; use unknown/absent states honestly. Any persisted new field requires a separate migration approval. |
| Admin `settings_public` settings + `labels: admin` | `settings_public` exists for pricing only. Current `AdminLayout` does a client-side label check; `/api/admin/*` and `approve-topup` do server-side label checks. No IPA, pending cap, or admin-team setting UI was found. | **C — pricing and server checks exist; settings scope is missing** | Continue using server checks for protected behavior. New settings and controls require owner approval and permissions review. |

### Incorrect/outdated handoff assumptions found

- `settings_public.ipa`, `deliveredCount`, `requestedCount`, `/dashboard/chat/[id]`, and live Appwrite Realtime are not established by current code/schema.
- “Signed download URLs” is not the current client behavior; the app uses Appwrite Storage download/view methods under existing access controls.
- The prototype's sample top-up/job/user/analytics data is not real application data.
- The `0.085` calculator is explicitly a display example in the design handoff. Real quotes must continue to come from server pricing/capability logic.

## E — Interaction coverage

| Area | Working now | Gaps or risk |
|---|---|---|
| Landing | Route links, section anchors, FAQ toggles, example-template navigation, animated explanatory demo. The demo is visibly labelled as simulation. | No ask field/session-preserved question, chips/lens/magnet/cost slider/footer legal destinations. Demo “agree/start” and finish controls are simulated and must not be represented as a real job. |
| Login/register | Required email/password/name controls, password visibility button, minimum eight-character signup validation, Appwrite submission, loading and caught-error messaging, links between forms. | No forgot password, verification mail/state, resend cooldown, token callback, verification gate, or pending question transfer. Errors surface Appwrite messages; design's exact wording not applied. |
| User shell/chat | Auth redirect, paginated ledger sum, conversation list/search/new/select, assistant message send/retry, onboarding/profile, discovery answers, plan edits, server quote, explicit quote start, job events, result tabs/downloads, artifact edit/version undo, methodology request. | No offline state, theme, notification center, requests/settings/legal navigation in shell, designed four-step layout, persistent full-height reference shell, or deep-linked conversation ID route. Validate data/authorization through existing APIs; do not replace working calls with sample UI. |
| Quote states | Server supplies quote points and affordability; component shows expiry text; low balance links to top-up. | Designed shortfall-and-return route, refresh quote button and all exact states/copy/layout are incomplete. No client-calculated replacement quote. |
| Wallet/top-up | Pricing read, selectable presets/custom amount, reference field, optional accepted receipt file upload with client checks, Appwrite `submit-topup`, pending request history, ledger list/filter, copy configured payment address/phone, loading/error/success messages. Server enforces caller identity, pending cap, unique reference/receipt ownership, and status `pending`. | No sender name/phone, mandatory receipt, compression requirement, submitted detail screen/steps/realtime, reason for rejection, or design summary categories for reserved/monthly returned/spent. The receipt's optional status is enforced in both client and server today. Do not change it without backend/schema approval. |
| Jobs/results | Polling list, filters/search, event expansion, status, real row count, reserved/charged points, download controls with loading/error, re-run order. Failure text states full reservation was released. | Design filters/labels differ; no lifecycle promise or cleanup evidence for “download for 90 days”; no retry action that repeats same plan from a saved plan record was verified. |
| Admin top-ups | Filter tabs, reload, loading/empty/error/success feedback, view receipt, approve and reject actions. Server approval validates admin label and updates ledger/row. | UI query uses the browser Appwrite SDK and relies on table/row permissions; route layout gate itself is client-side. There is no detail sheet, sender fields/mismatch, rejection reason, confirmed-amount editor, two-step rejection, bulk select/CSV or audit record. Financial action path is real. |
| Admin provider endpoints | Three API routes have server-side admin-label authorization. LLM status reveals configured/provider/model/status metadata; it does not return a full provider key. | No provider settings screen/write endpoint. Smoke route invokes the shared provider smoke tests and may cause real external calls. It was not called. No key/environment write, toggle, or deployment operation was attempted. |
| Settings, legal, notifications | None of these product screens are implemented. | Name/password/preferences, account deletion, legal copy, unread counts, realtime notification reads, email delivery, and message/read controls all need new functionality. Account deletion and legal publishing are sensitive/destructive/review-gated. |

**Authorization gap to preserve in the plan:** client-side `/admin` layout gating is useful for UX but not a server guard. The three existing admin API routes and `approve-topup` do server checks. Keep these distinctions in any future review; do not claim every admin page route is server-protected based on the client layout.

## F — File change plan

The following are **expected implementation files only**, grouped by future PR. This audit changes none of them. The list may be refined after the owner approves the audit and each focused PR is scoped.

| Future PR | Existing files likely to change | New files likely to be created | Scope |
|---|---|---|---|
| 1. Tokens, typography, brand, themes | `src/app/globals.css`, `src/app/layout.tsx`, and any existing shared UI primitives actually affected | Copy supplied SVGs under `public/brand/` using their source names; add `src/app/icon.svg` for App Router favicon metadata | CSS-first tokens; supplied fonts/brand assets; light/dark preference and reduced motion. No business logic. |
| 2. Landing and motion | `src/app/page.tsx` | `src/components/HeroLens.tsx`; keep other markup in existing page unless implementation needs a separately reviewed component | Match supplied landing copy/layout/hero/sections. Connect ask to real auth/chat routes without starting jobs. |
| 3. Auth states | `src/components/AuthLayout.tsx`, `src/app/login/page.tsx`, `src/app/register/page.tsx`, `src/hooks/useUser.tsx` | `src/app/verify/page.tsx`, `src/app/forgot-password/page.tsx`, `src/app/reset/page.tsx`; focused account callback helper if required | Appwrite verification/recovery, saved question handling and verified-email gate only after API behavior/config is approved. No passwords or tokens in logs. |
| 4. User shell/navigation | `src/app/dashboard/layout.tsx`, `src/app/dashboard/chat/components/ChatSidebar.tsx`, `src/app/dashboard/chat/page.tsx` | No new route is required for the existing shell. Add a focused component only if it can be reviewed independently. | Design shell, mobile drawer/navigation, route links and account menu. Retain existing auth, balance pagination, chat, and logout behavior. |
| 5. Research chat states | `src/app/dashboard/chat/page.tsx`, `src/app/dashboard/chat/components/DiscoveryCard.tsx`, `PlanQuoteCard.tsx`, `ActivityTimeline.tsx`, `ResultsCanvas.tsx` | only small state/presentation components needed | Visual mapping and accurate loading/empty/error/low-balance/expired/failed views. Reuse current server endpoints and event sources. |
| 6. Wallet display (frontend-only scope) | `src/app/dashboard/topup/page.tsx`, `src/components/ui.tsx` if shared controls need styling | wallet-specific presentation components as needed | Restyle real balance/ledger/top-up flow using fields already supported. Sender identity/required-receipt/rejection reason are deliberately outside this PR until backend approval. |
| 7. Requests, settings, legal | `src/app/dashboard/jobs/page.tsx`; shared shell links if not completed in PR 4 | `src/app/dashboard/settings/page.tsx`, `/legal/terms/page.tsx`, `/legal/privacy/page.tsx`; required API helpers only if separately approved | Restyle existing jobs and add only separately approved settings/legal behavior. Legal draft must not be published without legal review. |
| 8. Admin shell and existing top-up review | `src/app/admin/layout.tsx`, `src/app/admin/topups/page.tsx` | admin shell/detail components | Match shell and the currently supported top-up fields/actions. Do not change approvals, reject schema, table permissions or ledger behavior in visual PR. |
| 9. Admin overview/users/jobs/revenue | Existing `src/app/admin/layout.tsx`; new `src/app/admin/page.tsx`, `users/page.tsx`, `jobs/page.tsx`, `revenue/page.tsx` | Candidate read APIs: `src/app/api/admin/stats/route.ts`, `users/route.ts`, `activity/route.ts`, `revenue/route.ts`; exact contracts require approval | Requires owner-approved data contracts, server-side authorization, pagination/query design, and reliable metric definitions. Keep separate from UI-only PRs. |
| 10. Providers/system configuration/audit | `src/app/api/admin/llm-status/route.ts`, provider routes only if specifically approved | Candidate server-only function path `src/functions/admin-update-env/src/main.ts`, plus approved audit/cost schemas and admin pages; any `appwrite.json` change is separately blocked | High-risk infrastructure, credential, external-call, and permission scope. No frontend/browser key writes. Separate explicit approval required. |

## G — Backend and database gaps

No gap below was implemented. `[BLOCKED]` means the change requires explicit owner approval under the supplied financial, permission, infrastructure, or secret guardrails.

| Proposal in handoff | Current equivalent | Required change / risk | Disposition |
|---|---|---|---|
| Add `senderName`, `senderPhone`; validate on server; require receipt | Current `submit-topup` validates amount/reference and optional `receiptFileId`; current table schema has optional receipt and no sender fields. | Change Function schema, table schema/indexes, client form/upload validation and migration/permissions. Alters a live payment-submission contract; receipt optionality changes. | **[BLOCKED — owner approval]** Keep out of visual PR. |
| Add `topups.rejectReason` and required reason on rejection | `approve-topup` currently accepts approve/reject; rejects update only status/reviewer/time. | Schema and function/client payload changes; user-visible reason/notification behavior. | **[BLOCKED — owner approval]** No rejection behavior changed. |
| Admin stats/users/activity/monthly endpoints | No equivalent aggregate endpoint; current admin APIs are provider status/balance/smoke only. | New admin-only server queries, Appwrite Users data, pagination, query bounds, metric definitions and privacy constraints. Never expose server key or provider costs to customers. | **[BLOCKED — owner approval]** First define sources and formulas. |
| `notifications` table and Appwrite Messaging/email | No app notification route/table found. | New table, indexes, permissions, create/read functions, email channel, preferences, realtime subscriber, failure/retry behavior. | **[BLOCKED — owner approval]** Requires database/permissions and Messaging configuration. |
| `admin_audit_log` append-only history with IP | No equivalent table/log UI found. | New server-only append-only collection and write paths for approvals/rejections/configuration/login; IP is sensitive operational data and needs retention/access policy. | **[BLOCKED — owner approval]** Permissions and privacy review needed. |
| `provider_costs` per TREG/LLM call and profit metrics | Existing `job_calls`, `llm_usage`, `providerSpend` and provider-balance code cover some call/usage data; no exact unified `provider_costs` schema was found. | Reconcile definitions and ensure captured cost is actual/traceable, non-customer-readable, and no provider details leak into customer surface. | **[BLOCKED — owner approval]** Do not claim profit from estimates. |
| Provider key updates, `LLM_ENABLED`, `LLM_PROVIDER`, `TREG_LIVE`, model/base URL | Read-only status/balance and smoke endpoints exist; no safe update operation found. | Updating Appwrite Function environment and restarting/redeploying is an infrastructure mutation. Risk of secret disclosure or paid external calls. | **[BLOCKED — explicit owner approval]** Never send full keys to browser; never run smoke test in this audit. |
| Account deletion after 30 days | No endpoint/function/scheduled cleanup found. | New authenticated deletion request, cancellation policy, delayed scheduler, file/session deletion and privacy/retention handling. Destructive user-data operation. | **[BLOCKED — explicit owner approval]** No implementation. |
| Email verification/recovery and verified-user gate | Appwrite account creation/login exists; no routes or `emailVerification` gate found. | Appwrite account callback URLs, mail delivery configuration, route/state handling and server-enforced checks before quote/top-up/job submission. | **[NEEDS APPROVAL / CONFIG REVIEW]** Safe UI alone cannot enforce the business/security gate. |
| 90-day result retention claim | Downloads exist; no corresponding deletion/lifecycle function or retention policy found in checked repo config. | Storage lifecycle or scheduled cleanup and user-facing accurate expiry. Infrastructure and data-deletion policy. | **[BLOCKED — owner approval]** Do not display a 90-day guarantee until verified. |
| Admin server authorization | APIs/functions listed above enforce admin labels; page layout is client-side. | New APIs must independently verify current Appwrite identity and admin label. A route UI check is not authorization. | **Required acceptance criteria**; no infra change in this audit. |
| Mutable pending-top-up cap | `submit-topup` enforces a fixed maximum of 3; setup schema has no corresponding `settings_public` field. | Would add a server-read setting, validation/default policy and database attribute. Affects financial request handling. | **[BLOCKED — owner approval]** Keep existing cap and behavior. |
| Jobs `deliveredCount`/`requestedCount`, `refunded` status | Current schema has `rowsCollected`, reserved/charged credits, statuses without `refunded`; release is a ledger movement. | Adding schema fields/status requires migrations and lifecycle/worker changes; status can misstate financial outcome. | **[BLOCKED — owner approval]** Map existing values first; never add status for appearance alone. |

## H — Visual verification plan

Once the reference can be rendered under an allowed browser workflow and implementation PRs are approved:

1. Capture approved reference and app screenshots at **390px** and **1280px** for each approved screen/state.
2. Repeat for **light and dark** themes, and for desktop/mobile navigation layouts.
3. Compare component crops side by side: header/nav, hero, inputs, cards, quote, activity, wallet, sheets/drawers, admin charts/tables, empty/loading/error/success states.
4. Verify Arabic copy against source text character-for-character; inspect RTL order, punctuation, numeric formatting and mixed-direction email/IDs.
5. Verify supplied SVG logo/mark/favicon asset use without modification.
6. Exercise keyboard focus, visible focus treatment, 44px tap targets, minimum 16px mobile inputs, reduced-motion behavior, and mobile keyboard/visual viewport handling.
7. Exercise every action against local fake fixtures or mocked Appwrite boundaries. Do not execute a real research job or call paid/provider APIs.
8. Measure the motion-heavy hero under reduced-motion and low-device conditions; confirm the prototype's single-rAF/CSS-variable design is met without frame-by-frame React state updates.

**Current evidence:** no screenshots were produced. The bundled reference was not browser-rendered because the browser security policy rejected its local file URL and prohibited alternate access workarounds. Static source inspection is useful for structure/tokens/copy but does not establish pixel fidelity, responsive visual correctness, animation quality, or real prototype behavior.

## I — Ordered implementation roadmap

Each row is a proposed pull request, not implementation authorization. Every PR must remain small, keep real behavior connected, and have its own tests/visual evidence.

| PR | Scope / expected files | Functional acceptance tests | Dependencies | Risks |
|---|---|---|---|---|
| 1. Design foundation | `globals.css`, `layout.tsx`, supplied SVG assets in `public/brand`, icon route | Token assertions; light/dark persistence/system default; font and RTL checks; reduced-motion; screenshot crops at 390/1280. | Owner accepts audit and browser reference access is available. | Global CSS can regress every route; preserve Tailwind v4 CSS-first setup. |
| 2. Landing | `src/app/page.tsx`, new `HeroLens.tsx`/focused components | Ask link routes correctly and preserves only the question; suggestion chip fills/focuses; non-functional example cost is clearly illustrative; no fake job; motion/reduced-motion and screenshots. | PR 1. | Existing landing template navigation/demo must not break or misrepresent production behavior. |
| 3. Auth | auth layout/login/register and new verification/recovery routes/helpers | Register/login errors; verify success/failure/resend cooldown; recovery gives same response for known/unknown email; protected work blocked until verified; saved question consumed once. | PR 1; Appwrite callback/mail configuration contract. | Account security and email-delivery configuration; confirm callback routes before launch. |
| 4. User shell | dashboard layout, chat sidebar/page, shared nav | Correct existing route destinations, mobile drawer, selected state, role-gated admin link, logout; accurate balance/loading/error; keyboard and RTL checks. | PR 1; PR 3 only if shell assumes verified-user state. | Existing chat is a separate full-screen shell; avoid duplicate navigation or auth regressions. |
| 5. Research chat | chat page and existing discovery/quote/timeline/results components | Real quote and explicit approval still required; reject expired quote; insufficient balance uses real shortfall; failed jobs render actual release; result downloads only real files; polling/loading/error states remain truthful. | PR 1 and PR 4. | Money/quote/job behavior: presentation changes only; no ledger/quote changes. |
| 6. Wallet (existing contract) | top-up page/shared controls | Real current balance; form validation/error/success; existing pending cap and unique reference errors; receipt optional exactly as existing contract; ledger type mapping; no client ledger writes. | PR 1 and PR 4. | Financial page; no changes to amounts, pricing, receipts, or approval operation. |
| 7. Requests, settings, legal UI | jobs page; new settings and legal pages | Jobs filters/counts and downloads match real states; profile/preferences calls only if implemented/approved; legal copy review before publication; account delete requires separate approval. | PR 1, PR 4; legal review / any required API approval. | Draft legal copy and destructive deletion behavior. |
| 8. Admin shell + top-ups visual pass | admin layout/topups page and UI components | Client shell UX plus independent server checks; pending/approved/rejected/load/error states; only currently supported action payloads; permissions keep user/admin visibility. | PR 1; endpoint policy unchanged. | Real approval/rejection affects money; no action-contract changes in visual PR. |
| 9. Admin metrics/users/jobs/revenue | new admin pages/components/APIs | Server-side admin authorization; pagination and query bounds; metric reconciliation; no provider fields shown to customer; access-denial tests; mock-backed data states. | Owner-approved definitions/schema/query capacity; PR 8. | Financial reporting, PII, data access and cost estimates. |
| 10. Providers, system settings, audit/cost | separately approved server functions/APIs/schema/UI | Tests prove secrets never serialize; only last4/configured in browser; admin authorization, audit append-only semantics, no provider call unless explicitly capped/approved. | Separate owner approval for infrastructure, credential handling, external calls and permission/schema work. | Highest risk: secrets, deployments/restarts, paid third-party calls, provider identity/cost leakage. |

**Excluded from this roadmap unless separately authorized:** Goodwill compensation and dependent-plan functionality, both explicitly excluded by the handoff's project guardrails.

## J — Blockers and unresolved scope

1. **Reference rendering:** browser access to the local HTML was denied by tool policy; therefore exact visual pixel comparison, interactive behavior, and reference screenshots remain unverified. No workaround was attempted. This is the primary fidelity blocker.
2. **Missing archive:** the expected ZIP was absent. The constituent README/WIRING/source/assets were present in the folder, so source review could continue.
3. **Unverified remote state:** this was a local repository audit only. Current deployed Appwrite tables, row/table permissions, function environment, Sites configuration, mail setup, storage retention, and production traffic were not read or changed.
4. **Owner approval required:** new/changed money flows, top-up identity fields, required receipt, reject reason, financial analytics, database tables/indexes/permissions, provider configuration/key writes, smoke tests, cost logging, audit IP retention, email notifications, account deletion scheduling, and storage cleanup.
5. **Legal review:** reference terms/privacy text is a draft. Do not publish it as final legal terms without review.
6. **External contact destination:** WIRING suggests `support@digr.app` or WhatsApp and explicitly leaves the final link to the owner. Current support destination was not verified; don't ship a guessed link.
7. **Configuration facts:** WIRING's `settings_public.ipa`, `requestedCount`, `deliveredCount`, realtime subscription and chat-ID route do not match repository schema/routes found. These require mapping to the real data contract, not assumptions.
8. **Baseline TypeScript check:** standalone `npx tsc --noEmit` currently reports 9 diagnostics in existing tests (details in baseline results below). The production Next build passed its own application type-check. No code was changed to hide these diagnostics.

## Baseline verification results

| Check | Result | Evidence / limit |
|---|---|---|
| Working tree before audit doc | Clean for tracked files | Only the pre-existing untracked `New UI/` handoff directory was present; left untouched. |
| `npm ci` | Pass | 337 packages installed. npm reported 6 dependency audit findings (2 moderate, 2 high, 2 critical); no dependency or lockfile changes made. |
| Test safety review | Pass | Vitest suites use mocked `fetch`/mock tables for provider and Appwrite boundaries. Live/e2e mutation scripts are under `scripts/` and are not invoked by `npm test`; none were run. |
| `npm test` | Pass: **44 files, 368 tests** | `vitest run`, local suite. |
| `npx tsc --noEmit` | Fail: **9 diagnostics** | Existing test type mismatches: `claude-brain-phase-b.test.ts` (2), `clean-user-surface.test.ts` (1), `example-templates-phase5.test.ts` (1), `open-assistant.test.ts` (1), `stuck-reservation-phase6.test.ts` (3). Application source was not changed. |
| `npm run build` | Pass | Next.js 15.4.8 compiled, generated all 16 static pages, listed expected existing routes, and the post-build client bundle scan checked 42 files and found zero secrets. No live job/provider calls were made. |
| Diff / changed-file scope | Audit document only after commit | `package-lock.json` remained unchanged. `New UI/` remains untracked and is excluded from the commit. |

The 44-test suite covers (among other areas) ledger/release-first invariants, quote hashing/expiry, auth/rate limits, LLM trust boundaries and mocked providers, Appwrite permission contracts, job execution/recovery, honest display, result review/download contracts, wallet journey simulation, and redesign guardrails. Tests/scripts explicitly targeting live Appwrite/production mutations (`scripts/test-*`, cleanup, setup/deploy, live E2E, provider smoke) were not run.

## Evidence paths

- Repository baseline: `README.md`, `docs/HANDOFF.md`, `package.json`, `package-lock.json`, `next.config.mjs`, `postcss.config.mjs`, `src/app/globals.css`, `appwrite.json`.
- Design contract: `New UI/design_handoff_digr_redesign/README.md`, `WIRING.md`, `design/Digr Final.html`, `design/source/Digr V7 Still Lens.dc.html`, `design/source/Digr Admin.dc.html`, `design/source/support.js`.
- Core implementations: `src/hooks/useUser.tsx`, `src/components/AuthLayout.tsx`, `src/app/dashboard/layout.tsx`, `src/app/dashboard/chat/page.tsx`, `src/app/dashboard/chat/components/`, `src/app/dashboard/jobs/page.tsx`, `src/app/dashboard/topup/page.tsx`, `src/app/admin/layout.tsx`, `src/app/admin/topups/page.tsx`, `src/app/api/`, `src/functions/shared/ledger.ts`, `src/functions/shared/quoteAccept.ts`, `src/functions/create-job/src/main.ts`, `src/functions/submit-topup/src/main.ts`, `src/functions/approve-topup/src/main.ts`, `scripts/setup-db.ts`, `tests/`.
