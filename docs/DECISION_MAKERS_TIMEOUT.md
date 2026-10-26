# Decision makers: the search timeout of 2026-10-26, the direct source, the live test and the per-field costs

Follows `docs/DECISION_MAKERS_LIVE_FAILURE.md` (PR #252, which added the identity key). Read-only diagnosis, then a code fix. No price or constant changed
(83 / 55 / 55 stays); no SQL; no paid provider call. The public catalog GETs (`https://treg.to/catalog/endpoints/<id>`, `https://treg.to/integrate.md`, `https://treg.to/openapi.json`) are free and need no credentials.

## What the database shows (test account, 2026-10-26, UTC; Cairo is UTC+3)

| Job | created | provider call | duration | status | cost | error |
|---|---|---|---|---|---|---|
| `job_quote_32a0…` | 08:24:04.7 | `provider_costs` 1009: `professional-people-search`, 1 call, started 08:24:07.4 | 30,005 ms | failed | 0 | «تعذر استخراج البيانات من المصدر بعد عدة محاولات.» |
| `job_quote_db6a…` | 08:28:13.8 | `provider_costs` 1010: same, started 08:28:16.1 | 30,002 ms | failed | 0 | same |

Both: `attempt_count 1`, `step 0`, 0 delivered, hold fully released, no email or phone lookup ever started. The owner's provider dashboard shows the second call as `POST treg.people.search` 200, cost 0.00114 USD, and its routed child `icypeas.people.search` 200, 0.00114 USD (3 rows × 0.00038): the source finished and billed a call our client had already abandoned.

## Root cause

1. **We stopped waiting for a call that the source completed and billed.** `tregClient.ts` aborts with `AbortSignal.timeout(options.timeoutMs)` (the people search was given 30 s by `peopleSearchTimeoutMs`, PR #252). The abort is caught as `network_failure` / 503, people calls have `retries = 0`, and the generic sentence was shown for what was one attempt. The abort came BEFORE the response headers: if the headers had arrived, the call would have been `ok` with an unreadable body and the adapter would have said «استجاب المصدر ببيانات غير متوافقة…», not the generic sentence.
2. **Why the routed call is slow: the gateway holds the connection until its own routing loop ends.** The catalog entry `treg.people.search` is `kind: routed`, `async: null`; it tries up to 26 providers one after another and "misses are billed too" for 17 of them (`cost.note`); its own latency is not published (`p50_ms null`). The response is small (3 rows), the call is not streaming and has no async or polling mode (`async: null` on both the routed endpoint and its child). The duration of the routed call itself is NOT measured anywhere we can read.
3. **The direct child is a different kind of call.** `icypeas.people.search` is `kind: data`, `async: null`, "SYNCHRONOUS", observed p50 584 ms and p95 1,122 ms over 1,276,463 calls, 0.00038 USD per row, `pagination.size` (1 to 200, default 100) is the price dial. A production job through it on 2026-10-16 (`job_quote_1e39…`, `icypeas.people.search`, 5 delivered, cost 0.0038) took 8 s from creation to completion.
4. **The gateway offers a re-read.** `integrate.md`: an idempotent replay "reports 0 and puts the first call's charge in `X-Treg-Original-Cost-Micro`"; `GET /calls/{id}/result` returns "the stored response of a successful catalog call"; `GET /calls` lists recent calls. `openapi.json` does not say what a replay does while the first call is still running.
5. **How the gateway maps our flat body to the child's body is not documented** (the dashboard shows only the child's call). The catalog says locations are "best given as alpha-2 country codes (FR, US); a comma narrows them", so `EG` is the documented form; the body that worked for the owner used `"Egypt"`. Poor relevance does not come from one spelling: the direct call with «Egypt» also returned a person in Bahrain, so the source's location filter is loose and the rows must be judged by us.

## What changed

- **The search goes to the direct source** (`PEOPLE_DISCOVERY_ENDPOINT`, `tregAdapter.ts`) with the body `{query: {currentJobTitle, location (alpha-2), keyword}, pagination: {size}}` built from the plan's params (`icypeasPeopleBody`); the plan, the quote, the prices and the settlement are unchanged. Rows asked for: three times the people wanted, at most 11 (11 × 0.00038 = 0.00418 USD, under the unchanged 0.005 per-call ceiling; the per-job 0.04 ceiling is unchanged).
- **A call cut by our own time limit is replayed once with the same idempotency key** (`executeTregCallWithReplay`): the stored answer is read at no charge and the first call's charge is the one recorded (`callCostMicro`, from `X-Treg-Original-Cost-Micro`). The first wait is up to 20 s (the worker deadline decides), the replay runs only if at least 5 s remain after keeping 12 s for the lookups and the job's spend budget allows one more reserved call. The client now flags `timedOut` and reads the original-cost header.
- **A timeout is told honestly:** «تأخر المصدر في الرد ولم يصلنا ردّه، ويمكنك إعادة المحاولة.» (not deterministic: the retry offer stays; the old sentence said «بعد عدة محاولات» for one attempt).
- **Relevance, before any paid lookup and again in the worker's gate:** a person whose own address is in another country is refused (as before); a company address in another country, or a company with none of the requested activity words in its name, industry or description, goes to the review sheet. Neither is looked up, delivered or charged. Lookups stop once the people still needed have a contact value; people who match come first, those with a contact value before those without.
- **No contact value is read from free profile text:** only the source's structured contact fields (and the lookups' answers) fill the work email and the phone; per-field charging is unchanged (`decisionMakerDeliveredUnits`).
- **Decision, for the owner:** for a person the company's declared industry counts as evidence together with its name and description (the company directory gate refuses a label alone). The stricter rule would deliver fewer people.

