# Phases 2–4 baseline: the audit compared with the current code (14 Nov 2026)

**Reference:** `docs/intelligence/DIGER_INTELLIGENCE_AUDIT.md`, audited at `001cbeb` on 11 Nov 2026 and merged into the repository by PR #482 (`c657599`).

**Compared against:** `main` = `c657599`. The last code change is `7d30ec8` (PR #479). PRs #446–#481 were checked on GitHub on 13–14 Nov 2026:

* #446–#480 are merged;
* #481 (spend-gate worker wiring, INACTIVE) is open and is not touched by this campaign.

**Method:** the code, the catalog snapshot, the data policy and the tests were read. Two read-only queries were run on production Supabase (Appendix). No provider or model call was made.

**Production flags (read-only, 13 Nov 2026 22:5x UTC):** `agent_settings` holds only two keys:

* `redesign_flags`: x, tiktok, youtube, facebook and instagram are `on`; people, places, companies, social_posts, social_account and social_comments are `test`;
* `social_discovery`: `test`.

`capability_discovery_v1` and `chat_research_brief_v1` are NOT set. The whole discovery layer of PRs #454–#465 is therefore **OFF for every account in production**.

## 1. What the audit asked for, and what exists now

Status words used below:

* **DONE**: implemented and in use where its flag allows.
* **OFF**: implemented, behind a flag that is off in production.
* **PARTIAL**: started but not complete.
* **MISSING**: not built.
* **OWNER**: blocked on an owner decision (money, secrets, permissions, paid capture).

### Phase 2: provider integration readiness

| Audit item | Status | Evidence |
|---|---|---|
| One capability list across TREG, Firecrawl and Context.dev (the audit's chapter 6 point 7) | **OFF** | `src/lib/agentMission/capabilities/registry.ts` `buildCapabilityRegistry` (PR #454). It is used by `discover.ts` and wired into `agent/src/runMission.ts:470` and `src/lib/agentMission/chatTurn.ts:294,370,615`, behind `capability_discovery_v1`. Tests: `tests/unified-capability-discovery.test.ts` (27). |
| PR-2.1: web via TREG (`treg.web.extract`, `branddev.brand.retrieve-by-name`, `branddev.web.search`, `firecrawl.web.search`) | **PARTIAL** | See the table below. All four ids exist in the snapshot and are policy `public`. Through `treg_call` they get every gateway check (`agent/src/gateway.ts:21-34`, steps 1–7). In the registry, `web.search` and `web.extract` capability strings map to `web.search` / `web.read` (`registry.ts` TREG_RULES), so `branddev.web.search`, `firecrawl.web.search`, `treg.web.search` and `treg.web.extract` are already discovery candidates. **Company enrichment** (`companies.enrich`, the `branddev.brand.retrieve*` family) maps to no operation, so no plan can contain a validated enrichment stage. There is no `web_via_treg` flag. |
| PR-2.2: availability checks key **and** cap | **PARTIAL** | `webAvailability.ts` checks the key only. The registry rejects a web provider whose daily cap is 0 (`registry.ts` `webUnavailable`). It does NOT reject a cap that is **already spent today**, and it never checks TREG's own daily cap. Exhaustion is caught only at call time, by `reserve_provider_spend_atomic` (refusal `daily_cap`). `readProviderSpendToday` (`src/lib/server/multiProvider/providerCaps.ts:52`) exists but planning does not use it. |
| PR-2.2: drop `firecrawl.extract` (removed upstream 2026-12-10) | **MISSING** (low risk) | `src/lib/multiProvider/catalog.ts:169` is part of the legacy chain, reachable only by the old planner (audit §4.5). |
| PR-2.2: new Context.dev parsers (reddit, yelp, tripadvisor) listed as discovered only | **MISSING** | `sources.ts` `PARSERS` lists the 20 parsers documented on 2026-10-28. |
| PR-2.2: refresh dated price constants | **OWNER** | `CONTEXTDEV_USD_PER_CREDIT` and `FIRECRAWL_USD_PER_CREDIT` (`src/lib/multiProvider/catalog.ts`, read 2026-10-22) feed planning estimates. Changing them changes the cost that customer prices are measured from, so it is a pricing decision, not done here. This campaign labels them `estimated`. |
| PR-2.3: direct-key path for the worker (Vault) | **OWNER** | Secrets and migration. Proposal only (Phase 2 PR). |
| PR-2.4: web-call accounting (`provider_cost_id` on web `mission_calls` rows) | **MISSING** | `agent/src/webGateway.ts:106` always writes `provider_cost_id: null`. The reservation id exists inside `httpCall.ts:53` but is not returned. TREG rows carry it (`gateway.ts:283`). |
| Pricing confidence kept per capability | **MISSING** | The catalog has `cost_confidence` (verified 2,019 / documented 848 / unknown 158 / inferred 37 / none 214). No code reads it. `Capability.usdPerRow` is a bare number. A routed endpoint (`treg.web.*`, price 0 with misses billed) is priced at its dearest sibling by `unitCost`, and that is not marked as an estimate. |
| Failed or unanswered calls are not assumed free | **DONE** | TREG: `gateway.ts:276-282` (an unanswered call keeps its estimate). Web: `webGateway.ts:131-141` (rounds 59/60). |
| Provenance: mission, provider, operation, call id, cost, status, raw evidence | **PARTIAL** | `mission_calls` has: mission_id, phase, endpoint_id (the provider is its prefix), id (= mission:call_N), status, refused_reason, http_status, rows_returned, cost_usd, estimate_usd, provider_cost_id (TREG only), storage_path (the full raw answer in the private bucket), duration_ms. **Missing:** the plan stage of an execution call, and `provider_cost_id` on web calls. The row field marks `_src` / `_call` belong to Phase 5 (audit §9.1.4). |

**The four audit ids in the current snapshot** (`data/treg/treg_catalog_sellable.json`, describe pass 2026-10-27):

| Id | Kind | Capability | Price in catalog | Confidence | Item fields documented | TREG-observed ok rate | Registry today |
|---|---|---|---|---|---|---|---|
| `treg.web.extract` | routed (12+ siblings) | web.extract | 0 per success; «NOT free: misses billed», up to the route cap | documented | none | 0.873 | web.read, priced at dearest sibling |
| `branddev.brand.retrieve-by-name` | direct | companies.enrich | 0.02534 per success | verified | `hex,name,source` (list_path `brand.colors`: the brand COLOURS, not the company record) | 0.957 | **not mapped** |
| `branddev.web.search` | direct | web.search | 0.002534 per success | verified | url, title, description, relevance, markdown | 0.994 | web.search |
| `firecrawl.web.search` | direct | web.search | 0.01 per success | verified | url, title, description, position | 0.999 | web.search |
| (also) `branddev.web.scrape` | direct | web.extract | 0.002534 | verified | `level,text` (list_path `metadata.headings`: the page's HEADINGS) | 0.747 | web.read with outputs «text» marked **documented**: a false proof |
| (also) `firecrawl.web.scrape` | direct | web.extract | 0.005 per page | verified | none | **0.401** | web.read, outputs unknown |

**Finding (schema honesty):** for a one-record endpoint, the snapshot's `item_fields` describe the list at `list_path`, which can be a sub-list of the record (colours, headings). Today the registry reads those as the record's outputs:

* `branddev.web.scrape` is treated as proven to give page text, from its headings;
* `branddev.brand.retrieve-by-name` would be treated as documented to give a «name» (a colour name) and nothing else.

The audit's rule «missing schema information must remain unknown» requires these outputs to be UNKNOWN (proved on a sample).

### Phase 3: verified capability registry

| Audit item | Status | Evidence |
|---|---|---|
| Extend, do not duplicate (one registry) | **DONE** (runtime) | `registry.ts`. There is no competing registry in the agent path. The legacy `src/lib/multiProvider/catalog.ts` `CAPABILITIES` remains for the old chain (audit: leave, deprecate later). |
| PR-3.1: generated reviewable artifact `data/capabilities/registry.json` with fingerprints and statuses | **MISSING** | The registry is built in memory at run time. Nothing is generated, reviewed or diffed. |
| Verification levels (advertised / schema-checked / fixture / live / production-eligible / broken-deprecated) | **MISSING** | The registry has `outputsKnown` (documented vs unknown outputs) only. Hand ToolCards have `status: verified \| catalog_only \| broken` (`foundation/toolCards/types.ts:12`). |
| PR-3.2: statuses wired to `toolCards/verify.ts`; production-eligible only from a reviewed list | **MISSING** | `checkCardOnPage` (`foundation/toolCards/verify.ts:16`) is used by tests over stored real pages (`tests/fixtures/live/missions/*`, 39 missions, `call-index.json`: 25 endpoints with stored real pages). The registry does not read it. |
| PR-3.3: reliability report from `mission_calls` | **MISSING** | `sourceRanking.ts` `statsFromCalls` / `sourceHealth` measure recent calls at planning time (runtime health). No report exists. Appendix A gives the read-only aggregate. |
| PR-3.4: recover `scripts/treg/build-data-policy.mjs` | **DONE** (the audit's finding is outdated) | The script is in the repository. `tests/data-policy.test.ts:15` runs it with `--check` (byte-identical output). |
| Change safety (new / removed / price / breaking / deprecated / policy) | **MISSING** | No diff tool exists. The snapshot is pinned (`src/lib/treg/catalog.ts`). |
| Obsolete generator | n/a | `scripts/update-capability-registry.ts` writes to **Appwrite** (`node-appwrite`). It is obsolete and must NOT be run. |

### Phase 4: intelligent tool routing

| Audit item | Status | Evidence |
|---|---|---|
| Deterministic hard filters + lexicographic ranking | **OFF, PARTIAL** | `discover.ts` `hardReject` checks privacy, availability (key / cap = 0), platform, input and documented outputs. `compare` ranks by documented outputs, then feeds child, volume, filters covered, preferred outputs, price, id. **Differences from the audit (§8.2):** constraint coverage is ranked 4th, not 1st. There is no evidence tier (no verification levels). No Diger-measured yield or latency is used. A routed or unpriced capability's price is not marked unknown. Runtime health (`sourceHealth`) is not applied in discovery. |
| `rankByCoverage` wired (PR-4.1) | **MISSING** | `sourceRanking.ts:248` is used by tests only. |
| Fallbacks within approval and budget | **PARTIAL** | Compiled social path: next validated card of the same role, read once (audit §8.4). Discovery: every eligible candidate is kept, but there is no fallback group and no «safe fallback» check. |
| Dependency validation (parent → child field binding) | **OFF, DONE** for the chains that exist | `need.ts` `stagesOfNeed` / `linkOf`, `discover.ts` (`cannot_take_parent_output`), `selection.ts` `planStageIssues` / `bindPlanStages` (strict place in the chain), `verifyApprovedScope` at execution. **Missing chain:** companies → official website (enrichment) → contacts. Contacts are fed only from a website the companies source itself gives. |
| Approval safety: scope sealed, no substitution after approval | **OFF, DONE** | `selection.ts` `capabilitySelectionOf` / `verifyApprovedScope` / `resealCapabilitySelection` (PRs #454/#455). Tests 12, 12b in `tests/unified-capability-discovery.test.ts`. |
| Families (task 4.3) | see below | |

| Family | Operation(s) | Status | Note |
|---|---|---|---|
| A Company discovery | companies.discover | OFF, DONE | TREG companies searches; Context.dev maps. |
| B Website enrichment | — | **MISSING** | `companies.enrich` is not mapped (Phase 2 PR). |
| C Public company contacts | company.contacts | OFF, DONE | TREG `companies.emails.*`; Context.dev `emails` / `phone-numbers` parsers (real recorded calls in `tests/fixtures/msn-088c-calls.json`). |
| D Business people | people.discover | OFF, DONE | TREG people searches; Context.dev people search. |
| E Places | places.discover | OFF, DONE | TREG maps; Context.dev google-maps. |
| F Place reviews | places.reviews | OFF, DONE | TREG reviews; Context.dev maps reviews. |
| G TikTok public profiles | — | **MISSING** as an operation | catalog `tiktok.user.profile` endpoints and the Context.dev `tiktok-profile` parser exist; nothing maps them. |
| H Instagram public profiles | — | **MISSING** as an operation | same. |
| I Instagram topic search | social.parents (instagram) | DONE for test accounts (`social_discovery=test`) | compiled path, discovery-derived cards. |
| J Reddit posts / comments | — | **MISSING** | 52 catalog endpoints; Diger has real recorded calls (`scrapecreators.reddit.search.posts` 12/12 with rows, `crawl4ai.reddit.search.posts` 4/4, `crawl4ai.reddit.post.comments` 2/2). There is no operation mapping and no platform recognition (Phase 1 lexicon). |
| K Web search + extraction | web.search → web.read | OFF, DONE | Firecrawl, Context.dev direct and TREG ids. |
| L Five social platforms | social.* | DONE in production (compiled path) | hand ToolCards + real stored pages. Must not change. |

## 2. Already proven, not rebuilt

* **Data policy, block list, sellable check, sensitive path, parameters, budget, daily cap, recording, raw answer saved:** `agent/src/gateway.ts` steps 1–7. Not touched.
* **Model never prices or approves:** pricing is in `src/lib/modelPlanner/pricing.ts` and `recordPricing.ts`; money moves only through `accept_quote_atomic` / `settle_job_atomic` / `release_job_atomic`. Not touched.
* **Chat-side honesty** (unsupported / partial / blocked with an Arabic sentence and a reduced scope): `discover.ts`, `chatTurn.ts`.
* **Approved scope sealed:** `selection.ts`.
* **Data policy regeneration is reproducible offline:** `build-data-policy.mjs --check`.

## 3. Plan of this campaign (four PRs, each behind an OFF flag or data-only)

| PR | Scope | Flag |
|---|---|---|
| A (Phase 2) | Company enrichment via TREG (`company.enrich`), an enrichment stage in the companies chain; honest outputs for sub-list schemas; availability that also rejects an exhausted cap (TREG included); pricing basis on every capability; `provider_cost_id` on web calls; offline acceptance A–J; the PR-2.3 proposal (owner) | `web_via_treg` (agent_settings, scoped, OFF) |
| B (Phase 3) | Verification levels and evidence; a deterministic offline generator → `data/capabilities/registry.json` (+ `--check` test); change-safety diff; reliability report from an aggregated read-only snapshot of `mission_calls` | data only; nothing reads the artifact at run time |
| C (Phase 4) | Router: the mission's 10 hard filters and 8-step ranking, safe fallbacks, chain-binding validation; wired into discovery only when the flag is on | `registry_router` (OFF) |
| D (Phase 4 + cross-phase) | Family coverage (profiles, Reddit, enrichment) at registry and router level; `tests/intelligence-phases-2-4-acceptance.test.ts` (≥ 35 scenarios, 20 journeys); final acceptance report | same flags |

With every flag off, the planning, execution, pricing and settlement paths are byte-identical. The existing flags-off digests prove it: `tests/fixtures/flags-off-digests.json`, `foundation-flags-off.json`, `stage2-card-flags-off.json`, `stage3-flags-off.json`.

## Appendix A: read-only queries (13 Nov 2026)

1. `select key, … from agent_settings`: the flags quoted above. The user-id lists were reduced to counts.
2. A per-endpoint aggregate of `mission_calls` for 146 endpoints, through 2026-11-13: attempts, ok, ok-with-rows, empty, empty-and-paid, failed, refused, rows, cost, cost-null, p50 latency. It is stored without mission or user ids in `data/capabilities/reliability-snapshot.json` (Phase 3 PR).
   * **Firecrawl direct:** 18 refused (`firecrawl.search`) and 6 refused (`firecrawl.scrape`). It has never been called with a key.
   * **Context.dev direct:** first real calls on 13 Nov 2026 (msn_088c): 7/7 scrapes with rows; parse emails 10 of 23 with rows, 11 empty and paid; phone-numbers 7 of 19 with rows, 10 empty and paid. Empty answers are billed: this is the evidence that «HTTP 200 ≠ research».
