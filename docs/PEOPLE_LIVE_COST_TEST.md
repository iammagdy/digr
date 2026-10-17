# Decision-maker live cost test

Date: 2026-10-17 (UTC accounting day)

## Outcome

**NOT RUN — no TREG provider call was made.** Path A (the signed-in Preview product flow) was used. The request reached the chat, but the product returned no plan or quote card, so there was no approval action and no worker/provider execution. The UI response was: `تعذر إعداد خطة تسعير دقيقة للطلب بالبيانات المتاحة. يمكنك إعادة صياغة الطلب أو تحديد إحدى المنصات المعتمدة (فيسبوك، لينكد إن، إكس، يوتيوب).`

The deployment's code requires `settle_people_job_atomic` before it builds a decision-maker quote. A read-only query of `pg_proc` returned `[]` for that function. This is consistent with the product guard blocking the flow, though the generic UI error does not prove which internal check produced that message. File 6 was not applied. No approve button appeared and none was clicked.

## Attempted product request

Exact request: `أريد ٣ صناع قرار، مديرين أو أعلى، في شركات كهروميكانيكية في مصر، مع البريد الإلكتروني المهني ورقم الهاتف المكتبي لكل شخص.`

The request was submitted once in the authenticated Preview at `https://diger-qa3xdt3au-iam-magdy.vercel.app/dashboard/chat`. An immediate post-submit accessibility snapshot took 379 ms; this is UI action timing only, not full response latency. The final response was observed later; total end-to-end response time was not measured.

## Provider-call evidence

| Call | Endpoint id | Exact provider request parameters | HTTP status | Latency | Provider-reported cost field/value | Child provider | Data returned |
|---|---|---|---|---|---|---|---|
| No call | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

Provider calls: **0**. People returned: **0**. Per-person field presence and cost: **NOT RUN**. No response cost field or child-provider result existed to inspect. No empty or refused provider call occurred, so its cost is **NOT RUN**.

## Spend and price comparison

The post-attempt read-only query returned the following raw rows:

```json
[{"provider":"llm","utc_day_start":"2026-10-17 00:00:00","today_spend_usd":"0.516586","daily_cap_usd":"0.800000","remaining_usd":"0.283414"},{"provider":"treg","utc_day_start":"2026-10-17 00:00:00","today_spend_usd":"0.007300","daily_cap_usd":"0.800000","remaining_usd":"0.792700"}]
```

TREG spend before this attempt was `$0.007300`; after it remained `$0.007300`. Incremental TREG spend: **$0.000000**. Remaining TREG daily budget: **$0.792700**. This test's cost per person, average, search/email/phone split, email/phone coverage, and price-to-cost ratios are **NOT RUN** because there were no provider calls or returned people. The code prices supplied for comparison (83 base points, 55 work-email points, 55 phone points; 5,500 points/USD) cannot be compared to measured field costs without provider results.

## Read-only readiness evidence

The function-presence query was:

```sql
SELECT n.nspname AS schema_name, p.proname AS function_name, p.oid::regprocedure AS signature
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'settle_people_job_atomic'
ORDER BY p.oid;
```

Raw result: `[]`.

No database writes, quote approvals, job executions, migrations, or direct provider requests were made.

## Follow-up database inspection — 2026-10-17 19:22 UTC

The owner later reported that a decision-makers request had been approved. This follow-up used read-only SQL only. It found **no decision-makers job** in the live database at inspection time. The latest decision-makers quote found was still `quoted`, and its derived job, ledger, and provider-cost queries all returned empty arrays. No approval was submitted from this inspection.

The latest matching quote row had quote id `3a4972a9cbd04cb9a4f1`, status `quoted`, `total_reserved_credits=600`, endpoint `treg.people.search`, requested limit `3`, country `EG`, requested fields `work_email` and `phone`, and unit prices `{basePerson:83, workEmail:55, phone:55}`. The associated `user_id` is omitted from this report. The account comparison against the previously specified test-account identity returned `false`; therefore this quote was not approved or executed by this agent.

The plan arithmetic is `3 × (83 + 55 + 55) = 579` points. The 15% reserve would be `ceil(579 × 1.15) = ceil(665.85) = 666`, reduced by the 600-point cap to a 600-point quote reserve. Since there is no job, actual delivered field counts, settled charge, and release are **NOT RUN / NOT APPLICABLE**; no actual charge or release can be reported.

### Raw read-only query results

Latest jobs using the decision-makers endpoint:

```json
[]
```

Job row for the latest decision-makers quote's deterministic job id (`job_quote_` + `md5(quote id)`):

```json
[]
```

All ledger rows for that derived job id:

```json
[]
```

All provider-cost rows for that derived job id:

```json
[]
```

The quote inspection result, with the account UUID omitted:

```json
[{"quote_id":"3a4972a9cbd04cb9a4f1","status":"quoted","total_reserved_credits":"600","is_known_test_account":false,"endpoint_id":"treg.people.search","required_contact_fields":["work_email","phone"],"unit_prices":{"phone":55,"workEmail":55,"basePerson":83},"requested_limit":"3","country":"EG","created_at":"2026-10-17 19:10:17.15971+00","job_exists":false,"ledger_balance":"808"}]
```

### Delivery and cost result

- Provider calls and recorded cost for this quote: **NOT FOUND**. No provider-cost row exists for its derived job id, so the recorded provider cost is unavailable rather than assumed to be zero.
- People, field presence, verification statuses, email/phone shares, per-call costs, and price-to-real-cost comparison: **NOT RUN** because no job or provider result exists.
- Excel download and inspection: **NOT RUN** because the quote has no job and no result file.
- Reserve/charge/release ledger arithmetic: **no ledger rows**; no reserve, charge, or release transaction is associated with this quote.

No data rows were written, no provider endpoint was called directly, and no UI controls were used during this follow-up.
