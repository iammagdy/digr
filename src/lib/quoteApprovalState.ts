export interface QuoteApprovalState {
  canApprove: boolean;
  expiredByTime: boolean;
  inactiveStatus: boolean;
}

/**
 * A quote must still be current in storage as well as inside its time window.
 * `unknown` is used for restored cards when the stored status could not be read.
 */
export function getQuoteApprovalState(
  status: string | undefined,
  expiresAt: string,
  now = Date.now(),
): QuoteApprovalState {
  const expiresAtMs = Date.parse(expiresAt);
  const expiredByTime = !Number.isFinite(expiresAtMs) || expiresAtMs <= now;
  const inactiveStatus = status !== undefined && status !== "quoted";

  return {
    canApprove: !expiredByTime && !inactiveStatus,
    expiredByTime,
    inactiveStatus,
  };
}

/**
 * A plan with a step that has no service, no parameters or no volume is incomplete: the card shows no price and no
 * approve button for it, and the customer is asked ONE question instead.
 */
export function isQuotePlanComplete(items: Array<{ capabilitySlug?: string; params?: Record<string, any>; targetVolumeMax?: number }> | undefined): boolean {
  if (items === undefined) return true; // restored cards without items are judged by status and time only
  if (items.length === 0) return false;
  return items.every((item) => Boolean(item.capabilitySlug) && Boolean(item.params) && Object.keys(item.params || {}).length > 0 && Number(item.targetVolumeMax) > 0);
}