## Live test for the tester (test account, 3 people, quote limit 700 points)

Spend: the search bills at most 11 rows (0.00418 USD); lookups are capped at 0.005 USD per call and the job at 0.04 USD.

0. Free check first (no charge): call `icypeas.people.search.count` (free, p50 265 ms) with `{"query":{"currentJobTitle":{"include":["CEO"]},"location":{"include":["EG"]},"keyword":{"include":["information technology","software","technology"]}}}` and again with `"Egypt"` in `location`: compare `total` and note which is closer to Egyptian technology companies.
1. Send exactly: `عايز ٣ من صناع القرار في شركات تكنولوجيا في مصر، مع البريد المهني والهاتف`. The plan card must show ١٩٣ نقطة للشخص, expected ٥٧٩, hold ٦٦٦.
2. Approve. Read (read-only) `jobs`, `job_events` and `provider_costs` of the job: expect ONE `icypeas`-sized search call of about 1 s (not 30 s), then at most four lookup calls per matching person.
3. Pass: the job completes. The file lists the matching people first, each field with its status; people of another country or another activity are in the review sheet only. `charged_credits` = 83 × (people with an email or a phone) + 55 × emails + 55 × phones, never above 666; the hold's remainder is released with the wording «حجز مؤقت مُحرَّر».
4. If the search call again ends at 20 s: read the call in the provider dashboard (filter by `job=<job id>`): if it shows 200 and a cost, the replay should have returned it, and the two rows of `provider_costs` (search call, replay) show whether the replay was read; send the dashboard rows. If the job fails with the timeout sentence and nothing was billed, the source is down: retry later.

## Per-field cost: what is visible today, against the current prices (nothing applied)

Rule: points = USD × 5,500. USD figures are catalog prices and the owner's dashboard; the real cost of a delivered record is NOT AVAILABLE (no decision-makers job has delivered one).

| Field | USD seen | Points at ×5,500 | Current points |
|---|---|---|---|
| Person row from the direct source | 0.00038 per row (dashboard: 0.00114 for 3 rows); at 3 rows fetched per person wanted, 0.00114 per person | 2.09 per row; 6.27 per person wanted | 83 |
| Work email, children inside the 0.005 cap | 0.000495, 0.004834, 0.005 (hit rates 0.4112, 0.3186, 0.3672) | 2.72, 26.59, 27.5 | 55 |
| Office phone, children inside the 0.005 cap | 0.000495, 0.004834 (hit rates 0.1486, 0.1251) | 2.72, 26.59 | 55 |
| One person, every call billed at its ceiling | 0.00114 + 0.005 + 0.005 = 0.01114 | 61.27 | 193 |

## Not verified

- How long the routed call took, and what a replay does while the first call is still running (the spec does not say).
- That the direct call answers in about a second from the worker's region (the catalog's p95 is 1,122 ms; the 2026-10-16 job took 8 s end to end).
- Whether `location: ["EG"]` returns more relevant rows than «Egypt» (item 0 of the live test answers it for free).
- Whether the lookups (`treg.people.email.find`, `treg.people.phone.find`, still routed) can also exceed 12 s; they now get the same replay.
