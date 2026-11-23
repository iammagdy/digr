# باختصار
ميزة أمان تضمن عدم تخزين أو حفظ أي استعلامات بحث أو نتائج لدى خوادم المزود نهائياً فور اكتمال الطلب. توفر حماية تامة لبيانات البحث الحساسة وأسماء الشركات أو الأشخاص المستهدفين لمنع تتبعها. يستفيد عميل ديجر من الالتزام التام بمعايير الخصوصية والأمان وحماية استراتيجياته وأبحاثه من أي تسريب.

---

# Study Report: Context.dev Zero Data Retention (`contextdev-zero-data-retention`)
**Provider**: Context.dev  
**Date**: 2026-11-23  
**Status**: Feature released (November 12, 2026)  
**Sources**:
- Documentation: [https://docs.context.dev/optimization/zero-data-retention](https://docs.context.dev/optimization/zero-data-retention)
- Changelog: [https://docs.context.dev/changelog](https://docs.context.dev/changelog)

---

### 1. What it does
Provides a strict privacy compliance guarantee where queries, search filters, and returned payload results are never logged, stored, or retained on Context.dev disk storage or telemetry databases after request transmission.

### 2. Endpoint / Tool & Request Shape
- **Scope**: Applicable to all Context.dev v1 endpoints (`/v1/people/search`, `/v1/people/enrich`, `/v1/companies/search`, `/v1/companies/enrich`).
- **Activation**:
  - Request body field: `"zdr": "enabled"` (or boolean `true`).
  - Or HTTP Header: `X-Context-ZDR: 1`.

### 3. Response Shape
Identical to standard endpoint response schemas, with response header confirmation:
`X-Context-ZDR-Active: true`.

### 4. Pricing & Credits
- **Cost**: Free ($0.00 USD). No extra charge or credit multiplier for activating ZDR.

### 5. Rate Limits & Concurrency
- Standard rate limits apply unchanged.

### 6. Authentication
- Same Bearer token as base endpoints.

### 7. Paging
- Compatible with standard pagination cursors.

### 8. Which Diger Customer Requests it Serves
- **Customer Request (Example)**: "البحث عن مسؤولي أمن سيبراني لعميل قطاع بنكي يشترط عدم حفظ سجلات البحث خارج المملكة".
- **Customer Request (Example)**: "استعلامات التنافسية التجارية الحساسة لشركات مدرجة في البورصة".

### 9. Integration Proposal (Catalog Entry Fields)
- `feature`: `zero_data_retention`
- `provider`: `contextdev`
- `default_setting`: `enabled` across Diger internal workflows for enterprise security compliance.

### 10. Open Questions
1. Does ZDR disable caching, and does repeated querying with ZDR incur full credit costs on identical queries?
