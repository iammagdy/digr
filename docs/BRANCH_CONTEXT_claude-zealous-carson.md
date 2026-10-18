# Branch context: `claude/zealous-carson-sdg9x4` (draft PR #80)

Written 2026-10-18 for an agent that has not seen this work and has to judge conflicts with the other open PRs before anything is merged.
No secret, credential or customer value appears here. Everything marked "measured" was read from a command or a database/catalog query;
everything marked "NOT RUN" was not executed.

## 1. Where this branch sits

| Item | Value |
|---|---|
| Repo | `iammagdy/digr` (production branch `main`, Vercel Hobby, Supabase project `pfinlfaqwnytesedchik`) |
| Branch / code head | `claude/zealous-carson-sdg9x4`; last code commit `ea40cbb205dca428e06f1cfc405e6434bf602e72` (a commit that only adds this document may follow it) |
| PR | #80, DRAFT, base `codex/discovery-stage-fixes` (PR #79, also DRAFT, base `main`). It is NOT based on `main`. |
| Size | 21 commits, 95 files, +7489 / -1387 relative to `codex/discovery-stage-fixes` |
| `main` | `de8e6e9`; `main` has not moved since this branch's merge base (0 commits ahead) |
| Vercel | head READY: `dpl_69jYz3dL2X5dW4UsjT3J1oGoqVjH` (the exact SHA matches) |
| Checks run | `npx vitest run`: 1163 tests in 132 files, all pass (1034 at the start of the work); `npx tsc --noEmit` clean; `npm run build` passes, zero client-bundle secrets |
| Database | NOT touched. Only read-only queries were run. One OPTIONAL migration file was added and NOT applied: `supabase/migrations/20261017150000_register_professional_people_search.sql` |

### Open PR map (read from GitHub on 2026-10-18)

| PR | Branch | Base | State | Relation to this branch |
|---|---|---|---|---|
| #79 | `codex/discovery-stage-fixes` | `main` | draft | This branch is stacked on it. |
| #80 | `claude/zealous-carson-sdg9x4` | #79's branch | draft | This work. |
| #81 | `codex/quote-cap-and-money-atomic` | THIS branch (`ea40cbb`) | draft | Stacked on this branch. It changes many files this branch created or changed (see section 6). Only the first 100 of its changed files were listed; its content was NOT reviewed. |
| #69 | `codex/auth-topup-flow` | `main` (older sha `289526d`) | draft | Auth confirmation and top-up status. Almost no file overlap with this branch (section 6). |
| #3-#11, #40, #41, #44 | design / persona / refund chain and design-foundation PRs | various | open, not draft | Older (2026-10-10 to 2026-10-13). Not reviewed here. #3 to #9 form a chain of stacked branches. |

Merge order implied by the stack: #79, then #80, then #81. If the stack is merged with SQUASH merges, the later PRs still contain the earlier PRs' original
commits and will conflict; use merge commits for a stack, or rebase each later branch onto the new base before merging.

## 2. Owner rules that govern every change (they were given as non-negotiable)

1. Money tables (`credit_ledger`, `jobs`, `topups`, `plans_quotes`, `provider_costs`, `profiles`) change only through the approved SQL functions: `reserve_credits_atomic`, `accept_quote_atomic`, `settle_job_atomic`, `release_job_atomic`, `approve_topup_atomic`, `reserve_provider_spend_atomic`, `commit_provider_spend`, `claim_job_chunk`, `complete_chunk`, `record_chunk_failure`, `purchase_methodology_atomic`. The ledger is append-only. Refunds are `rel_` rows. Nothing is spent before approval. The model never decides prices or money.
2. Pricing: provider unit cost USD x 55 x 10 / 0.10 = points, rounded up per unit; 15% buffer on the reserve only; charge = ceil(delivered unique matching rows x unit price), never above the reserve; caps `PROVIDER_DAILY_SPEND_CAP_USD` 0.80 and `JOB_MAX_POINTS_CAP` 600; the public calculator and the quote writer must use the same pricing function.
3. Supabase: read-only queries for evidence; schema changes are migration files that the owner applies; new function privileges are revoked from PUBLIC/anon/authenticated and granted to service_role only.
4. Customer-facing text: Arabic only, Arabic-Indic digits, no emoji, never a provider name, endpoint id, USD amount, model vendor or internal function name.
5. Never change the Anthropic model string (it is `claude-haiku-5-5`, the one the database records) or the LLM daily cap.
6. No real provider spend without the owner. No script that spends provider budget was run.
7. Owner decisions already taken: works for any country (no default country); the customer's name comes from the profile and is asked once if missing; decision makers are normal B2B work; source wording is "مصادر متاحة"; Excel carries data only and the methodology is a separate Arabic PDF; discovery asks only for missing required inputs, one at a time.

