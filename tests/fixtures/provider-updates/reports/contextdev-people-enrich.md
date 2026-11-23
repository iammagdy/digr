# باختصار
تتيح هذه الميزة جلب السيرة المهنية الكاملة لأي شخص بمجرد تزويدها برابط حسابه على لينكد إن. توفر بيانات تفصيلية تشمل المنصب الحالي وتاريخ الخبرات الوظيفية السابقة والشهادات والجامعات والمهارات واللغات. يستفيد عميل ديجر من تحديث بيانات العملاء والشركاء المحتملين والتحقق من خبراتهم قبل الاجتماعات والتفاوض.

---

# Study Report: Context.dev People Profile Enrichment (`contextdev-people-enrich`)
**Provider**: Context.dev  
**Date**: 2026-11-23  
**Status**: Feature live in official docs (November 2026)  
**Sources**:
- Documentation: [https://docs.context.dev/people/enrich](https://docs.context.dev/people/enrich)
- API Reference: [https://docs.context.dev/api-reference/people/enrich](https://docs.context.dev/api-reference/people/enrich)
- Changelog: [https://docs.context.dev/changelog](https://docs.context.dev/changelog)

---

### 1. What it does
Fetches full career and background profile data for an individual using their LinkedIn profile URL or Context person identifier. Returns structured current employment, historical employment timeline, education history, certified skills, and contact handles.

### 2. Endpoint / Tool & Request Shape
- **Method**: `POST`
- **Path**: `https://api.context.dev/v1/people/enrich`
- **Inputs**:
  - `profile_url` (`string`, required): Full public profile URL (e.g. `https://www.linkedin.com/in/satyanadella`).
  - `zdr` (`string`, optional): `"enabled"` to enforce Zero Data Retention on this lookup.

### 3. Response Shape
JSON object containing:
- `full_name` (`string`)
- `current_headline` (`string`)
- `location` (`object`: city, country, region)
- `current_company` (`object`: name, domain, title, start_date)
- `experience` (`array` of employment records with company, role, duration, achievements)
- `education` (`array` of school, degree, dates)
- `skills` (`array[string]`)
- `social_profiles` (`object` with available links)

### 4. Pricing & Credits
- **Billing**: 10 credits ($0.02 USD) per found profile on standard Developer tier.
- **Miss (404 / Not Found)**: 0 credits ($0.00 USD).

### 5. Rate Limits & Concurrency
- Standard tier: 60 requests per minute (RPM).
- Concurrency limit: 5 concurrent in-flight calls.

### 6. Authentication
- Bearer API Key in header: `Authorization: Bearer $CONTEXT_DEV_API_KEY`.

### 7. Paging
- N/A (Single-record enrichment endpoint).

### 8. Which Diger Customer Requests it Serves
- **Customer Request (Example)**: "فحص السيرة الذاتية المفصلة للرئيس التنفيذي للشركة المستهدفة قبل بدء محادثات الاستحواذ".
- **Customer Request (Example)**: "التحقق من صحة الخبرات السابقة للمرشحين للوظائف القيادية في ديجر".

### 9. Integration Proposal (Catalog Entry Fields)
- `id`: `contextdev.people.enrich`
- `provider`: `contextdev`
- `kind`: `data`
- `domain`: `contacts`
- `method`: `POST`
- `path`: `/v1/people/enrich`
- `cost_usd`: 0.02
- `capabilities`: `["people.enrich"]`

### 10. Open Questions
1. Does enrichment update dynamically from live profile crawls or rely purely on cached index snapshots?
2. How does Context.dev handle localized non-English profile texts?
