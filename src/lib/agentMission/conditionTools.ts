import type { TregCatalog } from "../treg/catalog";
import { rankedHelpers } from "./contactFinders";
import type { StatsMap } from "./sourceRanking";
import { toolProfile } from "./toolProfile";

/**
 * D7 (docs/REDESIGN.md section 2.3, S4): when the customer names a country, a tool that can EXPRESS it in its own inputs wins over one that cannot, even if it costs more. The tools of the same capability (a search of the same platform) whose country input really filters, cheapest first. Pure.
 * An input that only places the request (a proxy region) does not count (toolProfile `enforces`).
 */
export interface CountryTool { id: string; usd: number; field: string }

export function countryToolsFor(currentId: string, catalog: TregCatalog, o: { isAllowed: (id: string) => boolean; stats?: StatsMap; now?: number }): CountryTool[] {
  const current = catalog.byId.get(currentId);
  if (!current?.capability) return [];
  const usable = catalog.endpoints.filter((e) => e.id !== currentId && e.platform === current.platform && e.capability === current.capability && e.kind === "direct" && !e.async && o.isAllowed(e.id) && toolProfile(e).country?.enforces === true);
  return rankedHelpers(usable, catalog, o.stats ?? new Map(), o.now ?? Date.now()).map((r) => ({ id: r.id, usd: r.usd, field: toolProfile(catalog.byId.get(r.id)!).country!.field }));
}