## 3. Part 1 of the branch: verification pass over PR #79 (report: `docs/MUSE_REPORT.md`)

- The head of #79 had 41 failing tests (14 new in #79, 27 already failing on `main`). Each was reviewed: code fixed where the code was wrong, test updated where an owner decision replaced the old behavior. None deleted, skipped or weakened. Decision table is in `docs/MUSE_REPORT.md`.
- Retry reuse: the retry button reuses rows a failed job collected (partials `partials/<jobId>/step_<n>.json`) and fetches only the deficit. Marker `retryOfJobId` lives in the plan item params (part of the plan hash), is stripped before the provider, and is validated from the database (same user, status failed, under 24 h, same search signature). New files `src/lib/server/retryReuse.ts`, `src/lib/retryMessage.ts`; no new SQL.
- No Egypt default (three leftovers removed), structured industry over free keywords, Arabic number words, post-approval message, stale `diger_active_job_id` guard, one request-status resolver (`src/lib/jobs/requestStatus.ts`), English city names to Arabic, distinct provider-failure vs valid-empty release reasons, softer relevance for "contracting", plain Arabic activity events, ETA from measured batch durations.
- Name handling (`src/lib/customerName.ts`, `src/lib/server/customerNameStore.ts`): never a hardcoded name; asked once; stored through the customer's own session.
- Decision makers: a verified code-served capability `professional-people-search` (83 points a person), contact-field wording in `src/lib/contactExpectation.ts`, field verification statuses in `src/lib/contactVerification.ts`.
- Result files: Excel is data only; company workbook has verification status columns and a linked branches sheet; methodology is Arabic text.
- The manual `rel_` instruction in the stuck-job report was removed. `docs/MONEY_WRITES_PLAN.md` lists every direct write to the six money tables (82 sites; none rewritten) and proposes `create_quote_atomic`, `submit_topup_atomic`, `reject_topup_atomic`, `log_llm_cost`, `schedule_account_deletion`, `cancel_account_deletion`, `anonymize_deleted_profile` as migration files for the owner.
- Prompt caching: system prompt sent as a cacheable fixed block plus a small per-turn block (`buildSystemPromptParts`), cache tokens priced (read 0.1x, write 1.25x).

## 4. Part 2 of the branch: social research (report: `docs/SOCIAL_RESEARCH_REPORT.md`)

Goal: researchers pull comments of a Facebook/YouTube/TikTok post or video, videos of a keyword, a channel or the trending feed, and trending videos together with their comments.

### Root causes found (each with evidence in the report)

1. Every social endpoint id in the live registry (11 rows) plus the `internal-...` ids for Facebook and YouTube comments returns HTTP 404 on the provider's public catalog (`https://treg.to/catalog/endpoints/<id>`). Only the TikTok profile, companies and people services exist.
2. The assistant did not read "كومنتس / ستراندنج"; the catalog was searched for the platform alone and the cheapest-first ranking put a 364-point post search above the comments service.
3. The result reader recognized lists only under fixed names (`videos`, `posts`...) and not `comments`, `rows` or a routed `{output, raw}` envelope; an aggregator answer `data.comments` became ONE junk row that would have been billed.
4. The default source was the slow one (median 14 s, 97.7% success vs 3.4 s and 99.99%); 6 of 10 TikTok keyword-video jobs in the database failed. No per-call time limit and a 60 s worker limit.
5. The worker runs plan step 1 only, so "videos and their comments" was impossible.
6. The old TikTok channel service needs a `secUid`, not a username.
7. Result files had raw English columns, a duplicated likes column, raw unix timestamps, and CSV and Excel disagreed.
8. A silent default period ("آخر شهر" / "آخر ٣ شهور") filtered social results and discarded older comments.
9. Questions borrowed another question's options (country question offered "حتى ٢٥ سجلاً"; account-name question offered platforms).
10. The calculator priced from provider cost while the quote writer priced from the customer rate (5 vs 9 points for a YouTube comment).

