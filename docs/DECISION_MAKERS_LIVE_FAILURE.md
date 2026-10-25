# Decision makers («صناع القرار»): the live failure of 2026-10-25, the fix, the live test and the per-field costs

Read-only investigation, then a code fix. No price, constant or SQL was changed or applied; no paid provider call was made. The public catalog entries
(`GET https://treg.to/catalog/endpoints/<id>`, free, no credentials) were read on 2026-10-25 for the schema and the prices below.

## What happened (test account, production)

Request: «عايز ٣ من صناع القرار في شركات تكنولوجيا في مصر، مع البريد المهني والهاتف».

| Attempt | What the database holds | Customer text |
|---|---|---|
| 22:17 plan | `plans_quotes` item: capability `professional-people-search`, 193 points a person, hold 666. Params: `{limit:3, country:"EG", keywords:["information technology","software","technology"], requiredContactFields:["work_email","phone"], contactFieldsToAttempt:[…]}`: **no title, no q, no company, no name** | plan card (fine) |
| 22:17 job | `jobs` failed after 3.5 s, 0 delivered, 0 charged, hold released. `provider_costs`: one row, status `failed`, duration 360 ms, cost 0 | «تعذر معالجة مدخلات الطلب لدى المصدر.» |
| 22:19 retry (new conversation) | `messages.request_error` = «سعر الوحدة غير صالح للخدمة المطلوبة.» (no plan, no quote) | «حصل تعثر مؤقت، لم يُخصم أي رصيد، جرّب مرة أخرى.» + retry button |

An older job (2026-10-23, `treg.people.search`) carried `title:"Director"`; it failed after about 13 s with «تعذر استخراج البيانات من المصدر بعد عدة محاولات.» (its cost-reserve row was written 12.6 s before the failure: the 12 s per-call limit).

## Root causes

1. **The search body had no identity key (HTTP 422).** The catalog says `treg.people.search` "matches each provider on the variants it accepts
   ({q} | {company_domain} | {company_domain, title} | {title} | {full_name})"; `country`, `location`, `keywords` and `limit` are filters only. «صناع القرار» names no role, so
   `peopleParamsFromIntent` (`src/lib/requestIntent.ts`) set no `title` (it also deletes `q`), and `missingInputsForIntent` accepts the phrase as roles. The body
   `{country, keywords, limit}` is refused in 360 ms (`providerFailureMessageAr`, `src/lib/server/tregAdapter.ts`, maps 422 to the sentence above).
   `quoteScopeGaps` let it through (keywords or the decision-makers flag passed as "scope").
2. **The quote builder matched the live zero-cost listing first.** `validationCaps` is `[live catalog capabilities…, registry…]` (`chatHandler.ts`), the live catalog lists `treg.people.search` at **cost 0**
   (a routed wrapper), and `createAndSaveManagedQuote` matched by any of slug, id or endpoint id in list order, so a turn whose catalog search returned that listing priced the plan at 0 and threw
   «سعر الوحدة غير صالح للخدمة المطلوبة.» (`planManager.ts`). The first attempt, with the listing absent from the turn's list, priced correctly: the failure depended on what the turn had searched.
3. **That plan-time error looked like a hiccup, with a retry button.** The server's reason `plan_build_failed` (status 500) was shown as «حصل تعثر مؤقت…» and every chat failure offered «إعادة المحاولة الآن».
4. **Not proven, and not guessed at:** why the 2026-10-23 job (with a title) did not answer in 12 s. The raw provider body is only written to runtime logs (`treg_client_rejected`, `treg_call_timing`), which were not read.

## What the fix does

- A people search always carries an identity: a role the customer names is kept; otherwise the default title is `CEO` (shown on the plan card as «الرئيس التنفيذي», editable before approval). Built at plan time (`peopleParamsFromIntent`) and again at job time (`normalizeTregPeopleParams`), so a quote issued before the fix also works. Module: `src/lib/peopleSearchInput.ts`.
- A people plan with no identity key is incomplete (`quoteScopeGaps`) and is not offered.
- The quote builder matches the plan's own slug first, then aliases (`planManager.ts`).
- A deterministic refusal (`plan_build_failed`, `capability_not_found`, `unsupported_platform`) shows the server's own sentence and no retry button; a failed job whose text says the source refused the request's input (or cost ceiling, or target) offers no «إعادة المحاولة» (`src/lib/providerFailureText.ts`, `customerError.ts`, the chat and requests pages). A network drop, timeout or hiccup keeps the temporary sentence and the button.
- The routed search may use the time the worker's deadline leaves (12 s up to 30 s; the per-person lookups keep 12 s).
- A contact value the source marked «غير صالح» is shown as «غير متاح» in the file; it is now also not counted for the per-field charge. A person with no contact value is still not charged.
- The plan card says before approval that email and phone do not reach every person, and what the default title is.

