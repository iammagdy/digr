# Pressure test runbook (for the owner)

A staged test of 50, 100, 250 and 500 virtual visitors against a **preview deployment** that uses a **fake data provider** and a **separate test database**. It is run by the owner. It is never run by an agent and never against `diger.tech`.

What it proves: that a room of phones can sign in, chat, get a plan, approve it, have the long jobs run in chunks, see the results and download a file, without a crash, without a double reserve, a double charge, a charge above the reserve or a negative balance. What it cannot prove: how the real provider, the real model or the real sign-in limits of the live project behave (see section 7).

The script refuses to start unless all of these are true (`scripts/pressure/lib.ts`, tested): the address is a preview address (`*.vercel.app`) and not one of the live addresses; the database address is not the live project; `PRESSURE_TEST_CONFIRM=preview-and-test-database` is set; the stage is 50, 100, 250 or 500; stage 500 also needs `--yes-500`. The fake provider itself switches on only when `PRESSURE_FAKE_PROVIDER=on`, the deployment is a Vercel **preview** and the database is not the live one (`src/lib/server/fakeProviderMode.ts`, tested): on the live site it can never be on.

## 1. What you create (once, about 40 minutes)

1. **A second Supabase project** (free plan is enough), for example `diger-pressure`. It must be a different project from `pfinlfaqwnytesedchik`.
2. **Its schema:** apply every file in `supabase/migrations/` to the new project in file-name order (Dashboard > SQL Editor, or `supabase db push` linked to the new project). The files are the ones the live project already runs. Do not apply them to the live project (they are already applied there).
3. **An admin user in the test project only:** create a user in Authentication > Users, then in the SQL editor of the TEST project run `update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}' where email = '<that email>';`. Sign in with it on the preview to reach `/admin`.
4. **A promo code in the test project** (admin page «الأكواد الترويجية»): for example `PRESSURE` worth 600 points, with at least 600 redemptions and no per-day limit. The script gives each virtual visitor their points through this real route.
5. **Provider limits in the test project** (admin page «مزودو الخدمة»): the daily cap and the credit must be high (for example 1000 dollars each) or the plan gate and the busy mode will close the door for the test. The fake provider records no cost.
6. **Authentication > Rate Limits in the test project:** raise sign-ups and sign-ins, token refresh and token verifications (the same values as in `docs/SUPABASE_FREE_PLAN.md` section 4). The test creates and signs in users from your computer; the script paces sign-ins (20 a minute by default, `PRESSURE_SIGNIN_PER_MINUTE`).
7. **A Vercel preview environment for one dedicated branch**, for example `pressure-test`: in Vercel > Project > Settings > Environment Variables add the variables of section 2 with the **Preview** scope restricted to that branch, then push (or merge) the code you want to test into that branch. Preview deployments use the Vercel deployment-protection login, so for the script create a **Protection Bypass for Automation** secret (Settings > Deployment Protection) and keep its value for `PRESSURE_BYPASS_TOKEN`.

## 2. Environment values (names only; take the values from the TEST project and keep them out of chat and out of git)

On the Vercel preview (branch `pressure-test`, Preview scope):

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | the TEST project's URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the TEST project's publishable (anon) key |
| `SUPABASE_SERVICE_ROLE_KEY` | the TEST project's service-role key |
| `CRON_SECRET` | any new random string (it signs the internal calls between the routes) |
| `PRESSURE_FAKE_PROVIDER` | `on` |
| `LLM_PROVIDER` | `fake` (no call to the language model) |
| `PROVIDER_CREDIT_USD` | `1000` |
| `NEXT_PUBLIC_SITE_URL` (or the site-address variable the project already uses) | the preview's own address |
| `FAKE_PROVIDER_LATENCY_MS` (optional, default 250) | how long each fake provider call takes |
| `FAKE_PROVIDER_COMMENTS_PER_VIDEO` (optional, default 200), `FAKE_PROVIDER_VIDEOS` (default 40) | how much the fake source holds |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | set by Vercel itself once you create the Protection Bypass for Automation (step 7); the platform's own calls between the routes need it on a protected preview. If a job fails with a start problem on the preview, check this variable exists |
| `DEGRADED_MODE` (optional) | leave unset |

