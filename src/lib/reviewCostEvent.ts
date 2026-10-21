/**
 * The owner's internal job_events row about the review spend of a job (see server/reviewSpendLog). It has its own event type so the
 * customer's activity list can leave it out; this module has no server dependency, so the page can use it.
 */
export const REVIEW_COST_EVENT_TYPE = "review_cost";

/** False for the owner's internal rows: the customer's activity list never shows them. */
export const isCustomerVisibleJobEvent = (eventType: unknown): boolean => eventType !== REVIEW_COST_EVENT_TYPE;
