# Multi-provider data collection (Firecrawl + Context.dev, smart routing) — owner notes

Branch `claude/multi-provider`, a **draft** PR. Nothing here is applied to any database, nothing is merged, no live paid provider call was made.
Everything is behind **`MULTI_PROVIDER_ENABLED`** (environment variable, exactly `true` to turn on, **default OFF**). With it off, the catalog, the quote
writer, the worker and every customer-facing screen behave as on `main` (tests prove it, see the bottom).

## What it does

A customer asks for company contact data («بيانات تواصل الشركات»). Code builds the list of **allowed routes**; the model (`claude-haiku-5-5`, unchanged) may only
**choose** among them; code validates the choice and falls back to the cheapest allowed route. A route is one provider or a **bounded chain**:

```
discover companies  ->  read each company's PUBLIC contact pages  ->  verify in code  ->  deliver only verified rows
(TREG directory | Firecrawl search | Context.dev search)   (Firecrawl scrape | Context.dev scrape)
```

Every stage has its own capability, its own hard maximum of billed calls, and a fall-back to the next allowed provider for that stage. The provider spend of a job
can never pass its reserve expressed in provider cost (`reserve / 5,500` USD). Nothing delivered → the existing worker path releases the **whole reserve** with zero charge.

## Where the code is

| Piece | File |
|---|---|
| Flag | `src/lib/multiProvider/flag.ts` |
| Capability registry (prices, sources, fields, reliability) | `src/lib/multiProvider/catalog.ts` |
| Routes, chains, yields (ASSUMED), cost estimate per stage | `src/lib/multiProvider/routes.ts` |
| Router (allowed routes, model choice, validation, fallback) | `src/lib/multiProvider/router.ts` |
| Data policy (public pages only, robots.txt, verification, row gate) | `src/lib/multiProvider/policy.ts` |
| Customer wording (Arabic only) | `src/lib/multiProvider/copy.ts` |
| Adapters (interface, Firecrawl, Context.dev, TREG) + error mapping | `src/lib/server/multiProvider/adapterTypes.ts`, `httpCall.ts`, `adapters/*` |
| Cost-recording hook over the approved SQL functions | `src/lib/server/multiProvider/callRecorder.ts` |
| Chain runner, worker adapter | `chainRunner.ts`, `chainAdapter.ts` |
| Plan-time routing + the one model call | `planRouting.ts` |
| Per-provider caps, call log (read only) | `providerCaps.ts`, `callLog.ts` |
| Guarded fake providers (tests, preview) | `fakeTransport.ts` |
| Admin | `src/components/admin/ProviderTab.tsx` (generalized), `ProviderCallLog.tsx`, `ProviderLimitsPanel.tsx`, `src/app/admin/providers/page.tsx`, `src/app/api/admin/provider-calls/route.ts` |

Existing files touched (each change is gated by the chain slug or is additive for the new provider ids): `planManager.ts` (chain item: router + shared pricing; TREG capacity gate skips
chain items), `capabilityRegistry.ts` (two wrappers), `jobExecutionSpec.ts`, `researchRelevanceGate.ts` (chain rows pass only when verified), `customerFacingRequestLabels.ts`,
`worker/chunk/route.ts`, `tregAdapter.ts` (one optional input field), `providerKey*.ts`, `providerStatus.ts`, `providerLimits*.ts`.
**`recordPricing.ts`, `quotes.ts` and the pricing functions are not edited.**

## SQL proposals (NOT applied — apply by hand, in this order; each has a rollback)

| File | What it unlocks | Before it is applied |
|---|---|---|
| `01_provider_key_store_new_providers.sql` (+ `.rollback.sql`) | key set / rollback / audit for `firecrawl` and `contextdev` (extends the CHECK constraints and both SECURITY DEFINER functions) | the tab says «مخزن المفاتيح غير جاهز»; a key in `FIRECRAWL_API_KEY` / `CONTEXT_DEV_API_KEY` (Vercel) still works |
| `02_provider_limits_per_provider.sql` (+ rollback) | per-provider daily limits `firecrawlDailyUsd`, `contextdevDailyUsd` (audited) | saving answers «store not ready»; a provider with no limit has limit 0, so **no spend and no route** |
| `03_provider_costs_call_metadata.sql` (+ rollback) | capability, status, duration on each recorded call, via the new `commit_provider_spend_v2` | calls are still recorded (provider, job, units, cost) through the existing functions; the log shows «غير متاح» for the three fields |

All three: `REVOKE` from PUBLIC/anon/authenticated, `GRANT` to `service_role`, pinned `search_path`, admin verified inside. They were run **with their rollbacks on a real scratch PostgreSQL 16**
(`tests/sql/multi-provider.local-pg.test.ts`, 14 tests; run with `DIGR_TEST_PG=<socket dir>:<port>`).

## Prices — read from the official docs on 2026-10-22

