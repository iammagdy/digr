# Final merge report (stack #79, #80, #81 with the final fixes)

Date: 2026-10-18. Only raw evidence is reported. Anything not run is marked NOT RUN.

## 1. SHAs and deployment

| Item | Value |
|---|---|
| main before | `de8e6e95575ee6b69e1f5ae67a7a7837f630e2a4`, unchanged for the whole run (checked before the dry run and again before every merge) |
| #81 head before the fixes | `8d577921281d6679a6a7fcafe947832b0c20b3a7` |
| Final-fixes PR | #82 (`claude/final-fixes`, base `codex/quote-cap-and-money-atomic`), head `9b986c9a6428eb848139dbb0ba9520e4439848f3` |
| Merge commit of #82 into #81's branch | `26bd247e488d6dcce0555270fc42219af477d507` |
| Merge commit of #79 into main | `599ca9ce736d7c9e7a72df9488daac8a8a717000` |
| Merge commit of #80 into main | `50414a4554b8783f61fa4becf8efbd176d9612f0` |
| Merge commit of #81 into main | `7aa1782419dbce163a30119a4bd614ec4be3d989` |
| main after | `7aa1782419dbce163a30119a4bd614ec4be3d989` |
| Vercel production deployment of that SHA | `dpl_2u4rR7SqJ4c7TLhKiH7zLBw9qYhs`, state READY |

All four merges used merge commits (no squash, no admin override, no force push). Each merge passed the expected head SHA. Draft PRs were marked ready only because the merge API refuses drafts. #80 and #81 were retargeted to main after their base merged. Older PRs (#3-#11, #40, #41, #44, #69) were not merged or touched.

