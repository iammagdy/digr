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
