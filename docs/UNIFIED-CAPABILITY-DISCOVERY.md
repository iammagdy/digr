# Unified request-to-execution: capability discovery (switch `capability_discovery_v1`, OFF)

**Status.** One PR. Everything new is behind ONE server switch, `capability_discovery_v1` in `agent_settings`, read with the same reader as the research brief (`scopedFlagOn`: `true` / `"on"` for everyone, `{"user_ids":[…]}` for named accounts, anything else OFF). **Nothing in the repository or the database sets it.** With it OFF the chat, the planning and the execution are exactly what they were (tested: the TikTok compiled plan, its provider calls and its price are identical, and a plan without a record is not checked).

No money, pricing, ledger, wallet, reservation, approval, settlement, refund, credential, schema, migration, auth, Vercel or Heroku configuration change. No live provider or paid model call was made. No new provider, flag or paid workflow is activated.

## 1. What the code actually had (traced, not assumed)

| Path | Who plans | Providers reachable | Gate |
|---|---|---|---|
| Social (TikTok, X, Instagram, Facebook, YouTube) | the plan **compiler** (`agent/src/compiled.ts`), no model; catalog cards (`foundation/toolCards`), optional catalog discovery (`foundation/discovery`, `social_discovery` = test) | TREG catalog | the platform's own `redesign_flags` value; a social plan proposed by the model is refused |
| Companies / places (no platform) | the **model planner** (`agent/src/tools.ts`: `catalog_search`, `describe_endpoint`, `treg_call`, `collect_pages`, `parse_page`, `web_search`, `web_scrape`, `people_search`, `run_code`, `propose_plan`) | TREG + Context.dev parsers + Firecrawl/Context.dev search & scrape + Context.dev people search | web tools only when the worker has a key (`webAvailability.ts`); the provider's daily cap at call time |
| Companies by code | `stage3/b2bPlanning.ts` | TREG verified cards | `DIGER_STAGE3_COMPANIES` (test accounts) |
| Public web (news, articles) with no platform | **not reachable**: the keyword route (`legacyRouteOf`) answers «clarify» and ends after two questions | — | — |
| Chat | one model call per message (`decideTurn`); brief mode behind `chat_research_brief_v1` | none | — |

`catalog_search` already merged TREG endpoints and web sources into one cost-ranked list, but nothing tied the **customer's request** to the **operations it needs**, nothing checked a capability's **output fields** against the next stage's **inputs**, a cheaper source could outrank one that can satisfy the request, the chat model knew nothing of what can actually be collected, and nothing re-checked the approved plan's sources before execution.

## 2. What was built

`src/lib/agentMission/capabilities/` (pure; no network, no clock, no paid call):