Two intermediate production deployments were created by the merge order (for the #79 and #80 merge commits, `dpl_5NnSDTUEumW1DNfv2VJanCYxRFyx` and `dpl_DCrfBBimV4XP5TNFdj7w8QqrSAhN`); the last deployment is the one above.

## 2. Tests, build, type check

| Check | Before (#81 head 8d57792) | After (final-fixes head 9b986c9) | Merged main 7aa1782 |
|---|---|---|---|
| `vitest run` | 151 files, 1269 tests passed | 155 files, 1293 tests passed | 155 files, 1293 tests passed |
| `tsc --noEmit` | not run before | exit 0 | exit 0 |
| `npm run build` | not run before | exit 0, zero client-bundle secrets (87 files scanned) | Vercel production build READY |

New tests: 24 (file cards 9, Excel label 5, rejected-row sample 5, owner conversation and approval 5).

## 3. Conflict table

Dry run in a throwaway clone: main + #79, then #80, then #81 with the fixes.

| File | Resolution | Risk |
|---|---|---|
| none | zero conflicts at every step | none |

The merged tree equals the final-fixes branch plus one docs file (`docs/BRANCH_CONTEXT_claude-zealous-carson.md`, the only commit of #80 that #81 did not already contain). No money code, SQL migration, pricing, cap, ledger or settle/release file conflicted, so the stop rule was not triggered. #79 is an ancestor of #80; #81 already contained #80 except that docs commit.

Live database check (read-only SELECT) before merging: all 14 approved money functions exist, security definer, executable by `service_role` only (not `authenticated`, not `anon`), including `create_quote_atomic`, `reject_topup_atomic`, `approve_topup_atomic` and `settle_people_job_atomic(p_job_id, p_base_units, p_email_units, p_phone_units, p_points_cap, p_result_file_id)`. Registry: `professional-people-search` enabled at 83 points, `icypeas-people-search` disabled, six `social-*` capabilities enabled.

## 4. Part A results

**A1 Result cards.** Cause: the chat card, the results panel and the activity footer each hard-coded three download buttons. Fix: the job data API now returns the stored file ids and `producedFormats` from the latest artifact record (a format is produced only when its file id is set). The three places list only those formats; the others appear under "generated on request from the saved data, at no extra cost". Downloading one stores it on the job. The download route already rebuilt files from the saved data with no provider call (asserted by a test). A plain edit now regenerates only formats the job already has, and an unproduced format stays empty. Evidence: `tests/result-file-cards.test.tsx` renders the card; for an Excel-only quote it has one download arrow and two on-request buttons.

**A2 "جاري سحب البيانات".** The sentence exists in one file (`src/lib/postApproval.ts`) and is shown in one place: `handleStartExecution` in the chat page, after the accept-quote call returned success (a failed approval throws first). That handler is wired only to the plan card's approve button. The accept-quote route returns 400 before accepting, reserving or dispatching unless the request carries `explicitApproval: true`. No server text, plan text or prompt contains the sentence. It could not appear earlier, so no code change; tests lock it.

**A3 Excel label.** The workbook really is data only: company workbook = one data sheet (plus a branches sheet when the source returned branches, plus the review sheet only for uncertain rows), people = one sheet, social = one sheet; no methodology, summary or codebook sheet. The label said "data + methodology guide", which was wrong. The label is now "جدول البيانات فقط" and the PDF "الدليل المنهجي". Note: the company workbook can include a branches sheet and the structured workbook can include comment and reply sheets; these are data tables, not methodology.

**A4 Ledger reconciliation** (test account `b0d08be8-db61-4860-841e-fa963045557e`, read-only SELECT, database time 10:09 UTC). Balance is the sum of the ledger (692 now). Rows from 08:51 onward:

| Time (UTC) | Job | Type | Delta | Balance after the job |
|---|---|---|---|---|
| 08:51:20 | job_quote_7c4d2c25... | reserve | -35 | |
| 08:51:32 | same | charge | -6 | |
| 08:51:32 | same | release | +35 | 710 |
| 09:22:27 | job_quote_5b68da43... | reserve | -11 | |
| 09:22:36 | same | charge | -9 | |
| 09:22:36 | same | release | +11 | 701 |
| 10:06:21 | job_quote_17526001... | reserve | -11 | |
| 10:06:28 | same | charge | -9 | |
| 10:06:28 | same | release | +11 | 692 |

Arithmetic: 710 + (-11 - 9 + 11) + (-11 - 9 + 11) = 710 - 9 - 9 = 692. The jobs table agrees: both 09:22 and 10:06 jobs are `completed`, reserved 11, charged 9, delivered 3 of 3. Over the full last three hours (07:41 onward, 20 rows) the net is -113 = fa6d (-50) + 667f (-9) + 9d58 (0, released after failure) + f8dd (-30) + 7c4d (-6) + 5b68 (-9) + 1752 (-9). Every reserve has a matching release for its unused part and every charge equals the delivered units; no unexplained row.

**A5 Rejected-row sample.** Not present before (only uncertain rows were stored). Added `partials/<job>/rejected_sample.json`: at most 10 masked rows per job (emails, phones, links cut; handles cut to two characters; only diagnostic fields kept) with reason codes `out_of_region`, `industry_mismatch`, `no_text`, `topic_not_in_text`, `other_mismatch`. It is written best effort before any release path, so a job whose rows were all rejected still leaves evidence; it never changes delivery or charge. The relevance gate itself is unchanged.

**A6 Owner conversation.** `tests/owner-conversation-regression.test.ts` runs the real chat handler offline: "عايز ٣ شركات كهرباء في مصر" returns a plan card (Excel only, 9 points expected, 11 reserved, which is the exact amounts in the ledger above); after approval and completion, "فين الايميلات بتاعت الشركات دي؟" returns a conversational answer with the decision-makers offer (579 expected, 600 reserved), exactly one question mark, no card, no English, no emoji, and no "جاري سحب البيانات" anywhere before the approval.

## 5. Production checks

**Environment variable names on Production** (names only; values not read): present: `TREG_LIVE`, `TREG_TOKEN`, `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `APP_URL`. Also present and unused by the current code: `OPENAI_API_KEY`, `APPWRITE_API_KEY`, `NEXT_PUBLIC_APPWRITE_ENDPOINT`, `NEXT_PUBLIC_APPWRITE_PROJECT_ID`.
**Not present on Vercel: `RESEND_API_KEY`** (the name the code reads in two places). If the platform emails are sent from Supabase edge functions the key lives in Supabase secrets, which was NOT checked (no access to secrets). Confirm before the launch that email confirmation and top-up emails actually send.
**Deployment Protection:** SSO protection is enabled with scope "all except custom domains", password protection off. Production traffic on `diger.tech` is not blocked. Internal worker dispatch uses the request origin, so it works when customers use `diger.tech`. A request made on a `*.vercel.app` URL would be blocked by protection; for that case `VERCEL_AUTOMATION_BYPASS_SECRET` would be needed and it is NOT set.

**Smoke test** (no login, no jobs, no spend), against the final deployment:

| Check | Result |
|---|---|
| `GET https://diger.tech/` | 200, 79,639 bytes, `lang="ar" dir="rtl"`, title "Diger — مصادر متاحة جاهزة للتحليل" |
| `/services` | 200, 39,854 bytes |
| `/calculator` | 200, 25,298 bytes |
| Provider names in HTML (case-insensitive counts) | home 0; `/services`: `icypeas` 1, all others 0; `/calculator`: `icypeas` 1, all others 0 (tikhub, scrapecreators, anyapi, crawl4ai, treg, apify, serpapi, openai, anthropic, claude, supabase, vercel, resend all 0) |
| Security headers | present: strict-transport-security, x-content-type-options nosniff, x-frame-options SAMEORIGIN, referrer-policy, permissions-policy. Not present: content-security-policy |

The single `icypeas` hit on each page is the internal capability id `icypeas-companies-search` in page markup (a React key on `/services`, an option value on `/calculator`); the visible text is the Arabic label "بحث واستخراج بيانات الشركات". It is not shown to a customer but it is readable in the page source. Follow-up (not done, it touches the id used for pricing lookups): expose an opaque id to the browser.

## 6. Older open PRs (listed only; one-line risk each, from title and base, diffs not reviewed here)

- #3 to #9 (A to G): a chain of stacked PRs from 2026-10-10 (question cards, persona modules, result review, goodwill refunds, dependent plans, OpenAI readiness, polish). #4 to #9 target each other, not main; the goodwill-refund and artifact-edit parts touch money-adjacent code, and they are 8 days older than main, so expect conflicts (not tested).
- #10: governance docs only; low risk, may conflict on docs.
- #11: full redesign on top of the #3 to #9 chain; very large, targets `feat/visual-polish`, not main.
- #40: design handoff audit (docs); low risk.
- #41: UI redesign onto main; large UI change that overlaps files changed by this stack (chat page, landing); needs a fresh rebase and a visual check.
- #44: Vercel Web Analytics; small, but adds a third-party script to the page; check privacy wording first.
- #69 (draft): email confirmation and pending review fixes; not touched as instructed; it overlaps auth and top-up code that this stack also changed.

## 7. Remaining risks

- Intermediate production deployments exist for the first two merge commits; only the last matters.
- `RESEND_API_KEY` is not on Vercel (see above).
- No content-security-policy header.
- The browser flow (login, plan card, approval, download cards) was NOT RUN in a real browser in this task; it is covered by offline tests and a rendered-markup test only.
- No provider call and no job was run on the merged production build, so the people (decision-maker) settlement path is verified by tests and by the live function signatures only, not by a live job.
- The rejected-row sample is written best effort; if storage fails it is silently skipped.
- Ledger rows from earlier test runs and test accounts still exist (balance is derived from the ledger and cannot be edited).

## 8. Owner TODO list (apply nothing automatically)

1. Change the test account password.
2. Clean test accounts and balances using `docs/OWNER_SQL.md`.
3. Set a monthly spend cap in the Anthropic console.
4. Add a support email or WhatsApp number.
5. Build the free-credit promo code system (not built yet; the 500 free points for the friendly launch need it).
6. Confirm where emails are sent from (Resend key) and that confirmation emails arrive.
7. Then ask Codex to run the browser test on https://diger.tech with the test account.
