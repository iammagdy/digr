# باختصار
تتيح هذه الميزة البحث عن المرشحين والكفاءات المهنية ومطابقتهم مع متطلبات الوظيفة تلقائياً، مع صياغة رسائل تواصل مخصصة وموجهة بناءً على ما ينشره المرشح علناً. توفر بيانات الاسم الكامل والمسمى الوظيفي والشركة الحالية ونبذة من منشورات المرشح وإمكانية استخراج البريد المهني. يستفيد عميل ديجر من توظيف الكفاءات أو استقطاب الشركاء التجاريين بسرعة ودقة عالية دون استنزاف الوقت في جمع البيانات والتواصل اليدوي.

---

# Study Report: Firecrawl Alexandria Recruiting Tools (`firecrawl-recruiting-tools`)
**Provider**: Firecrawl  
**Date**: 2026-11-23  
**Status**: Feature announced and live (November 23, 2026)  
**Sources**:
- Official Changelog: [https://www.firecrawl.dev/changelog/recruiting-tools](https://www.firecrawl.dev/changelog/recruiting-tools)
- Alexandria Portal: [https://alexandria.firecrawl.dev/go/recruiting](https://alexandria.firecrawl.dev/go/recruiting)
- Agent Onboarding Skill: [https://www.firecrawl.dev/agent-onboarding/SKILL.md](https://www.firecrawl.dev/agent-onboarding/SKILL.md)

---

### 1. What it does
Candidate search and automated outreach generation powered by the Firecrawl Alexandria dataset index (250M+ candidates across 26M+ companies). It allows AI agents, LLM harnesses (ChatGPT, Claude, Cursor, Grok, OpenClaw), and automations to search for candidates matching specific job descriptions and draft tailored outreach based on what candidates publish online.

### 2. Endpoint / Tool & Request Shape
- **Interface**: Firecrawl Alexandria Plugin, MCP v3 server, and REST search endpoint.
- **Method**: `POST`
- **Path**: `https://api.firecrawl.dev/v2/search` (Alexandria recruiting tools capability)
- **Inputs**:
  - `query` (`string`, required): Natural-language candidate requirement (e.g. role, industry, technologies, location).
  - `limit` (`integer`, optional): Number of candidate records to retrieve (default/max: «غير معروف» via web UI; API standard 10–50).
  - `generate_outreach` (`boolean`, optional): Whether to synthesize contextual outreach messages from candidate web/social activity.
  - `filters` (`object`, optional): Specific company, location, or seniority constraints: «غير معروف».

### 3. Response Shape
Candidate object containing:
- Candidate full name and professional headline.
- Current employer and job title.
- Summary of recent online posts/publications.
- Draft outreach message customized to the candidate's public activity.
- Work email availability flag (profile + work email per contact).

### 4. Pricing & Credits
- **Benchmark Claim**: "88% less than Clay at scale (Profile + work email per contact vs. Clay Launch's typical 6-credit record, annual list prices, Nov 2026)".
- **Exact Credit Deduction on Firecrawl API**: «غير معروف» (announced through Alexandria plugin/connector; standalone per-call credit rate for REST API has not yet been itemized in v2-openapi.json).

### 5. Rate Limits & Concurrency
- Governed by Firecrawl team plan limits (`/team/credit-usage` and `/team/queue-status`).

### 6. Authentication
- Standard API Key via `Authorization: Bearer $FIRECRAWL_API_KEY`, or WorkOS ID-JAG token via `https://www.firecrawl.dev/auth.md`.

### 7. Paging
- Standard Firecrawl cursor/offset pagination.

### 8. Which Diger Customer Requests it Serves
- **Customer Request (Example)**: "ابحث عن مهندسي ذكاء اصطناعي متخصصين في استخراج البيانات ولديهم إسهامات مفتوحة المصدر، مع كتابة رسائل استقطاب مخصصة لكل مرشح".
- **Customer Request (Example)**: "استخراج قائمة بمسؤولي المبيعات في شركات التجارة الإلكترونية مع رسائل تقديمية مخصصة بناءً على نشاطهم الأخير".

### 9. Integration Proposal (Catalog Entry Fields)
- `id`: `firecrawl.alexandria.recruiting`
- `provider`: `firecrawl`
- `kind`: `data`
- `domain`: `recruiting`
- `status`: `evaluating`
- `note`: "Requires clarification on direct headless REST API pricing vs ChatGPT/Claude plugin connector."

### 10. Open Questions
1. Is candidate data accessible purely via headless REST API with standard JSON output without requiring the ChatGPT/Claude plugin wrapper?
2. Does the 88% cheaper pricing versus Clay apply to credits on standard Firecrawl API plans, or does it require an Alexandria Enterprise add-on?