### What was built (new files)

| File | Purpose |
|---|---|
| `src/lib/socialSources.ts` | Verified source table: six capabilities (`social-tiktok-comments`, `social-youtube-comments`, `social-facebook-comments`, `social-tiktok-videos`, `social-youtube-videos`, `social-facebook-posts`), each with ordered sources (endpoint id, method, price, max rows per call, paging, parameter builder). `canonicalSocialParams`, `socialPlanSummaryAr`, `extractSocialRef`, `validateSocialParams`, `estimateSocialChunkCostUsd`. |
| `src/lib/socialTasks.ts` | Pure request understanding (Egyptian and standard Arabic and English): platform, task, link kind, channel, trending; `getMissingSocialTaskInputs` and `socialTaskQuestion`; `SOCIAL_TASK_PLATFORMS`; `SOCIAL_TASK_QUESTION_IDS`. |
| `src/lib/server/socialAdapter.ts` | Runs one worker chunk of a social capability: tries sources in order, falls through on failure / unrecognized answer / empty first page, two-stage videos-then-comments with state in the chunk cursor (JSON), per-call time limit, chunk time budget (40 s) and call budget (6), idempotency key per call. The network call is injected. |
| `src/lib/server/providerRows.ts` | One reader for provider answers: `findProviderResultList`, `findProviderNextCursor`, `hasRecognizedProviderResultShape` (valid empty list vs no list). |
| `src/lib/server/socialRows.ts` | Fixed Arabic result schema for comments and videos (`normalizeSocialComment/Video`, `parseCount`, `toIsoDate`, `SOCIAL_COLUMN_ORDER`). |
| `src/lib/socialDiscovery.ts` | Shared helper for the discovery gate (account / topic / platform). |
| `scripts/verify/verify-social-live.ts` | Ten tiny live checks (about USD 0.03) for the OWNER to run with `--confirm-spend`. NOT RUN. |
| `tests/fixtures/treg-social-catalog.json` | Catalog fixture captured 2026-10-17 (method, declared parameters, required parameters, price, measured success) for the contract test. |

### What was modified (the integration points; these are where other branches collide)

