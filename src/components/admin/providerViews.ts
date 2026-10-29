import type { ProviderView } from "./ProviderTab";

export type ProviderTabId = "treg" | "firecrawl" | "contextdev" | "anthropic";
export const PROVIDER_TAB_IDS: ProviderTabId[] = ["treg", "firecrawl", "contextdev", "anthropic"];

/** The short views inside one provider. The model provider has no call log of its own; its last activity takes that place. */
export const providerViews = (tab: ProviderTabId): Array<[ProviderView, string]> => [
  ["status", "الحالة والرصيد"], ["keys", "المفاتيح"], ["limits", "الحدود"], ["calls", tab === "anthropic" ? "آخر النشاط" : "سجل المكالمات"],
];

/** `/admin/providers?p=treg&v=keys`: which provider and which view to open. Anything unknown falls back to the first provider's status view. */
export function parseProvidersQuery(search: string): { tab: ProviderTabId; view: ProviderView } {
  const q = new URLSearchParams(search);
  const p = q.get("p") as ProviderTabId | null;
  const v = q.get("v") as ProviderView | null;
  const tab = p && PROVIDER_TAB_IDS.includes(p) ? p : "treg";
  const view = v && providerViews(tab).some(([id]) => id === v) ? v : "status";
  return { tab, view };
}

export const providersQuery = (tab: ProviderTabId, view: ProviderView): string => (tab === "treg" && view === "status" ? "" : `?p=${tab}&v=${view}`);
