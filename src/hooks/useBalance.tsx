"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/hooks/useUser";
import { balanceFailed, balanceLoading, balanceReady, type BalanceView } from "@/lib/honestDisplay";

interface BalanceContextValue {
  /** Available points = sum of credit_ledger deltas. Holds (reserve) are negative deltas, so held points are already excluded. */
  balance: BalanceView;
  refresh: () => Promise<void>;
}

const BalanceContext = createContext<BalanceContextValue>({ balance: balanceLoading(), refresh: async () => {} });

export function BalanceProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const [balance, setBalance] = useState<BalanceView>(balanceLoading());

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("credit_ledger")
        .select("delta");

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
    window.addEventListener("digr:balance-changed", on);
    window.addEventListener("focus", on);
    return () => { window.removeEventListener("digr:balance-changed", on); window.removeEventListener("focus", on); };
  }, [refresh]);

  const value = useMemo(() => ({ balance, refresh }), [balance, refresh]);
  return <BalanceContext.Provider value={value}>{children}</BalanceContext.Provider>;
}

export const useBalance = () => useContext(BalanceContext);