| File | Change |
|---|---|
| `src/functions/shared/chatHandler.ts` | Discovery gate calls `getMissingSocialTaskInputs` and skips the old generic topic question for requests the social services understand. For a social request: only the verified capability is shown to the model (`capabilityAsCatalogEndpoint`), plan items are rebuilt server-side (`canonicalSocialParams`, volume from the customer's stated count capped at the capability's `maxRows`), the plan goal line is written by the server (`socialPlanSummaryAr`), dates come only from a period the customer wrote (`extractDateHint(conversationRequestText)`, never `brief.dateRange`). |
| `src/functions/shared/capabilityRegistry.ts` | `RAW_SEED_CAPABILITIES` is now `[...BASE_SEED_CAPABILITIES, ...social seeds]`. `getEnabledCapabilitiesWithCoreServices` serves `professional-people-search` and the six social slugs from code only while the registry has NO row for them (a disabled row is a kill switch), with one registry query for all slugs (`registryRowStates`). |
| `src/lib/server/jobExecutionSpec.ts` | A social slug resolves from the quote alone: `pricingUnit: "call"`, `unitCostUsd` = chunk worst-case estimate, `pageSize` 50, `paginationStrategy: "cursor"`; the live catalog is never consulted for it. |
| `src/lib/server/tregAdapter.ts` | `defaultTregAdapter` dispatches social slugs to `runSocialChunk` through `socialCallThroughTreg` (one retry only); `providerFailureMessageAr` extracted; `hasRecognizedProviderResultShape` re-exported from `providerRows`. |
| `src/functions/shared/tregClient.ts` | Optional `timeoutMs` on a call (`AbortSignal.timeout`). |
| `src/app/api/worker/chunk/route.ts` | De-duplication across pages and chunks is applied to social rows too (`dedupeIdentity`); result metadata carries `socialKind` and the platform; Arabic title (`socialResultTitleAr`); retry seed and distinct failure reasons from Part 1. |
| `src/lib/server/normalizationPipeline.ts` | `normalizeDataset` uses the fixed schema when `metadata.socialKind` is set; Arabic-only column titles (removed "(Handle)", "(URL)", "(Bio)", "(Retweets)"); new column titles for video / comment fields. |
| `src/functions/shared/fileGenerators.ts` | `generateSocialDataWorkbook` (one sheet, Arabic headers, live links). |
| `src/functions/shared/catalogClient.ts` | `mapSearchQueryToEnglish` uses the social intent (a task query such as "tiktok video comments") before the generic keyword map. |
| `src/functions/shared/clarification.ts` | A free-text question never carries option chips; a question whose id is in `SOCIAL_TASK_QUESTION_IDS` keeps its own options. |
| `src/functions/shared/systemPrompt.ts` | New "SOCIAL RESEARCH (RULE S1)" section in the fixed block. `PROMPT_VERSION` is deliberately still `6.0.0` (three tests pin it). |
| `src/lib/calculatorPricing.ts` | Unit price uses `customerPriceUsdPerItem` when set, like the quote writer. |
| `src/lib/server/retryReuse.ts` | `rowIdentity` also reads `cid` and `aweme_id`. |

## 5. Contracts a merge must keep (checks for the reviewing agent)

- Tests: `tests/social-*.test.ts` (tasks, sources, adapter, plans, worker, outputs, spec) must still pass. `tests/social-sources.test.ts` is a contract test against the catalog fixture: every endpoint id, method and parameter name used by a source must be declared there, required parameters must be sent, and the first source of each task must be at 97% measured success or better (one stated exception: the YouTube trending feed).
- `RAW_SEED_CAPABILITIES` must keep the social seeds; `tests/capability-registry-phase2.test.ts` requires every seed to have `unit` in a fixed set, `estimatedSuccessRate` strictly between 0 and 1, and `verificationNote === VERIFICATION_NOTE`.
- Calculator parity: calculator unit price must equal the quote writer's for every social capability (9 points YouTube comment, 11 Facebook comment).
- A social plan item's params hold exactly one of `url`, `query`, `channel`, `trending` (+ `region`); `dateFrom`/`dateTo` appear only when the customer wrote a period.
- The worker still uses the approved SQL functions only; the adapter never writes to the database.
- Customer-facing strings stay Arabic only; `socialPlanSummaryAr`, the four social questions and every result header are tested for no Latin letters and no provider name.
- The model string is untouched; `PROMPT_VERSION` pinned by tests.

## 6. Conflict hot spots with the other open PRs

Method used: `git diff --name-only`, GitHub PR file lists. File lists only; PR contents beyond that were NOT read.

**#81 (`codex/quote-cap-and-money-atomic`, stacked ON this branch).** Its first 100 changed files include many that this branch created or changed:
`src/lib/socialSources.ts`, `socialTasks.ts`, `socialDiscovery.ts`, `server/socialAdapter.ts`, `server/socialRows.ts`, `server/tregAdapter.ts`, `server/jobExecutionSpec.ts`, `server/normalizationPipeline.ts`, `server/relevanceValidationLayer.ts`, `app/api/worker/chunk/route.ts`, `functions/shared/chatHandler.ts`, `capabilityRegistry.ts`, `llmClient.ts`, `planManager.ts`, `systemPrompt.ts`, `fileGenerators.ts`, `lib/calculatorPricing.ts`, `lib/planParameters.ts`, `app/dashboard/chat/page.tsx`, plus new migrations (`create_quote_atomic`, `approve_topup_atomic_privileges`, `settle_completed_jobs_with_stale_lease`, `settle_decision_maker_fields`, `cleanup_capability_registry_social`), several `docs/*`, `scripts/cleanup-all.ts` removed, `package.json`/`package-lock.json` changed. Because its base is this branch there is no base conflict now; conflicts appear only if this branch changes after #81 was cut (its base sha is `ea40cbb`, equal to this head, so currently none) or if #79/#80 are merged by squash. Things to check there: that it keeps the social contracts in section 5 (it edits `socialSources.ts` +172 lines, `socialTasks.ts`, `socialRows.ts`); that its migration `cleanup_capability_registry_social` agrees with the code-served social capabilities (it must not delete or disable the six `social-*` slugs by accident, and the old wrongly named registry rows are the ones to clean); that `create_quote_atomic` and the approve/settle migrations keep the privilege rule (service_role only).

