# باختصار
تتيح البحث وتصفية الكفاءات والخبراء حسب المسمى الوظيفي والشركة والمهارات والموقع الجغرافي. تعيد قائمة بالمرشحين المطابقين مع روابط حساباتهم ومعرفاتهم الخاصة لتمكين التواصل معهم. يستفيد عميل ديجر من بناء قوائم عملاء مستهدفين وفرق عمل مؤهلة بدقة عالية ودون دفع أي تكلفة على النتائج الفارغة.

---

# Study Report: TREG Forager People Search (`forager.people.search`)
**Provider**: TREG (Vendor: Forager)  
**Date**: 2026-11-23  
**Status**: Added to TREG catalog (November 23, 2026)  
**Sources**:
- TREG Catalog Endpoint: [https://treg.to/catalog/endpoints/forager.people.search](https://treg.to/catalog/endpoints/forager.people.search)
- Forager Official Documentation: [https://docs.forager.ai/openapi.md](https://docs.forager.ai/openapi.md)

---

### 1. What it does
Searches professional candidates by job title, company name, skills, and geographic region. Returns matching individuals with Forager person IDs, current job headlines, and public LinkedIn slugs.

### 2. Endpoint / Tool & Request Shape
- **Method**: `POST`
- **Path**: `https://treg.to/call/forager.people.search`
- **Inputs**:
  - `job_title` (`string`, optional): Targeted role (e.g. `"VP Sales"`).
  - `company` (`string`, optional): Target company name or domain.
  - `skills` (`array[string]`, optional): Required technical or functional skills.
  - `location` (`string`, optional): Country or city filter.
  - `limit` (`integer`, optional): Page size (default 10, max 50).
  - `page` (`integer`, optional): Page number.

### 3. Response Shape
JSON object containing:
- `total_results` (`integer`)
- `page` (`integer`)
- `results` (`array` of candidate objects with `person_id`, `full_name`, `headline`, `linkedin_public_identifier`, `location`)

### 4. Pricing & Credits
- **Cost**: 1 credit ($0.01333 USD) per returned candidate match.
- **Empty / 0 matches**: 0 credits ($0.00 USD).

### 5. Rate Limits & Reliability
- TREG managed gateway limits.
- OK rate: 100%, hit rate: ~78%, latency P50 ~380ms.

### 6. Authentication
- TREG Bearer token: `Authorization: Bearer <TREG_TOKEN>`.

### 7. Paging
- Standard numeric `page` and `limit`.

### 8. Which Diger Customer Requests it Serves
- **Customer Request (Example)**: "استخراج قائمة مهندسي أمن معلومات في دبي للتواصل معهم لعرض وظائف".
- **Customer Request (Example)**: "حصر مدراء الحسابات في شركات تقنية محددة لبناء شراكات".

### 9. Integration Proposal (Catalog Entry Fields)
- `id`: `forager.people.search`
- `provider`: `forager`
- `platform`: `people`
- `kind`: `data`
- `domain`: `contacts`
- `method`: `POST`
- `cost_usd`: 0.01333
- `type`: `per_success`
- `capabilities`: `["people.search"]`

### 10. Open Questions
1. Can Forager search results be seamlessly piped into `forager.people.enrich` by `person_id` without external API calls?
