/**
 * The link a request on «طلباتي» opens. Opening a request only shows it (its results or its conversation). A retry is a separate,
 * explicit action: only the «إعادة المحاولة» button asks for it, and only then does the link carry `retry=1`.
 */
export function openJobHref(input: { jobId: string; conversationId?: string | null; retry?: boolean }): string {
  const query = new URLSearchParams();
  query.set("jobId", input.jobId);
  if (input.conversationId) query.set("c", input.conversationId);
  if (input.retry === true) query.set("retry", "1");
  return `/dashboard/chat?${query.toString()}`;
}
