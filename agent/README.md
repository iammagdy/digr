# Diger agent worker

A long-running worker that runs Diger's real AI agent: a Claude agent (the Claude Agent SDK, `@anthropic-ai/claude-agent-sdk`) that understands a data mission, searches the TREG
catalog, samples and looks at real rows, splits the work into stages, runs for as long as it needs, links results to their parents and delivers analysis-ready files. It is hosted on
Heroku as a **worker dyno** (no 60-second limit). The website stays the interface for users and money.

**Since Phase 1 the agent serves the customer chat.** Every research request typed in the chat becomes a mission (a greeting, a general question and a file-shaping turn are still answered by the old code). The admin page «الوكيل» still starts missions for the test account.

* **The rollback switch** is ONE constant: `AGENT_SERVES_CHAT` in `src/lib/agentMission/constants.ts`. `true`: the chat creates a mission; `false` and redeploy the website: the old planner path answers, exactly as before. The old planner is not deleted.
* **What the customer sees**: a card in the chat (`src/components/mission/AgentMissionCard.tsx`) drawn from `/api/missions/<id>` by `src/lib/agentMission/customerView.ts`: one summary sentence, numbered stages with their expected rows (they add up), 2 to 3 sample rows with readable columns, the price, the hold and the expected time on one line, and the buttons «اعتمد» and «عدّل الطلب». After approval the live panel «خطة المهمة» ticks from `mission_events` (the counts are in the events' `counts` JSON, written by code), the page may be closed, and the customer gets an in-site notice and an e-mail (the existing `send-email` function, template `job-update`) when the mission ends. A guest sees the plan and is asked to sign up before approving.
* **Queue**: with one mission at a time (`AGENT_CONCURRENCY=1`) a mission that waits shows «مهمتك في الدور وهتبدأ خلال دقائق» and its position (missions waiting before it + 1).
* **Event text guard** (`src/lib/agentMission/eventText.ts`): every line that reaches `mission_events` passes the Arabic-only check; a line that fails is replaced by the fixed Arabic line of its kind. Numbers go in `counts`.

```
admin page «الوكيل» ──► missions (Supabase) ◄── worker (Heroku) ──► Claude (Agent SDK)
        │ approve                                   │ the ONLY tools: catalog_search, describe_endpoint, treg_call,
        ▼                                           │   run_code, report_progress, ask_question, propose_plan, save_rows, finish
 existing money functions                           ▼
 (reserve / settle / release)             gateway ──► TREG   (code-enforced: sellable, block list, data policy,
                                                            mission budget, provider daily cap, every call recorded)
```

**Phase 2** adds the page parsers, web search and scrape, people search, the contacts stage with verified values only, paged collection of hundreds of rows and readable files: see `docs/AGENT_WEB_SOURCES.md`.

## What is enforced in code (not in the prompt)

* `treg_call` checks, before every call: the endpoint is sellable, it is not on the block list (write actions, own_account, apollo, datagma), the data policy (a sensitive endpoint only for the admin
  or a verified business), the mission's USD budget (planning 0.05; execution 40% of the approved reserve's value, floor 0.005) and the provider's daily cap. Every call is recorded in `provider_costs`
  with the actual charge, the full raw answer is saved to private storage, and the model gets a shape digest and the first rows only.
* `run_code` runs JavaScript in a separate process with an empty environment, Node's permission model, a vm context with no `require`, `process`, `fetch`, timers or string code generation, a time limit and a
  memory limit, on the mission's own saved files only. The SDK's built-in shell, web fetch and file tools are disabled three ways, and the SDK's process never receives the Supabase key or the TREG token.
* The model never states a price. The site computes it: unit price = measured cost per final row x 5,500; reserve = ceil(volume x unit x 1.15), cap 25,000; charge = ceil(delivered unique final rows x unit price),
  never above the reserve, the rest released. Settlement uses the existing money functions only.
* What the customer reads is Arabic only, with Arabic-Indic digits, and never a provider name, an endpoint id, a dollar amount or an internal id: the prompt says so and `src/lib/agentMission/text.ts` refuses a line that breaks it.

The system prompt is a file: `agent/prompts/system.md`.

## Environment variables (names only; set them in Heroku, never in the repository)

| Name | What |
|---|---|
| `ANTHROPIC_API_KEY` | the Anthropic API key |
| `TREG_TOKEN` | the TREG token (the same one the website uses) |
| `SUPABASE_URL` | the Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | the Supabase service-role key |
| `AGENT_CONCURRENCY` | optional; how many missions the worker runs at once. Default **1** (a Basic dyno has 512 MB, and each running mission starts a native process of its own); at most 4 |
| `PROVIDER_KEYS_ENCRYPTION_KEY` | (Phase 2) the same value as on the website: the worker reads the Firecrawl and Context.dev keys from the encrypted provider key store. Without it the worker falls back to `CONTEXT_DEV_API_KEY` / `FIRECRAWL_API_KEY` |
| `AGENT_MODEL` | optional; `claude-haiku-5-5` (default) or `claude-sonnet-5-5`. Planning can be switched separately from the admin page «الوكيل» (the model of each phase and its cost are stored on every mission, so the two can be compared) |

