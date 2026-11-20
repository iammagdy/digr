# Social delivery and listed mission rates

The LLM-first planner priced these missions from a small provider sample and estimated model costs. A terminal empty video search was read as one object, a counted comments route could miss continuation input, and a scout could report depletion while it still had a continuation. A comments total could also increase the planned number of parents during a count edit.

New eligible single-delivery plans use the same listed-rate function as the public pricing page. The amount charged for delivery still comes from the sealed job unit and the existing minimum and settlement rules. The temporary hold also funds the forecast for the sampled page sizes and checked routes. The customer sees the listed rate, maximum full-delivery charge, and temporary hold separately. Unmarked stored plans, mixed plans, companies, decision-makers and X retain their existing pricing path.

| Default test case | Listed points per item | Full charge | Hold |
|---|---:|---:|---:|
| 300 YouTube comments | 0.275 | 200 | 200 |
| 200 Facebook comments on named-page posts, two per page | 1.034 | 207 | 327 |
| 50 named-page Facebook posts | 3.4485 | 200 | 200 |
| 20 YouTube videos | 5 | 200 | 200 |
| 300 TikTok comments | 0.275 | 200 | 200 |

D-0162 funds each stage's full call schedule. The schedule accounts for partial pages split between parents, barren pages before productive pages, and barren pages at the end of parents that fail to fill the target. The worker checks the same limit before every dispatch and persists the count across restarts. Planning checks both the wallet and the job cap before showing a card. Repricing and approval use the same schedule, and atomic approval checks the wallet again. In the synthetic replay, 14 listing calls and 276 comment calls are budgeted, which requires a 752-point hold. The paid-tail replay uses seven listing and 138 comment calls, delivers 200 comments, charges 207 points, and releases the remaining 545 points. The positive control uses 100 comment calls and settles at the same 207 points.

## Reviewed scope

Gate 1 passed the D-0161 cut on v4, SHA-256 `c6818088ac4b42fcbff264c730599870241d36c08dc51688a1884b8db6c1dffc`, at base `94ad7558a34edaf7afd9a34006a5305a7d29a5c3`. Planning stops sampling a stream at an open-empty page. Execution retains the two-barren-page stop. New children with a global total and a kept parent have no funded alternate. Resolved lookup alternatives preserve their own bindings.

The November 20 source traces contained two truly empty video-search results and two comment pages with a terminal flag and stale next token. The tests use sanitized structural subsets. Larger inventories and longer continuations are synthetic. The continuation checks cover committed pages on restart. A worker interruption after a provider response but before saving the page can repeat a request under the existing commit behavior.

## Verification

The new pricing cases run on injected provider, model and ledger fakes. Before production changes, nine of the first ten pricing checks failed and the mixed-delivery control passed. The thin-page fixture produced an old cost-based rate of 6.251667 and a 1,438-point hold. A new 20-video replay exposed an old cost-based rate of 4.29 in place of the listed 5, with the minimum already charging 200. The 200-comment replay stopped at a planning question on the old scout.

QA still needs to verify the card and real delivery where the provider supplies enough rows. The incident fixtures cannot establish that the original searches now return enough inventory. Rollback is a revert through COMMANDER.

Sanitized source fixture SHA-256 values

| Fixture | SHA-256 |
|---|---|
| `tiktok_search_1.json` | `85fe37b14c8a71f7d173683d6c021baef1cdc9c99958e04a0220c4cd8eeb8047` |
| `tiktok_search_2.json` | `7a5129d6a6f56441488ab7cd1c5cfb7d08d15009183079765529d23ab430a039` |
| `fb_comments_p1.json` | `e6067d02f4d2db0ea8893ac54b49bf42988d874a927d61c76d5e314749b36add` |
| `fb_comments_p2.json` | `ee27d348ce86daac386a62dd8e3f9801a22daa43c4090e68bf10d107a3b47107` |

The integrated replay checks the 327-point hold, the 207-point charge, 7 parent calls, 100 distinct comment calls and 200 delivered workbook rows. The video replay checks the five-point listed rate, the 200-point minimum and twenty delivered workbook rows. The capped replay offers 178 comments at a 300-point cap and offers no numeric choice below the 200-point minimum.
