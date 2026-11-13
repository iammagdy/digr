/**
 * ROUND 57/58: THE WORDS OF A REVISED REQUEST. A change the customer typed in the chat about the open plan is planned again from the whole request with the change joined after this marker (chatTurn.ts), so nothing they asked for before is lost.
 * Pure; no money.
 */
export const REVISION_JOINER_AR = "تعديل العميل على نفس الطلب:";

/** The customer's changes of a revised request, the LATEST FIRST (empty for a request that was never revised). */
export function revisionChangesLatestFirst(requestText: string | null | undefined): string[] {
  const parts = String(requestText ?? "").split(REVISION_JOINER_AR);
  return parts.slice(1).map((p) => p.trim()).filter(Boolean).reverse();
}
