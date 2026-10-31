"use client";

import { useEffect, useState } from "react";
import { ClientsPanel } from "@/components/admin/invoices/ClientsPanel";
import { InvoiceList } from "@/components/admin/invoices/InvoiceList";
import { ItemTypesPanel } from "@/components/admin/invoices/ItemTypesPanel";
import { SettingsPanel } from "@/components/admin/invoices/SettingsPanel";

const TABS = [["docs", "الوثائق"], ["types", "أنواع البنود"], ["clients", "العملاء"], ["settings", "بيانات البائع"]] as const;
type Tab = (typeof TABS)[number][0];

/** «الفواتير»: quotes and invoices for hand-made research work. Admin only, and separate from the points wallet. */
export default function AdminInvoicesPage() {
  const [tab, setTab] = useState<Tab>("docs");
  useEffect(() => {
    const h = window.location.hash.replace("#", "") as Tab;
    if (TABS.some(([id]) => id === h)) setTab(h);
  }, []);
  const choose = (t: Tab) => { setTab(t); try { window.history.replaceState(null, "", `#${t}`); } catch { /* ignore */ } };
  return (
    <div data-screen-label="Invoices" className="flex min-w-0 flex-col gap-3.5">
      <div className="flex min-w-0 flex-wrap gap-2" role="tablist" aria-label="أقسام الفواتير">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => choose(id)}
            className={`min-h-[44px] rounded-xl border px-4 text-[13px] font-semibold ${tab === id ? "border-ink bg-ink text-sf" : "border-ln bg-sf text-ink"}`} data-testid={`tab-${id}`}>{label}</button>
        ))}
      </div>
      {tab === "docs" ? <InvoiceList /> : null}
      {tab === "types" ? <ItemTypesPanel /> : null}
      {tab === "clients" ? <ClientsPanel /> : null}
      {tab === "settings" ? <SettingsPanel /> : null}
    </div>
  );
}
