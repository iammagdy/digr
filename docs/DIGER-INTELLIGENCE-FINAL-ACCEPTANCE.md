# Diger intelligence layer: final acceptance (round 51)

**Baseline:** main `c0a5c27` (PR #461). Vercel production was READY on that SHA when this round started (deployment `dpl_4YpoTgfm3EkmUVKCWSpuxFSGG98T`).
**Model:** `claude-haiku-5-5`, the repository default for the chat and the worker planner.
**Authorization:** real Anthropic testing with the dedicated evaluation key. The owner raised the cumulative evaluation ceiling from $10 to **$30** during this round. The earlier mission's reported $4.2746 counts inside it, so this round's budget state was created with a ceiling of **$25.7254**.
**Not changed:** production flags, database, schema, SQL, pricing, auth, deployment settings. No live provider call and no customer execution.

<!--RESULTS-->

## 1. Provider catalogs actually inspected

Everything below was read from the repository's own files. Nothing was fetched, and no provider was called.

**TREG snapshot** (`data/treg/treg_catalog_sellable.json`, loaded by `src/lib/treg/catalog.ts` `loadTregCatalog`)

* 3,276 sellable endpoints. Own-account (652), write (29) and paused (12) endpoints were already removed when the snapshot was built.
* The data policy (`data/treg/data_policy.json`) classifies them as:
  * 2,993 public;
  * 231 b2b_contact;
  * 50 sensitive;
  * 278 blocked.
* After the block list and the customer policy, **3,224** are allowed for a normal customer and 3,274 for an admin or verified business.

**Context.dev** (`src/lib/agentMission/sources.ts`)

* 20 pre-built parsers.
* Before this round, 8 of them served an operation. Two more now do: the Google Play and App Store review parsers (see section 3).
* Also a web search, a page scrape and a people search.

**Firecrawl** (`sources.ts`): a web search and a page scrape.

**The registry** (`src/lib/agentMission/capabilities/registry.ts`) maps all of these to one vocabulary of operations. The mapping is by capability string, not by name, and private-data capability strings are never mapped.

| Operation | Produces | Parent | Provider families that serve it |
|---|---|---|---|
| social.parents | posts, videos, tweets | none | TREG (5 platforms), Context.dev (TikTok, Instagram feeds) |
| social.comments | comments | social.parents | TREG (5 platforms), Context.dev (TikTok, Instagram) |
| social.replies | replies | social.comments | TREG (TikTok, Instagram, Facebook, YouTube). On X a reply is the comment. |
| companies.discover | companies | none | TREG, Context.dev (maps) |
| company.contacts | official work e-mail or phone | companies.discover | TREG, Context.dev (e-mails, phone numbers) |
| places.discover | places | none | TREG (maps, Tripadvisor, Yelp, Apple Maps, Bing), Context.dev (maps) |
| places.reviews | reviews | places.discover | TREG, Context.dev (maps reviews) |
| web.search | articles, news, pages | none | TREG, Firecrawl, Context.dev |
| web.read | page text | web.search | TREG, Firecrawl, Context.dev |
| people.discover | professional profiles | none or companies | TREG, Context.dev |
| **apps.discover** (new) | mobile apps in a store | none | TREG (Google Play and App Store searches) |
| **apps.reviews** (new) | app reviews | apps.discover | TREG (store reviews), Context.dev (store review parsers) |

**Which path plans what**

* **The compiled social path (code, no model)** plans every `social.*` operation on all five platforms (`agent/src/compiled.ts`, `foundation/compilePlan.ts`). A social plan proposed by the model is refused.
* **The model planner (`runPlanning` → `propose_plan`)** plans companies, contacts, places, reviews, web, people and now apps. With `capability_discovery_v1` on, each stage may only use the capabilities code validated for it. They are listed to the planner ranked by ability, then price, across all three provider families (`plannerCapabilitySection`).

**How selections are validated**

* **Chat side.**
  * `parseBrief` rejects an unknown operation or field.
  * `validateBrief` / `objectivesIssue` check structure, parent chain, platform grounding and that nothing was dropped.
  * `capabilityGate` answers an unsupported or partial request honestly, with no mission.
* **Worker side.**
  * The registry is rebuilt with the account's real access, provider keys and caps.
  * `propose_plan` refuses any id that is not a validated candidate for its own stage (`planStageIssues`).
  * At execution, `verifyApprovedScope` refuses added stages, swapped capabilities or changed parameters.

**Documented but not served**

* 10 Context.dev parsers still serve no operation: app details, G2 reviews, TikTok and Instagram profiles, followers and following, user search, links.
* Catalog endpoints for Reddit (52), Telegram (9) and Snapchat (3) map to no operation. Such requests are answered as unavailable.
