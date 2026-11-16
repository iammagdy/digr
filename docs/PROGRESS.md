# Diger: where it stands (updated 16 Nov 2026, main `a580274`)

This is a one-page status for an agent or developer arriving fresh.
- The detailed history, newest first, is in `docs/HANDOFF.md`.
- How the parts fit together is in `README.md`.

## What the product does today (verified live on diger.tech, 16 Nov 2026)
1. **Chat** (Next.js on Vercel, `src/app/dashboard/chat`).
   - The customer writes a request in Arabic or English.
   - The chat model (`claude-haiku-5-5` by default, which the site's `ANTHROPIC_MODEL` overrides; `src/lib/agentMission/conversationModel.ts`):
     - answers small talk naturally;
     - asks one question when the request is unclear;
     - refuses private data;
     - otherwise creates a **mission card**.
2. **Planning** (the worker on Heroku app `diger-agent`, `agent/`). The LLM-first planner (`agent/src/llmPlanner/`, model `claude-sonnet-5-5`, switch `llm_planner_v1` ON):
   - understands the request;
   - chooses tools from the TREG catalog (`data/treg/`), and from our own Firecrawl and Context.dev keys for web search;
   - reads one real page per step;
   - measures what the source holds, and asks the customer before the plan when it holds less than 90% of the number;
   - prices the plan.
   - Company and people research hands over to the earlier, live-proven B2B path.
3. **Plan card.**
   - It shows the count, the highest price and the time.
   - Nothing is charged before «اعتمد». On approval the maximum is held.
4. **Execution** (`agent/src/engine/`).
   - It pages each tool to the count, then moves to the approved fallback tools.
   - It dedupes, and reviews relevance where the plan asks for it.
   - The **live sheet** fills while it runs: an Excel-like grid on desktop, the newest three rows on a phone.
5. **Delivery.**
   - Files: Excel, CSV and a methodology CSV.
   - Settlement charges only what was delivered, and releases the rest of the hold.

**Verified live on 16 Nov.** Delivered in full:
- Google Maps places and the reviews of a named place;
- Google Play reviews;
- Amazon products;
- news and articles;
- X, TikTok, Reddit, LinkedIn and YouTube (earlier rounds).

When a source holds less than the number, the customer is asked first, and the plan follows their answer. See `docs/PLATFORM-CHECK-2026-11-16.md` for the table.

## Hard rules (do not break)
- **No provider or model name in anything the customer reads.** Customer text passes `checkCustomerText` (`src/lib/agentMission/text.ts`), which also bans the spreadsheet words «صف» and «الصفوف».
- **N requested = N delivered,** or the customer is told why before approving. A partial delivery is charged only for what was delivered.
- **Money paths stay atomic.** These are `accept_quote_atomic`, `settle_job_atomic` and `release_job_atomic`. The `SourceGateway` has no money code.
- **Pinned tests guard the switches.** `tests/flags-off-byte-identical.test.ts` and `tests/phase5-*.test.ts` pin behaviour. Re-pinning a digest is a deliberate act: write why in the test file.
- **Before any merge:** run the full suite (`npx vitest run`, about 9 minutes, about 14,400 tests) and the typechecks (`npx tsc --noEmit -p tsconfig.json` and `-p agent/tsconfig.json`).

## Deploy chain
- **Merging:** PRs are squash-merged into `main`.
- **Vercel** builds the site, project `diger`. Its queue can take 20 to 35 minutes.
- **Heroku** `diger-agent` deploys the worker, usually within about 5 minutes.
  - Check the release description: it should read `Deploy <sha8>`.
- **Worker environment** (names only): `ANTHROPIC_API_KEY`, `TREG_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PROVIDER_KEYS_ENCRYPTION_KEY` (our Firecrawl and Context.dev keys are stored encrypted in the database), `DIGER_STAGE2_LIVE_SHEET`, `AGENT_CONCURRENCY`.
- **Real-model planner eval:** `agent/scripts/evalPlanner.ts`. It runs on a one-off worker dyno so the key stays on Heroku, and makes no provider calls.

## Open items
| Item | Owner | Note |
|---|---|---|
| Price of an accepted shortfall | owner decision | The customer who accepts 10 of 20 pays the 200-point minimum; an unasked partial delivery of the same 10 was charged 142 |
| Amazon reviews | provider | `crawl4ai.amazon.product.reviews` answered 504 on every call on 16 Nov; the fallback gives the top 10 only |
| `exa.web.search.news` answers 402 | provider / TREG | Probably unpaid; the planner now skips it at once |
| Firecrawl and Context.dev in a live mission | engineering | Wired and tested (scripted end to end); not yet seen live, because catalog tools were enough |
| GitHub repository search | catalog | Not in the catalog; «repos about X» plans GitHub trending |
| Live verification of #510 and #511 (research spec continuation) | engineering | See HANDOFF, 15 Nov P0 section |
| `multi_stage_engine` switch | owner | OFF; only plans that name a direct web tool use the `SourceGateway` |

## Next sensible steps
1. Decide the price of an accepted shortfall, then implement it: drop the minimum, or say it on the question.
2. Watch the first live mission that uses Firecrawl or Context.dev (worker log `llm_planner_web_fallback`), and check its file.
3. Ask TREG about the exa 402s and the Amazon reviews 504s.
