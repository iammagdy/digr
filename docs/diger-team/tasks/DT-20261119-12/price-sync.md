# DT-20261119-12 · Catalog price sync

D-0154. Base `55814a05`. The committed overlay has revision 2 and four corrections. Each comes from the COMMANDER's 2026-11-20 public catalog responses. The offline fixtures contain the billing and input metadata extracted from the 11 checksum-verified captures. Example responses and links are excluded from the committed fixtures.

## Prices this PR ships

The customer columns are maximum charge / reserve in points for a single stage with the stated delivered count and default pricing settings. They were computed with the existing `expectedCost` and `priceMissionByCode` on the baseline and final catalogs. These are example quotes.

| Endpoint | Provider USD per record | 50 delivered | 100 delivered | 200 delivered |
| --- | ---: | ---: | ---: | ---: |
| `blitzapi.companies.enrich` | 0.000495 → 0.001 | 208/239 → 347/399 | 344/396 → 622/715 | 616/709 → 1172/1348 |
| `blitzapi.companies.search` | 0.000495 → 0.001 | 208/239 → 347/399 | 344/396 → 622/715 | 616/709 → 1172/1348 |
| `blitzapi.companies.tam-by-jobs` | 0.000495 → 0.001 | 208/239 → 347/399 | 344/396 → 622/715 | 616/709 → 1172/1348 |
| `blitzapi.companies.tam-by-people` | 0.000495 → 0.001 | 208/239 → 347/399 | 344/396 → 622/715 | 616/709 → 1172/1348 |

A mixed plan delivers companies and managers, with email and phone lookups modeled as non-delivered stages. These examples use the catalog rates for people and Maps and an example email call rate of $0.000495.

| Companies | Managers per company | No contacts | Email | Maps | Email and Maps |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 1 | 555/638 → 693/797 | 762/877 → 901/1036 | 628/722 → 767/882 | 836/961 → 975/1121 |
| 50 | 2 | 830/954 → 969/1114 | 1173/1349 → 1312/1509 | 903/1039 → 1042/1198 | 1247/1434 → 1386/1594 |
| 100 | 1 | 966/1111 → 1243/1430 | 1309/1506 → 1587/1825 | 1041/1198 → 1319/1517 | 1385/1593 → 1663/1912 |
| 100 | 2 | 1516/1743 → 1794/2062 | 2132/2451 → 2409/2771 | 1591/1830 → 1869/2149 | 2207/2538 → 2485/2858 |
| 200 | 1 | 1788/2056 → 2343/2695 | 2404/2765 → 2959/3403 | 1868/2148 → 2423/2787 | 2484/2856 → 3039/3495 |
| 200 | 2 | 2888/3321 → 3444/3960 | 4049/4656 → 4604/5295 | 2968/3413 → 3523/4052 | 4128/4747 → 4684/5386 |

## Held and report-only rows

| Saved response | Stored → observed USD | Reason for keeping the stored price |
| --- | ---: | --- |
| `crawl4ai.google.serp.maps` | 0.00015 → 0.00023 | The live `limit` note adds a maximum. The snapshot states only a default. |
| `crawl4ai.google.serp.organic` | 0.00015 → 0.00038 | The `q` note that carries its size limit differs byte-for-byte. |
| `crawl4ai.tiktok.user.profile` | 0.00035 → 0.00064 | The live `username` input adds a note. The generic sync treats changed input notes as ambiguous. |
| `crawl4ai.web.scrape` | 0.00015 → 0.00025 | Live metadata adds `timeout` with a structured 5–120 range. |
| `sixtyfour.companies.intelligence.start` | 0.24 → 0.30 | Live `per` is absent. |
| `sixtyfour.companies.search` | 0.024 → 0.030 | Live `per` is absent. |
| `sixtyfour.people.search` | 0.024 → 0.030 | Live `per` is absent. |

Of the original 81 changes, the 63 billing-label changes stay held, three rows already reflect DT-11, and four routed rises remain report-only. The four routed effective estimates stay at $0.875, $0.015, $0.015 and $0.01476. All four DT-11 pinned IDs remain report-only. A direct price update also stays report-only if it would change a routed sibling estimate.

## Weekly runbook

1. COMMANDER runs the dry report from the repository root. The command uses only public metadata and writes the report to the path selected by the operator.

   ```sh
   npx tsx scripts/capabilities/sync-prices.ts --scope all --date YYYY-MM-DD --out /tmp/diger-price-sync.md
   ```

2. Review the proposed prices, held rows, withdrawals and copied card prices. Re-run with `--apply` only to prepare the reviewed PR. A 404 with an explicit unknown-endpoint error can withdraw an endpoint. An outage or unverified row preserves the last confirmed price and availability. The command validates the whole candidate in a fresh process, then publishes those same bytes atomically. Update both the revision and its SHA-256 in `src/lib/treg/priceRev.ts` using the values printed by the command. Regenerate the registry, update the card literals named in the report, and run the tests.
3. Before merging, COMMANDER checks read-only that zero approved or running jobs exist. Merge only when that check returns zero. Recheck immediately after deployment. The runtime estimates and D-0138 cap now use the synced rates. An older unapproved card that used a corrected source must be re-quoted before points are reserved. An already approved job settles using its sealed unit and reserve.
4. If rollback is needed, restore the previously reviewed rate in a higher-revision overlay and keep the changed ID in the file. This re-quotes older cards that used it. Follow the same zero-active-job check for the rollback.

## Reproduction and verification

- The first failing integration run on `55814a05` recorded three failures and two passes. The new CLI suite also failed to load on the base because the sync module did not exist.
- The final focused tests use the real gateway and TREG client with fake HTTP. A $0.05 page sends one $0.05 header with $0.055 daily room. With $0.04 daily room it dispatches zero requests and spends zero.
- Golden fixture updates are restricted to five stored mission hashes and five revision stamps. The before/after diff of the golden tests showed the same customer views, notices, workbooks, provider call sequences and ledger amounts.
- Mutation checks cover bad rate validation, absent billing multiplier, repeat-run anchor, reverse sibling impact, stale approval and revision pin. The catalog invariant test also alters an unchanged endpoint by $0.000001 and asserts that the comparison fails.
- Live billing, provider rate limits, production job counts and deployment trace behavior require separate verification. This work ran with saved metadata and offline provider fakes.

