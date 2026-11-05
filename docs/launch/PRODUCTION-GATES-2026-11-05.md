# Production gates, evidence and the exact next authorization (5 Nov 2026)

Everything below is **read-only evidence** gathered on 5 Nov 2026 (Supabase read-only SQL, Vercel API, Resend read-only API, GitHub) or **a plan**. **Nothing was applied, enabled, sent or spent.** Labels: **VERIFIED** (evidence named), **UNVERIFIED** (nothing available proves it), **BLOCKED** (needs the named approval).

## 1. Deployments

| Layer | Evidence | Status |
|---|---|---|
| Vercel (project `diger`, production, auto-deploys every merge to `main`) | `list_deployments`: production deployment `githubCommitSha` is checked against the merge SHA recorded in §7 | see §7 (filled at the end) |
| Heroku worker | **No Heroku access in this session** (no CLI, no `HEROKU_API_KEY`, no integration). A worker IS alive: `agent_worker_heartbeat` row `worker.1`, last beat seconds before the check, model `claude-haiku-5-5`. But its `version` field says `dev`, **not a commit SHA** | **UNVERIFIED**: worker running ≠ worker at the merge SHA. BLOCKED for every Stage 4 flag until the owner (or an integration with access) shows `heroku releases:info` commit == merge SHA |

## 2. Supabase read-only checks (5 Nov 2026, aggregate counts only, no PII)

