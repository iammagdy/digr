"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/hooks/useUser";
import { balanceFailed, balanceLoading, balanceReady, type BalanceView } from "@/lib/honestDisplay";

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
  const [balance, setBalance] = useState<BalanceView>(balanceLoading());
  const lastReadAt = useRef(0);

  const refresh = useCallback(async () => {
    if (!user) return;
    lastReadAt.current = Date.now();
    try {
      const supabase = createClient();
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      const headers: Record<string, string> = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      // 1. Primary: Shared server-side balance endpoint
      const res = await fetch("/api/wallet/balance", { headers }).catch(() => null);
      if (res && res.ok) {
        const json = await res.json().catch(() => null);
        if (json?.success && typeof json.balance === "number") {
          setBalance(balanceReady(json.balance));
          return;
        }
      }

      // 2. Direct client fallback strictly filtered by user.id
      const { data, error } = await supabase
        .from("credit_ledger")
        .select("delta")
        .eq("user_id", user.id);

      if (error) {
        // A failed request proves nothing about the balance — never show a fake zero.
        setBalance(balanceFailed());
        return;
      }
      const total = (data || []).reduce((sum, row) => sum + (Number(row.delta) || 0), 0);
      setBalance(balanceReady(total));
    } catch {
      setBalance(balanceFailed());
    }
  }, [user]);

  useEffect(() => { void refresh(); }, [refresh]);

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
