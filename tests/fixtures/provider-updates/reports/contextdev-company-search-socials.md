# باختصار
تم تحديث نتائج البحث عن الشركات لتتضمن تلقائياً روابط حسابات الشركة الرسمية على منصات التواصل مثل لينكد إن وإكس وكرانش بيس. تمنح العميل روابط موثوقة ومباشرة للوصول السريع إلى صفحات الشركات وقنواتها الرسمية ومتابعة أخبارها. يستفيد عميل ديجر من متابعة نشاط الشركات والتواصل معها عبر منصاتها المفضلة دون بحث يدوي.

---

# Study Report: Context.dev Company Search Social Links Enhancement (`contextdev-company-search-socials`)
**Provider**: Context.dev  
**Date**: 2026-11-23  
**Status**: Changelog update (November 2026)  
**Sources**:
- Documentation: [https://docs.context.dev/companies/search](https://docs.context.dev/companies/search)
- Changelog: [https://docs.context.dev/changelog](https://docs.context.dev/changelog)

---

### 1. What it does
Enhances company search response items to automatically return verified links to company official social media pages (LinkedIn, X/Twitter, Crunchbase, GitHub) directly within each company record.

### 2. Endpoint / Tool & Request Shape
- **Method**: `POST`
- **Path**: `https://api.context.dev/v1/companies/search`
- **Inputs**:
  - `query` (`string`, required): Plain-text company description or criteria.
  - `filters` (`object`, optional): Country, industry, headcount range.

### 3. Response Shape
Each company item now includes:
```json
"social_profiles": {
  "linkedin_url": "https://www.linkedin.com/company/...",
  "twitter_url": "https://x.com/...",
  "crunchbase_url": "https://www.crunchbase.com/organization/...",
  "github_url": "https://github.com/..."
}
```

### 4. Pricing & Credits
- 10 credits ($0.02 USD) per results page (up to 10 companies).
- No surcharge for the additional social profile fields.

### 5. Rate Limits & Concurrency
- 60 requests per minute (RPM).

### 6. Authentication
- `Authorization: Bearer $CONTEXT_DEV_API_KEY`.

### 7. Paging
- Standard cursor-based pagination.

### 8. Which Diger Customer Requests it Serves
- **Customer Request (Example)**: "جلب حسابات إكس ولينكد إن للشركات الناشئة في مجال الطاقة المتجددة لمتابعة إعلاناتها".
- **Customer Request (Example)**: "تأكيد الهوية الرقمية للشركات الموردة وربطها بأنظمة CRM".

### 9. Integration Proposal (Catalog Entry Fields)
- Updates `contextdev.companies.search` output schema mapping in Diger pipeline to auto-populate social channel fields.

### 10. Open Questions
1. What percentage of SMB records have complete social profile links?