## Heroku, step by step (no command line)

0. **Supabase first.** Apply `docs/proposals/agent-worker/` in the order of its README (the admin page tells you if it is not applied). Do not turn the worker on before this.
1. **Create the app.** dashboard.heroku.com → **New** → **Create new app** → give it a name (for example `diger-agent`) and a region → **Create app**.
2. **Connect GitHub.** In the app, tab **Deploy** → **Deployment method: GitHub** → **Connect to GitHub** → search `iammagdy/digr` → **Connect**. Under **Manual deploy** choose the branch (`main`) and press **Deploy Branch**. (Optional: **Enable Automatic Deploys**.) Heroku detects Node from `package.json` (Node 22) and builds with `heroku-postbuild`.
3. **Add the settings.** Tab **Settings** → **Reveal Config Vars** → add the four names above with their values (and `AGENT_MODEL` if you want to change the default).
4. **Choose the dyno and turn the worker on.** Tab **Resources** → under **Free/Hobby/Basic** the list shows one line, `worker` (from the `Procfile`; there is no `web` line, which is correct). Press the pencil icon on that line → choose **Basic** → switch it **on** → **Confirm**.
5. **Check.** Open the admin page «الوكيل»: the dot turns green («العامل يعمل») within a minute. In Heroku: **More** → **View logs** shows `[agent] worker ... started`.
6. **To stop it**: Resources → the pencil → switch the worker off. Missions waiting stay queued; a mission that was running is taken over by the worker when you turn it on again (its lease ends after two minutes).

The admin page «الوكيل» shows the worker's memory (the worker alone, and with the processes it started, against the dyno's 512 MB) from every heartbeat; it turns red above 80%.

## Memory on the 512 MB dyno

The numbers live in `src/lib/agentMission/constants.ts` (`AGENT_MEMORY_*`, with the evidence in the comment above them); the figure that counts is the **tree** memory (the worker plus the processes it started, read from `/proc`).

* **One process, small heap.** The `Procfile` runs `node --max-old-space-size=192 --max-semi-space-size=4 --import tsx agent/src/main.ts`. A freshly started worker reads about 259-267 MB tree at idle (183 MB of its own plus a child of about 76-84 MB, not identified); older workers read 208-250.
* **One SDK session at a time** (`agent/src/sessions.ts`); a finished session is closed and its temp folder removed. Tool results are cut at 10,000 characters; the code sandbox has a 96 MB heap.
* **Measured, not guessed.** Every run writes its own peak (worker and whole tree, per phase) as an INTERNAL event of the mission (`mem_*` counts; the admin page «الوكيل» shows it in Arabic, the customer's panel never does). Re-set the limits from those peaks.
* **Hard limit 580 MB** = the highest idle reading (267) + a whole SDK process (about 270) + margin, above the 486 MB planning peak that was measured. 580 MB is 13% over the dyno's quota (the platform's R14 warning zone; its kill threshold is not measured). At the hard limit the running mission is stopped and goes back to the queue (planning: `queued`; execution: `approved`, hold and saved rows kept), at most 2 times, then it ends with what is saved.
* **Admission 300 MB:** a new mission is not taken while the tree is at or above it (it stays `queued`). An admission limit BELOW the idle memory of a healthy worker starves the queue (it did, at 250). A worker that is idle, up for 15 minutes, and stays above it for 2 minutes exits so the platform restarts it with a fresh heap; a younger worker never does.

## A mission never stays leased by a worker that does not run it

* The heartbeat renews the lease of **exactly the missions the worker is running in memory**. A mission whose run ended, or whose worker restarted (a new worker has a new id), is not renewed: its lease ends and the next claim takes it over.
* Every claimed mission goes through `runMissionSafely` (`runMission.ts`): an exception, or a run that returns without leaving the mission in any state, ends cleanly. Planning (nothing held) goes back to `queued`, at most 2 times, then fails honestly with one Arabic message. Execution goes back to `approved`, at most 2 times, then is settled with what is saved through the existing settlement functions (charge = ceil(delivered x unit), never above the reserve, the rest released).
* What a mission remembers about its runs (`run_state.json`, application/json in its own folder) counts starts and requeues; a phase that starts more than 8 times ends honestly. The bucket accepts ONLY `application/json`, `text/csv` and the xlsx type: the in-memory store of the tests enforces the same list.
* A source that refuses a search by its own description (`crawl4ai.x.search.posts`: a topic search without an X login answers HTTP 400, free) is not called at all; a failed, empty or refused sample lists the untried sources of the ranking so exploration goes on within the budget. The reason of a failed call is kept in `mission_calls.params_digest._failure` for the admin.

## ONE item store, the code engine, settling from the file (2026-10-29; full account and evidence in `docs/ENGINE_AND_ITEM_STORE.md`)

