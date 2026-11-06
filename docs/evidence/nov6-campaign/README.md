# Nov 6 2026 five-platform acceptance campaign: corrective release evidence

All production facts below come from read-only SELECTs on the test account `b0d08be8-db61-4860-841e-fa963045557e`. No SQL write was made. No refund, top-up or ledger correction was made. No mission was edited. No paid call or provider call was made. No flag was changed.

Files in this folder marked **SIMULATED** come from a local app or render with fakes. They are **not** production evidence.

## The five missions (as stored)

| Platform | Mission / job | Held | Released | Charged | Delivered units | Ledger rows |
|---|---|---|---|---|---|---|
| TikTok | `msn_f9cdb48986c81ffca69d` / `job_quote_bbd4327b8e4abdb0e8ea7b8921a82827` | 200 | 200 | 200 | 6 | `res_` / `rel_` / `chg_` |
| YouTube | `msn_5e7dc2df0af1a39a099d` / `job_quote_cd5c3c00661ec10dcc116c38e35f9acf` | 200 | 200 | 200 | 6 | `res_` / `rel_` / `chg_` |
| Facebook | `msn_60fd71cf5e4d1c9fc5f2` / `job_quote_7125022b542d8c612366926f2c5c2098` | 248 | 248 | 215 | 6 | `res_` / `rel_` / `chg_` |
| Instagram | `msn_34dcf09434697a62995c` / `job_quote_23f61141a3992490106b91a818e3a74d` | 200 | 200 | 100 | 3 | `res_` / `rel_` / `chg_` |
| X | `msn_d31f37958788a24ec46d` / `job_quote_0c51137a3be88d007ef2b843c514a04c` | 200 | 200 | 200 | 2 | `res_` / `rel_` / `chg_` |

- Total charged: **915 points**.
- Each job has exactly one reservation row, one release row and one charge row.

## X charge: eligibility review (evidence only; NO financial action)

**What was requested**
- «اجمع لي منشورين عامين من إكس عن الذكاء الاصطناعي، مع ردين حقيقيين على كل منشور، والروابط وأسماء الحسابات.»
- That is: 2 original public posts about AI, plus 2 real replies to each, with links and account names.

**What was approved** (`missions.plan`, approved at 18:59:09 UTC)
- One stage, `tweets`, read with `anyapi.x.search.posts`.
- Query `"الذكاء الاصطناعي"`, `queryType: Latest`, `limit: 20`, with **no** `-filter:replies`.
- Promise: `tweets` exact 2.
- Summary: «تغريدتان من إكس عن «الذكاء الاصطناعي».».
- There was **no replies stage and no `unserved_steps` line**. The card never said the replies were dropped.
- Price: 200 points, which is the minimum charge (`minApplied: true`, `deliveredRows: 2`).

**What was delivered**
- 2 rows. Both pinned rows are `is_reply: true`, i.e. replies to other accounts.
  - `2118780026737041638` (@naseer_ri), posted 18:58:18.
  - `2118779993329480040` (@waelyash), posted 18:58:10.
  - Both have `replies_count: 0`.
- No original post was delivered and no reply sheet was delivered.
- The approved columns include `is_reply` («رد على تغريدة»), so the sheet would carry that mark on both rows. This is inferred from the plan: the delivered file was not read.

**What the ledger charged**
- `res_job_quote_0c51…` −200 at 18:59:10.
- `rel_…` +200 and `chg_…` −200 at 18:59:14.
- Net: 200 points.
- Job: `charged_credits` 200, `delivered_units` 2, provider cost USD 0.00054.

