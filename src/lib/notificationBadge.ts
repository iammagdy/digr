/**
 * The number on the bell counts only what needs the customer to DO something: an unread top-up that was turned down (the customer corrects and sends it again). A finished request, a welcome
 * note, an approved top-up and a released hold are routine updates: they are in the list (unread dot and all) and make the bell show a plain dot, but never a number, so «تحتاج انتباهك» is
 * never said about a routine update (a customer with thirty finished requests used to read «٣٠+ تحتاج انتباهك»).
 */
export const ACTIONABLE_NOTIFICATION_KINDS: ReadonlySet<string> = new Set(["topup_rejected"]);

export function actionableUnreadCount(items: ReadonlyArray<{ kind: string; read: boolean }>): number {
  return items.filter((item) => !item.read && ACTIONABLE_NOTIFICATION_KINDS.has(item.kind)).length;
}

/** How many notifications the bell loads (newest first). The number on the bell can never count past this. */
export const NOTIFICATION_LIST_LIMIT = 30;

/**
 * The text of the bell's number. The list holds only the newest NOTIFICATION_LIST_LIMIT items, so when every one of them is an unread item
 * that needs the customer the true count may be higher: it reads «٣٠+», never a plain «٣٠» that looks like an exact count.
 */
export function bellBadgeText(actionable: number, listLength: number, toDigits: (n: number) => string): string {
  const capped = listLength >= NOTIFICATION_LIST_LIMIT && actionable >= NOTIFICATION_LIST_LIMIT;
  return `${toDigits(actionable)}${capped ? "+" : ""}`;
}

/** How far back the «anything new?» check looks beyond the newest row it holds: rows written a moment earlier by another clock or in the same second still arrive. */
export const NOTIFICATION_NEWER_WINDOW_MS = 10 * 60_000;

/**
 * Puts freshly read rows into the list: a row already held keeps its place (and its read state), a new one joins, and the whole list is
 * sorted newest first by creation time (then id), so the order never depends on which row the check happened to see first. `foundNew` says
 * whether any row was new.
 */
export function mergeNewerNotifications<T extends { id: string; created_at: string }>(held: ReadonlyArray<T>, fetched: ReadonlyArray<T>, limit = NOTIFICATION_LIST_LIMIT): { items: T[]; foundNew: boolean } {
  const known = new Set(held.map((item) => item.id));
  const fresh = fetched.filter((item) => !known.has(item.id));
  if (fresh.length === 0) return { items: [...held], foundNew: false };
  const items = [...fresh, ...held]
    .sort((a, b) => (Date.parse(b.created_at) - Date.parse(a.created_at)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, limit);
  return { items, foundNew: true };
}