## Per-field cost, today's public catalog, against the current prices (nothing applied)

Rule: points = USD × 5,500. The adapter limits every routed call to 0.005 USD (`DECISION_MAKER_ROUTE_COST_CAP_USD`), so only the children priced at or under it can serve a call.

| Field | Endpoint | Children (priced) | Child price USD: min / median / max | Children inside the 0.005 cap | Current points | Rule points at median / at the cap |
|---|---|---|---|---|---|---|
| Person (name, title, company) | `treg.people.search` | 26 | 0 / 0.006 / 0.3 | 13 | 83 | 33 / 27.5 |
| Work email | `treg.people.email.find` | 23 of 24 (one catalog entry did not answer) | 0.000495 / 0.02 / 0.15 | 3 | 55 | 110 / 27.5 |
| Office phone | `treg.people.phone.find` | 15 | 0.000495 / 0.15 / 0.7488 | 2 | 55 | 825 / 27.5 |
| All three | | | sum of medians 0.176 | | 193 | 968 / 82.5 |

Observed hit rates of the children that fit under the cap (catalog `observed.hit_rate`): email 0.4112, 0.3186, 0.3672; phone 0.1486, 0.1251 (a low chance that a phone arrives); person 0.2 to 0.6886 for the ones that report one.
The route cap means the median columns are not what a call costs here (the dearer children are excluded), and the cap column is a ceiling, not a measured cost. **Actual cost per delivered record: NOT AVAILABLE**: no decision-makers job has ever completed in production (two failed, 0 delivered, cost 0).

## Live test for the tester (test account, 3 people, quote limit 700 points)

Spend note: this is the first paid run of the service; the adapter's own limits are 0.005 USD per routed call and 0.04 USD for the job.

1. Balance of at least 700 points. New conversation. Send exactly: `عايز ٣ من صناع القرار في شركات تكنولوجيا في مصر، مع البريد المهني والهاتف`.
2. The plan card must show: «نوع البحث: الرئيس التنفيذي», country مصر, ٣ سجلات, ١٩٣ نقطة للشخص, expected ٥٧٩, hold ٦٦٦ (under 700), the sentence «لا يتوفر البريد المهني ولا الهاتف المكتبي لكل شخص…», and no «حصل تعثر مؤقت». Do not try 4 or 5 people: the hold would exceed 700.
3. If instead the card is missing or shows a refusal, stop and read (read-only): `select created_at, role, request_status, request_error from messages where user_id = '<test account id>' order by created_at desc limit 6;`.
4. Approve and wait for the end of the job.
5. Read (read-only), with the job id from «طلباتي»:
   - `select status, delivered_units, reserved_credits, charged_credits, error_message from jobs where id = '<job id>';`
   - `select event_type, message, created_at from job_events where job_id = '<job id>' order by id;`
   - `select capability, status, units, cost_usd, duration_ms from provider_costs where job_id = '<job id>' order by id;`
6. Pass: the job completes with at least one person; every row shows its status per field; `charged_credits` = 83 × (people with an email or a phone) + 55 × (emails) + 55 × (phones), never above 666; a person with neither is in review and not charged; the unused hold is released with the wording «حجز مؤقت مُحرَّر».
7. Also acceptable, and honest: a failed job with 0 charged. Then the page must show the real sentence; for «تعذر معالجة مدخلات الطلب لدى المصدر.» there must be NO «إعادة المحاولة» in «طلباتي». Send the two runtime log lines of that job: `treg_call_timing` (status and latency of the search call) and `treg_client_rejected` (sent parameter names and the sanitized detail), plus the three query results above.
8. A second 422 on the search means the title alone is still not enough for the source: the next step is to add a free-text `q` built from the title, the English keywords and the country (the catalog describes the search as «by a free-text description»); a call that ends at about 30 s means the routed search itself is too slow for one worker chunk.