**#69 (`codex/auth-topup-flow`, base `main` at older `289526d`).** Files: `docs/CUTOVER.md`, `src/app/dashboard/topup/page.tsx`, `src/app/verify/page.tsx`, `src/components/AuthLayout.tsx`, `src/hooks/useNotifications.ts`, `src/lib/authMessages.ts` (new), `src/lib/topupStatusTransition.ts` (new), a realtime migration for `topups`/`notifications`, two tests. This branch only touches `src/app/dashboard/topup/TopupForm.tsx` of that area (a fallback display name), a different file, so no textual conflict is expected; it must be rebased onto the current `main` before merging because its base is older.

**#79.** This branch builds on its head `1e11ded`. Hot files shared with #79 (both changed them): `chatHandler.ts`, `capabilityRegistry.ts`, `clarification.ts`, `systemPrompt.ts`, `fileGenerators.ts`, `planParameters.ts`, `tregAdapter.ts`, `app/api/worker/chunk/route.ts`, `dashboard/chat/page.tsx`, `dashboard/requests/page.tsx`, `liveActivityFeed.ts`, `addressParser.ts`. Any later commit pushed to #79 after `1e11ded` must be merged into this branch first.

**Older PRs (#3-#11, #40, #41, #44).** Not examined. Any of them that touch `chatHandler.ts`, `llmClient.ts`, `systemPrompt.ts`, `fileGenerators.ts`, `capabilityRegistry.ts` or the chat page should be treated as high-risk, and their persona / clarification / refund logic must be re-checked against the changes in `clarification.ts` and `systemPrompt.ts`.

Suggested commands for the reviewing agent:

```
git fetch origin
git diff --stat origin/main...origin/claude/zealous-carson-sdg9x4
git merge-tree $(git merge-base origin/main <other-branch>) origin/claude/zealous-carson-sdg9x4 <other-branch> | grep -c '^<<<<<<<'
git diff --name-only origin/claude/zealous-carson-sdg9x4 <other-branch>   # files both changed since the fork
npx vitest run && npx tsc --noEmit && npm run build                       # on the merged result, never skip
```

## 7. NOT RUN and open decisions

NOT RUN: any live provider call (no token in the environment, no spend allowed), any browser run on the Preview (it is behind Vercel sign-in and no test account was available), the optional migration, and any registry change.

Owner decisions still open (details in `docs/SOCIAL_RESEARCH_REPORT.md`):

1. Per-comment price vs the 600-point job cap: a delivered row is priced at the provider's price of one call (6 points a TikTok comment, 9 YouTube, 11 Facebook) while a call returns 20 to 500 comments, so a job holds at most about 100 / 66 / 54 rows.
2. A quote above 600 points shows the full amount, but settlement charges `LEAST(delivered x unit price, reserve, cap)`.
3. Source order trades price for measured reliability (about double the cheapest source on TikTok keyword videos and TikTok comments).
4. The dead registry rows with ids that do not exist.
5. The "مؤكداً" wording for decision-maker emails (see `docs/MUSE_REPORT.md`).

Known risks: sources were chosen from the provider's published measurements and none was called from here; TikTok trending depends on one source; Facebook comments depend on a source verified by the catalog on 2026-07-28 but with no success statistics; Instagram, X, Reddit and LinkedIn were not changed.
