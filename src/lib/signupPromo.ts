/**
 * The promo code of a QR / invitation link: carried through sign-up and the e-mail confirmation (which happens in another tab or app)
 * in the browser's own storage, then redeemed ONCE after the account is verified, through the existing redeem route. Nothing here is
 * trusted by the server: the redeem route validates the code, its limits and the account exactly as it does for a typed code.
 */
export const PENDING_PROMO_KEY = "diger.pendingPromo";
/** The redeem route's own limits apply; this only keeps the client from retrying a failing code forever. */
export const PENDING_PROMO_MAX_ATTEMPTS = 3;

/** A code as the redeem box takes it: upper case, letters, digits, dash and underscore, 3 to 40 characters; otherwise null. */
export function normalizePromoCode(raw: unknown): string | null {
  const value = String(raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return /^[A-Z0-9_-]{3,40}$/.test(value) ? value : null;
}

export interface PendingPromo { code: string; attempts: number }

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function savePendingPromo(store: Store | null | undefined, raw: unknown): boolean {
  const code = normalizePromoCode(raw);
  if (!code || !store) return false;
  try { store.setItem(PENDING_PROMO_KEY, JSON.stringify({ code, attempts: 0 } satisfies PendingPromo)); return true; } catch { return false; }
}

export function readPendingPromo(store: Store | null | undefined): PendingPromo | null {
  if (!store) return null;
  try {
    const parsed = JSON.parse(store.getItem(PENDING_PROMO_KEY) || "null");
    const code = normalizePromoCode(parsed?.code);
    const attempts = Number(parsed?.attempts);
    return code ? { code, attempts: Number.isFinite(attempts) && attempts >= 0 ? Math.floor(attempts) : 0 } : null;
  } catch {
    return null;
  }
}

export function notePromoAttempt(store: Store | null | undefined, pending: PendingPromo): void {
  try { store?.setItem(PENDING_PROMO_KEY, JSON.stringify({ code: pending.code, attempts: pending.attempts + 1 })); } catch { /* nothing to keep */ }
}

export function clearPendingPromo(store: Store | null | undefined): void {
  try { store?.removeItem(PENDING_PROMO_KEY); } catch { /* nothing to clear */ }
}

/** Where a QR or short link goes: the sign-up page with the code in the field. A malformed code is dropped, never carried. */
export function registerPathForCode(raw: unknown): string {
  const code = normalizePromoCode(raw);
  return code ? `/register?promo=${encodeURIComponent(code)}` : "/register";
}