| Check | Result |
|---|---|
| Migration `20261104222136_one_open_addon_per_file` | **NOT applied** (newest applied `20261017184147`) |
| Add-on rows in `missions` | **0** (of 217 missions) |
| Files with two open add-ons (the migration's own precondition) | **0** |
| Users with a negative balance (sum of `credit_ledger.delta`) | **0**; lowest balance 351 |
| Charge above reserve | **0** |
| Reserve amount ≠ job `reserved_credits` | **0** |
| Charge rows with no job | **0** |
| Active missions with a stale lease (> 1 h) | **0** |
| Jobs `queued`/`running` | 9, **all created 2026-10-12** and stale (> 1 h), reserved 0–10 points, none created in the last 7 days |
| Jobs with `reserved_credits > 0` and no `res_<job>` ledger row | 10, **all created 2026-10-12** (ids `vrun_…`) |
| Terminal jobs without `rel_<job>` | 4, all 2026-10-12 |
| Completed jobs whose `charged_credits` ≠ ledger `chg_` | 2, all 2026-10-12 |
| `chg_` rows without `rel_` | 5 (4 after 17 Oct) |

**Reading.** The anomalies are confined to 12 Oct 2026 `vrun_…` verification-run jobs (docs/CUTOVER.md: verification fixtures, ≤ 10 points each) created before the settlement functions of 12–17 Oct were in place. No customer-money invariant is violated (no negative balance, no overcharge, no mismatched reserve). They are **not** caused by this release. **Not proven** by this check: that all five `chg_`-without-`rel_` rows are fixtures (4 are dated after 17 Oct: they need a person to look at them before any pilot); the 9 stale `queued/running` jobs are pre-existing and hold ≤ 10 points in total. Owner decision: leave, or repair with a reviewed SQL (not prepared here).

## 3. The migration: exact apply, verify, rollback (NOT executed; needs the authorization of §6)

Migration: `supabase/migrations/20261104222136_one_open_addon_per_file.sql`. Database: the production Supabase project (the one the checks above ran on). It creates ONE partial unique index on `public.missions`, never changes a row, never touches money tables, functions, policies or grants; its own `DO` blocks stop it with an exception and no change if the table/column is wrong, a file already has two open add-ons, or an object of that name exists that is not exactly the guard.

1. **Before (read-only):** `list_migrations` (newest must still be `20261017184147`); the duplicate query of §2 must return 0 (it did on 5 Nov).
2. **Apply:** once, by the owner or by an approved session with write access, as migration `20261104222136_one_open_addon_per_file`. `missions` has 217 rows: the index build is instantaneous and holds a brief lock only.
3. **Verify (read-only):** `list_migrations` shows the version; `select indexdef from pg_indexes where indexname = 'missions_one_open_addon_per_file'` returns the partial unique index; `pg_index.indisvalid and indisready` are true; the duplicate query still returns 0.
4. **Rollback:** `DROP INDEX IF EXISTS public.missions_one_open_addon_per_file;` (no data change; stated in the index's own comment).

## 4. Flags (all default OFF; none is enabled by any merge)

Order and values as in `LAUNCH-CHECKLIST.md` §5, with one change from this release: Stage 4 flags accept **`allowlist`** (see `docs/STAGE-4-TEST-GATE.md`): served only to a signed-in, verified, non-guest customer whose user id is in the server-only `DIGER_STAGE4_TEST_USER_IDS`. Worker: `DIGER_STAGE4_VERSIONS` must be `on` for the version-1 write. **Do not set any Stage 4 flag until: the worker is verified at the merge SHA, the migration is applied and read back, and the pre-checks of §2 are accepted.**

## 5. Controlled real pilot (BLOCKED: needs §6)

Steps are those of `LAUNCH-CHECKLIST.md` §6. Budget (proposal, adjustable by the owner): one research mission (≤ 200 points) + one review (≈ 100) + one edit (100) ≈ **≤ 400 points** on one approved test account, plus provider spend for the research mission and the edit lookup (**real provider cost is unmeasured here: the owner states a ceiling in USD**). Open the delivered XLSX once in Excel for Android (closes risk 1 of E-37 only if done). Record the points before/after and the ledger rows (`res_/rel_/chg_`) per job.

## 6. Exact next authorization (one message from the owner closes the gates)

> **AUTHORIZE PILOT:** (1) apply migration `20261104222136_one_open_addon_per_file` to the production Supabase project `pfinlfaqwnytesedchik` exactly as in §3; (2) enable on Vercel production `DIGER_STAGE4_TEST_USER_IDS=<user id of the approved test account>` and the Stage 4 flags with value `allowlist`, in the checklist order, and on the Heroku worker `DIGER_STAGE4_VERSIONS=on`, after the worker release commit equals the merge SHA; (3) test account: `<email / user id>`; (4) maximum **points** budget: `<N>` (suggested 400); (5) maximum **provider spend**: `<USD>`; (6) the run stops at the first anomaly of `LAUNCH-CHECKLIST.md` §7.

Until that message exists: no SQL is run, no flag is set, no point moves, no provider is called.

## 7. Launch e-mail readiness (nothing sent; Resend and Supabase read-only)

| Item | Evidence (5 Nov 2026) | Status |
|---|---|---|
| Sender domain | Resend: `diger.tech` verified, sending enabled, eu-west-1, open/click tracking off | READY |
| Transactional path | Supabase Edge Function `send-email` ACTIVE, version 5 | READY (existing templates only) |
| Announcement template | none exists (`PlatformEmailTemplateId` has welcome / top-up / job-done / refund / job-update / admin alert) | **BLOCKED**: a `news` template must be added in both copies and the Edge Function redeployed (owner) |
| **Eligible audience** | `auth.users`: 9 accounts, 6 verified non-guest, **0 with `prefs.notif.news = true`**, 2 guests | **ZERO eligible recipients today.** Registered accounts are NOT marketing opt-ins and are not treated as such |
| Resend contacts | 81 contacts, 2 of 3 segments (a separate list; **not** a consent source this repo can verify, not used) | UNVERIFIED consent: do not use |
| Suppression | Resend suppression list is the provider-side guard; the platform has no suppression table; the send must re-read the preference per recipient | partially READY |
| One-click unsubscribe | no `List-Unsubscribe` header in `resendHeaders.ts`; only the settings-page link | **BLOCKED** (code change + Edge Function deploy, owner) |
| Duplicates | idempotency key `launch-2026-11:<userId>` (supported by `sendPlatformEmail`) | designed, untested at scale |
| Volume and cost | allowance 50,000/month, used 248 (resets 24 Nov); a 0-recipient audience costs 0; cap proposal ≤ 20% of allowance | READY (plan price not visible here: UNVERIFIED) |
| Bounded test send | 3–5 owner-controlled accounts via the existing path | **BLOCKED**: needs the template and the owner's explicit send approval and budget |
| Features the text may promise | only those READY in `LAUNCH-CHECKLIST.md` §10 on the day: none of Stage 2/3/4 is READY for customers (flags OFF, no pilot) | do not mention them |

The Arabic text and subject lines are in `LAUNCH-EMAIL-AR.md`. **No bulk campaign until: the pilot passed, a `news` template and the unsubscribe header are deployed, the recipient count is > 0 from real opt-ins, and the owner approves a recipient cap and budget.**

## 8. Record

Filled from the final release report: merged order #420 `5174a542`, #419 `35aee90a`, #416 `9796a07d`, #417 `05dc7f47`, #418 `7e37df61` (**final `main` merge SHA `7e37df6102857abe72fc7bb76f6ef84e6afc6fd4`**); Vercel production deployment for that SHA: see the release report; Heroku: UNVERIFIED; migration NOT applied (index absent, history unchanged after the merge, read back).
