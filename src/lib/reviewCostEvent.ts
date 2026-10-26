/**
 * The owner's internal job_events row about the review spend of a job (see server/reviewSpendLog). It has its own event type so the
 * customer's activity list can leave it out; this module has no server dependency, so the page can use it.
 */
export const REVIEW_COST_EVENT_TYPE = "review_cost";
/** The owner's internal row about a review call that failed or left rows without a verdict (code, stop reason, tokens, reply length, rows missing). */
export const REVIEW_FAILURE_EVENT_TYPE = "review_failure";

/** The owner's internal row with the head of the model's first reply of a job (scrubbed of row text), kept once per job to see why replies are longer than their verdicts. */
export const REVIEW_SAMPLE_EVENT_TYPE = "review_sample";
/** The owner's internal row that says a job took the previous review budget rule because the daily review ceiling was reached or could not be read. */
export const REVIEW_FALLBACK_EVENT_TYPE = "review_fallback";

/** The owner's internal row about the decision-makers email and phone lookups of a chunk (what each did; no name, email, phone, link or token). */
export const LOOKUP_LOG_EVENT_TYPE = "lookup_log";

/** False for the owner's internal rows: the customer's activity list never shows them. */
export const isCustomerVisibleJobEvent = (eventType: unknown): boolean => eventType !== REVIEW_COST_EVENT_TYPE && eventType !== REVIEW_FAILURE_EVENT_TYPE && eventType !== REVIEW_FALLBACK_EVENT_TYPE && eventType !== REVIEW_SAMPLE_EVENT_TYPE && eventType !== LOOKUP_LOG_EVENT_TYPE;
