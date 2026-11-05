# Production acceptance test (5 Nov 2026): zero-cost part DONE, paid part BLOCKED (three named blockers)

Evidence labels: **VERIFIED** (source named), **BLOCKED** (cannot be done by this session; the exact reason is stated), **UNVERIFIED**. **Nothing was spent, applied, enabled or sent.** No sign-in was made, no mission was created, no flag was changed, no SQL was written, no e-mail was touched.

## 1. Baseline (verified at the start of this pass)

| Layer | Evidence | Status |
|---|---|---|
| `main` | `17318660c2fd8e35e9a59181f4279b7446035adc` (docs-only merge of #428; the last application-code merge is `0974bc82`, #424) | VERIFIED |
| Vercel production | GitHub deployment `7583475006` (Production) `success` 19:39:58 UTC at `17318660`; the previous production deployment `dpl_BuNC3AUqHWHvndPjrf3vkuMWdYPT` (`378825e6`) READY with no runtime errors; `https://diger.tech` answers 200 | VERIFIED |
| Heroku worker | GitHub deployment `7583309478`, environment `diger-agent`, `ref` = `17318660`, `success` 19:33:40 UTC; one worker beating in `agent_worker_heartbeat` | VERIFIED **at the release level only**. The dyno still reports `version = dev`; there is no Heroku API access, so the running commit and the config-var names (e.g. `DIGER_STAGE4_VERSIONS`) are **UNVERIFIED** |
| Migration `20261104222136_one_open_addon_per_file` | applied history ends at `20261017184147`; `pg_indexes` has no `missions_one_open_addon_per_file` | VERIFIED **not applied** |
| Flags | Vercel production env names (values never read): no `DIGER_STAGE2_*`, `DIGER_STAGE3_*`, `DIGER_STAGE4_*`; `agent_settings` keys: `redesign_flags`, `social_discovery` only. Everything is OFF | VERIFIED |

## 2. Zero-cost results

### 2.1 Real browser (Chromium, `https://diger.tech`, desktop 1280 and iPhone 13 390 px, `ar-EG`)
11 public pages × 2 viewports (`/`, `/login`, `/pricing`, `/calculator`, `/help`, `/contact`, `/services`, `/join`, `/legal/terms`, `/legal/privacy`, a non-existent path): **all 200 (the non-existent path 404 with the Arabic «الصفحة المطلوبة غير موجودة»), `lang=ar dir=rtl`, no horizontal overflow (scrollWidth = clientWidth in every case), 0 broken images, 0 console errors (the only one is the expected 404)**. The six protected routes (`/dashboard`, `/dashboard/requests`, `/dashboard/wallet`, `/dashboard/settings`, `/admin`, `/admin/jobs`) all land on `/login` when not signed in, on both viewports. The screenshots (home, login, pricing) read correctly right-to-left on the phone and on the desktop. The login form is **e-mail + password only** (no magic link, no OAuth, no one-time code).

### 2.2 Unauthenticated API probes (no cookie, no token)
`/api/admin/jobs`, `/api/admin/agent`, `/api/admin/topups`: **401** (Arabic message). `/api/missions`, `/api/missions/<id>`, `/api/jobs/<id>/download`, `/api/requests`: **401**. `/api/busy-status` and `/api/llm-enabled`: 200 public. `POST /api/admin/launch-email` and `GET /api/email/unsubscribe`: **404** (the launch-e-mail PR #425 is not merged and not in production: confirmed). The private storage buckets (`agent-missions`, `partials`, `results`, `receipts`, `avatars`) are all `public = false`.

### 2.3 Mission history and files, by read-only SELECT (the same data the signed-in pages read)
- The test account proposed for the paid test, `47693c59-89f1-405d-bec1-e72271517870` (balance **351**), has **no missions** (52 jobs of the older engine only). The account with mission history is `b0d08be8-db61-4860-841e-fa963045557e`: 215 missions: 145 completed (12,070 rows delivered, 31,599 points charged), 27 cancelled, 24 unserved, 17 failed, 2 plan_ready (no hold). **No active mission, no queued/running job in the last 7 days.**
- The three most recent delivered missions (`msn_1992a0fb…`, `msn_f6caeacd…`, `msn_44c89e92…`, 5 Nov, 5 rows each): `delivered_units` 5 = `jobs.delivered_units` 5; ledger `res_` −200, `rel_` +200, `chg_` −200 = `charged_points` 200 = `jobs.charged_credits`; storage objects exist for each (`result.xlsx` 11.7 to 13.6 KB, `result.csv` 2.2 to 5.9 KB); `files` lists exactly the two (xlsx, csv) with Arabic download names. (A methodology file exists only when the customer bought it: `chg_meth_*`.)
- Financial invariants re-run today: terminal jobs with an unreleased hold **0**; open holds on active jobs **0**; completed jobs whose ledger charge ≠ `jobs.charged_credits` **0**; negative balances **0** (lowest balance 351).

### 2.4 Observation (not fixed: a data change)
`/api/busy-status` returns `queueAhead: 9, position: 10` although nothing is running: `getBusyState` counts every `jobs` row in `queued`/`running`, and the 9 stale `vrun_…` verification fixtures of 12 Oct (no ledger rows) are among them. It only reaches a customer when busy mode is on (daily cap or low provider balance): the banner would then read «… قيد التنفيذ أو الانتظار الآن: ٩ …». Cleaning those 9 rows is a production data change that needs its own authorization.

## 3. What is BLOCKED, and exactly why

1. **Sign-in (blocks every signed-in check):** the login is e-mail + password. The session holds no password for any account, must not ask for one, and has no write-capable admin tool to mint a session. So these could **not** be done: the dashboard and request-history pages in a browser, opening delivered results, **downloading the real Excel/CSV/methodology and comparing cell contents, counts and ids**, mobile layout of the signed-in pages, and the PR1/admin screens behind login. (What was checked instead: the same rows by SELECT, §2.3, and the refusals without credentials, §2.2.) No substitute result is claimed.
2. **Authorization of the paid test:** the limits in the request are *proposed*. Setting the flags (Vercel), applying the SQL, using points and calling paid providers each need the explicit authorization text of `FINAL-PILOT-PACKAGE-2026-11-05.md` §8.
3. **Heroku (Stage 4 only):** the worker's `DIGER_STAGE4_VERSIONS=on` and its Stage 2/3 `test` flags cannot be read or set from this session (no Heroku access), and the SQL cannot be applied (the Supabase connection is read-only). Leg A (Stage 2 flags, no Stage 4, no migration) does not need either of the two, except the worker's Stage 2 flag.

## 4. Finding: the proposed budget cannot cover the complete journey

Prices from the code (`stage4/addonQuote.ts`, `addonSettlement`, the pricing page): a mission costs **at least 200 points** (the three most recent delivered 5-row missions each charged exactly 200; the pricing page states the 200-point minimum); a **review** costs 1 point per 100 cells, **at least 100**; an **edit** has a **minimum of 100** (more for a large re-read). The test account holds **351**, with no top-up. So: mission 200 → 151 left → review 100 → 51 left → **an edit (≥ 100) cannot be approved: the clean refusal for insufficient balance is the expected result**. The complete journey Ask → … → Review → Edit needs **≥ 400 points**; 351 reaches at most mission + review (300), or mission + edit (300). Options for the owner: (a) accept 300 points and let the edit end at its quoted price and the insufficient-balance refusal (that refusal is itself an acceptance check: nothing held, nothing charged); (b) give the test account at least 100 more points by a separate, owner-authorized ledger entry (not done, not proposed by default); (c) use `b0d08be8…` (7,026 points) with the same 400-point ceiling enforced by the stop rule, not by the balance.

## 5. The run protocol (ONE mission; executes only after the authorization of §8 of the pilot package)

**Prerequisites, in order (each verified read-only before the next):**
1. Vercel production READY on the current `main`; Heroku deployment `success` for the same SHA (both true today).
2. Leg A needs: Vercel `DIGER_STAGE2_ASK_CARD`, `DIGER_STAGE2_QUESTION_CARDS`, `DIGER_STAGE2_LIVE_SHEET` = `test`; the worker the same three (Heroku). **Leave `DIGER_STAGE3_EMAIL_NOTICE` UNSET** (it can send job e-mails: this test touches no e-mail). `DIGER_STAGE3_COMPANIES`/`QUEUE` are not needed for a YouTube request.
3. Leg B (review/edit) needs the migration applied and verified (`pg_indexes` row present and valid, duplicate query = 0), the worker's `DIGER_STAGE4_VERSIONS=on`, then on Vercel `DIGER_STAGE4_TEST_USER_IDS=47693c59-…`, and `DIGER_STAGE4_VERSIONS`, `REVIEW`, `EDITS`, `APPROVAL` = `allowlist` (never `on`), in the order of `LAUNCH-CHECKLIST.md` §5.
4. Record before: the account balance S0 (351), the ledger row count, the open-missions count (0), provider spend today.

**The mission (the cheapest realistic request, the same kind that delivered 5 rows for 200 points in each of the three most recent missions, §2.3):** «اجمع ٥ فيديوهات عامة من يوتيوب عن الذكاء الاصطناعي». Expected: quote ≤ 200 points held; provider about 0.02 USD (average of 204 missions; maximum 0.21).

**Steps and what to record at each:** (1) Ask: the «فهمنا طلبك» card, the questions, Arabic text, no error. (2) Plan: price shown before any hold; no hold row yet. (3) Approve: exactly one `res_` row = the shown hold. (4) Execute: the worker takes it (heartbeat shows the mission), live sheet fills with a counter, mobile layout at 390 px. (5) Deliver: status completed, `delivered_units` = rows in the file. (6) Download Excel and CSV (and the methodology only if the owner wants to buy it, 10 or 50 points, a separate charge): same row count, same ids, same cells in both, the limits sheet in Arabic, Excel opens. (7) Version 1 listed. (8) Review: card with an exact price (≥ 100) before any hold, approve, one hold, report, one charge. (9) Edit: the quote card (≥ 100); with 351 the approval is refused for insufficient balance (option (a)) or approved (option (b)): either way the ledger must show no orphan hold. (10) After: `res_` = `rel_` for the mission and the review; charges equal the shown prices; balance = S0 − charges; the add-on rows closed; the §2.3 invariants all zero; flags unset.

**Automatic stop (the first one ends the test and the flags are unset):** total charge above the account's balance or above 350/400 points; any quote above 200 points for the mission; provider + model spend above 2.00 USD (`mission_calls.cost_usd` plus `*_llm_usd` of the test account since the start); a second hold for one request; a hold without its release; a charge different from the shown price; a negative balance; any page, worker or API error that is not a clean refusal; the worker absent from the heartbeat for 5 minutes.

**Rollback:** unset every pilot flag on Vercel and Heroku; `DROP INDEX IF EXISTS public.missions_one_open_addon_per_file;` (only if the migration was applied and nothing needs it).
