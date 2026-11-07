# Digr Product

Product goals and feature intentions. Each feature is labeled
IMPLEMENTED (in the product today) or PROPOSED (planned, not built).
Never confuse the two.

Implementation labels below follow the owner's foundation report and
`docs/HANDOFF.md`; per-feature independent verification is tracked in
`Project Atlas/CURRENT_STATE.md`.

## User personas (PROPOSED — to be validated)

Students, researchers, professors, statisticians, analysts, marketers,
and content creators who need trustworthy public-data research with
clear methodology and honest coverage.

## Features

### Research discovery (IMPLEMENTED — foundation)
The AI assistant asks discovery questions to understand the research
requirement before proposing anything.

### Editable plans (IMPLEMENTED — foundation)
The assistant prepares a data-collection plan the customer can review
and edit before approval. Edits go through the typed `edit_plan`
schema and are validated server-side.

### Research templates (IMPLEMENTED — foundation)
Reusable research blueprints the assistant can propose. Registry:
`templates` (+ `templates_private` server-only).

### Capability catalog (IMPLEMENTED — partial)
A registry of data-collection capabilities (`capability_registry`).
Only `tiktok-profile` is verified active; other capabilities are
marked "coming soon" pending reliability testing and real-cost
benchmarking. New capabilities are added incrementally.

### Points-based pricing (IMPLEMENTED)
1 point = 0.10 EGP. Server-generated expiring quotes, explicit user
approval before spend, append-only ledger. See
`Project Atlas/GOVERNANCE.md` §2.

### Activity Canvas (PROPOSED)
Intended real-time view: current stage, active query, source/platform,
items discovered, item in progress, pagination progress, per-batch
records, unique totals, requested vs delivered, balances, errors and
partial results. All data must come from actual server-side execution
events — never fabricated, never estimated-as-collected, never
showing internal costs. History must persist across sessions.

### Result review (IMPLEMENTED — foundation; extended in PR #5 PROPOSED)
Customers review results and request corrections. Distinguish free
fixes to existing data from paid new collection.

### Research deliverables (IMPLEMENTED — foundation)
Excel, CSV, and PDF outputs with methodology notes, source
information, and honest data-quality reporting. Generated
server-side; stored in the `results` bucket.

## White-label rule (IMPLEMENTED — mandatory)

Customer-facing content is Arabic-first and never exposes upstream
provider identities, credentials, internal costs, profit margins, or
endpoint identifiers.
