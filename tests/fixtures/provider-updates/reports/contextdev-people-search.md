# باختصار
تتيح هذه الأداة البحث عن المهنيين وصناع القرار في مختلف المجالات بكتابة وصف بسيط باللغة العادية مثل "مدراء مبيعات الطاقة الشمسية". تمنحك النتائج الاسم الكامل والمنصب واسم الشركة وموقعها وسنوات الخبرة والمهارات ورابط الحساب المهني في لينكد إن. يستفيد عميل ديجر من الوصول المباشر إلى الأشخاص المناسبين للتواصل والبيع أو التوظيف بنقرة واحدة وبأعلى دقة.

---

# Study Report: Context.dev People Search (`contextdev-people-search`)
**Provider**: Context.dev  
**Date**: 2026-11-23  
**Status**: Feature launched (October 23, 2026; Ultra mode added October 27, 2026; ZDR added November 12, 2026)  
**Sources**:
- Documentation: [https://docs.context.dev/people/search](https://docs.context.dev/people/search)
- API Reference: [https://docs.context.dev/api-reference/people/search](https://docs.context.dev/api-reference/people/search)
- Changelog: [https://docs.context.dev/changelog](https://docs.context.dev/changelog)

---

### 1. What it does
People Search discovers professionals matching a natural-language description (e.g. "VPs of sales at solar companies in California"). It searches structured and unstructured professional data, returning up to 10 candidates per page with full name, current role, employer name and domain, location, years of experience, skills, schools, and public profile links (such as LinkedIn).

### 2. Endpoint / Tool & Request Shape
- **Method**: `POST`
- **Path**: `https://api.context.dev/v1/people/search`
- **Inputs**:
  - `query` (`string`, required): Plain-language description. Max 500 characters in `fast` mode; max 5,000 characters in `ultra` mode.
  - `mode` (`string`, optional): `"fast"` (default, ~2s) or `"ultra"` (deep planner + LLM candidate scoring, up to 30s).
  - `filters` (`object`, optional):
    - `countries` (`array[string]`, optional): 2-letter ISO country codes (e.g. `["US", "SA", "AE"]`).
    - `years_of_experience_min` (`integer`, optional): Minimum years of professional experience.
    - `years_of_experience_max` (`integer`, optional): Maximum years of professional experience.
  - `cursor` (`string`, optional): Opaque cursor from `next_cursor` of the previous page. Must be passed with identical `query`, `mode`, and `filters`.
  - `zdr` (`string`, optional): `"enabled"` for Zero Data Retention (requires organization ZDR entitlement).
  - `tags` (`array[string]`, optional): Up to 20 labels (1–50 chars each) for usage analytics.

### 3. Response Shape
JSON object:
```json
{
  "results": [
    {
      "name": "Alex Morgan",
      "description": "Sales leader helping solar companies grow.",
      "profiles": ["https://www.linkedin.com/in/alex-morgan-example/"],
      "location": {
        "country_code": "US",
        "region": "California",
        "city": "San Francisco"
      },
      "role": {
        "title": "VP of Sales",
        "seniority": "executive",
        "functions": ["sales"],
        "started_on": "2023-06-01",
        "company": {
          "name": "Solstice",
          "domain": "solstice.example"
        }
      },
      "years_of_experience": 12,
      "is_founder": false,
      "skills": ["Enterprise Sales", "Sales Leadership", "Renewable Energy"],
      "schools": ["University of California, Berkeley"],
      "match": {
        "confidence": 0.94
      }
    }
  ],
  "next_cursor": "eyJhbGciOi...",
  "request_id": "3f1c2a6e-8b4d-4c1e-9f0a-2d7b5e6c8a91"
}
```
*Note*: `match.confidence` (0.0 to 1.0) is present only in `ultra` mode. Unavailable fields are `null` or empty arrays.

### 4. Pricing & Credits
- **Fast Mode**: 10 credits per page with results ($0.02 USD per page at standard Developer tier $20/10k credits; empty pages cost 0 credits).
- **Ultra Mode**: 50 credits per page with results ($0.10 USD per page; empty pages cost 0 credits).
- **Per-candidate cost**: ~$0.002 USD/candidate in fast mode (10 candidates/page).

### 5. Rate Limits & Latency
- Free tier: 2 concurrent requests, no per-minute cap.
- Paid tiers: Higher concurrency; HTTP 429 returns `Retry-After`.
- Latency: Fast mode ~2 seconds; Ultra mode up to 30 seconds.

### 6. Authentication
- Standard Bearer token in HTTP header: `Authorization: Bearer $CONTEXT_DEV_API_KEY`.

### 7. Paging
- Cursor-based pagination using `next_cursor`.
- Maximum 10 results per page; up to 1,000 candidates per search query.
- Terminate when `next_cursor` is `null` or absent.

### 8. Which Diger Customer Requests it Serves
- **Customer Request (Example)**: "ابحث لي عن مدراء التقنية والتسويق لشركات التقنية المالية في السعودية والإمارات".
- **Customer Request (Example)**: "تحديد مسؤولي المشتريات وسلاسل الإمداد في مصانع الأغذية بالرياض للتواصل التجاري B2B".
- Solves Diger's need for structured decision-maker discovery before contact enrichment, bypassing noisy unverified web scrapes.

### 9. Integration Proposal (Catalog Entry Fields)
- `id`: `contextdev.people.search`
- `provider`: `contextdev`
- `kind`: `data`
- `domain`: `contacts`
- `method`: `POST`
- `path`: `/v1/people/search`
- `cost`: `{"type": "per_result", "value": 10, "currency": "credit", "usd": 0.02, "unit": "page"}`
- `reserve`: `{"max_rows_per_call": 10, "default_rows": 10}`
- `capabilities`: `["people.search", "professional.discovery"]`

### 10. Open Questions
1. Does Context.dev's underlying profile corpus cover Arabic-language LinkedIn profiles and local GCC corporate titles accurately?
2. Can `profiles` output URLs (LinkedIn) be chained losslessly into Diger's TREG contact endpoints (`treg.people.email.find` / `forager.people.enrich`) without intermediate scraping?