On your computer, in the shell that runs the script (never committed):

| Name | Value |
|---|---|
| `PRESSURE_TEST_CONFIRM` | `preview-and-test-database` |
| `TEST_SUPABASE_URL`, `TEST_SUPABASE_ANON_KEY`, `TEST_SUPABASE_SERVICE_ROLE_KEY` | the TEST project's |
| `PRESSURE_PROMO_CODE` | `PRESSURE` (the code of step 4) |
| `PRESSURE_BYPASS_TOKEN` | the deployment-protection bypass secret |

Check before the first stage: open the preview, sign in as the test admin, confirm `/admin/conference` loads and the provider tab shows the high limits. Check the preview's Vercel environment shows **no** key of the live project.

## 3. Running a stage

```
npx tsx scripts/pressure/run.ts --stage 50 --base https://<the preview address> --dry-run     # prints the plan, touches nothing
npx tsx scripts/pressure/run.ts --stage 50 --base https://<the preview address>
```

Order: 50, then 100, then 250, then (with `--yes-500`) 500. Run the next stage only if the one before **passed** and you looked at the numbers. Each stage writes `pressure-stage-N.json` and prints the verdict. A stage:

1. creates its test users (`@example.test` addresses, confirmed, in the test project), signs them in (paced), and ramps the visitors in over 60 to 120 seconds;
2. each visitor: reads the busy status, redeems the promo code, reads the balance, sends a greeting and then the request «٣٠ تعليق على تيك توك عن كرة القدم خلال الشهر الماضي» (a plan, a quote), waits a few seconds between turns;
3. a quarter of the visitors approve the plan, follow the job exactly as the page does (read the row directly, nudge when it does not move), then open the results and download the Excel file;
4. reads the whole ledger of the test users and checks the money rules (`checkLedger`): one reserve per job, one release at most, one charge at most, no charge above its reserve, no balance below zero.

Passed means: the ledger check found nothing, at least 98% of chat turns answered, the slowest 5% of chat turns took under 20 seconds, and fewer than 5% of visitors could not finish. A failed ledger check is the one that matters: **stop, keep the test project as it is, and send `pressure-stage-N.json`.**

## 4. What to read on the day of the test

- Vercel > Project > Usage (Active CPU and function invocations) before and after a stage: the difference is the stage's CPU. `docs/CPU_MODEL.md` predicts it; the model is only as good as its assumptions, and this is how to correct them.
- Vercel > Observability / Logs for the preview (runtime logs last one hour on the free plan: read them right after the stage).
- The test project's Reports (database CPU and memory, API requests, Auth requests and rate-limit errors).
- `/admin/conference` on the preview.

## 5. After the test

Delete the test users (or the whole test project), remove the preview variables of section 2, and delete the branch environment. Nothing of this touches the live site or the live database.

## 6. What the stand-in does and does not exercise

Real code: sign-in checks, the chat route, understanding, the plan and its price, the busy mode, the approval and the reserve, the worker route with its leases and chunks, the social chunk runner, relevance rules, result files (Excel, CSV, PDF), settlement, release, notices, the results view and downloads, rate limits and the concurrent-job limit.
Fake: the data provider (a TikTok-like source: a keyword search and cursor-paged comments), the language model (`LLM_PROVIDER=fake`), the provider balance and its daily cap (high), e-mail (users are created confirmed, no mail is sent).

## 7. Not covered by this test

The real provider's speed and limits, the real model's speed and monthly limit, the sign-in limits and e-mail limits of the live project (check them in `docs/SUPABASE_FREE_PLAN.md`), the hosting plan's limit on deployments per day, and a real venue network.
