# Digr Glossary

Canonical terminology. Use these terms exactly as defined. Do not invent
synonyms in code, documents, or customer-facing text.

## Canonical keywords

| Term                  | Meaning                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| POINTS                | The platform's internal billing unit. 1 point = 0.10 EGP.                               |
| AVAILABLE_BALANCE     | Points the customer can currently spend. Computed server-side from the ledger.          |
| RESERVED_POINTS       | Points locked by an approved quote while a job is prepared or running.                  |
| QUOTE                 | A server-generated, expiring price offer for a plan (30-minute expiry).                 |
| PLAN_HASH             | SHA-256 hash binding a quote to the exact approved plan content.                        |
| USER_APPROVAL         | The customer's explicit confirmation that starts spending (e.g. clicking "Start").      |
| CAPABILITY            | A data-collection ability the platform offers (e.g. `tiktok-profile`).                  |
| TEMPLATE              | A reusable research blueprint the assistant can propose.                                |
| JOB                   | One approved, priced execution of a plan.                                               |
| ACTIVITY_EVENT        | A server-side execution event recording what the job is doing right now.                |
| COLLECTED_COUNT       | Records actually collected so far (never estimated).                                    |
| AVAILABLE_COUNT       | Records the provider reports as available for the query.                                |
| DATA_COVERAGE         | Honest reporting of what was collected vs requested vs available.                        |
| CHARGE                | The final ledger debit after a job completes (`chg_<jobId>`, never exceeds reserved).   |
| RELEASE               | The ledger credit returning reserved points (`rel_<jobId>`), before the final charge.   |
| GOODWILL_ADJUSTMENT   | A bounded, code-ruled courtesy credit (`gwl_<jobId>`). The AI never decides it freely.  |
| FAKE_MODE             | Development mode: AI and data calls are simulated. Production default until go-live.     |
| LIVE_MODE             | Production mode with real AI/data calls. Requires explicit owner approval and caps.      |
| WHITE_LABEL           | The rule that customer surfaces never reveal providers, costs, or margins.              |
| SERVER_ONLY           | Logic or data that must live server-side (pricing, ledger, secrets, provider calls).   |

## Financial transaction IDs

| ID pattern     | Meaning                                  |
| -------------- | ---------------------------------------- |
| `res_<jobId>`  | Points reserved when a quote is approved. |
| `rel_<jobId>`  | Reserved points released after the job.   |
| `chg_<jobId>`  | Final charge debited after release.       |
| `top_<topupId>`| Points credited from an approved top-up.  |
| `gwl_<jobId>`  | Goodwill adjustment credit (code-ruled).  |

## Approved Arabic customer-facing terminology

Use these Arabic terms in the UI. Do not expose the English internal
keywords to customers.

| Internal term      | Arabic customer term |
| ------------------ | -------------------- |
| POINTS             | النقاط               |
| AVAILABLE_BALANCE  | الرصيد المتاح        |
| QUOTE              | عرض السعر            |
| PLAN               | خطة البحث            |
| USER_APPROVAL      | تأكيد البدء          |
| JOB                | مهمة البحث           |
| DATA_COVERAGE      | تغطية البيانات       |
| TOP-UP             | شحن الرصيد           |
| DELIVERABLE        | ملف النتائج          |
| METHODOLOGY        | المنهجية             |

Never show customers: provider names, internal costs, margins, endpoint
identifiers, ledger internals, or transaction ID patterns.