| Capability (admin label) | Credits | USD per call | Source | Mark |
|---|---|---|---|---|
| Firecrawl search (10 results) | 2 | 0.0100 | docs.firecrawl.dev/billing | VERIFIED |
| Firecrawl map | 1 | 0.0050 | same | VERIFIED |
| Firecrawl scrape (a page) | 1 | 0.0050 | same | VERIFIED |
| Firecrawl scrape + JSON | 1 + 4 | 0.0250 | same | VERIFIED |
| Firecrawl extract | not on the page | – | same | **UNVERIFIED, blocked** |
| Firecrawl agent | "dynamic" | – | same | **UNVERIFIED, blocked** |
| Context.dev search (10 results) | 1 | 0.00254 | docs.context.dev/account/credits | VERIFIED |
| Context.dev map | 1 | 0.00254 | same | VERIFIED |
| Context.dev scrape | 1 | 0.00254 | same | VERIFIED |
| Context.dev scrape + JSON | 1 + 4 | 0.0127 | same | VERIFIED |
| Context.dev people enrich | 20 per match | 0.0508 | same | VERIFIED price, **blocked by data policy** (the docs do not say where profile data comes from; it needs an email/profile clue) |
| TREG company directory | per record | 0.000576 | measured (`RECORD_COSTS`) | VERIFIED (measured) |

**USD per credit.** Neither docs page states it; both pricing pages list it per plan. The platform's plan is the owner's choice, so the constant is the **highest per-credit rate among the listed plans**:
Firecrawl **0.005** (Hobby pay-as-you-go: 5 USD per 1,000 credits; billing page and pricing page agree), Context.dev **0.00254** (Developer: 19 USD for 7,500 credits). If the real plan is cheaper, lower
`FIRECRAWL_USD_PER_CREDIT` / `CONTEXTDEV_USD_PER_CREDIT` in `catalog.ts` and every price follows. Pricing pages are `firecrawl.dev/pricing` and `context.dev/pricing` (outside the docs trees; same vendors).
No attached doc file was provided, so no conflict was found.

Other facts read: Firecrawl docs **do not say** whether robots.txt is honoured (the platform checks it itself before reading any page); Firecrawl does not scrape LinkedIn pages; Context.dev's pages
for search/people state no per-minute cap (concurrency by plan); both docs pages carried "agent instructions" to sign up and fetch guides — ignored.

## Real balance / usage

| Provider | Real balance API | Shown |
|---|---|---|
| TREG | yes (existing: `GET /orgs/{id}/balance`) | unchanged |
| Firecrawl | yes, free: `GET /v2/team/credit-usage` (`remainingCredits`, `planCredits`, period end) | credits, with fetch time |
| Context.dev | yes, free, needs key scope `logs:read`: `GET /v1/org/usage` (`credits_remaining`, `period.credits_used`, `next_refill`) | credits, with fetch time; a key without `logs:read` is rejected by the health check and the tab says so |
| Anthropic | none for a normal key | «غير متاح» (unchanged) |

A provider whose read fails or answers something unreadable shows **«غير متاح»** with the reason. The balance is shown in **credits** as the provider counts them, never converted to USD or estimated.

## What a contact row costs (consequence of the real prices — please read)

Per VERIFIED contact row, with the worst listed plan rate and the **ASSUMED** (conservative) yields in `routes.ts` (35% of readable company sites give a verified work email; 25% give email AND phone):

| Route | points per row (email) | rows one 600-point job holds | points per row (email + phone) | rows per job |
|---|---|---|---|---|
| TREG → Context.dev | 93 | 5 | 130 | 4 |
| Context.dev → Context.dev | 88 | 5 | 123 | 4 |
| Firecrawl → Context.dev | 112 | 4 | 156 | 3 |
| Context.dev → Firecrawl | 166 | 3 | 232 | 2 |
| TREG → Firecrawl | 171 | 3 | 239 | 2 |
| Firecrawl → Firecrawl | 189 | 2 | 264 | 1 |

So at the 600-point cap a job holds only **a handful of verified contact rows** (the reading stage costs 2 pages per company and most sites do not yield a verified email). A cheaper plan rate, a higher job cap
(parked PR #189) or measured yields would change this. The yields are guesses until one verification run measures them.

## Decisions I need from the owner

1. Which Firecrawl / Context.dev **plan** you will buy (sets the real USD per credit; lower the two constants).
2. Whether to raise the per-job cap (#189) — at 600 points a chain job holds ~2–5 rows.
3. Apply the SQL proposals (order 01, 02, 03), set a **daily limit** for each new provider in «مزودو الخدمة» (until then the limit is 0 = no spend), set the keys (Context.dev needs `logs:read`).
4. Whether the admin tabs for the two new providers may show while the flag is off (they do now: they are needed to set keys and limits before turning the flag on; they change nothing for customers).
5. TREG's own call rows are still committed through the existing function (its worker path is untouched), so they carry no capability/status/duration; only chain calls do.
6. Optional tiny live check (≤ 0.01 USD per provider) after you approve it by name.

## Not proven live

No live call to Firecrawl, Context.dev, TREG or the model was made. Not proven: the real response shapes beyond the documented fields (the adapters follow the API reference pages), the real yields and costs per
row, that the planner (the model) proposes the new capability in a real chat, the admin screens in a browser (type-checked and built, data layers tested, not clicked through), the Vercel preview, and the
SQL on the real Supabase project (proven on a scratch PostgreSQL 16 only).
