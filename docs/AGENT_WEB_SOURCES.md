# The agent's web sources (Phase 2)

What was added to the agent worker, with the price each one is recorded at. Read on 2026-10-28 from docs.context.dev (the credits page, the scrape API reference, the 20 parser pages, People Search, People Enrich, the changelog).

## One gateway, five tools

`agent/src/webGateway.ts` has the same rules as `treg_call`, in code, before every call: the source and its inputs are valid; the URL is a public page (`checkPublicReadUrl`: a public social page may be READ, a login / account / private-host page may not); the mission budget (the SAME budget as the TREG calls) is asked first; the provider's daily cap is reserved before the call and the ACTUAL charge is committed into `provider_costs`; the provider's key comes from the encrypted key store; the full answer is saved (`{ rows, ... }`), a `mission_calls` row is written, and the model gets a shape digest and the first rows only.

| Tool | Source id (plan / call log) | Provider endpoint | Price |
|---|---|---|---|
| `parse_page` | `contextdev.parse.<parser>` (20 parsers) | `POST /v1/web/scrape` with `formats.parse: true`, `parseParams: { type: "prebuilt", parser }` | **Not stated per parser in the documentation.** Recorded at the answer's own `key_metadata.credits_consumed` when present (`cost_basis: reported`); otherwise at the documented base scrape credit, **1 credit = 0.00254 USD, as an ESTIMATE** (`cost_basis: estimated` in the call row; shown in the admin trace). A failed parse costs nothing, except a target that answered 404 (the credits page keeps the base charge). |
| `web_search` | `firecrawl.search`, `contextdev.search` | existing adapters (`/v2/search`, `/v1/web/search`) | Firecrawl 2 credits per 10 results (0.005 USD a credit), Context.dev 1 credit per 10 results (0.00254 USD): documented |
| `web_scrape` | `firecrawl.scrape`, `contextdev.scrape` | existing adapters (`/v2/scrape`, `/v1/web/scrape` with markdown) | 1 credit each: documented |
| `people_search` | `contextdev.people.search` | `POST /v1/people/search` (`mode: fast`, optional `filters.countries`, `cursor`) | **10 credits a page of up to 10 people, a page with no match is free**: documented (launched 2026-10-23). It returns names, roles, companies, locations and public profile links, **never an e-mail or a phone**, so a contact source is still needed for those. People Enrich (20 credits a match, `person.email` not documented as a work e-mail, no phone) was NOT added. |
| `collect_pages` | any catalog endpoint with a cursor input | the endpoint's own | the endpoint's own price per call, each page through the same gateway checks |

The 20 parsers: `google-maps`, `google-maps-reviews` (up to 1,000; `sort`, `limit`), `google-play`, `google-play-reviews` (200), `app-store`, `app-store-reviews` (500), `instagram-profile`, `instagram-post`, `instagram-feed`, `tiktok-profile`, `tiktok-video`, `tiktok-feed`, `tiktok-comments` (first 20 only), `tiktok-followers`, `tiktok-following`, `tiktok-user-search` (top 10), `g2-reviews` (25), `emails`, `phone-numbers`, `links` (one page, no crawling). There is no X, Facebook or YouTube parser: those stay on the TREG catalog.

## Rules in code

* **Cheapest suitable source first, across all providers.** `catalog_search` returns the catalog's endpoints and these sources in ONE list ordered by cost per row computed by code (parsers: documented credit / rows one call returns). A call to a source ranked below an untried cheaper one is refused unless the agent passes `why`; the reason is kept in `mission_calls.params_digest._why` and shown on the admin page under «سجل استدعاءات المصادر».
* **Contacts.** A request for work e-mails or phones needs a contact stage (a `b2b_contact` endpoint or the `emails` / `phone-numbers` parser) or one honest sentence (`contacts_note_ar`, shown on the customer card). Columns marked `kind: work_email | phone` are verified by code (company-domain e-mail, never a personal mailbox or placeholder; 7 to 15 digit phone); an unverified value is left empty and a contact row with no verified value is not saved, so it is not delivered or charged.
* **Planning budget.** A multi-stage request (a parent and its children, or contacts) gets `AGENT_PLANNING_BUDGET_MULTI_STAGE_USD = 0.10`; every other request keeps 0.05.
* **Volume.** `collect_pages` pages in code until the target, the source's end, a refusal or `max_pages` (60), joins and de-duplicates, and ticks the live panel with real counts and the time left from the real speed.
* **Files.** Readable first: the parent row's name and link next to each child row, the stage's own readable columns, ids last under Arabic headers, no duplicated column, numbers as numbers, frozen header, filters, summary sheet first.

## Heroku

The worker reads the Firecrawl and Context.dev keys the way the website does: from the encrypted provider key store (`useProviderKeyStoreClient` with the worker's own Supabase client). It needs **`PROVIDER_KEYS_ENCRYPTION_KEY`** on Heroku (the same value as on the website). If the store gives no key it falls back to `CONTEXT_DEV_API_KEY` / `FIRECRAWL_API_KEY`. With neither, the web tools answer «source unavailable» and the agent uses the catalog. The provider's **daily cap** (admin page, provider limits: `contextdevDailyUsd`, `firecrawlDailyUsd`) must be above 0 or every call is refused with `daily_cap` (a cap of 0 means «spend nothing»).
