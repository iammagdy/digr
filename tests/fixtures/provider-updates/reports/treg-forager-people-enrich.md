# باختصار
تتيح هذه الخدمة سحب الملف المهني والوظيفي المتكامل للشخص عبر معرّف حسابه على لينكد إن. تقدم سجلاً كاملاً يشمل المسمى الحالي والشركات السابقة وسنوات الخبرة والمؤهلات واللغات والمهارات. يستفيد عميل ديجر من فحص خلفية المرشحين والمؤسسين والتحقق من مصداقية السير الذاتية بتكلفة منخفضة ومضمونة.

---

# Study Report: TREG Forager People Profile Enrichment (`forager.people.enrich`)
**Provider**: TREG (Vendor: Forager)  
**Date**: 2026-11-23  
**Status**: Newly added to TREG catalog (November 23, 2026)  
**Sources**:
- TREG Catalog Endpoint: [https://treg.to/catalog/endpoints/forager.people.enrich](https://treg.to/catalog/endpoints/forager.people.enrich)
- Forager Official Documentation: [https://docs.forager.ai/openapi.md](https://docs.forager.ai/openapi.md)
- Forager Credit Pricing: [https://docs.forager.ai/api-overview/credit-pricing](https://docs.forager.ai/api-overview/credit-pricing)

---

### 1. What it does
Fetches a person's complete professional profile using their LinkedIn public identifier (vanity slug) or a Forager person ID. Returns headline, location, skills, full role and employer history, education, certifications, languages, patents, and projects.

### 2. Endpoint / Tool & Request Shape
- **Method**: `POST`
- **Path**: `/api/{account_id}/datastorage/person_detail_lookup/` (routed through TREG: `POST https://treg.to/call/forager.people.enrich`)
- **Inputs**:
  - `linkedin_public_identifier` (`string`, optional): The slug from `linkedin.com/in/<slug>/` (e.g. `"williamhgates"`).
  - `person_id` (`integer`, optional): ID obtained from a previous Forager search or lookup.
  - *Note*: Send exactly one of `linkedin_public_identifier` or `person_id`.

### 3. Response Shape
JSON object containing:
- `full_name`, `headline`, `location`
- `skills` (`array[string]`)
- `experience` / `roles` (`array` of objects with title, employer, dates, description)
- `education` (`array` of objects with school, degree, dates)
- `certifications`, `languages`, `patents`, `projects`

### 4. Pricing & Credits
- **Billing Model**: `per_success` (only charged when a matching person is found).
- **Cost**: 1 credit = $0.01333 USD per found person.
- **Miss (404)**: Free ($0.00 USD). Live probes verified no credit spent on 404.

### 5. Rate Limits & Reliability (TREG Measured)
- Samples measured: 72
- OK rate: 100.0%
- Hit rate: 77.78% (72 samples)
- Latency: P50 = 361 ms, P95 = 469 ms.

### 6. Authentication
- TREG Bearer token in HTTP header: `Authorization: Bearer <TREG_TOKEN>`. No direct Forager account or key required.

### 7. Paging
- N/A (Single-record enrichment endpoint).

### 8. Which Diger Customer Requests it Serves
- **Customer Request (Example)**: "إثراء ملف صانع القرار في شركة ما بعد الحصول على رابط حسابه على لينكد إن لمعرفة سنوات خبرته والمناصب السابقة".
- **Customer Request (Example)**: "فحص الخلفية التعليمية والمهنية لمؤسسي الشركات الناشئة المتقدمة لطلب استثمار".

### 9. Integration Proposal (Catalog Entry Fields)
- `id`: `forager.people.enrich`
- `provider`: `forager`
- `platform`: `people`
- `kind`: `data`
- `domain`: `contacts`
- `method`: `POST`
- `cost_usd`: 0.01333
- `type`: `per_success`
- `miss_status`: [404]
- `capabilities`: `["people.enrich"]`

### 10. Open Questions
1. Does Forager have coverage parity for Arabic names and GCC regional employment histories compared to PDL and Crustdata?
2. What is the cache TTL on Forager profiles?
