/**
 * The number on the bell counts what needs the customer: an unread result to open, or an unread top-up that was turned down. A welcome note, an
 * approved top-up and a released hold are in the list (unread dot and all) but never in the number, so the badge is a count of things to do and
 * disappears when there is none.
 */
export const ACTIONABLE_NOTIFICATION_KINDS: ReadonlySet<string> = new Set(["job_done", "topup_rejected"]);

export function actionableUnreadCount(items: ReadonlyArray<{ kind: string; read: boolean }>): number {
  return items.filter((item) => !item.read && ACTIONABLE_NOTIFICATION_KINDS.has(item.kind)).length;
}
