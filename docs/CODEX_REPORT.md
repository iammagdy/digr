# Codex continuation report

Date: 2026-10-17 (UTC)

## 1. Branch, PR, and deployment

- Starting head verified: `ea40cbb205dca428e06f1cfc405e6434bf602e72` on `claude/zealous-carson-sdg9x4`; its Vercel deployment was `dpl_69jYz3dL2X5dW4UsjT3J1oGoqVjH`, `READY` for that exact SHA.
- Working branch: `codex/quote-cap-and-money-atomic`.
- Draft PR: [#81](https://github.com/iammagdy/digr/pull/81), based on `claude/zealous-carson-sdg9x4` (which remains stacked on draft PR #79). PR #80 was not changed.
- Reviewed implementation head: `01ace37691f26570299e7afc2affd3c588a3e74b`.
- Vercel deployment for that exact implementation SHA: `dpl_GyjQCzHMn4AfY3mJ6jPEaoJ4H6r3`, state `READY`, Preview URL `https://diger-boeskvzeo-iam-magdy.vercel.app/`.
- This report is a documentation-only follow-up commit after that deployment. The final PR head therefore has a later SHA and its own Vercel deployment; that deployment is recorded in the accompanying final message because its ID cannot be embedded in the commit that triggers it.
- The three requested prior reports existed on the starting branch: `docs/MUSE_REPORT.md`, `docs/SOCIAL_RESEARCH_REPORT.md`, and `docs/MONEY_WRITES_PLAN.md`.

## 2. Verification counts

| Check | Before this continuation | After implementation |
|---|---:|---:|
| `npm install` | completed; 343 packages audited, 6 reported vulnerabilities (2 moderate, 2 high, 2 critical) | Not rerun; lockfile unchanged |
| `npm test -- --run` | 1,163 passed in 132 files | 1,168 passed in 133 files |
| `npm run build` | passed | passed; client bundle scan found zero secrets in 88 files |
| `npx tsc --noEmit` | passed | passed (exit 0) |

The first post-change suite exposed failures while cap expectations and worker mocks were being brought in line with the new behavior. Those were corrected; the final full run above passed. No production SQL or live provider writes were made.

## 3. Steps 1–9 evidence

| Step | Status | Evidence / limitations |
|---|---|---|
| 1. Verify starting state, branch, install, tests, build, typecheck, PR | PASS | Starting SHA and READY deployment recorded above. Reports existed. Initial exact counts are above. Branch created from the verified PR #80 head; draft PR #81 opened against it. |
| 2. Quote versus settlement cap | PASS | `planManager.ts` now constrains quote volume to the hard 600-point settlement cap even if an environment override is higher. Unit rates remain unchanged. The normal reserve is recalculated using the 15% buffer on the reduced volume. The public calculator reports the same reduced volume/reserve/settlement. Arabic plan text explains the requested and fitting record counts. Tests cover the 100-comment example (YouTube: 57 records at 9 points each; 513 expected charge; 590 reserve) and calculator alignment. |
| 3. Decision-maker wording and missing fields | PASS | Plan wording now says returned work email and phone may carry an explicit unconfirmed status. The worker makes a base people-search call and, for each missing requested field, attempts an enrichment call: up to 3 calls/person when both email and phone are missing. The unit test’s mocked calls total 150 micro-USD (`0.00015 USD`); this is test-fixture evidence, not a measured live-provider price. Rows missing required requested fields are filtered after those provider calls, so provider spend can be consumed for an undelivered row. Safer proposal: obtain a provider contract/route that charges only for successfully returned fields, or quote contact enrichment as optional field-level work and only bill for fields actually delivered; keep incomplete rows/statuses visible for review. No live people search was run. |
| 4. Registry cleanup migration | PASS | Added `supabase/migrations/20261017175000_cleanup_capability_registry_social.sql`; it is not applied. It removes the 13 listed 404 endpoint IDs and registers six social capabilities using the code’s pricing formula and declared rates. The migration notes the pricing defaults (55 EGP/USD, 10× markup, 0.10 EGP/point); compare live environment overrides before applying. |
| 5. Stuck job investigation and fix proposal | PASS | Read-only rows and function/route inspection are below. Code now verifies the persisted terminal cursor/delivered count before settlement. Migration `supabase/migrations/20261017175500_settle_completed_jobs_with_stale_lease.sql` allows a stale lease to be retired only when the terminal cursor or target count is already persisted; incomplete collection still raises. Migration is not applied. The exact historical holder/timing of the lease cannot be reconstructed from current rows; the evidence proves settlement met an active lease while the job had already persisted 20/20 and `completed`. The failed historical job was already released with zero charge; this migration does not retroactively settle it. |
| 6. Script hygiene | PASS | The five named test scripts now read `DIGER_TEST_PASSWORD`; the three named live browser scripts read `DIGER_TEST_EMAIL` and `DIGER_TEST_PASSWORD`. Values are never emitted. `scripts/cleanup-all.ts` is deleted. No live script was run. |
| 7. Money-write plan and atomic migrations | FAIL | Five spot checks in `docs/MONEY_WRITES_PLAN.md` matched code: top-up approval (apply then status update), quote create/update in `planManager.ts`, provider cost insertion, account delete/cancel profile updates, and watchdog profile anonymization. No error was found in those entries. Draft SQL and static tests exist for `create_quote_atomic` and top-up approval function privileges. Per instruction, money callers were not rewritten: quote creation still writes through `planManager.ts`, and `src/app/api/admin/topups/approve/route.ts` still applies the top-up then updates status separately. Those two production paths remain non-atomic until the owner reviews and routes them through the approved functions. Neither migration was applied. |
| 8. Browser scenarios | NOT RUN | `DIGER_TEST_EMAIL` and `DIGER_TEST_PASSWORD` were both unset (checked by variable name only). Preview request was `curl.exe -sS -I https://diger-boeskvzeo-iam-magdy.vercel.app/`; raw response status was `HTTP/1.1 302 Found`, with `Location: https://vercel.com/sso-api?...` (nonce and cookie values omitted). Per instruction, all scenarios a–j are NOT RUN. No browser timing, screenshot, download, or test-account DB query exists for this run. |
| 9. Push, PR, and Vercel | PASS | Implementation SHA `01ace37691f26570299e7afc2affd3c588a3e74b` was pushed to the draft PR branch and has the exact READY deployment listed above. This report is then committed as a documentation-only follow-up; its resulting head deployment is reported in the final message. |

## 4. Scenarios a–j

| Scenario | Status | Evidence / reason |
|---|---|---|
| a. TikTok starter example, placeholder block, real-handle plan | NOT RUN | Preview returned 302 to Vercel SSO; test credentials unset. |
| b. Five electricity companies with/without country | NOT RUN | Same Preview/credential block. |
| c. Five Egyptian contracting companies | NOT RUN | Same block. No quote or execution was attempted. |
| d. Ten Saudi IT companies and empty-result request inspection | NOT RUN | Same block. No provider request was sent. |
| e. Liechtenstein rockets and German software | NOT RUN | Same block. |
| f. Five decision-makers with work email and phone | NOT RUN | Same block. No quote or approval was attempted. |
| g. Greeting, new research, stale-job wait, plan edits, expired quote | NOT RUN | Same block; no three-minute browser wait was performed. |
| h. Social research cards and missing-input flow | NOT RUN | Same block. Static and automated tests passed, but no Preview scenario was exercised. |
| i. Excel/PDF content and 390×844 mobile view | NOT RUN | Same block. No account artifact was downloaded or opened. |
| j. Long job via cron/worker | NOT RUN | No job was approved or dispatched. No new batch-gap query was made. Historical evidence is limited to the stuck-job record below. |

## 5. Read-only production evidence

Historical job query:

```sql
select * from public.jobs where id='job_quote_a5fb246b5d8095a3413f20fc68a5467c';
```

Raw result:

```json
[{"id":"job_quote_a5fb246b5d8095a3413f20fc68a5467c","user_id":"47693c59-89f1-405d-bec1-e72271517870","status":"failed","endpoint_id":"icypeas.companies.search","target_volume_min":1,"target_volume_max":20,"reserved_credits":"69","charged_credits":"0","delivered_units":20,"current_cursor":"completed","accumulated_cost_usd":"0.0114","attempt_count":1,"result_file_id":null,"error_message":"Cannot settle job job_quote_a5fb246b5d8095a3413f20fc68a5467c while active chunk lease is held until 2026-10-15 14:29:10.316384+00","created_at":"2026-10-15 14:28:00.230479+00","updated_at":"2026-10-15 14:28:12.602842+00","next_attempt_at":"2026-10-15 14:28:21.318624+00","step":3,"lease_until":null,"unit_price":"3"}]
```

Ledger query:

```sql
select id,user_id,delta,type,job_id,topup_id,note,created_at from public.credit_ledger where job_id='job_quote_a5fb246b5d8095a3413f20fc68a5467c' order by created_at,id;
```

Raw result (copied query output):

```json
[{"id":"res_job_quote_a5fb246b5d8095a3413f20fc68a5467c","user_id":"47693c59-89f1-405d-bec1-e72271517870","delta":"-69","type":"reserve","job_id":"job_quote_a5fb246b5d8095a3413f20fc68a5467c","topup_id":null,"note":"حجز رصيد للطلب","created_at":"2026-10-15 14:28:00.230479+00"},{"id":"rel_job_quote_a5fb246b5d8095a3413f20fc68a5467c","user_id":"47693c59-89f1-405d-bec1-e72271517870","delta":"69","type":"release","job_id":"job_quote_a5fb246b5d8095a3413f20fc68a5467c","topup_id":null,"note":"إرجاع الحجز بالكامل عند تعثر المهمة","created_at":"2026-10-15 14:28:11.640338+00"}]
```

Arithmetic: `res_` reserved 69 points (`-69`), no `chg_` row and charged 0, `rel_` returned 69 (`+69`); net ledger change 0. The job row says 20 delivered rows at 3 points/unit, which would be 60 points before the failure, but settlement did not occur. Historical provider cost rows for this job were 3 calls: `$0.0038` each, total `$0.0114`; this is historical spend, not spend from this continuation.

Current UTC-day provider-cost aggregate, from a read-only query:

```json
[{"provider":"treg","call_rows":13,"units":24,"cost_usd":"0.0073","first_at":"2026-10-17 09:17:11.806615+00","last_at":"2026-10-17 11:42:47.959936+00"}]
```

Read-only settings query returned provider cap `$0.80`, LLM cap `$50`, and job cap `600` points. Remaining provider budget at query time: `$0.7927`. Spend incurred by this continuation: `$0.00` provider spend and `0` customer points. No job was approved or run.

## 6. Owner actions and remaining risks

1. Set `DIGER_TEST_EMAIL` and `DIGER_TEST_PASSWORD` for the non-admin test account, then provide Preview access (or the appropriate Vercel bypass) and rerun scenarios a–j. Do not use the admin account.
2. Review the registry migration’s formula against actual Vercel pricing environment overrides before applying `20261017175000_cleanup_capability_registry_social.sql`.
3. Review/apply `20261017175500_settle_completed_jobs_with_stale_lease.sql` to address future complete-but-leased jobs. The historical failed job is already released and should remain untouched unless separately reconciled through an approved owner workflow.
4. Do not apply `20261017180000_create_quote_atomic.sql` or `20261017180500_approve_topup_atomic_privileges.sql` as a complete fix until the server callers are separately changed and reviewed to use the functions. Those live callers remain non-atomic.
5. Add an Anthropic monthly spending cap in the provider account if one is not already set; the code/database daily LLM cap remains `$50` and was not changed.
6. Re-run a small end-to-end quote and settlement check after Preview access is available. This continuation did not verify browser UX, actual provider output quality, exports, mobile layout, or cron completion.

Known risks: the browser/product flow and social provider integrations remain unverified on Preview; provider contact enrichment can consume calls for rows later filtered out; quote creation and admin top-up approval still use direct multi-write code paths; all proposed migrations remain unapplied; and the Vercel SSO block prevented measurement of actual user-visible latency or downloaded artifacts.
