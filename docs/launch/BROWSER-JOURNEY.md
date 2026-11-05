# Real-Chromium journey of the Stage 4 paid flow (5 Nov 2026) — FAKE money, FAKE providers, NOT production

**Evidence class: fake-browser test. It is NOT an authenticated production test and does not make the platform launch-ready.**

## What it is
`scripts/browser-journey/stage4-journey.browser.ts` (not in the default suite; excluded from `tsc`; run with the config next to it).

- **Real:** the built Next app (`next start`), real Chromium via Playwright at **desktop 1280×900** and **phone 390×844** (iPhone user agent, touch, 2× DPR), the real request page and its Stage 4 components, the browser's real `fetch`.
- **Fake:** the sign-in service and the two tables the page reads (a tiny local HTTP server; the browser carries a fake session cookie); every `/api/*` answer is produced by the **real route handlers** running over the shared fake world: hardened fake money core (fake wallet), fake storage, and the **real worker add-on runner**. No network, no provider, no real points.

Run (from a built tree, `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399` at build time):
`APP_DIR=$PWD npx vitest run --config scripts/browser-journey/vitest.browser.mts`

## Result on the integrated Stage 4 tree (head `4660c2fd`, before this doc): 32 of 32 checks passed (16 desktop, 16 phone)

| # | Check (each run at desktop and phone) |
|---|---|
| 1 | the details page opens for the signed-in customer |
| 2 | VERSIONS: version 1 is listed |
| 3 | REVIEW QUOTE shown, nothing held |
| 4 | REVIEW REQUEST prepared unpaid, then the approval control appears |
| 5 | REVIEW APPROVAL with a **double click**: exactly one hold (one approval POST) |
| 6 | worker runs the review: report published, one charge, release first |
| 7 | review charge = the shown price, balance correct |
| 8 | EDIT QUOTE (rename a column) and EDIT REQUEST unpaid |
| 9 | EDIT APPROVAL: one hold; worker publishes **version 2**; charge ≤ hold; release first |
| 10 | NEW FILE VERSION listed; version 2 downloads as a real Excel; version 1 unchanged |
| 11 | FINAL BALANCE = start − the two charges, never negative, ledger ids unique |
| 12 | no uncaught page error |
| 13 | **NOT ENOUGH POINTS**: refused in words («رصيدك لا يكفي»), nothing held, request stays waiting **with its approve button and cancel**, no «possibly paid» mark (fix #421) |
| 14 | after a top-up the **same** request is approved: one hold, charged once |
| 15 | **LOST ANSWER** (the server holds the points, the browser never hears): the page says «قد تكون نقاطك حُجزت», never «nothing was held» |
| 16 | the worker finishes the held request: one hold, one charge, release first, balance = start − charge |

Also exercised in the browser: refresh (page reloads keep state), failed requests (aborted approval answer). Pages and requests were served with the real handlers' ids, status words and Arabic text.

## What this run does NOT cover (stated honestly)
- **Ask → plan → customer quote → approval → reservation → worker execution → live progress → completed Excel and CSV → methodology** of the *research mission itself* is **not** driven in Chromium: the harness answers `GET /api/missions/:id` with 404 (the mission card shows its loading state) and does not run the research planner/worker. That part is covered by non-browser tests over the same fake money core: `tests/integration-stage2-3-4-flags.test.ts` (same companies mission under all flag combinations, money identical, live DONE snapshot = file cell by cell), `tests/launch-e2e-approval-journey.test.ts`, `tests/stage4-e2e-*.test.ts` (flows 1–10), and the Round 32/35/36/37 Excel-equals-CSV cell-by-cell tests on stored real rows.
- The earlier rounds' browser runs of the Stage 2 live sheet and the phone counter (`docs/INTEGRATION-STAGE-2-3-4.md`) used a different, uncommitted harness; they are **not** re-run here.
- Concurrent approvals from two tabs, worker crash and restart, and provider failures are covered by route/worker-level tests (`tests/stage4-concurrency-*.test.ts`, `tests/safety-*`), not in the browser.
- No real Supabase, no real Vercel preview session, no real wallet, no real provider, no physical phone: **UNVERIFIED** until the controlled pilot.