* **`registry.ts`: one capability list from the three providers that exist.** TREG: every endpoint of the local snapshot whose capability string maps to an operation (`social.parents | social.comments | social.replies | companies.discover | company.contacts | places.discover | places.reviews | web.search | web.read | people.discover`), with its inputs (`toolProfile`), documented output fields (`item_fields`; a wrapper object makes them *unproven*), paging, expressible filters (period / country / language), price per row (`expectedCost`), and availability (sellable, block list, the account's data policy). Firecrawl and Context.dev: their documented search, scrape, parsers and people search (`sources.ts`), unavailable when the worker has no key or the provider's daily cap is 0. Capabilities that return **private personal data** (`*.personal`, phone→person, e-mail→identity, home addresses, audiences, private chats) are never mapped and are refused wherever they are named.
* **`need.ts`: the request as data operations**, read by code from the customer's words (+ the validated brief's checked platforms and contents): kind (social / companies / places / people / web), platforms, comments, replies (on X a reply to a post *is* its comment), reviews, websites, public business e-mails / phones, the people of each company, the count, period / country / language, privacy, a platform no provider serves. Then the **chain** of stages with what each must give and what it can be fed with.
* **`discover.ts`: eligibility and ranking.** Hard rules first (public data, available now, right platform, an input the stage can be fed with, the required output fields when they are documented, a parent whose fields feed it). Then **ability to serve the request** (documented outputs, feeds the next stage, reaches the volume by paging, the conditions it can enforce, useful optional fields) and only then **price**, then id. A stage with no eligible capability makes the request `unsupported` (first stage) or `partial` (a later stage) with an Arabic sentence of what is unavailable and the feasible reduced scope; a condition the chosen capability cannot enforce becomes a customer-facing limitation (never claimed as applied).
* **`selection.ts`: the backend decides.** `validateCapabilityChoice` (a recommendation must be one of the stage's validated candidates), `planStageIssues` (a proposed plan stage is accepted only on a validated candidate OF ITS OWN STAGE of the chain: a root plan stage binds only to a root discovery stage, a child only to the discovery stage whose parent its own plan parent is bound to; a capability validated for another stage is refused), `capabilitySelectionOf` (the record stored with the plan: each stage's exact capability, operation, parent, the field that links it to its parent, the limitations actually shown, a digest of the capabilities and `params_digest` of every stored execution parameter), `verifyApprovedScope` (execution re-checks the stored approved plan against both), `resealCapabilitySelection` (the customer's own edit before approval, `editPlanForCustomer` / `smallerVersionForCustomer`, is the one change that re-seals the parameters; never the capabilities).
* **`prompt.ts`:** the chat's capability lines (kinds of data and platforms only: no provider, no endpoint, no price) and the planner's `VALIDATED CAPABILITIES` section (ids in rank order, what they take and give, paging, price).

### Wired into the existing paths (switch ON only)

```
chat (brief mode)   decideTurn prompt + «what can be collected now» (same ONE call)  →  validateBrief  →  discovery of the ready brief
                       unsupported / partial / blocked → honest sentence + feasible scope, brief kept «needs_clarification», NO mission
                       supported → the mission is created as today
worker runPlanning  discovery with the account's policy, the worker's keys and the providers' caps (no provider call)
                       non-social: blocked / unsupported → unserved before any model or provider call; partial → a question card «نعم، اجمع المتاح فقط / لا، ألغِ الطلب» before any plan or price
                       a recognised non-social need (incl. the public web) is routed by discovery instead of the keyword route
                       model-planned path: VALIDATED CAPABILITIES in the prompt; propose_plan refuses a stage outside the validated set; treg_call refuses a private-data endpoint
                       social: the compiler is unchanged (one social executor); its plan is only recorded against the discovery
                       plan_ready: plan.capability_selection (+ the limitation sentences in notes_ar on the model/companies paths)
worker runExecution verifyApprovedScope(stored plan) → a stage added, switched to another capability, or whose counts / filters / pins / pages changed after pricing (other than the customer's own edit before approval) is never run: nothing is called, the hold is released whole by the existing settlement
```

The model never prices, holds, approves, chooses a provider outside the validated set, or changes the approved scope. One chat-model call per message, as before (the prompt grows by about 15 short lines; no extra metered call).

## 3. Offline acceptance (`tests/unified-capability-discovery.test.ts`, 27 tests)

Scripted chat model, the real `agentChatTurn`; the worker's real `runPlanning` / `runExecution` with a fake planning model, fake TREG answers, a fake Context.dev / Firecrawl fetch, the existing money fakes (`create_quote_atomic` → `accept_quote_atomic` → `settle_job_atomic`), the real item store, workbook and delivery checks (`assertReplayInvariants`).

| # | Scenario | Path proven |
|---|---|---|
| 1 | vague «عايز داتا عن السياحة في مصر» → the model's own question (prompt carries the code's capability lines) → answer → one mission | chat |
| 2 | clear request → no question, one model call, discovery `supported` | chat |
| 3 | «تعليقات عن السياحة» → «من تيك توك» → «موافق» (nothing approved) → «آخر شهر» → «خليهم ٥٠٠» → «والردود كمان» → ONE live request with every requirement | chat + discovery |
| 4 | TikTok via TREG: compiled plan identical ON/OFF (stages, provider calls, price) + capability record verified | worker (stored live pages) |
| 5 | public web via **Firecrawl** search → scrape, routed by discovery, executed, pages joined to results, delivered and charged | chat → worker → approval → execution → settlement |
| 6 | **Context.dev** Maps + reviews parsers, the planner sees the validated set, 200 reviews with their place | full chain |
| 7, 13, 14 | companies (TREG) → employees (TREG) + work e-mails / phones (Context.dev contact pages): chain validated and recorded; 13 of 15 verified rows; partial; charged for 13 | full chain |
| 8 | Snapchat → honest limitation + alternative, no mission; a served social platform is never blocked by the chat for a child step only the compiler decides; worker: an unavailable e-mail step is ASKED before any plan; «لا» cancels; unknown source ends before any call | chat, worker |
| 9 | no key / cap 0 → capabilities rejected; a plan on them refused; no Context.dev request | discovery, worker |
| 10 | 300 TikTok comments: a paged source beats a cheaper unpaged one; equal capability → cheaper; «في مصر» → a source that filters by country beats cheaper ones | discovery (real catalog) |
| 11 | non-candidate / unknown stage / private-data id refused; worker: the planner's plan on a non-validated id refused, the fixed plan accepted and delivered | discovery, worker |
| 12 | the stored plan changed after the customer saw it → execution refuses: no provider call, nothing delivered, nothing charged, hold released | worker + money |
| 12b | a count or filter changed after pricing → refused at execution; the customer's own edit (the real `editPlanForCustomer`) re-seals and runs; a jsonb round trip digests the same | worker scope check + customer edit |
| 11b | a capability validated for another stage (the e-mails parser under the employees, a child-only parser as a first stage) is refused at this stage | discovery, worker |
| 15 | private component in the brief refused; private capabilities never in the registry; private endpoint refused before the gateway | chat, discovery, worker |

**Not proven by these tests:** what the real chat or planning model writes; live provider answers, latency or coverage; the real Context.dev parser credit per call (documented as an estimate, unchanged).

## 4. Rollout (owner action, NOT done by this PR)

```sql
-- test account only (the same account as docs/AGENT-UNDERSTANDING-V1.md); brief mode must also be on for the chat part
insert into agent_settings(key, value) values ('capability_discovery_v1', '{"user_ids":["<test-account-uuid>"]}') on conflict (key) do update set value = excluded.value;
```

Rollback: delete the row (or set `false`). The worker reads the web providers' daily caps (`settings_private.provider_limits`, read only) only while the switch is on for the mission's account.

## 5. Known limits

* Superseded in part by `docs/LLM-FIRST-OBJECTIVES.md`: the model's validated objectives are now the primary reading of the need (the keyword reading is the fallback), and a plan made through discovery can no longer skip the scope check by losing its record.

* The operation map covers the capability strings above; a catalog endpoint with no capability string (about a third of the snapshot) is not a discovery candidate (the compiler's own cards still use them, recorded as `source: "code"`).
* The chat does not know the worker's keys and caps: it can say a source does not exist, never that a key is missing; the worker decides with the real availability.
* A city is not a filter (unchanged); «في القاهرة» is a country-less place word for the planner.
* Product reviews on app stores / G2 are documented parsers but not yet a discovery operation.
