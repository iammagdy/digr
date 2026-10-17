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
