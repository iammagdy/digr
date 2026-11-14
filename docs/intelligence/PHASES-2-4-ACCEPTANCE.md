# Phases 2–4: final acceptance (14 Nov 2026)

**Reference documents:**

* `docs/intelligence/DIGER_INTELLIGENCE_AUDIT.md` (PR #482, merged as `c657599`);
* `docs/intelligence/PHASES-2-4-BASELINE.md` (the gap analysis that started this campaign).

**Rules kept throughout:**

* No paid call to any provider or model.
* No flag set in production.
* No change to pricing, ledger, reservation, settlement, refunds, wallet, schema, permissions, secrets, provider caps or infrastructure.
* Every change went through a PR merged at its verified head. Nothing was pushed to `main`.
* PR #481 (spend-gate wiring, inactive) was not touched.

## 1. Status at a glance

| | CODE COMPLETE | OFFLINE VERIFIED | LIVE PROVIDER VERIFIED | PRODUCTION ENABLED | OWNER APPROVAL REQUIRED |
|---|---|---|---|---|---|
| **Phase 2**: provider readiness | Yes | Yes (acceptance A–J) | **No.** No call was made. The TREG-resold enrichment (`branddev.brand.retrieve-by-name`) was never called by Diger. | **No.** `web_via_treg` is off. | Direct-key path (proposal); one capped live capture of the enrichment step; the unanswered-web-call cap accounting (§6) |
| **Phase 3**: registry | Yes | Yes (generator `--check`, evidence rules, change safety) | **Partly.** The live levels are Diger's own recorded calls up to 13 Nov 2026 (read-only aggregate). Nothing was re-verified live in this campaign. | The artifact is not read at run time unless the router switch is on. | Additions to the reviewed production list |
| **Phase 4**: routing | Yes | Yes (router tests; 20 journeys; 35 audit scenarios; 20 stored missions) | **No.** No plan made by the router has been executed. | **No.** `registry_router` is off. | Turning the switches on for a test account, then for customers |

**Verdict.** Phases 2–4 are **code complete and offline verified**. They are **not live verified and not enabled**. The production behaviour of every customer is unchanged, except one recording detail: web calls now store their `provider_costs` id.

## 2. What was built, per phase

### Phase 2: provider integration readiness (PR #483, merge `fb26563`)

* **Company website enrichment through the existing TREG gateway.**
  * TREG `companies.enrich` endpoints map to the internal operation `company.enrich` (48 capabilities). One example is `branddev.brand.retrieve-by-name`, the Context.dev brand API resold by TREG.
  * With `web_via_treg` on, and only when no companies source documents a website, the chain becomes companies → official website (fed by the company name) → public contacts.
  * No new key. Every TREG gateway check applies.
* **The other three audit ids** (`treg.web.extract`, `branddev.web.search`, `firecrawl.web.search`) were already discovery candidates. They now carry `access` (`treg_routed` / `treg_direct`) and a pricing basis.
* **Schema honesty.** When a one-record endpoint's catalog fields describe a sub-list of the record (brand colours, page headings), its outputs are unknown, never «proven».
* **Availability.** A provider whose daily cap is already used up today is not planned on, TREG included. A spend figure that cannot be read stays unknown, never 0.
* **Pricing provenance.** Every capability carries a basis: 287 verified, 130 documented, 50 estimated (routed TREG endpoints and the direct providers' credit-based figures), 19 unknown.
* **Accounting.** Web calls record `mission_calls.provider_cost_id`.
* **Proposal only:** `PROPOSAL-WORKER-DIRECT-KEYS.md` (credentials; owner decision D3).

### Phase 3: verified capability registry (PR #484, merge `cc81502`; families extended in PR D)

* **One registry** (`buildCapabilityRegistry`). It covers TREG, Firecrawl and Context.dev, plus the hand ToolCards, which are verified on stored real pages.
* **A generated, reviewable artifact:** `data/capabilities/registry.json`. Its generator, `scripts/capabilities/build-registry.ts`, is deterministic, offline, has a `--check` mode and records the digest of every input.
* **Today's registry (with PR D):**
  * 486 capabilities;
  * by level: **20 production_eligible**, **40 live_verified**, 135 schema_checked, 285 advertised, **6 broken** (measured: never a row);
  * by provider: TREG 470, Context.dev 14, Firecrawl 2;
  * by access: 436 `treg_direct`, 34 `treg_routed`, 16 `direct`.
* **Usable capabilities:**
  * 431 are public and not broken;
  * a customer account can use the **20** production-eligible ones;
  * a test account can use those 20 plus the 40 live-verified ones (60).
* **Levels follow evidence** (`evidence.ts`). The production list is explicit and reviewed (`production-eligible.json`: the 20 verified social cards). The reviewed list alone promotes nothing.
* **Change safety** (`registryDiff.ts`). A breaking change on a production-eligible capability requires review. A new capability is never production-eligible on arrival.
* **Reliability report:** `docs/intelligence/RELIABILITY-REPORT.md`, built from `data/capabilities/reliability-snapshot.json`.
  * The snapshot is a read-only aggregate of `mission_calls`: 146 endpoints, 2,783 calls, $4.731104.
  * HTTP 200 is not counted as research. Billed empty answers are counted separately; for example, the Context.dev e-mail parser had 11 empty paid calls out of 23.
* **Reproducible build.**
  * `scripts/treg/build-data-policy.mjs` exists and is checked byte for byte (`tests/data-policy.test.ts`). The audit's «missing generator» finding is outdated.
  * The Appwrite script `scripts/update-capability-registry.ts` is obsolete and is never run.

### Phase 4: intelligent tool routing (PR #485 and PR D)

* **Router** (`router.ts`).
  * **Hard filters:** the discovery filters (privacy, authorization, operation, platform, input, key and cap), plus:
    * the verification minimum: customer accounts use production-eligible capabilities only; test accounts use fixture- or live-verified ones;
    * never broken;
    * outputs proven for a stage that feeds another;
    * a known price within the bound;
    * runtime health.
  * **Lexicographic rank:** complete constraint coverage, evidence, health, chaining, volume, Diger-measured yield (only when both candidates were measured), cost per usable row, latency, id.
  * **Safe fallbacks:** the next candidate of the same stage that carries the same constraints and the same parent field, within the bound. Refusals are never worked around.
  * **Chain-binding validation.**
* **Families (task 4.3):**

| Family | Operations | Customer account (production-eligible) | Test account | Evidence |
|---|---|---|---|---|
| A Company discovery | companies.discover | not yet (none reviewed) | yes | Diger-measured (e.g. `tomba.companies.search.reveal` 69/85 with rows) |
| B Website enrichment | company.enrich | not yet | not yet (no measured source) | advertised / schema only |
| C Company public contacts | company.contacts | not yet | yes | measured |
| D Business people | people.discover | not yet | yes | measured |
| E Places | places.discover | not yet | yes | measured |
| F Place reviews | places.reviews | not yet | yes | measured |
| G TikTok profiles | social.profile | not yet (said honestly) | yes (`crawl4ai.tiktok.user.profile` 2/2) | measured |
| H Instagram profiles | social.profile | not yet | not yet (none measured) | schema only |
| I Instagram topic search | social.parents | not yet | yes | measured |
| J Reddit posts / comments | social.parents → social.comments | not yet | yes | measured (12/12, 4/4, 2/2) |
| K Web search and extraction | web.search → web.read | not yet | yes | measured |
| L Five social platforms | social.parents → comments → replies | **yes** | yes | hand cards verified on real pages + measured |

* **«Not yet»** means the router answers honestly: «المصادر التي تقدّمها لم نتحقق بعد من جودتها وتكلفتها» (the sources that provide it have not yet been verified for quality and cost). It never guesses.
* Promoting a family for customers means adding its sources to the reviewed list, with evidence, in a PR. That is an owner decision (§7).

## 3. Tests (all local; the repository has no GitHub Actions)

| PR | Head | Full suite | New tests | Typechecks | Build + secret scan | Mutation checks | Vercel |
|---|---|---|---|---|---|---|---|
| #483 (Phase 2) | `52e52bc` | 13,578 passed, 0 failed, 47 expected-fail, 78 skipped | 15 | clean | clean | 7/7 | preview READY; production READY on `fb26563` |
| #484 (Phase 3) | `94d11b1` | 13,598 / 0 / 47 / 78 | 20 | clean | clean | 8/8 | preview READY; production READY on `cc81502` |
| #485 (Phase 4) | `2475a2f` | 13,618 / 0 / 47 / 78 | 20 | clean | clean with a 4 GB heap (see §6.6) | 10/10 | preview READY; production on `df1c534` (§8) |
| PR D (this) | see the PR | see the PR | 61 (acceptance) | see the PR | see the PR | see the PR | see the PR |

The baseline on `main` `c657599` before the campaign was 13,563 passed, 0 failed, 47 expected-fail, 78 skipped. No existing assertion was removed, skipped or weakened. The two existing assertions that encoded a false limitation (Facebook replies «partial») were kept: the improvement exists only with the router switch, where a new test records it.

**Real vs simulated evidence:**

* **Real:** the catalog snapshot, the data policy, the hand cards checked on stored real provider pages (`tests/fixtures/live/missions`), Diger's recorded call aggregate, and the 20 stored missions' requests and approved plans.
* **Simulated** (labelled in the tests): the provider answers in the Phase 2 gateway tests, and the synthetic capabilities in the router's unit tests.
* **Never claimed:** a live provider call, a browser journey, or an executed router plan.

## 4. Cross-phase acceptance (`tests/intelligence-phases-2-4-acceptance.test.ts`, 61 tests)

* **The 20 required journeys:** J1–J20, plus J1b (enrichment). Each runs the invariants:
  * no provider name, price or currency in any text the customer reads;
  * the chosen capability is the router's first candidate;
  * every candidate is public and at or above the account's level, never broken;
  * every chain is bound by a documented field;
  * a supported request selects every stage, and anything not served is said.
* **The audit's 35 scenarios**, each for a customer account and a test account.
* **The 20 stored missions**, compared with their approved plans (§5).
* **The approval boundary:** a capability swapped after approval, an added stage or changed parameters are refused. **Pricing ownership:** no point price or USD in customer text.

## 5. Stored missions vs historical approved plans (customer account, router on)

All **20** missions are served («supported»). Their 49 historical stages break down as follows (`tests/fixtures/phases-2-4-historical-routing.json`):

| Outcome | Count | Explanation |
|---|---|---|
| same | 27 | The router chooses the historical source. |
| eligible | 10 | Still a validated candidate; the router prefers another verified one. Example: a keyword Facebook search over a page listing when no page is named in the words. The compiled path keeps its own card choice for named pages. |
| excluded, `below_verification` | 9 | Historically used sources that are live-verified but NOT on the reviewed production list: `crawl4ai.tiktok.video.comments`, `tikhub.tiktok.video.comments`, `crawl4ai.youtube.search.videos`. The owner can add them with their evidence. |
| excluded, `no_usable_input` | 2 | `crawl4ai.instagram.user.posts` and `tikhub.x.instagram-v2-fetch-post-comments`: their catalog inputs (a handle, a code) are not mapped to an input class. The compiled path uses the verified cards instead. |
| excluded, `broken_or_deprecated` | 1 | `scrapecreators.x.v1-facebook-post-comment-replies`: Diger measured 0 rows in 4 billed calls. The router avoids it (an **improvement**: that mission recorded «no source» for replies). |

**Important:** the compiled social path, which is ON in production, still chooses its own cards. The router's verdict is recorded against it and never blocks it. No production social plan changes.

## 6. Findings: pinned by tests, not changed, owner decision

1. **An unanswered direct web call commits $0 to `provider_costs`** (`httpCall.ts`). This frees its room in the provider's daily cap, while the TREG path commits the estimate. The mission budget keeps the estimate, and the call row is flagged `charge_unknown`. Changing it changes provider-cap accounting.
2. **The brand API's TREG rows are colours** (`branddev.brand.retrieve-by-name`, `list_path: brand.colors`). `rows_returned` of that endpoint must not be read as companies. The record is in the saved raw answer.
3. **The chat privacy guard allows «personal e-mails of company employees» in a business context**, in every phrasing tried, Arabic and English. Downstream, no personal-contact capability is a candidate for a normal account: the request becomes company-level public contacts. Whether the chat should refuse it outright is an owner policy decision (it changes the chat for every customer).
4. **Phase 1 understanding gaps found by the scenarios.** They are recorded in the test table, not fixed here; the rule was not to reopen Phase 1.
   * «فمصر» and «السعوديه» are not read as countries.
   * «رقم المقر» is not read as a phone ask.
   * «اللي الناس كاتباه تحت فيديوهات» is not read as comments.
   * A company's public social links have no stage.
   * A correction inside ONE message («… لا خليهم على يوتيوب») is read as both platforms. The chat's validated brief carries the correction, and the router follows it (tested).
5. **Overlap:** open PR #481 edits `webGateway.ts`, `runMission.ts` and `main.ts` too. It will need a rebase before it can merge.
6. **Build headroom.** In the build container, Next's type-check worker (`next build` → «checking validity of types») runs out of memory at its default ~2 GB heap from PR #485 on. It aborted twice, reproducibly. Next type-checks the whole repository, about 980 test files included. The build and the client-bundle secret scan are clean with `NODE_OPTIONS=--max-old-space-size=4096`, and Vercel's own builds are READY. No build configuration was changed. Excluding `tests/` from the Next type check (they are type-checked by `tsc`), or raising the heap, is a small infrastructure decision for the owner.

## 7. Owner approvals required (nothing here was done)

| # | Decision | Cost / risk |
|---|---|---|
| 1 | Turn on `capability_discovery_v1` + `registry_router` (+ `web_via_treg`) for the **test account** only, then review real plans | No spend until a test mission runs; then the existing caps apply |
| 2 | One capped live capture of `branddev.brand.retrieve-by-name` through TREG, to prove the enrichment record fields | ≤ $0.03 (1 call at $0.02534) |
| 3 | Add measured sources to `production-eligible.json`: companies, places, reviews, web, Reddit. Each with its evidence, in a PR | None (data). It decides what customers can be offered. |
| 4 | Direct Firecrawl / Context.dev keys on the worker (`PROPOSAL-WORKER-DIRECT-KEYS.md`, option B) | Migration and secrets |
| 5 | §6.1: commit the estimate of an unanswered web call to `provider_costs` | Cap accounting |
| 6 | §6.3: refuse «personal e-mails of employees» in the chat | Chat policy, every customer |
| 7 | Phase 1 fixes for the gaps in §6.4 | None (code) |
| 8 | §6.6: exclude `tests/` from Next's type check, or raise the build heap | Build configuration |

## 8. Production state

Recorded at each merge:

* **`fb26563` (#483):**
  * Vercel production `dpl_Cnr2y99XB8Ao5zvy9ynR8HEioWEL` READY;
  * Heroku worker heartbeat `fb26563`, `active_missions 0`.
* **`cc81502` (#484):**
  * Vercel production `dpl_FGvB7oLLntbtUU2QEEajqXyW59mc` READY;
  * Heroku heartbeat `cc81502`, `active_missions 0`.
* **`df1c534` (#485):** see `docs/HANDOFF.md` «CURRENT STATE» (verified after the merge).
* **PR D:** see the PR. The final state is in `docs/HANDOFF.md`.

**`agent_settings` in production throughout the campaign:** only `redesign_flags` and `social_discovery`. No flag was set.

## 9. Recommendation for Phase 5 (multi-provider execution)

**CONDITIONAL GO.** The routing and planning layer is complete and offline verified. Phase 5 should start only with three things:

* **(a)** the owner's decision 1 (switches on a test account) and decision 2 (the ≤ $0.03 enrichment capture), so that at least one router-planned, non-social mission is executed and reviewed on real data;
* **(b)** decision 3 for the families to be sold;
* **(c)** PR #481 rebased.

Phase 5 was not started.
