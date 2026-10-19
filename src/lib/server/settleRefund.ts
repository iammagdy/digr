/**
 * Points released back to the customer by a settlement, read from what the settle function returned.
 * The settle functions return `reserved_credits` and `charged_credits` (not a refund figure), so the refund is the
 * difference; an explicit `refunded_credits` wins when present. An already-settled reply carries no reserve, so it
 * reports 0 and no second refund notice is produced.
 */
export function refundedPointsFromSettle(settle: unknown): number {
  const data = (settle && typeof settle === "object" ? settle : {}) as Record<string, unknown>;
  const explicit = data.refunded_credits === undefined || data.refunded_credits === null ? NaN : Number(data.refunded_credits);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.round(explicit);
  const reserved = Number(data.reserved_credits);
  const charged = Number(data.charged_credits);
  if (!Number.isFinite(reserved) || !Number.isFinite(charged)) return 0;
  return Math.max(0, Math.round(reserved - charged));
}