**Assessment for the owner**
- The 200 points paid for 2 rows that are not what was asked: replies were delivered as the requested original posts.
- The requested replies step was dropped without disclosure, because of a parser defect (fixed in #432).
- The account is a dedicated test account, so no customer was harmed.
- On the evidence, **remediation is warranted if the owner applies the customer-facing rule**: «never bill an unrelated reply as a requested original». The candidate is a full 200-point goodwill credit for this job.
- **Decision and any ledger action belong to the owner. Nothing was done.**

The Instagram (100 points, 1 of 2 reels unrelated to the request, 3 of 6 rows) and Facebook (215 points, 1 of 2 posts marked «لا يذكر الموضوع») charges carry the same class of question. They are listed for the owner's review only.

## Five-mission regression replay (verbatim production requests; code, no calls)

`five-requests-ask-before-242cd69.json` and `five-requests-ask-after.json` hold `buildAsk` of the five verbatim requests, on old main `242cd69` and on the merged code.

| Platform | Field | Before (`242cd69`) | After |
|---|---|---|---|
| X | `replies` | `none` | `some` |
| X | per-tweet replies | — | 2 |
| X | order | `newest` | `most_commented` (`Top`) |
| Facebook | `kind` | `videos` | `posts` |
| Facebook | topic | «الذكاء الاصطناعي (منشورات فيديو لو متاح)» | «الذكاء الاصطناعي» |
| Facebook | preference | — | «منشورات فيديو لو متاح» |
| Instagram | topic | «… (ريلز لو متاح)» | «الذكاء الاصطناعي» |
| Instagram | preference | — | «ريلز لو متاح» |
| All five | comments per parent | none (a question was asked) | 2, read from «تعليقين … على كل» |
| All five | `wants` | none | `author` (from «أسماء الحسابات/الصفحات/القنوات») |

The failure shapes are replayed on the stored plan rows in:
- `tests/nov6-x-replies-scope.test.ts`
- `tests/nov6-topic-relevance.test.ts`
- `tests/nov6-instagram-file-contract.test.ts`
- `tests/stage2-live-equality.test.ts` (Facebook case)

## Browser evidence (SIMULATED)

**`live-sheet-journey-SIMULATED.json`**
- 48/48 checks pass: 16 desktop at 1280, 16 phone at 390, 16 narrow at 320.
- Setup: the existing real-Chromium journey (`scripts/browser-journey/live-sheet-journey.browser.ts`) with `next dev` from this tree, the real live route, the real worker snapshot code, stored M12 rows, fake sign-in and in-memory storage.
- Run on the tree that contains #432 to #435.

**`card-ui-SIMULATED.json` with `card-*.png`**
- 18/18 checks pass at 1280, 390 and 320. Covered:
  - no sideways scroll;
  - «اعتمد بدون هذه الخطوة» shown and fully on screen;
  - the excluded replies step and its choice line shown;
  - «عينة أولية قبل التنفيذ» shown;
  - RTL layout.
- Setup: the real `AgentMissionCardBody`, rendered from the real customer view over a compiled plan of the stored X request with no replies card, with the production-built CSS, in real Chromium.
- Script: `scripts/browser-journey/nov6-card-ui.chromium.ts`.

## Not proven / not accessible
- **Wegz's original XLSX, CSV and browser captures were not available to this session.** The production facts above come from the database only.
- The private Storage objects (`result.xlsx/csv`, `rows/*.json`, `live/snap_*.json`, `raw/*.json`) could not be read: the access is SQL only.
- So the **source of the Facebook chat table's «1,602 likes / 584,517 views» is NOT proven**. Neither number is in any database row of the mission. The deciding read is `msn_60fd71cf5e4d1c9fc5f2/live/snap_*.json`.
- **Heroku:** the worker heartbeat reports `version: "dev"`, so the running dyno's commit is **unknown**.
  - New worker ids started at 20:38:48, 20:54:47, 21:08:56 and 21:29:51 UTC.
  - Those times follow the four merges, which Vercel deployed at 20:37, 20:53, 21:07 and 21:29.
  - This is consistent with an auto-deploy from `main`. It is not verified.
- No provider fallback was exercised. No claim is made about tool-selection quality or fallback behaviour beyond the unit tests.
