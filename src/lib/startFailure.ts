/**
 * What the customer reads when pressing «أوافق وابدأ البحث» did not come back with a start. The balance is blamed only when the
 * server said so (its own 402 sentence, with the numbers). Anything else (a dropped connection, a platform error page, a timeout)
 * says what is true: the request may or may not have started, and nothing is charged except what is delivered.
 */

/** The job of the quote exists: the start went through and only the answer was lost. */
export type StartedJobState = "exists" | "none" | "unknown";

export const START_NOT_STARTED_AR = "حصل تعثر مؤقت في بدء الطلب ولم يبدأ التنفيذ، ولا يُخصم رصيد إلا مقابل ما يُسلَّم. جرّب مرة أخرى بعد قليل.";
export const START_UNKNOWN_AR = "حصل تعثر مؤقت أثناء بدء الطلب. افتح «طلباتي» لتعرف إن كان قد بدأ؛ ولا يُخصم رصيد إلا مقابل ما يُسلَّم.";

/** The sentence for a failed start, or null when the request did start (its job exists) and the page should show it as started. */
export function startFailureText(input: { deliberateText: string | null; jobState: StartedJobState }): string | null {
  // The server wrote this sentence for the customer (insufficient balance, expired quote, limit of active requests, ...).
  if (input.deliberateText) return `تعذر بدء الاستخراج: ${input.deliberateText}`;
  if (input.jobState === "exists") return null;
  return input.jobState === "none" ? START_NOT_STARTED_AR : START_UNKNOWN_AR;
}