* **The model plans, code executes.** After approval, a plan whose every stage has a proven recipe (`stage.engine`, derived by code at plan time from the agent's measuring call and its mapping `run_code`, and re-run on the measured page to prove it) is carried out by `agent/src/engine/run.ts` with no model session: pages from the recorded cursor (resume, never restart), the recipe's mapping, `agent/src/items/ingest.ts` (rule first, the model only for the ambiguous, in batches, within the review budget), until the target or a RECORDED stop reason. Any other plan is carried out by the model through the same store, with `finish` refused (three times) while matching items are needed and a source has more pages, and up to two further rounds. `RunnerDeps.engine = false` switches the engine off.
* **ONE item store** (`agent/src/items/itemStore.ts`): an append-only log of immutable objects `items/seg_<seq>_<writer>.json` (create-only upload, read through the listing then a download of the names it returned). Never read-extend-overwrite: Supabase Storage serves an overwritten object stale from its CDN for up to 60 seconds, which is what lost 115 items in the live run of 2026-10-28. `found = new + duplicates`, `new = accepted + excluded + pending + unchecked`, `saved = accepted`, `delivered` = the items in the file.
* **Settle from the file** (`settleExecution`): fresh read of the log, files built and published, xlsx read back and counted; that count is the delivered count, the charge basis, and every number the customer reads. A disagreement charges by the file and flags the mission (internal event `adm_flag`, `missions.error` = `admin: ...`).
* The older files `rows/`, `excluded/`, `checks.json`, `review_state.json` are rewritten from the store for the admin page only; nothing decides from them.

## Only matching rows are delivered and charged; the one pricing rule; the cost account

* **Relevance** (`src/lib/agentMission/relevance.ts`, applied in `save_rows`): a stage whose rows were found by a TEXT SEARCH carries a rule the agent proposes (`subject_ar`, `terms`, `context_terms`, `exclude_terms`, `text_columns`) and `yield_from`, the run_code output with ALL the rows of the measured page. Code counts the share that matches and prices on the cost per MATCHING row. In `save_rows`, a row whose text lacks the name (it matched through the author's name), a bare mention, an empty reply and a row of another person with the same name are left out (kept with their reason in `excluded/<stage>.json`, never delivered or charged). Uncertain rows go to the model review (`review.ts`: one small HTTPS request per batch to the model API, NOT an SDK session) within 20% of the mission's revenue; an unreviewed row is not delivered. `save_rows` answers with `still_needed`, so the agent keeps paging; a shortfall is stated in plain words by code.
* **Pricing** (`src/lib/missionPricing.ts`, one function for the quote, the calculator and the public pages): unit = (provider + model cost, review included, per delivered matching row) x markup x 55 / 0.10; charge = max(minimum, ceil(delivered x unit)) when anything is delivered; reserve = max(minimum, ceil(volume x unit x 1.15)); cap 25,000. Markup (10) and minimum (200) are admin settings (`agent_settings`, key `mission_pricing`, audit row per change, page «الوكيل»). The minimum is exact for a full delivery through the job's unit; for a PARTIAL delivery it needs `docs/proposals/agent-pricing-minimum/` (NOT APPLIED; no code depends on it).
* **Cost truth:** every run writes an internal event with its input, output, cache-read and cache-write tokens and its model cost (`tok_*`, `llm_micro_usd`); every model message checkpoints the running cost on the mission, so a killed run's cost is kept; the review's tokens come from the API's own answer. The SDK's `total_cost_usd` is an estimate at list prices, not a bill (documented in its type definitions).
* **Environment:** the review uses the `ANTHROPIC_API_KEY` the worker already has; no new variable.

## Developing

```
npm test                       # all tests, with a fake model transcript and fake TREG answers: no real call
npm run agent:typecheck        # type-checks the worker, including the SDK driver
npm run agent:worker           # starts the worker (needs the four environment variables)
```

`agent/` has its own `package.json` (the Claude Agent SDK, which ships a native binary of about 280 MB) so the website's install does not carry it; the website's `tsconfig.json` excludes the two files that import it
(`agent/src/main.ts`, `agent/src/sdkRuntime.ts`). Everything else in `agent/src` is plain code over injected stores, clocks and model drivers, and is tested without the SDK.

## NOT PROVEN

* A real run with the real model: no Anthropic key was used and no provider was called while building this. The SDK driver type-checks against the installed SDK and its options are asserted in tests, but a real mission has not run.
* The SDK's native process memory on a Heroku Basic dyno (512 MB) during a real planning run — the limits above act on the measured tree, but no real run was measured here — and the slug size (the website's dependencies plus the SDK's native binary) are not measured; the build (`heroku-postbuild`) has not run on Heroku.
* The sandbox is a separate Node process with the permission model and a vm context. Node 22's permission model does not restrict the network, and a vm context is not a security boundary against an unknown engine bug; an OS-level network jail is not in place.
* The SQL has run only on a scratch PostgreSQL, not on Supabase; the job cap (25,000) must already be applied there for a large mission to be approvable.
