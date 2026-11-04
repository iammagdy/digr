"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/hooks/useUser";
import { balanceFailed, balanceLoading, balanceReady, type BalanceView } from "@/lib/honestDisplay";
import { balanceForUser } from "@/lib/balanceForUser";
import { readBalanceForSession } from "@/lib/readBalance";

interface BalanceContextValue {
  /** Available points = sum of credit_ledger deltas. Holds (reserve) are negative deltas, so held points are already excluded. */
  balance: BalanceView;
  refresh: () => Promise<void>;
}

/** A return to the tab refreshes the balance only when the last read is older than this. */
export const BALANCE_FOCUS_MIN_GAP_MS = 20_000;

const BalanceContext = createContext<BalanceContextValue>({ balance: balanceLoading(), refresh: async () => {} });

export function BalanceProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const [cached, setCached] = useState<{ ownerId: string | null; balance: BalanceView }>({ ownerId: null, balance: balanceLoading() });
  const balance = balanceForUser(cached, user?.id ?? null);
  const lastReadAt = useRef(0);
  const userIdRef = useRef<string | null>(user?.id ?? null);
  userIdRef.current = user?.id ?? null;
  /** The read that is on its way, and the account of the last read that started: a read already running is shared, never doubled. */
  const inflight = useRef<Promise<void> | null>(null);
  const startedFor = useRef<string | null>(null);

  // The read comes from the stored session itself, so it starts on mount in parallel with the page (it no longer waits for the page to render the user first).
  const refresh = useCallback(async () => {
    lastReadAt.current = Date.now();
    const run = (async () => {
      try {
        const read = await readBalanceForSession(createClient() as any, (input, init) => fetch(input, init), userIdRef.current);
        if (!read) return;
        startedFor.current = read.ownerId;
        setCached({ ownerId: read.ownerId, balance: read.balance });
      } catch {
        // A failed request proves nothing about the balance: it stays a skeleton or «غير متاح», never a fake zero.
        if (userIdRef.current) setCached({ ownerId: userIdRef.current, balance: balanceFailed() });
      }
    })();
    inflight.current = run;
    try { await run; } finally { if (inflight.current === run) inflight.current = null; }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // A different account (sign-in, sign-out, a switch) is read again, unless the read that is already running (or done) is for that account.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) { startedFor.current = null; return; }
    let cancelled = false;
    void (async () => {
      if (inflight.current) await inflight.current;
      if (!cancelled && startedFor.current !== userId) await refresh();
    })();
    return () => { cancelled = true; };
  }, [userId, refresh]);

  // Pages dispatch this after anything that moves points (approve quote, top-up, refund).
  useEffect(() => {
    const on = () => void refresh();
    // Switching back to the tab on a phone fires «focus» again and again: a read less than 20 s old is still true, so no new call.
    const onFocus = () => { if (Date.now() - lastReadAt.current >= BALANCE_FOCUS_MIN_GAP_MS) void refresh(); };
    window.addEventListener("diger:balance-changed", on);
    window.addEventListener("focus", onFocus);
    return () => { window.removeEventListener("diger:balance-changed", on); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  const value = useMemo(() => ({ balance, refresh }), [balance, refresh]);
  return <BalanceContext.Provider value={value}>{children}</BalanceContext.Provider>;
}

export const useBalance = () => useContext(BalanceContext);
