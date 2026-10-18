# Published people and contact pricing facts

Accessed 2026-10-17. This is a read-only snapshot of public treg.to catalog GET endpoints and public use-case pages. No provider credentials were used and no provider data endpoint was called. Prices are the public catalog's USD values, before Diger's conversion. Catalog values and availability may change.

## Endpoints used by Diger

Code references: `src/functions/shared/planManager.ts` calls `getEndpointDetails` for `treg.people.search`, `treg.people.email.find`, and `treg.people.phone.find` when building decision-maker prices. `src/lib/server/tregAdapter.ts` uses the email and phone routes and sets `routeMaxCostUsd: "0.005"` on both; the people search route also receives a `$0.005` route cap in the provider call path. These are catalog lookups / server calls, not browser calls.

| Service | Endpoint ID | What it returns | Published price model and child-price distribution (USD) | Aggregate success / latency | Pagination or page-size limit | Source |
|---|---|---|---|---|---|---|
| People search (base person record) | `treg.people.search` | Provider-native people rows matching description, company/domain, title, country or location; the route does not promise email/phone | Routed, variable; 26 configured children. Min `$0`, median `$0.01075`, max `$3.00` per configured child unit (median is the middle of the 26 route-plan prices). Aggregate catalog cost is marked inferred/variable; misses may also cost money. | 91.10% route request success (1,588,856 samples); aggregate p50/p95 NOT FOUND. Child metrics below. | `limit` defaults to 10; route metadata does not publish one global maximum. Child limits differ. | [public endpoint catalog](https://treg.to/catalog/endpoints/treg.people.search), [people search comparison](https://treg.to/use-cases/people-search) |
| Work-email finder | `treg.people.email.find` | A person's work email, when found | Routed, variable; 25 configured children. Min `$0.000495`, median `$0.02258`, max `$0.15` per configured child unit. Catalog note: misses can incur child charges; default route ceiling is `$1`. | 93.17% route request success (2,141,657 samples); aggregate p50/p95 NOT FOUND. Child metrics below. | No route-level page-size field published; this is an identity lookup request. | [public endpoint catalog](https://treg.to/catalog/endpoints/treg.people.email.find), [email-finder comparison](https://treg.to/use-cases/find-professional-emails) |
| Phone finder | `treg.people.phone.find` | A person's direct/business phone where found; the response can include line type/country code | Routed, variable; 15 configured children. Min `$0.000495`, median `$0.15`, max `$0.7488` per configured child unit. Catalog note says misses are billed by zero of the 15 children; the successful child is charged. | 89.56% route request success (772,073 samples); aggregate p50/p95 NOT FOUND. Child metrics below. | No route-level page-size field published; this is an identity lookup request. | [public endpoint catalog](https://treg.to/catalog/endpoints/treg.people.phone.find), [phone-finder comparison](https://treg.to/use-cases/find-phone-numbers) |

“Success” is the catalog's operational 2xx/timeout measure, not the chance of finding a person/contact. `hit` below is the measured hit/match rate. They are separate measures. Route `works` is the per-child operational success measure. Child median latency is catalog observed p50 in milliseconds; `—` means the catalog did not publish a value. The configured child list below comes from each routed endpoint's public `routing.plan`; additional endpoints shown under `routing.also` are not in that route plan and are excluded from the distribution above.

### `treg.people.search` configured child routes

| Child endpoint | Price USD | Hit rate | Works | p50 ms |
|---|---:|---:|---:|---:|
| `quickenrich.people.search` | 0 | 59.22% | 99.98% | 80 |
| `leadsforge.people.search` | 0 | 34.40% | 99.90% | 522 |
| `dropleads.people.search` | 0 | 23.73% | 96.49% | 2343 |
| `blitzapi.people.search` | 0.000495 | 94.43% | 100% | 554 |
| `icypeas.people.search` | 0.00038 | 39.53% | 100% | 594 |
| `aviato.people.search.simple` | 0.0025 | 70.24% | 99.95% | 656 |
| `aviato.people.search` | 0.0025 | 61.20% | 99.54% | 791 |
| `aiark.people.search` | 0.002634 | 20.63% | 99.82% | 553 |
| `parallel.people.search` | 0.005 | 90.95% | 99.91% | 1943 |
| `leadmagic.x.employee-finder` | 0.00125 | 21.81% | 98.42% | 802 |
| `exa.people.search` | 0.007 | 99.42% | 99.90% | 1724 |
| `quickenrich.people.search.domain` | 0.004834 | 39.18% | 99.95% | 64 |
| `wiza.people.search` | 0.0125 | 94.19% | 100% | 468 |
| `prospeo.people.search` | 0.0245 | 100% | 99.99% | 366 |
| `crustdata.people.search` | 0.009 | 31.34% | 99.97% | 414 |
| `findymail.search.domain` | 0.0198 | 44.40% | 99.21% | 4572 |
| `leadmagic.x.role-finder` | 0.05 | 22.96% | 77.45% | 1927 |
| `hunter.companies.emails` | 0.0245 | 36.39% | 99.98% | 270 |
| `findymail.search.employees` | 0.0198 | 25.50% | 98.43% | 7937 |
| `fiber-ai.people.search` | 0.02 | 20.21% | 96.17% | 860 |
| `lusha.people.search` | 0.1248 | 76.44% | 100% | 674 |
| `companyenrich.people.search` | 0.0196 | 7.98% | 99.99% | 296 |
| `leadmagic.people.search` | 0.025 | 8.73% | 99.91% | 1674 |
| `harvestapi.linkedin.leads.search` | 2.50 | 93.79% | 99.96% | 3736 |
| `enrichlayer.people.search` | 3.00 | 46.39% | 100% | 955 |
| `oceanio.people.search` | 1.62 | 6.55% | 100% | 447 |

### `treg.people.email.find` configured child routes

| Child endpoint | Price USD | Hit rate | Works | p50 ms |
|---|---:|---:|---:|---:|
| `blitzapi.people.email.find` | 0.000495 | 38.28% | 99.99% | 434 |
| `quickenrich.people.email.find` | 0.004834 | 32.40% | 99.95% | 68 |
| `trykitt.people.email.find` | 0.005 | 37.72% | 99.95% | 3809 |
| `aiark.people.email.find` | 0.005267 | 24.19% | 99.44% | 1822 |
| `tomba.people.email.find` | 0.0089 | 20.06% | 99.78% | 5617 |
| `tomba.people.email.find.linkedin` | 0.0089 | 37.84% | 99.52% | 7437 |
| `moltsets.people.email.find.name` | 0.01 | 8.08% | 99.99% | 41 |
| `dropleads.people.email.find` | 0.018 | 21.78% | 99.67% | 2195 |
| `findymail.search.business-profile` | 0.0198 | 24.83% | 99.86% | 3083 |
| `findymail.search.name` | 0.0198 | 13.23% | 99.95% | 3552 |
| `limadata.people.email.find.name` | 0.02 | 100% | 99.80% | 251 |
| `datagma.people.email.find` | 0.02258 | 3.34% | 99.98% | 7138 |
| `prospeo.people.email.find` | 0.0245 | 100% | 99.99% | 230 |
| `hunter.people.email.find` | 0.0245 | 8.10% | 99.98% | 2787 |
| `leadsforge.people.email.find` | 0.0245 | 5.69% | 99.93% | 4237 |
| `leadmagic.people.email.find` | 0.025 | 2.31% | 98.92% | 6096 |
| `fiber-ai.people.contacts.reveal` | 0.04 | 40.68% | 99.78% | 17375 |
| `leadmagic.x.personal-email-finder` | 0.05 | 42.21% | 99.19% | 809 |
| `limadata.people.email.find.linkedin` | 0.06 | 100% | 99.96% | 585 |
| `fiber-ai.people.contacts.turbo` | 0.06 | 7.36% | 99.76% | 4444 |
| `wiza.people.email.find` | 0.075 | 6.42% | 99.98% | 226 |
| `aviato.people.email.find` | 0.08 | 12.64% | 99.98% | 129 |
| `sixtyfour.people.email.find.work` | 0.12 | 14.19% | 98.92% | 88427 |
| `harvestapi.linkedin.user.profile.email` | 0.02 | 16.20% | 99.95% | 5127 |
| `contactout.people.contact.work` | 0.15 | 99.13% | 99.61% | 187 |

### `treg.people.phone.find` configured child routes

| Child endpoint | Price USD | Hit rate | Works | p50 ms |
|---|---:|---:|---:|---:|
| `blitzapi.people.phone.find` | 0.000495 | 33.29% | 100% | 421 |
| `quickenrich.people.phone.find` | 0.004834 | 13.90% | 99.86% | 49 |
| `aiark.people.phone.find` | 0.026335 | 22.17% | 99.74% | 539 |
| `tomba.people.phone.find` | 0.0445 | 18.30% | 100% | 222 |
| `dropleads.people.phone.find` | 0.054 | 2.30% | 99.82% | 451 |
| `aviato.people.phone.find` | 0.08 | 3.99% | 99.99% | 117 |
| `leadmagic.people.phone.find` | 0.125 | 8.32% | 98.90% | 1913 |
| `wiza.people.phone.find` | 0.15 | 11.02% | 99.99% | 252 |
| `findymail.search.phone` | 0.198 | 7.05% | 100% | 3573 |
| `limadata.people.phone.find` | 0.20 | 100% | 99.89% | 1075 |
| `prospeo.people.phone.find` | 0.245 | 100% | 100% | 233 |
| `leadsforge.people.phone.find` | 0.245 | 13.01% | 99.99% | 880 |
| `contactout.people.contact.phone` | 0.25 | 100% | 99.92% | 160 |
| `sixtyfour.people.phone.find` | 0.72 | 5.10% | 100% | 7988 |
| `lusha.people.phone.find` | 0.7488 | 33.91% | 100% | 310 |

## Other relevant public contact services

| Service / endpoint | What it returns | Cheapest / median / most expensive published price | Success rate / speed | Source |
|---|---|---|---|---|
| `treg.people.enrich` | Profile enrichment from email, LinkedIn URL, or name + company; title/employer/seniority/location and other profile data | Configured 27-child route plan: `$0.000495` / `$0.010` / `$0.38` | Route success 67.95% (312,390 samples); aggregate latency NOT FOUND | [endpoint catalog](https://treg.to/catalog/endpoints/treg.people.enrich), [person-enrichment comparison](https://treg.to/use-cases/enrich-a-person) |
| `treg.people.email.verify` | Deliverability verdict for an address already known | Configured 12-child route plan: `$0` / `$0.006125` / `$0.024` | Route success 96.68% (1,749,433 samples); aggregate latency NOT FOUND | [endpoint catalog](https://treg.to/catalog/endpoints/treg.people.email.verify), [verification comparison](https://treg.to/use-cases/verify-an-email) |
| LinkedIn profile fetch (catalog comparison, not the Diger decision-maker route) | Profile name, headline, location, current/past roles and education | Public page lists `$0.0009` cheapest external price; median across its mixed per-found/per-result/per-call listings is NOT FOUND as a comparable unit; highest listed paid provider `$0.65` per found. LinkedIn's own-account row is free but returns the connected member's own profile, not a prospect. | Provider-level success and speed are published on the page; examples include TikHub 100% (36,323 calls), AnyAPI 100% (297,936), ContactOut 100% (214), with median latency 28.8s, 2.0s, 332ms respectively. | [LinkedIn profile comparison](https://treg.to/use-cases/get-a-linkedin-profile) |
| `hunter.companies.emails` | Company-domain contact list: names, roles, email addresses, confidence; results are not necessarily verified | `$0.00245` per email returned, billed in a rounded-up block of 10 (catalog display `$0.0245` per started 10); one endpoint, so median is the same unit cost | 99.98% success, p50 270ms (202,996 samples). Catalog warns directory rows may be unverified. | [public endpoint catalog](https://treg.to/catalog/endpoints/hunter.companies.emails) |
| `thecompaniesapi.companies.email_pattern` | Domain email formats (e.g. first.last), not a particular person's address | `$0.0019` per found pattern; Tomba comparison is `$0.0089` per call; ZeroBounce `$0.276` per found. Three listings; median by displayed price `$0.0089`, though units differ. | The Companies API 100% (1,152 calls, 243ms p50); Tomba 100% (279 calls, 213ms p50); ZeroBounce only 1 call, so a stable rate is NOT FOUND. | [endpoint catalog](https://treg.to/catalog/endpoints/thecompaniesapi.companies.email_pattern), [comparison page](https://treg.to/use-cases/company-email-format) |

## Route cap behavior

The public `integrate.md` describes `X-Treg-Route-Max-Cost` as a USD ceiling for the whole routed call (default `$1.00`), not a provider selector and not a promise that a particular child will be used. If the estimated reserve exceeds the cap, the request is rejected with HTTP 402 `route_max_cost` before billing; when the route can run under the cap, the provider choice still depends on eligible inputs, own-key precedence, cost order, and waterfall behavior. Waterfall misses can themselves be billable for some routes. The endpoint metadata says 17/26 people-search children, 1/25 email children, and 0/15 phone children bill a miss. Diger's `$0.005` cap limits the route spend for each routed call but may exclude higher-priced children or produce a safe refusal; it does not make the open-route median prices the expected costs under that cap. [Public integration instructions](https://treg.to/integrate.md)

The people-search endpoint's public `cost.note` says its child range is `$0–$0.30 per hit`, but the same public endpoint's actual `routing.plan` has children priced at `$1.62`, `$2.50`, and `$3.00`. The range/plan conflict is unresolved in the catalog snapshot. Distribution statistics and child table here use the explicit `routing.plan` values; do not treat the prose note's `$0.30` as the maximum.

The route plan includes free children with own-account or special billing behavior, and route prices can be per call, per found result, or per result. The min/median/max summarizes the published USD numbers as given, not an apples-to-apples cost for the same returned fields. Operational success does not equal match rate or correct/verified contact data.

## Points arithmetic and comparison

Using the requested conversion exactly: `ceil(USD × 55 EGP/USD ÷ 0.10 EGP/point) = ceil(USD × 550)`. Wait: the expression is `USD × 55 × 10 / 0.10` per the request; evaluated literally it is `USD × 5,500` points per USD. This report applies that literal requested expression (not the algebraically different exchange-rate conversion):

| Scenario | At cheapest child prices | At median child prices | At `$0.005` per call ceiling |
|---|---:|---:|---:|
| Person only (one search call) | `ceil((0 + 0) × 5,500) = 0` points | `ceil(0.01075 × 5,500) = 60` points | `ceil(0.005 × 5,500) = 28` points |
| Person + email | `ceil((0 + 0.000495) × 5,500) = 3` points | `ceil((0.01075 + 0.02258) × 5,500) = 184` points | `ceil((0.005 + 0.005) × 5,500) = 55` points |
| Person + phone | `ceil((0 + 0.000495) × 5,500) = 3` points | `ceil((0.01075 + 0.15) × 5,500) = 885` points | `ceil((0.005 + 0.005) × 5,500) = 55` points |
| Person + email + phone | `ceil((0 + 0.000495 + 0.000495) × 5,500) = 6` points | `ceil((0.01075 + 0.02258 + 0.15) × 5,500) = 1,009` points | `ceil((0.005 + 0.005 + 0.005) × 5,500) = 83` points |

**Conversion discrepancy to resolve:** the stated formula multiplies by both `55 × 10` and divides by `0.10`, giving 5,500 points per USD. If the intended meaning is `$1 = 55 EGP` and `1 point = 0.10 EGP`, the usual conversion is `55 ÷ 0.10 = 550` points/USD, ten times lower. The table follows the literal formula, as instructed. The `$0.005` column assumes each required call reaches exactly its full cap; the cap is a maximum, not a quoted price. `treg.people.search` itself may spend zero or up to the cap.

At the public route-plan medians, current user-provided code prices convert back to USD as follows under the literal requested factor:

| Field | Current Diger quote | USD-equivalent under requested formula | Catalog median comparison | Result |
|---|---:|---:|---:|---|
| Base person | 83 points | `83 ÷ 5,500 = $0.01509` | Search median `$0.01075` | Price is about 1.40× median; above it by `$0.00434`. |
| Work email | 55 points | `55 ÷ 5,500 = $0.01000` | Email median `$0.02258` | Price is below median by `$0.01258` (about 44.3% of median). |
| Phone | 55 points | `55 ÷ 5,500 = $0.01000` | Phone median `$0.15` | Price is below median by `$0.14` (about 6.7% of median). |
| All three (sum) | 193 points | `$0.03509` | Median sum `$0.18333` | Current combined price is below the open-route median by `$0.14824`. |

The stated `unitCostUsd: 0.035` is a provider-cost estimate, not customer price. Under the literal requested conversion it corresponds to `ceil(0.035 × 5,500) = 193` points; the three current quoted field prices sum to 193 points. This means the current estimate has effectively no gross headroom against its own price. The current `$0.005` per-call cap can lower actual spend, but the catalog's open-route median cannot prove that it will; the catalog does not publish the distribution of actual spend under Diger's specific cap/input mix.

## Recommendation

Do not raise static prices to the unbounded open-route medians and claim that they are the customer's cost: the route uses a `$0.005` ceiling and may refuse or select a cheaper provider, while route children have materially different units and match rates. For now, keep the listed 83 / 55 / 55-point prices only as capped-price tiers, preserve the `$0.005` cost ceiling, and make provider selection/refusal and actual per-field delivery cost visible in accounting. If pricing must cover median-cost open routing, the price facts imply 60 points for a base row, 125 points for email, and 825 points for phone before any margin (not the current prices); the phone median exceeds the 600-point job cap, so that uncapped service cannot be safely offered under the existing cap. A field should only be charged when it was returned. Before choosing either model, verify the conversion: the literal formula requested is 10× the ordinary EGP-to-points conversion.

## Evidence boundary

All route/provider numbers above came from unauthenticated `GET https://treg.to/catalog/endpoints/<id>` responses on 2026-10-17; broader comparisons came from the linked public use-case pages. No POST `/call` or provider-native endpoint was used; no token was read or sent; no database, job, quote, or provider balance was accessed.
