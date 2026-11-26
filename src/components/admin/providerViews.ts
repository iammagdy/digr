import type { ProviderView } from "./ProviderTab";
import { PROVIDER_ANTHROPIC, PROVIDER_CONTEXTDEV, PROVIDER_FIRECRAWL, PROVIDER_TREG } from "../../lib/multiProvider/types";

export type ProviderTabId = typeof PROVIDER_TREG | typeof PROVIDER_FIRECRAWL | typeof PROVIDER_CONTEXTDEV | typeof PROVIDER_ANTHROPIC;
export const PROVIDER_TAB_IDS: ProviderTabId[] = [PROVIDER_TREG, PROVIDER_FIRECRAWL, PROVIDER_CONTEXTDEV, PROVIDER_ANTHROPIC];

/** The short views inside one provider. The model provider has no call log of its own; its last activity takes that place. */
export const providerViews = (tab: ProviderTabId): Array<[ProviderView, string]> => [
  ["status", "الحالة والرصيد"], ["keys", "المفاتيح"], ["limits", "الحدود"], ["calls", tab === "anthropic" ? "آخر النشاط" : "سجل المكالمات"],
];

/** `/admin/providers?p=treg&v=keys`: which provider and which view to open. Anything unknown falls back to the first provider's status view. */
export function parseProvidersQuery(search: string): { tab: ProviderTabId; view: ProviderView } {
  const q = new URLSearchParams(search);
  const p = q.get("p") as ProviderTabId | null;
  const v = q.get("v") as ProviderView | null;
  const tab = p && PROVIDER_TAB_IDS.includes(p) ? p : PROVIDER_TREG;
  const view = v && providerViews(tab).some(([id]) => id === v) ? v : "status";
  return { tab, view };
}

export const providersQuery = (tab: ProviderTabId, view: ProviderView): string => (tab === PROVIDER_TREG && view === "status" ? "" : `?p=${tab}&v=${view}`);
