# Final pilot package (5 Nov 2026, second pass): ONE controlled decision

Evidence labels: **VERIFIED** (the source is named), **SIMULATED** (fake wallet, fake providers, fake sign-in; not production), **UNVERIFIED** (nothing available proves it). **Nothing was applied, enabled, sent or spent in this pass.** Baseline of the third pass: `main` = `378825e6b79b26cb10bba92dfd8d6775fc8dba75`, last application-code merge `0974bc829acc253e1b39852b35266ecc205da001` (#424).

## 1. Deployments

| Layer | Evidence | Status |
|---|---|---|
| Vercel production | `list_deployments` (project `diger`): `dpl_6Uji38syCas93KMJUvCo4Uj1gvUK`, `githubCommitSha` = `4ca7dd60…`, READY (the previous production deployment `dpl_CSSzNQMUdvEonxNn5YqCzYU9ibTP` is READY at `7e37df61…`); no runtime errors in the last 3 h; `GET /api/busy-status` answers 200 | **VERIFIED** |
| Heroku worker | Heroku's own GitHub integration (environment `diger-agent`) writes a GitHub **deployment + status** for every merge: deployment `7579354126`, `ref` = `4ca7dd60eaa0220af64bcc1b4f07e2bc3a6413dd`, status **success** at 16:38:09 UTC, description «Heroku», build `cfbb0969-57b2-4e60-bd6b-fa5454e10e2b` (and `7579007998` for `7e37df61…`, success 16:25:26). Read with `GET /repos/iammagdy/digr/deployments[/id/statuses]`. Corroboration: every merge since 15:11 UTC is followed within ~1 minute by the last heartbeat of the old `worker.1` process and a new `worker_id`; the current process (`w_worker.1_90455c2d`) started after 16:37:39 and beats every ~minute | **VERIFIED at the release level** (source commit of the Heroku build) |
| **Vercel for the #424 merge (`0974bc82`)** | **VERIFIED (corrected)**: Vercel's builds were delayed by a queue for ~25 minutes (not blocked): production deployment `dpl_9FF9QLT65yczqZ9dZfaguWiFvw5j`, `githubCommitSha` = `0974bc829acc253e1b39852b35266ecc205da001`, **READY at 18:37 UTC, aliased to `diger.tech`**, no runtime errors in the following 30 min. So the guest-cookie fix IS live. (The docs-only `d6fe5092` deployment was still QUEUED at that time; same application tree.) Heroku built `0974bc82` (GitHub deployment `7581447032`, success 18:12:05) and `d6fe5092` (success). This session's Vercel connection cannot create deployments itself (`POST /v13/deployments` → 403); it was not needed | READY |
| Tree equivalence | `git diff --stat 7e37df61 4ca7dd60` = two files, both under `docs/`; the application code deployed on Vercel and built by Heroku is the same tree | **VERIFIED** |
| What is still not proven | the running dyno does not report its own commit (heartbeat `version` is the literal `dev`), and Heroku config-var NAMES (e.g. whether `DIGER_STAGE4_VERSIONS` is set) are not readable without Heroku API access | **UNVERIFIED** (see §6 step 3) |
| Supabase preview check on main | «Supabase Preview» = failure on the merge commit: the integration's *preview branch* cannot replay the migration chain; it does not touch the production database (production history unchanged, §2) | pre-existing, noted |

### Third pass (current `main` `378825e6`), re-verified

| Check | Evidence | Status |
|---|---|---|
| Vercel production at current `main` | Vercel `list_deployments` (target production): `dpl_BuNC3AUqHWHvndPjrf3vkuMWdYPT`, `githubCommitSha` = `378825e6b79b26cb10bba92dfd8d6775fc8dba75`, **READY** (created after `d6fe5092` and `0974bc82`, both READY); GitHub deployment `7582522904` environment Production status `success`; `get_runtime_errors` (2 h): none | **VERIFIED** |
| Heroku at current `main` | GitHub deployment `7582233313`, environment `diger-agent`, `ref` = `378825e6…`, status **success** at 18:49:29 UTC (target `diger-agent-e143d4da7732.herokuapp.com`). The worker process in the heartbeat table changed right after (previous `w_worker.1_f3cf6052` last beat 18:49:10; current `w_worker.1_81409403` beating at 19:08) | **VERIFIED at the release level** (Heroku built that commit) |
| What this does NOT prove | the running dyno's own commit: its heartbeat `version` is still the literal `dev`, and there is no Heroku API access, so config-var names (e.g. `DIGER_STAGE4_VERSIONS`) cannot be read. The ordering evidence (new process after the success status) is corroboration, not proof of the running SHA. A stronger proof needs either Heroku read access, or a worker change that reports `HEROKU_SLUG_COMMIT` (needs `heroku labs:enable runtime-dyno-metadata`): neither was done | **UNVERIFIED** |
| Stage 4 migration | `20261104222136_one_open_addon_per_file` **not applied**: applied history ends at `20261017184147`, `pg_indexes` has no `missions_one_open_addon_per_file` | **VERIFIED** (read-only) |
| Flags | Vercel production env names (values never read): **no** `DIGER_STAGE2_*`, `DIGER_STAGE3_*`, `DIGER_STAGE4_*`, `LAUNCH_EMAIL_ENABLED`, `UNSUBSCRIBE_HMAC_SECRET`. Every pilot and e-mail lock is closed | **VERIFIED** |

## 2. Production database, read-only (5 Nov, SELECTs only, aggregate counts, no PII)

**The earlier §2 note «5 `chg_` rows without `rel_`, 4 after 17 Oct» is corrected here: it was a false positive of the check.** All five are `chg_meth_<job>`: the **methodology purchase** (`purchase_methodology_atomic`, a separate idempotent point charge of 10 or 50 for the methodology file, written once, by design with no hold and no release). Each parent job balances exactly (hold = release, charge = `jobs.charged_credits`).

| Check | Result |
|---|---|
| `chg_meth_*` rows | 5 (−10 ×3 on 15/20/24 Oct, −50 ×2 on 4 Nov), each parent job: `res` = −reserved, `rel` = +reserved, `chg_job` = −`charged_credits`: **0 mismatches**. Genuine customer charges, not fixtures, not risks |
| All 449 jobs with ledger rows | terminal jobs with an unreleased hold **0**; open holds on queued/running **0**; completed jobs whose ledger charge ≠ `jobs.charged_credits` **0** |
| Ledger rows whose job id is not in `jobs` (41 job ids) | all belong to the system fixture user `00000000-…` (no auth account), all 12 Oct, ids `test_job_*`, `verify_par*`, `job_live_*`, `job_test_*`; net effect on any customer **0** |
| 9 stale `queued`/`running` jobs | all `vrun_…` verification fixtures of the same system user, 12 Oct, **0 ledger rows** (no points held), none in the last 7 days. Harmless; may stay |
| Users with a ledger | 6, **0 negative**, lowest balance 351 |
| Add-on rows / duplicate open add-ons | 0 / 0; index `missions_one_open_addon_per_file` still absent |
| Applied-migration history ends at `20261017184147` | the history table is **not authoritative**: objects of the later files (`credit_ledger_kinds`, `promo_codes`, `support_messages`, `provider_api_keys`, `invoice_documents`) exist, i.e. earlier migrations were applied by hand without history rows (docs/OWNER_SQL.md practice). The add-on index was checked in `pg_indexes` directly |

**Verdict:** every anomaly is explained (test fixtures of 12 Oct, or the methodology purchase). **No customer financial risk found.** No repair, refund, release or delete is proposed or performed.

## 3. Authorization audit

| Item | Result |
|---|---|
| **Guest cookie** (`/api/chat`) | **Genuine defect, fixed in PR #424, merged as `0974bc829acc253e1b39852b35266ecc205da001`** (full suite on its head: 924 files, 12,091 tests passed, 0 failed, 65 skipped; two independent code reviews; the second one's MEDIUM fixed). A browser-chosen `guest_session_id=gst_<user id>` was honoured for ANY user id: signed in, the caller received that user's conversations, messages and missions and an account delete was attempted (RESTRICT foreign keys on `profiles`/`credit_ledger` stop the delete of a customer with money, not the data move); not signed in, the request ran as that user. Needs the victim's id (a UUID): **no customer-facing route was found that discloses another customer's id** (admin routes only), so it is a latent takeover, not a known active exploit. Reproduced with fake tables: 4 route tests are red on the old route. Fix: the id counts only for a Diger-made unconfirmed guest account (mark + generated address + unconfirmed). The same rule now guards `missionViewer` (independent review found it there) and the 7-day guest clean-up in the watchdog |
| **Redeem** (`/api/wallet/redeem`) | **Not exploitable today.** It needs a session; Supabase refuses sign-in for an unconfirmed address (all 3 unconfirmed accounts in production have never signed in); promo points are one-per-account, capped per code, throttled per IP and device. App-code enforcement of verification is NOT added (financial-adjacent; owner decision) |
| `user_metadata` forged flags | closed earlier (#419) for approval, payment, top-up and chat |
| Rule for activation | #424 is merged: the guest-cookie condition for activation is met. Left as follow-ups (not takeover paths): `middleware.ts`/`useUser` and `emailEligibility.ts` read `user_metadata.is_guest` for UI routing only; the guest-creation fallback re-tries `createUser` every turn |

## 4. Flags and the safest pilot

- **VERIFIED:** Vercel production has **no** `DIGER_STAGE2_*`, `DIGER_STAGE3_*`, `DIGER_STAGE4_*` variable (names listed with `filter_project_envs`; values are never read). Unset = OFF. `agent_settings` holds only the older `redesign_flags` and `social_discovery` (unrelated to the stage flags). Heroku config names: **UNVERIFIED**.
- Stage 2 (`ASK_CARD`, `QUESTION_CARDS`, `LIVE_SHEET`) and Stage 3 (`COMPANIES`, `QUEUE`, `EMAIL_NOTICE`) accept **`test`** (admin-designated test accounts only). The worker must carry the same flag so it writes the live snapshots and the test marker.
- **A pilot WITHOUT paid Stage 4 is possible**: set Stage 2 and Stage 3 flags to `test`, leave every `DIGER_STAGE4_*` unset. It still spends the existing research path's points and provider money (a normal mission), so it needs the same budget, but exercises no add-on hold/charge code and needs **no migration**. This is the **recommended first leg**. The Stage 4 leg (review, edit, versions) follows only after the migration and the worker check.
- Stage 4: `allowlist` + `DIGER_STAGE4_TEST_USER_IDS` (server-only), worker `DIGER_STAGE4_VERSIONS=on`. See `docs/STAGE-4-TEST-GATE.md`.

## 5. Simulated test evidence (not production)

- Full suite on the integrated tree (#418): 923 files passed, 12,066 tests passed, 0 failed, 65 skipped (8 are the named E-37 skips). With #424 (final head): 924 files, 12,091 passed, 0 failed.
- Real Chromium (desktop 1280, phone 390), fake wallet and providers: 32/32 (`BROWSER-JOURNEY.md`). Excel = CSV cell by cell (rounds 32/35/36/37 tests on stored real rows) and the PR1/Boost flows are inside the suite. **Not covered in a browser:** the research mission itself (ask → plan → quote → approval → worker → completed file); concurrent two-tab approvals; a worker crash. **Not covered anywhere:** Excel for Android re-save compatibility (E-37 remains UNVERIFIED), a physical phone.

## 6. The pilot (executes only after the authorization of §8)

**Budget, from evidence.** 204 missions since 25 Oct: provider (source) cost per mission avg **0.021 USD**, max **0.207 USD** (`mission_calls.cost_usd`); the 146 completed agent missions averaged 218 points (max 2,098). The review and edit steps use the model and have **no production measurement**. Proposal: **points ≤ 400** (one mission ≤ 200 + review ≈ 100 + edit 100) and **provider + model spend ≤ 2.00 USD** (about 3× three worst-case missions). The run stops at either ceiling.

**Proposed test account (for the owner's approval; no credential is held or needed by this session):** `47693c59-89f1-405d-bec1-e72271517870` (the HANDOFF test account; masked address `ia***@outlook.com`; created 15 Oct; confirmed, **not** a guest; matches the code's test-account rule; app role none). Its production ledger balance is **351 points**, i.e. **below the 400-point ceiling**: the balance itself is a hard physical cap on points (a hold cannot exceed the balance). Alternative `b0d08be8-db61-4860-841e-fa963045557e` (also a test-rule account, active today) holds 7,026 points, so only the app-level ceiling would limit it: **not recommended**. Both are read-only observations (aggregate balance and counts); nothing was changed. The owner signs in as that account himself; the session never receives its password.

**Automatic stop criteria (any one stops the pilot; the flags are then unset):** balance S0 − current balance > 351 (or > 400 on any other account); one mission quote above 200 points; provider + model spend (`mission_calls.cost_usd` summed for the test account since the start) above 2.00 USD; a ledger row without its pair (`res_` without `rel_`, `chg_` above `res_`); a second hold for one request; a negative balance; a charge different from the price shown; an add-on row left open; a worker or page error that is not a clean refusal; the worker not seen in the heartbeat table for 5 minutes.

**Pre-checks (read-only, must be true immediately before):** the 5 checks of §2 re-run give the same zeros; `list_migrations` unchanged; the test account's balance S0 recorded; Vercel production READY on a `main` SHA that contains #424 (true: `0974bc82`, §1); Heroku deployment status success for the SHA in force.

**Steps.**
1. (#424 is already merged.) Record the then-current `main` SHA; Vercel READY on it; Heroku deployment `success` on it.
2. Apply `supabase/migrations/20261104222136_one_open_addon_per_file.sql` once (preconditions in the file stop it on any conflict; one partial unique index; no row changes). Verify (`pg_indexes`, `indisvalid`, `indisready`, duplicate query = 0). Rollback `DROP INDEX IF EXISTS public.missions_one_open_addon_per_file;`.
3. Heroku: the worker needs `DIGER_STAGE2_*`/`DIGER_STAGE3_*` = `test` (leg A) and `DIGER_STAGE4_VERSIONS=on` (leg B). **No Heroku API access exists in this session**; a config var is the only step that cannot be performed from here (see §8).
4. Vercel: `DIGER_STAGE2_*`, `DIGER_STAGE3_*` = `test`; leg B: `DIGER_STAGE4_TEST_USER_IDS=<id>` then the Stage 4 flags `allowlist`, in the order of `LAUNCH-CHECKLIST.md` §5 (REVIEW/VERSIONS before EDITS/APPROVAL).
5. One journey on the test account: ask → plan → approve → live sheet → delivered Excel/CSV/methodology → (leg B) version list → review quote/approve → edit quote/approve → version 2. Record balance before/after and the ledger ids `res_/rel_/chg_` per job.
6. **Stop at the first anomaly** (`LAUNCH-CHECKLIST.md` §7): negative balance, charge above hold, a hold without release, a second hold for one request, a charge not equal to the shown price, a spend above either ceiling, any page or worker error that is not a clean refusal.
7. Post-checks (read-only): the §2 checks again; test account balance = S0 − the shown charges; ledger rows unique; no add-on row left open. Unset every pilot flag to roll back.

## 7. Launch e-mail

Eligible recipients today: **ZERO** (9 accounts, 6 verified non-guest, **0** with `prefs.notif.news = true` (re-queried read-only in the third pass), 2 guests). Resend contacts (81) are not consent. Nothing sent. The implementation (template `news`, one-click unsubscribe, consent audience, idempotent runner, caps, double lock `LAUNCH_EMAIL_ENABLED`, a single-run lock, uncertain deliveries keep their claim) is **PR #425** (open): two independent reviews, defects found by them fixed with regression and mutation tests; see `LAUNCH-EMAIL-AR.md` §9 (residual risks: forged opt-in at sign-up, owner-supplied suppression list) and §10 (the exact authorization text for the seed send). Merging #425 changes nothing for customers; the deployed Edge Function (v5) has no `news` template until the owner deploys it.

## 8. The single decision

> **AUTHORIZE PILOT (leg A + leg B):**
> (1) apply `20261104222136_one_open_addon_per_file` to `pfinlfaqwnytesedchik` as in §6 step 2;
> (2) set on Vercel production, in order: the Stage 2/3 flags to `test`, then `DIGER_STAGE4_TEST_USER_IDS=<test account user id>` and the Stage 4 flags to `allowlist`; on the Heroku worker the same Stage 2/3 flags and `DIGER_STAGE4_VERSIONS=on`;
> (3) test account: `47693c59-89f1-405d-bec1-e72271517870` (balance 351 points = a natural ceiling; or replace it with another verified non-guest id);
> (4) maximum points: **400** (on the proposed account the balance of 351 binds first);
> (5) maximum provider + model spend: **2.00 USD**;
> (6) stop at the first anomaly of §6 step 6; unset the flags afterwards.

**What I can and cannot do after that message.** I can: set the Vercel variables (Vercel tools exist), run every read-only check and the journey observation. I **cannot**: apply the SQL (the Supabase connection is read-only) or set Heroku config vars (no Heroku access). Those two need either a write-capable Supabase tool and Heroku API access granted to this session, or the owner doing exactly those two steps. That is the only owner action in the whole plan.
