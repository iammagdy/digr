"use client";

import { useEffect, useState } from "react";
import { PENDING_PROMO_MAX_ATTEMPTS, clearPendingPromo, notePromoAttempt, readPendingPromo } from "@/lib/signupPromo";

export interface PromoNotice { ok: boolean; text: string }

/**
 * The invitation code a visitor typed (or scanned) at sign-up is redeemed once, here, when the account is signed in and verified: through
 * the same redeem route a typed code uses, so every rule of the code applies. A code the server refuses is dropped with its plain reason;
 * a network failure keeps it for the next visit, a few times at most.
 */
export function usePendingPromo(enabled: boolean, onRedeemed: () => void): { notice: PromoNotice | null; dismiss: () => void } {
  const [notice, setNotice] = useState<PromoNotice | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const store = typeof window === "undefined" ? null : window.localStorage;
    const pending = readPendingPromo(store);
    if (!pending) return;
    if (pending.attempts >= PENDING_PROMO_MAX_ATTEMPTS) { clearPendingPromo(store); return; }
    let alive = true;
    notePromoAttempt(store, pending);
    (async () => {
      try {
        const response = await fetch("/api/wallet/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pending.code }) });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data?.success) {
          clearPendingPromo(store);
          onRedeemed();
          if (alive) setNotice({ ok: true, text: String(data.messageAr || "أضفنا نقاط الدعوة إلى رصيدك.") });
        } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          clearPendingPromo(store);
          if (alive) setNotice({ ok: false, text: String(data?.messageAr || "تعذر تطبيق كود الدعوة.") });
        }
        // 429, 5xx: the code stays for the next visit
      } catch { /* offline: it stays for the next visit */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return { notice, dismiss: () => setNotice(null) };
}
