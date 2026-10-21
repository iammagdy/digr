/**
 * Degraded mode: one configuration switch (`DEGRADED_MODE`, default off) the owner flips when the hosting plan's CPU budget runs low
 * during the conference. It only changes how often the browser asks and what the customer reads; it never touches a price, a cap, a
 * reserve, a charge or a review:
 *   off     everything as usual.
 *   on      every page asks about three times less often (the job follow-up, the menu count, the notifications) and a calm banner says
 *           the service runs at reduced capacity. Nothing is refused.
 *   closed  as «on», and no NEW request is started (the same door as «الخدمة مزدحمة»): chats and saved plans keep working, running
 *           requests carry on, nothing is reserved or deducted.
 * Why no model review is paused: every review of the worker (company rows, topic comments, videos) fails closed, so a skipped review
 * would change which rows are delivered and charged. Pausing one is a money change, so it is not offered here.
 * Pure: the caller supplies the environment.
 */
export type DegradedLevel = "off" | "on" | "closed";

export function degradedLevel(env: Record<string, string | undefined> = process.env): DegradedLevel {
  const value = String(env.DEGRADED_MODE ?? "").trim().toLowerCase();
  return value === "on" || value === "closed" ? value : "off";
}

/** How much longer every optional wait becomes while degraded. */
export const DEGRADED_SLOW_FACTOR = 3;

export const DEGRADED_BANNER_AR = "الخدمة تعمل الآن بسعة مخفّضة لتبقى متاحة للجميع، فقد تتأخر بعض التحديثات بضع ثوانٍ. تبقى محادثاتك وخططك محفوظة.";
export const DEGRADED_CLOSED_AR = "الخدمة مزدحمة جدًا الآن، لذلك لا نبدأ طلبات جديدة مؤقتًا. تبقى محادثاتك وخططك محفوظة، ولا يُخصم شيء، وسنعاود البدء قريبًا.";
