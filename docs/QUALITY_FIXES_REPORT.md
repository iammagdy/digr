# Quality fixes report

Branch `claude/quality-fixes`, started from main `ab0af3d` (PR #87, provider keys). Main had not moved when the branch was
finished (`git fetch` showed `ab0af3d` again), so the dry-run merge into main is "Already up to date": zero conflicts.

The merge commit, the main SHA after the merge and the Vercel production deployment id cannot be known before the merge.
They are in the final message of the run (main before: `ab0af3d`).

## Test counts

| | Files | Tests passed | Skipped |
|---|---|---|---|
| Before (main `ab0af3d`, no scratch Postgres) | 174 passed, 2 skipped | 1514 | 21 |
| After (this branch) | 182 passed, 2 skipped | 1584 | 21 |

`npx tsc --noEmit`: 0 errors. `npm run build`: exit 0, client-bundle secret scan "Zero client bundle secrets detected"
(102 static files scanned). The 15 earlier feature items keep their tests; none was removed. Four existing tests were
changed on purpose because the behaviour they pinned was the thing the owner asked to change (listed below).

New test files: `request-scope` (11), `stall-guard` (9), `topic-gathering` (8), `file-shaping-after-job` (8),
`provider-call-caps` (9), `excel-quality` (8), `arabic-only-public` (6), `prompt-token-breakdown` (4); extended:
`result-file-cards` (now 14), `system-prompt-parts`.

Existing tests changed on purpose: `result-file-cards` (no more «on request» offers), `anthropic-provider` (system prompt is
now four blocks), `company-report-scope-and-fields` (review sheet has a notice row first), `file-shaping`
(spec shape), `provider-keys-resolver` (a flaky tamper test: it flipped a base64 character that can decode identically).

## Items 1–10

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Context pollution | DONE | `tests/request-scope.test.ts`, exact sequence «مساء الخير» / «إنت مين؟» / 3 managers in Saudi energy / 10 TikTok comments on basketball in Egypt, and the two research requests in the opposite order. Offline probe on the old code: region `SA`, query «مساء الخير إنت مين مديرين شركات». After: region `EG`, query «كرة السلة», no contact wording. |
| 2 | «هات ١٠ تغريدات عن كرة السلة» stalls | DONE | `tests/stall-guard.test.ts` (9). Plan or ONE question, never an announcement; turn budget 38 s; client timeout message in Arabic. Root cause below. |
| 3 | «اجمع ١٠ دراسات عن الطاقة الشمسية في ألمانيا» | DONE | `tests/topic-gathering.test.ts` (8): one specific question (`topic_source_required`, four source options) before any model call; the generic «اكتب الموضوع أو أرسل رابط» sentence is replaced. |
| 4 | «قسّم الملف شيت لكل محافظة» after a delivered job | DONE | `tests/file-shaping-after-job.test.ts` (8), exact text on a company job: shaping flow on the saved data, no provider call, no charge. Company data has no governorate column, so it asks ONE question naming the real columns («المقر والنطاق الجغرافي» …). |
| 5 | Excess provider calls | DONE | `tests/provider-call-caps.test.ts` (9) replays both production job shapes through the worker. Cause below. |
| 6 | Result cards | DONE | `tests/result-file-cards.test.tsx` (14): `renderToStaticMarkup` of an Excel-only job shows exactly one download card and no other format; the report tab exists only when a PDF was produced; the timeline of a completed job has no «جاري …» line; the activity dot stops pulsing when the job is finished. |
| 7 | Excel | DONE | `tests/excel-quality.test.ts` (8): a LinkedIn URL in `website` moves to the LinkedIn column; addresses and categories translate through fixed maps or carry an Arabic marker («عنوان غير مترجم — كما ورد في المصدر:», «تصنيف غير مترجم — …»); the review sheet starts with «هذه السجلات لم تُحتسب عليك ولم تُخصم نقاطها…»; for an electricity request HVAC/air-conditioning/plumbing text goes to review (uncertain) even under an energy label, while a real electrical company is still delivered. |
| 8 | Arabic only | DONE | `tests/arabic-only-public.test.tsx` (6): no `@example` in /services (the example now reads «هات آخر ١٠ فيديوهات من حساب تيك توك أحدده لك»), the calculator and services pages write «إكس», /contact renders the support email and WhatsApp on the server pass with no «سيُضاف قريبًا»; with only one channel set the other card is hidden; the placeholder shows only when neither is set. |
| 9 | Prompt cost | PARTIAL | Structural change certain; the live number must be confirmed on the next `provider_costs` LLM rows. Estimates below. |
| 10 | Tests | DONE | Counts above. |

## Root cause, item 2 (plan turn stalls, composer disabled)

The model sometimes returned only an announcement («هجهز خطة…») as plain text with no tool call. The handler treated that as a
final answer, so no plan card came and the chat stayed in "preparing". On the catalogue path the loop allows up to four
search iterations, each with search retries and a model call, plus a stall retry and a colon retry. None of them had an overall
deadline, so one turn could run past the client's 55 s abort while the route allows 60 s, and the composer stayed disabled for
about a minute.

Fix: a stall guard before routing. A `search_catalog` answer or an announcement-only answer is retried once while time is left;
otherwise the code builds the plan itself (`buildAutoPlanProposal`) when the inputs are ready, or asks ONE concrete question.
A 38 s turn budget (`TURN_BUDGET_MS`, minimum 12 s for a new model call) is checked in every loop. A provider outage keeps its
honest refusal. The client timeout message now says nothing was charged and offers retry.

## Root cause, item 5 (19 provider calls for 2 records)

Evidence from `provider_costs` (read-only SQL):

- Job `job_quote_114c26de…`: 2 records requested, **19 pages of 2 records**, 17 pages with zero matches (every row rejected by
  the geographic gate «خارج النطاق الجغرافي المطلوب (مصر)»), matches only on pages 5 and 19. Rows 415–433, 0.00076 USD each,
  **0.01444 USD** in total, `units` 0 in 17 rows.
- Job `job_quote_92e9585b…`: 3 records requested, 2 pages of 10 records, 0.0038 USD each = **0.0076 USD** against a quote that
  assumed 0.00038 × 3 = 0.00114 USD.

Cause: (a) the plan's page size equalled the requested count (2), the provider mostly returned foreign companies, and nothing
limited the number of pages or the number of consecutive empty pages; (b) the provider bills every REQUESTED record on a page
(0.00038 USD per record), so a page costs page size × 0.00038, while the quote and the chunk estimate assumed only the records
still wanted.

Fix (all in `src/lib/server/providerCallCaps.ts`, documented constants): jobs of at most 10 records use a page of
`min(10, max(5, 3 × records))`, stop after 3 pages (`SMALL_JOB_MAX_PAGES`) or 2 consecutive empty pages
(`MAX_CONSECUTIVE_EMPTY_PAGES_SMALL`); large jobs stop after 3 consecutive empty pages and an absolute 30 pages. The chunk
spend estimate and the reserve now use the whole page, so the daily provider cap sees the real cost. Customer prices are
unchanged. When the cap stops a job, only the matching rows are delivered and the activity feed says why.

| Records | Page size | Max pages | Cost per page | Worst case |
|---|---|---|---|---|
| 2 | 6 | 3 | 0.00228 USD | 0.00684 USD (was 0.01444 USD observed) |
| 3 | 9 | 3 | 0.00342 USD | 0.01026 USD (was 0.0076 USD observed on 2 pages) |
| 10 | 10 | 3 | 0.0038 USD | 0.0114 USD |

## Item 9: where the tokens come from, and before/after

Section-by-section estimate of a real plan request (script-aware estimate: Arabic letters 1 token per 2.2 characters, other
text 1 per 3.6; printed by `npx tsx scripts/measure-llm-cost.ts` and by `tests/prompt-token-breakdown.test.ts`):

| Block | Tokens | Cached after this change |
|---|---|---|
| Tool schema (`actionResult`) | 1081 | yes |
| Fixed prompt (identity, product, language, plan rules, discovery, social, output, honesty, conversation, B2B, safety, output format) | 6.2k | yes |
| Full platform guide (inside the fixed prompt) | 2074 | yes |
| Capability inventory, all 20 capabilities | 810 | **moved into the cache** |
| User profile and persona | 295 | **moved into the cache (per user)** |
| Per-turn state (balance, date, conversation state) | 91 | no |
| Conversation messages (brief, catalogue summary, history) | varies, 0.3k–5k | no |

What was changed, with the full capability list and the identity untouched:

1. The system prompt is sent as four blocks in cache order: fixed rules, capability inventory, user profile, per-turn state.
   Before, the inventory and profile (about 1.2k tokens) were re-read at full price on every turn.
2. Earlier turns are shortened before they are sent (assistant replies to 500 characters, customer messages to 1200); the
   newest message is always whole.
3. A short brevity rule asks for at most two sentences per text field and no empty optional plan keys (expected to trim output
   tokens; not measured offline).
4. The model string `claude-haiku-5-5` is unchanged; the balance line is no longer duplicated in the prompt.

Estimate for one plan turn with a cache hit, calibrated so the "before" total matches the live ~16k input tokens
(0.0058–0.0067 USD per turn in `provider_costs`):

| | Input tokens | USD per turn |
|---|---|---|
| Before | ~15.5k | 0.00702 |
| After, cache blocks only (certain, history not shortened) | ~15.5k | 0.00618 |
| After, cache blocks and shortened history | ~12.5k | 0.00429 |

The target of 0.005 USD is met only if live conversations are as long as the calibration fixture (ten messages, assistant
replies of about 1800 characters). If live histories are shorter, the certain saving is about 0.0008 USD per turn (12 %).
The owner can verify after deploy: compare the units and cost of the next LLM rows in `provider_costs` with 0.0058–0.0067.

## Remaining risks

- Item 9 live cost is an estimate (see above); the cache needs repeat turns within five minutes to pay off, and a first turn
  writes a slightly larger cached prefix at 1.25 times the input price.
- Item 5: the happy path of a 2-record job now costs more provider money per page (0.00228 USD against 0.00076 USD) because
  pages are larger; the bad path is bounded at 0.00684 USD instead of unbounded. Customer prices were deliberately not changed,
  so a job that hits the cap costs more in provider money than its quote covers. The reserve and the daily
  provider cap now see the true cost.
- `/services` still lists the «topic-news-academic-research» service even though no executable service backs it; item 3 only
  makes the assistant ask a precise question instead of a generic one.
- The Supabase MCP in this run was read-only; nothing was written to the database.
- Not verified on real data: the English-to-Arabic address map is small (cities, countries, street words, numbers); anything
  else keeps the original behind the Arabic marker.

## Owner TODO

1. Clean the test accounts through `docs/OWNER_SQL.md` before launch.
2. Run the Codex browser test again.
3. Launch.
