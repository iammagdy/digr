# Production activation, 15 Nov 2026 (owner decision of the same day)

The owner authorized a production-wide rollout of the completed, production-eligible improvements. This file records what was **actually** switched, how, the evidence, and what stays off with its exact blocker.

## 1. Switched ON for every customer (`agent_settings`, value `true`, read back at 05:49:04 UTC)

| Key | What it does | Paid calls it adds |
|---|---|---|
| `chat_research_brief_v1` | The chat model consolidates the conversation into a research brief (platform, content, count, topic, **source**, period); code validates it against the customer's own words (`validateBrief`: never invented, never dropped) before ONE mission is created | none: the same single chat model call per turn, with a longer prompt; no customer charge |
| `capability_discovery_v1` | The chat and the worker read which supported services can serve the request (local catalog, web sources, policy, provider keys and caps); the planner may only use validated capabilities; unsupported parts are said before anything is priced | none by itself ("NO provider call and no model call", `runMission.ts`); execution stays under the existing planning budget, job budget, provider daily caps, pricing, reservation and explicit approval |
| `semantic_normalization_v1` | Fill-only reading of the request contract (fills a field the parser left empty, never overrides a filled one) | none (pure, offline, no model, no network) |

**How it was applied.** A one-off process on the Heroku worker app (`diger-agent`, dyno `run.1238`, 05:48:40 UTC) ran a short script with the worker's own service credentials. It printed no secret. It refused to write if any mission was `queued`/`planning`/`approved`/`executing` (none was). It upserted exactly these three keys, and touched no other key and no money table. The site and the worker read these keys on every chat turn and every planning run: no redeploy is needed.

**Snapshot before.** Only `redesign_flags` (platforms `on`, the six request types `test`) and `social_discovery` (`test`) existed. The three keys above were absent (OFF).

**Rollback** (any one, independently): set the key's value to `false`, or delete its row. Execution of plans approved before is unaffected: a plan without a scope anchor verifies as before (`verifyApprovedScope`, `checked: false`).

## 2. Already active before this task (unchanged)

- The five social platforms are `on` (compiled path) for every customer.
- PR #499's P0 corrections are on `dde50a4`: the general named-source rule, the source question before pricing, the exact author check, follow-ups of an ended request, and the truthful partial-delivery text.
- Excel/CSV/PDF delivery and the Arabic customer texts.
- Pricing, reservation and settlement.
- Web tools on the worker: Firecrawl and Context.dev were reachable in the latest production planning events (`adm_web_firecrawl: 1`, `adm_web_contextdev: 1`).

## 3. Still OFF, with the exact blocker

| Key | Blocker |
|---|---|
| `registry_router` | Never run in production. For a non-test account it filters capabilities by verification level, which can turn a request served today into «unsupported». The owner's rule: no router that silently removes working coverage without demonstrated replacement. |
| `web_via_treg` | Adds a new paid TREG step (official website via brand.dev) to company chains. It has never answered a real call. Its spend boundary was designed around the campaign spend gate (Phase 8), and that gate's SQL is not applied. |
| `multi_stage_engine` | A new multi-provider execution path. «No mission was run through the SourceGateway». Same spend-gate dependency as `web_via_treg`. |
| `customer_exclusion_files_v1` | A free re-run carries no file, so the exclusion promised to the customer would be dropped (PHASE-5-3-AND-6.md:81; the runbook says «Do not set»). |
| `social_discovery` = `on` | The code reads `on` as OFF by design. Only `test` exists, for test accounts. «Promoting a tool to every account is a DATA change … never this switch». No derived tool has answered a real call. |
| `redesign_flags` request types `test` → `on` | For requests with no platform (companies/places), the social type keys switch on the planning checkpoint and `sealFinalPrice`. That changes how the final price is sealed, and price changes are outside this authorization. The `companies`/`people`/`places` keys do nothing while `DIGER_STAGE3_COMPANIES` is unset. |
| `DIGER_STAGE*`, `DIGER_SPEND_GATE` (worker environment) | Not changed. Stage 4 versions need the add-on migration, which is not applied. The spend gate needs the owner's SQL (Phase 8, D1). |

## 4. Evidence

- **Offline, the combined production configuration.** The full suite passed: 14,120 tests, 0 failed (47 expected-fail, 99 skipped). Root and agent typechecks are clean.
- **`tests/p0-production-config-journey.test.ts` (5 tests).** It covers the incident's conversations with brief and discovery ON globally, on the recorded production pool:
  - one mission keeps X, 400, the period, the topic and the ministry as the source;
  - planning asks for the account identifier before anything is read, held or priced;
  - a model that drops the source cannot produce an all-of-X search;
  - the follow-up after the ended request keeps the ministry, X and 400;
  - with the identifier given, every search carries `from:<id>`; the recorded pool (38 other accounts) prices nothing; on a mixed page only the source's own rows are planned and the plan says the total may be lower than asked;
  - 79 items not from the source are told as «تسليم جزئي».
- **Replay of 248 real production requests (last 21 days, offline, no call).**
  - With discovery ON: 0 requests become unsupported. 173 social requests are unchanged. 46 companies/places requests still reach the same planner, restricted to validated capabilities. One public-web request that used to get a clarifying card now gets a plan. 0 «mixed» questions.
  - With semantic normalization ON: 1 of 248 contracts changes, an English request where the topic, country and comments are filled correctly. 0 overrides.
- **Production after the switch.**
  - Vercel production is `dpl_7ueGVty69XgAPZDsX6Qqxy5wpdi2` READY on `dde50a4`; the Vercel runtime errors read for the last hour (which covers the switch) show none.
  - Heroku v207 «Deploy dde50a4d»; the worker heartbeat reports `dde50a4` with 0 active missions.
  - `credit_ledger` is unchanged: 1,254 rows, total 15,995, last row at 14 Nov 19:26:38. No new mission was created by this work.
- **Browser (real Chromium, https://diger.tech).** `/`, `/login`, `/pricing` and `/dashboard` were checked on desktop and on iPhone 13. All are right-to-left, with no horizontal scroll and no page errors; `/dashboard` sends a visitor without a session to `/login`. The signed-in chat was **not** driven in a browser: this session has no customer or test-account session.
