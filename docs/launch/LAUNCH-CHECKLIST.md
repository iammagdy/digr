# Diger launch checklist (Stage 2 + Stage 3 + Stage 4) — gated, evidence-based

Legend: **READY** = verified with evidence named here; **BLOCKED** = cannot proceed until the named decision/action; **UNVERIFIED** = nothing available to us proves it. Written from the repository state of 5 Nov 2026 (main `0728e06f`; integration rehearsal `integration/rehearsal-r4-main-0728e06f`). Nothing in this file has been executed against production. **No live rollout starts before every gate in section 11 is signed.**

## 0. Principles

- Only reviewed PRs reach `main`. No direct push, no force push, no merge by the preparing agent without the gate set below passing.
- Money, SQL, infrastructure and provider spending need the owner's explicit yes (section 11).
- Every flag is OFF unless the variable is exactly `on` (or `test` where the stage supports it). Rollback of any feature = unset its flag.
- A test file that cannot load is reported as such (see `ROUND37-HISTORICAL-TEST-EXCEPTION.md`): the suite is never called «fully passing» while it exists.

## 1. GitHub: changes merged via reviewed PRs only

| # | Item | Status | Evidence / reason |
|---|---|---|---|
| 1.1 | Round 37 gap resolved by the owner's decision E-37 (a/b/reject) | BLOCKED | needs the owner's signature (`ROUND37-HISTORICAL-TEST-EXCEPTION.md` §6); main has one uncollectable test file until then |
| 1.2 | Stage 2 stack: #369 ← #406 ← #408 ← #409, rebased on the then-current main, 5 conflict files resolved (`docs/INTEGRATION-STAGE-2-3-4.md` §2, and the main-card resolution in `docs/STAGE-2.md` §14) | BLOCKED | PRs exist as DRAFT; a rebased integration PR must be created and reviewed |
| 1.3 | Stage 3: #370 on main+Stage 2, resolve `workbook.ts`, `customerView.ts`; re-record the 3 file digests in `tests/fixtures/stage3-flags-off.json` (proved identical on plain main) | BLOCKED | same |
| 1.4 | Stage 4 chain #371 … #404 bottom to top, conflicts at #371/#381/#388, FLOW 10 fix at #394 | BLOCKED | and the owner decisions of `docs/STAGE-4-APPROVAL-BOUNDARY.md` §6 |
| 1.5 | F-4 regression pin (#410, tests only) | READY | 3 tests, completed card = Excel denominator on stored real rows |
| 1.6 | Approval route (#411) and button, on #404 | BLOCKED | DRAFT, financial: needs independent review + owner |
| 1.7 | Boost workstream (`ccr-05abe766-375qtc*`) untouched, merged by its own owner | UNVERIFIED | not ours; verify no overlap before each merge (`git diff` of the touched files) |
| 1.8 | **Exact production merge SHA recorded** in this file's §12 | BLOCKED | filled after the last merge |

Gate to merge a non-financial PR automatically (Stage 2, Stage 3 integration PRs only): the full suite run reports `0 failed` AND the uncollected-file line states E-37 as agreed; both typechecks (`tsc --noEmit`, `npm run agent:typecheck`) clean; `next build` exit 0; client-bundle secret scan clean; scope review clean (no money file, no `supabase/**`); no other active branch touching the same files. Anything with money, SQL or a worker/infra change is never auto-merged.

## 2. Vercel (site) — verified against the exact SHA

| Step | How (read-only) | Pass condition | Status |
|---|---|---|---|
| 2.1 Preview of the final integration SHA | Vercel MCP `list_deployments` (project `digr`), then `get_deployment` | `state: READY`, `meta.githubCommitSha` equals the PR head SHA, `target: null` (preview) | READY for earlier SHAs (#409 `878b887d`, r4 `dbc8433f` were READY); the final SHA is UNVERIFIED until built |
| 2.2 Production deployment after merge | `list_deployments` filtered to production; `get_deployment` | `target: production`, `state: READY`, `githubCommitSha` == the recorded merge SHA, `readyState` READY, no build error in `get_deployment_events` | UNVERIFIED (no production deploy yet) |
| 2.3 Runtime errors after deploy | `get_runtime_errors` for the deployment, 30 min after | zero new error signatures on `/api/missions/*`, `/dashboard/requests/*` | UNVERIFIED |
| 2.4 Env vars needed | owner confirms names only (never values): `DIGER_STAGE2_*`, `DIGER_STAGE3_*`, `DIGER_STAGE4_*` all unset at first deploy | all unset | UNVERIFIED |

## 3. Heroku worker — verified against the exact SHA (the owner runs these; we have no access and must never receive secrets)

The worker runs `agent/` and must contain: Stage 2 snapshot writer, Stage 3 companies planning, Stage 4 add-on dispatch (`runAddon`), the unrecorded-hold fix (#404). Run on the owner's machine and paste **only the shown lines**:

```
heroku releases -a <worker-app> -n 5
heroku releases:info <version> -a <worker-app>        # shows the deployed commit / slug description
heroku config -a <worker-app> --shell | sed -E 's/=.*/=<hidden>/'   # NAMES only; never paste values
heroku ps -a <worker-app>                              # the worker dyno is up
```

Pass: the latest release's commit equals the recorded merge SHA; config names include the same `DIGER_STAGE*` names as Vercel (the worker reads the flags too; for Stage 2/3 `test` mode the worker writes the test marker); `ps` shows the worker `up`. Then in `/admin` the worker heartbeat is fresh (the queue line shows `workerAlive`). **Status: UNVERIFIED (no access); BLOCKED for Stage 4 until done.**

## 4. Supabase: migrations and financial checks (owner approves each SQL; we only read)

| Item | Status | Detail |
|---|---|---|
| Migration list | READY (read-only, 5 Nov) | newest applied `20261017184147`; `20261104222136_one_open_addon_per_file.sql` is **not applied**. Re-read with Supabase RO `list_migrations` immediately before and after |
| `20261104222136_one_open_addon_per_file` | BLOCKED | creates ONE partial unique index on `missions` (`plan->'addon'->>'of'`, deny-list of ended statuses); never updates/deletes/inserts rows; preconditions stop it if a file already has two open add-ons. Verified on a disposable PostgreSQL 16 (`docs/STAGE-4-ONE-OPEN-ADDON-INDEX-VERIFICATION.txt`). Needs the owner's yes; only needed before `DIGER_STAGE4_APPROVAL` |
| Pre-check SQL (read-only) | READY to run | (a) the migration's own conflict query: files with two open add-on rows must be 0; (b) `select count(*) from credit_ledger group by …` style checks below |
| Financial invariants before and after any pilot | READY to define | **ledger sum = balance** for every user touched (`sum(delta)` over `credit_ledger` per user equals the wallet balance); **no negative balance** (`min(balance) >= 0`); **no stuck hold** (no `jobs` row `reserved`/`running` older than the lease with no worker claim; every `res_<job>` has exactly one `rel_<job>` or `chg_<job>` when the job is terminal); **charge ≤ reserve** per job; **no duplicate ids** in the ledger |
| Executing these checks | UNVERIFIED | exact table/column names must be confirmed against the live schema by the owner or a read-only session before the pilot; this file does not guess them |

## 5. Feature flags — controlled sequence (all default OFF)

| Order | Flag | Values | Turns on | Test mode | Notes |
|---|---|---|---|---|---|
| 1 | `DIGER_STAGE2_ASK_CARD` | `on` / `test` / off | «فهمنا طلبك» card + its edit action | yes (worker writes a marker; site reads it) | no money |
| 2 | `DIGER_STAGE2_QUESTION_CARDS` | same | up to three question cards before planning | yes | no money |
| 3 | `DIGER_STAGE2_LIVE_SHEET` | same | worker live snapshots, polling route, live sheet UI (+ F-2 one phone counter) | yes | no money; adds storage writes (throttled 1 per 5 s per mission) |
| 4 | `DIGER_STAGE3_COMPANIES` | same | companies plan by code + attempts/gap lines in the file | yes | owner decision 15 (industry words) before `on` |
| 5 | `DIGER_STAGE3_QUEUE` | same | the new queue line | yes | display only |
| 6 | `DIGER_STAGE3_EMAIL_NOTICE` | same | one-e-mail-per-job decision | yes | touches e-mail volume: after §9 is understood |
| 7 | `DIGER_STAGE4_VERSIONS` | `on` / off | file versions list + `?version=N` download; worker writes version 1 | **site serves `on` only** | read-only |
| 8 | `DIGER_STAGE4_REVIEW` | `on` / off | review quote preview, create/cancel a review request, review report | **`on` only** | creates UNPAID requests only; nothing can approve them until 9 |
| 9 | `DIGER_STAGE4_EDITS` | `on` / off | edit request (quote, create, cancel) | **`on` only** | same |
| 10 (last) | `DIGER_STAGE4_APPROVAL` (new, PR #411) | `on` / off | the approval route (money: reserves points) | **`on` only** | needs worker + migration + owner yes |

Rules: one flag at a time on a **test account** (Stage 2/3 `test`), observe 24 h or one full journey before the next. Stage 4 customer routes cannot be limited to test accounts (customer code never imports the test-account list): enabling 7–10 means **every** customer; OWNER DECISION: a supervised short window with `on`, or a small server-side test-account gate on the approval route. Do not set 8/9 without 10's prerequisites (a customer could prepare a request nothing can approve — `docs/STAGE-4-APPROVAL-BOUNDARY.md` §7). Flags are read from the environment: the site (Vercel) and the worker (Heroku) must both be set and redeployed/restarted.

## 6. One bounded real test-account journey (after all prerequisites; simulated money until the owner authorizes this)

Account: a test account (`@digr.local` or the owner's `iam.magdy+N@outlook.com` per `src/lib/server/testAccounts.ts`). Balance noted before (B0).

| Step | Action | Expected | Check |
|---|---|---|---|
| 1 Ask | type a small request (e.g. «٥ تعليقات عن …» or the 2-video/20-comment TikTok shape) | the «فهمنا طلبك» card (Stage 2) | text is Arabic, fields editable |
| 2 Plan/Quote | plan appears with a points price P | price line = `priceMissionByCode` | no points moved (B0 unchanged) |
| 3 Approve | approve once | hold of P recorded; queue line | B0 − P; one `res_` row |
| 4 Execute/Live | watch the live sheet (desktop + phone width) | one counter «X من N» on phone (F-2), card status line unchanged; rows grow | refresh mid-run keeps state; N equals the Excel's promised |
| 5 Deliver | completion | card line «تم تسليم X من N» | equals Excel first sheet and the live DONE snapshot |
| 6 Download | Excel, CSV, methodology CSV | files open; ids are text; Arabic intact | **Excel = CSV = live sheet = card** on counts and ids; open the XLSX once in Excel for Android (closes risk 1 of E-37 only if done) |
| 7 Settle | wallet history | charge ≤ hold; release row before charge; balance B0 − charge | ledger sum = balance |
| 8 Review quote | on the delivered file, request a review | quote = 1 point/100 cells, min 100; nothing held | B unchanged |
| 9 Approve review | approve (flag 10 on) | exactly one reserve = shown hold; double-click does not double hold | one `res_` |
| 10 Review report | wait | «نتيجة مراجعة الملف» published; charge ≤ hold | report is in storage; no second charge on reload |
| 11 Edit quote | request one supported edit (e.g. rename a column) | fixed 100-point estimate/hold | B unchanged |
| 12 Approve edit | approve | one reserve | |
| 13 New version | wait | version 2 listed and downloadable; **version 1 byte-identical to before** | digests |

Expected points for the smallest pilot: review ≈ 100, edit = 100, plus the research mission's own price P. **Status: UNVERIFIED** (never run end to end on real services).

## 7. No critical customer-visible failures — what to watch

| Signal | Where | Threshold to stop and roll back |
|---|---|---|
| Runtime errors on `/api/missions/**`, `/dashboard/requests/**` | Vercel `get_runtime_errors` / logs | any new 5xx signature after a flag change |
| Stuck missions (`executing` with a stale lease), worker heartbeat | `/admin` agent page | a mission quiet beyond the stall limit |
| Ledger anomalies | read-only SQL of §4 | any negative balance, orphan `res_`, charge > reserve → stop at once |
| Customer-facing wording defects | the journey of §6 | any English/internal id/provider name in Arabic UI; «لم يُحجز» said where a hold may exist |
| E-mail failures | worker/site logs `[email:send_failed] reason=…` | repeated `function_unavailable` / `resend_rejected` |

## 8. ROLLBACK, per layer

| Layer | Rollback | Held points |
|---|---|---|
| Any feature | unset its `DIGER_STAGE*` variable on Vercel **and** Heroku, redeploy/restart. The UI draws nothing and the route answers 404 | A hold already made is always run to its end by the worker (`settleAddon`, release first); the customer never loses points for an interrupted add-on (watchdog + `recoverAbandonedAddon`) |
| Site code | Vercel instant rollback: `request_rollback` to the previous production deployment (or dashboard → Promote previous) | none |
| Worker code | `heroku rollback v<previous> -a <worker-app>` (owner) | an in-flight add-on is recovered from the job's own ledger state; never guessed |
| Migration | `DROP INDEX IF EXISTS public.missions_one_open_addon_per_file;` — the migration creates only that index (no data change); its own comment on the index states the same rollback | none |
| A stuck or uncertain approval | do not release by hand. Read the job's money state (`res_/rel_/chg_` rows); `released` ⇒ request ended, `held` ⇒ worker finishes or the watchdog releases | per ledger |

## 9. E-mail (see `LAUNCH-EMAIL-AR.md`)

Transactional e-mails already exist (`src/lib/server/sendPlatformEmail.ts` → Supabase Edge Function `send-email` → Resend). Enabling `DIGER_STAGE3_EMAIL_NOTICE` changes volume: confirm Resend plan limit (REDESIGN.md says 50,000 e-mails/month) before turning it on. A launch announcement has no template today (§ in the e-mail doc). Status: BLOCKED until the owner approves a template and a send.

## 10. Launch-feature classification (current evidence)

| Feature | Class | Why |
|---|---|---|
| Live research sheet (Stage 2) | UNVERIFIED | fake-API browser journeys 29/29 + 33/33 + 23/23 and unit tests pass; never on a real mission/preview with a signed-in account; not merged; worker not verified |
| One phone counter (F-2) | UNVERIFIED | same; tests + Chromium with emulated 390 px, not a real phone |
| Ask card / question cards | UNVERIFIED | not merged |
| Companies research + queue (Stage 3) | UNVERIFIED | fake-world tests only; owner decision 15 open |
| Downloadable Excel/CSV + methodology | READY | already on main (Rounds 32/35/36/37 tests; CSV from Excel), subject to E-37 |
| Completed text = Excel (F-4) | READY | #410 pin; production path proven on stored real rows |
| Versions list/download (Stage 4) | UNVERIFIED | not merged; read-only |
| Review report + review quote (Stage 4) | BLOCKED | unmerged; needs the approval route to be useful |
| Supported file edits + explicit approval | BLOCKED | approval route DRAFT (#411), button pending, worker/migration not done |
| Points reservation/settlement for add-ons | BLOCKED | fake-money tests only; no live run; owner-authorized pilot needed |
| Arabic methodology + progress messages | READY (main) / UNVERIFIED (Stage 2 live) | |
| Round 37 Android re-save compatibility | UNVERIFIED | original file unavailable; exception E-37 pending |

## 11. Owner-authorization gates

| Gate | Who says yes | Needed before |
|---|---|---|
| E-37 exception (a / b / reject) | Owner | any merge that claims a green suite |
| Merge of Stage 2 / Stage 3 integration PRs | Owner (or auto-merge only per §1 gate) | step 1.2–1.3 |
| Merge of the Stage 4 chain and #411 | **Owner** (financial) | any Stage 4 flag |
| Independent review of #411 and the money path | a second reviewer (not the author) | merge of #411 |
| Apply the migration | **Owner** (production SQL) | `DIGER_STAGE4_APPROVAL` |
| Deploy/verify the Heroku worker at the SHA | **Owner/infra** | Stage 2/3/4 flags that the worker reads |
| Set any production flag, in §5's order | **Owner** | each step |
| One bounded real-money pilot (budget in points, account) | **Owner** | §6 on real services |
| Test-account gate vs `on` for Stage 4 | **Owner** | flags 7–10 |
| Launch e-mail: template, audience, volume, cost cap, the send itself | **Owner** | any send |

## 12. Record (fill at launch)

Production merge SHA: ____________  Vercel deployment id/URL: ____________ (SHA matches: ☐)  Heroku release: ____________ (commit matches: ☐)  Migration applied at: ____________ (read-back: ☐)  Flags set (name, time): ____________  Pilot result: ____________  Rollback tested: ☐
