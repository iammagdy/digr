# Future features

Ideas the owner has approved in principle and that are NOT built. Nothing here is in the product, in a plan card, or in any customer text yet. Build only after the conference, with the owner's explicit go-ahead.

## Deep review («مراجعة معمّقة») — paid add-on

**Why.** The default review of posts and comments is deliberately light and cheap: one model call per page, a verdict per row and no explanation (see docs/REVIEW_COST_CUT.md). That keeps the price low but it can only judge a row from its own short text. Some customers will want a closer look at their own result, in their own words.

**The default does not change.** Every job keeps the cheap light review. Deep review is never switched on by itself and is never part of the standard price.

**How the customer meets it.**
1. The customer receives the output as today (the delivered sheet, the review sheet, and the «غير مراجَع» sheet if the budget ran out).
2. After looking at it, the customer presses «مراجعة معمّقة» on the result.
3. The customer describes in their own words what to check (for example «أريد فقط المنشورات التي تتحدث عن النادي الأهلي لا عن المنتخب»). The text is length-limited and treated as data, never as instructions to the system.
4. A quote appears BEFORE anything runs: how many rows would be re-checked, which rows (the delivered rows, the review-sheet rows, the «غير مراجَع» rows, or a choice among them), the price in points, and the plain statement of what the review does and does not promise. The customer approves or leaves it.

**Price.** Computed by code, never by the model: the real cost of a deeper review per row (a stronger model, a longer instruction, and a written reason per row) at the measured token prices, times the number of rows, converted to points by the same single pricing function as everything else, rounded up, with a clear upper bound shown before approval. Only the rows actually re-checked are charged; the difference is returned, as for any job. It goes through the same quote, approval, reserve and settle path as an extraction job (no new way to take points).

**What it must never promise.** Never «100% correct», never «no wrong rows», never a number of errors removed. The wording is: the review looks closer at each row against what the customer wrote and moves doubtful rows out of the delivered sheet; a row it cannot judge from its text stays out; a review can still be wrong. The customer is told this on the quote and in the result notice.

**How it would work (sketch, not a design).**
- A separate job type with its own reserve, quote and settlement; it reads the stored result rows, it does not fetch from the provider again.
- It can only make the delivered sheet stricter or move rows between sheets with a stated reason; a row with no verdict is never delivered (the same fail-closed rule as today).
- A hard spend ceiling per deep review, covered by the price shown; its spend is written to the same internal `review_cost` rows in job_events as the light review.
- The Arabic reason per row is kept here (it is the point of the add-on) and shown in the sheet; the light review stays verdict-only.

**Open questions for later.** The model and the price per row; the largest result it accepts; whether the «غير مراجَع» rows are offered first (they were never checked at all); how the result is delivered (a new file, or the same sheets updated); the exact Arabic wording of the notice reviewed by the owner before release.
