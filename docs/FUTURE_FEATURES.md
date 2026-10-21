# Future features

Ideas the owner has approved in principle and that are NOT built. Nothing here is in the product, in a plan card, or in any customer text yet. Build only after the conference, with the owner's explicit go-ahead.

## Deep review («مراجعة معمّقة») — paid add-on

**Why.** The default review of posts and comments is deliberately light and cheap: one model call per page, a verdict per row and no explanation (see docs/REVIEW_COST_CUT.md). That keeps the price low but it can only judge a row from its own short text. Some customers will want a closer look at their own result, in their own words.

**The default does not change.** Every job keeps the cheap light review (the scheme in docs/CHEAP_REVIEW_DESIGN.md, or today's one-call-per-page review until that is built). Deep review is never switched on by itself and is never part of the standard price.

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

## Structured-decision reviewer from TypeSafe («Jev») — to evaluate AFTER the conference

An outside reviewer that returns structured decisions instead of free text, which could replace or sit beside the model call as the first or second pass. Nothing is known here beyond that description: its accuracy, price, limits and terms are not reviewed.

Plan, in this order, and nothing is sent before step 4:
1. **Read** what it is, what it costs, its limits and its data terms.
2. **Shadow mode first:** run it on the SAME rows the current review already judges, in the background, logging only agreement and cost (internal `job_events` rows, no customer text, no effect on what is delivered or charged).
3. **Egyptian Arabic accuracy test** on a fixed, hand-labelled set of Egyptian posts and comments (dialect, sarcasm, short replies, country words, clubs and places), compared with the current model and with the cheap scheme, per topic family; the result is a table, not an impression.
4. **Terms and privacy review before any customer text leaves the platform:** does it keep or train on what it receives, where is it processed, can the customer's text be sent at all under the platform's terms and privacy statement, what must the customer be told. Only if this passes does any real customer row go to it.
5. A decision with the numbers: cost per delivered row, wrong rows per hundred, failures, latency.

## A small in-house classifier trained on stored review verdicts — later, with terms permission

A small model of our own (for example a text classifier on Arabic character and word features) trained on the verdicts the review has already produced, used as a cheap first pass in the same place as the strong-signal acceptance: accept or reject the clear cases, send the doubtful ones to the model.

What it needs, and what is true today:
- **The training data does not exist yet.** The platform stores the cost of a review call, not the verdicts and not the text of the rows it judged. Keeping them means storing customer-requested content and the model's decision on it.
- **Permission first:** the provider's terms for the data collected, the platform's own terms and privacy statement, and the customer's consent (an opt-in on the request, off by default) must allow keeping row text and verdicts for training, and a retention limit must be set; text must be kept per topic family, never shared across customers' private requests without that permission.
- **Then:** store a short normalised snippet, the topic, the country, the verdict and the source of the verdict (model, audit, customer correction) for the opted-in jobs; hold out a test set; measure false accepts at the threshold used by the cheap scheme before it decides anything; start in shadow mode next to the model; retrain on a schedule; keep the model's verdict as the audit for the classifier exactly as the audit works for the code signals.
- **Expected value:** it replaces hand-written vocabulary with measured signals and could decide most of the clear rows; it is only as good as its labels (an old model mistake is learned as truth), so the audit sample stays.

