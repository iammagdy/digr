# Pricing proposal: Facebook topic report (`facebook-topic-report`)

**Status: PROPOSED. The owner decides the price.** Nothing existing was repriced: no price, cap or ceiling of any other capability changed; the per-job cap (25,000 points), the Facebook ceilings (300 posts, 1,500 comments) and the 15% buffer (on the reserve only) are untouched. **No SQL is needed or proposed**: the capability is priced by the one `RECORD_COSTS` entry in `src/lib/recordPricing.ts`, which the quote writer, the calculator, the capacity gate and the worker settlement all read.

Labels: **M** measured (the owner's own run, 24 Oct 2026), **C** catalog price (the code's source table), **A** assumed.

## Where the number comes from

| Figure | Value | Basis |
|---|---|---|
| Total provider spend of the run | 0.9619 USD for 406 calls | M |
| Posts delivered / comments delivered | 305 / 1,753 (5.75 comments a post) | M |
| Page browsing | 0.0996 USD for 225 posts kept = 0.000443 USD a post | M |
| Keyword search | 0.3648 USD for 80 posts kept = 0.00456 USD a post | M |
| Comment calls | 0.4975 USD for 1,753 comments = 0.000284 USD a comment | M |
| All-in cost per delivered comment of that run | 0.9619 / 1,753 = **0.000549 USD** | M (but 26% of its posts came from the search) |
| Blended expectation at the search cap (15% of posts from the search, 5 comments a post) | 0.000284 + (0.85 x 0.000443 + 0.15 x 0.00456) / 5 = **0.000496 USD** | M figures, A mix |
| Dearest case (1 comment a post, search at its cap) | 0.001344 USD a comment | M figures, A mix |
| Search call price used for the worst case in the plan gate | 0.0661 USD | C |

**Cost basis in code: 0.00055 USD per delivered comment** = the dearer of the two (0.000549 measured all-in; 0.000496 blended), rounded up. Labelled **ASSUMED** because the new mix (round-robin, 20% cap, small search share) was never measured.

**Unit price = 0.00055 x 5,500 = 3.025 points a comment** (302.5 points per 100 comments; the one shared formula, fractional, rounded up at the sixth decimal). 1 point = 0.10 EGP, 55 EGP = 1 USD, so 3.025 points = 0.0055 USD of revenue: a 10x markup on cost, the same markup as every per-record service.

## Arithmetic (all from `jobArithmetic` in `src/lib/facebookReport/cost.ts`, pinned by tests)

| Request | Comments | Charge = ceil(n x 3.025) | Reserve = ceil(n x 3.025 x 1.15) | Revenue (USD) | Expected cost at 0.000549 | Margin at M | Margin, dearest case |
|---|---|---|---|---|---|---|---|
| 20 posts x 5 | 100 | 303 | 348 | 0.551 | 0.055 | 90.0% | 75.6% |
| 100 posts x 5 | 500 | 1,513 | 1,740 | 2.751 | 0.274 | 90.0% | 75.6% |
| 300 posts x 5 | 1,500 | **4,538** | **5,219** | 8.251 | 0.823 | 90.0% | 75.6% |
| 100 posts x 20 (cut to the ceiling) | 1,500 (75 posts) | 4,538 | 5,219 | 8.251 | 0.823 | 90.0% | 75.6% |
| 300 posts x 1 | 300 | 908 | 1,044 | 1.651 | 0.165 | 90.0% | 75.6% |

The charge never exceeds the reserve for any delivered count up to the volume (property test over 5,000 random cases). Only delivered comments (after removing empty, exact-duplicate and link-only ones) are charged; the rest of the reserve is released.

## Capacity gate

`checkPlanProviderCapacity` estimates volume x 0.00055 USD against a safe budget of 0.9 x min(real balance, remaining daily cap, user cap). 1,500 comments: estimate 0.825 USD, needs about 0.917 USD of effective balance. Below that the plan is refused in one Arabic sentence (the capacity it does hold is stated) and nothing is quoted or held.

Thresholds (tested): **20 posts x 5 comments** (100 comments, estimate 0.055 USD) needs an effective provider balance (the lowest of the real balance, the remaining daily cap and the user cap) of **0.0611 USD**, i.e. a safe budget of 0.055 USD; below it the plan, being under 600 points, is cut to what the budget holds (0.06 USD gives 98 comments), never refused. **100 posts x 20 comments, cut to 75 posts** (1,500 comments, estimate 0.825 USD) needs **0.9167 USD** (safe budget 0.825 USD); below it the plan is refused (0.91 USD refuses, 0.92 USD passes).

The capability is also **gated**: it is not offered until the owner has reviewed at least one registry Page (one line in the registry), so this price is not shown to anyone yet.

## Model cost (not in the table above)

The axis model (claude-haiku-5-5, unchanged) runs one call per 50 ambiguous posts inside 20% of the job's revenue (about 1.65 USD for the 1,500-comment job; at most 6 calls for 300 posts); beyond the budget a post is «general» and flagged. The provider table above does not count it; at the measured review-call cost (about 0.0083 USD) six calls are about 0.05 USD.

## What the owner should decide

1. Keep 3.025 points, or move the cost basis (one number in `RECORD_COSTS`). A lower search share or more comments per post lowers the real cost; fewer comments per post raises it (1 per post: 0.001344 USD, still 75.6% margin).
2. Whether to measure the new mix with one small live run before relying on the margin (the owner will approve one; none was made).

## Rollback

`git revert -m 1 <merge commit>` on a new branch. No SQL, no environment change, nothing to undo in the database.
