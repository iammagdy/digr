"use client";

import type { ReactNode } from "react";
import { BalanceProvider } from "@/hooks/useBalance";
import { AppShell } from "@/components/app/AppShell";

/**
 * THE ONE LAYOUT of every customer page that is not under /dashboard (the calculator, the catalog and its platform pages, the prices, the help page, the contact form, the terms and the privacy
 * page, the pages for each kind of customer): the same header with the logo, the same side menu and the same help links as the dashboard. A signed-in customer sees the balance and the bell; a
 * visitor sees the sign-in buttons. Before this, those pages had no header and no menu, only a text link «ديجر — العودة للصفحة الرئيسية».
 */
export default function SiteFrame({ children }: { children: ReactNode }) {
  return (
    <BalanceProvider>
      <AppShell allowGuest>{children}</AppShell>
    </BalanceProvider>
  );
}
