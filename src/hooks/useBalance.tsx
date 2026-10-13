"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Query } from "appwrite";
import { databases } from "@/lib/appwrite";
import { useUser } from "@/hooks/useUser";
import { balanceFailed, balanceLoading, balanceReady, type BalanceView } from "@/lib/honestDisplay";
import { CREDIT_LEDGER_COLLECTION, DATABASE_ID } from "@/lib/constants";

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
      let total = 0;
      let offset = 0;
      const limit = 100;
      while (true) {
        const res = await databases.listDocuments(DATABASE_ID, CREDIT_LEDGER_COLLECTION, [
          Query.equal("userId", user.$id),
          Query.limit(limit),
          Query.offset(offset),
        ]);
        for (const doc of res.documents) total += (doc.delta as number) || 0;
        if (res.documents.length < limit) break;
        offset += limit;
      }
      setBalance(balanceReady(total));
    } catch {
      // A failed request proves nothing about the balance — never show a fake zero.
      setBalance(balanceFailed());
    }
  }, [user]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Pages dispatch this after anything that moves points (approve quote, top-up, refund).
  useEffect(() => {
    const on = () => void refresh();
    window.addEventListener("diger:balance-changed", on);
    window.addEventListener("focus", on);
    return () => { window.removeEventListener("diger:balance-changed", on); window.removeEventListener("focus", on); };
  }, [refresh]);

  const value = useMemo(() => ({ balance, refresh }), [balance, refresh]);
  return <BalanceContext.Provider value={value}>{children}</BalanceContext.Provider>;
}

export const useBalance = () => useContext(BalanceContext);
