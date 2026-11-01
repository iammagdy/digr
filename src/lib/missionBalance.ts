/**
 * THE BALANCE AFTER A MISSION SETTLES (display only). The release of the unused hold and the charge are written at settlement, after the card last showed «running»; the header's balance (the shared useBalance provider) was refreshed only when the customer approved,
 * so it kept the hold taken until a reload (live 2026-11-01: header 5,426, wallet 5,506). When a mission is over, the card asks for the balance at once and once more a few seconds later (the same second read the legacy job path makes). No ledger read or write here.
 */
export const BALANCE_AFTER_SETTLE_DELAYS_MS: readonly number[] = [0, 3000];

/** Calls `refresh` at each delay; returns a function that cancels the reads not yet made. */
export function refreshBalanceAfterSettle(refresh: () => void): () => void {
  const timers = BALANCE_AFTER_SETTLE_DELAYS_MS.map((ms) => setTimeout(() => { try { refresh(); } catch { /* a failed refresh keeps the last shown balance */ } }, ms));
  return () => { for (const t of timers) clearTimeout(t); };
}
