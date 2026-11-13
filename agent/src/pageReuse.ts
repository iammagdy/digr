import { countryOfRequestText } from "../../src/lib/agentMission/places";
import { siteOf } from "../../src/lib/agentMission/pageExtract";
import type { PricedPlan } from "../../src/lib/agentMission/plan";
import type { WebGatewayDeps } from "./webGateway";

/**
 * ROUND 60: THE EXECUTION'S PAGE RULES (agent/src/webGateway.ts `pageReuse`): one paid fetch per page, and a detail step that reads company pages buys them only for companies already SAVED
 * in the mission (live msn_088c: 5 paid calls, $0.0127, read first-cosmetics.com after the 9 companies were saved without it; its contacts could never be delivered).
 */

/** The page sources a detail step may read company pages with. */
const PAGE_SOURCE = /^(?:contextdev\.(?:parse\.(?:emails|phone-numbers|links)|scrape)|firecrawl\.scrape)$/;
/** The fields of a saved company that name its own site (its LinkedIn or social page is not its site). */
const SITE_FIELD = /(?:^|_)(?:website|domain|homepage|site|url|web)$/i;
const SOCIAL_HOST = /(?:^|\.)(?:linkedin|facebook|instagram|twitter|x|tiktok|youtube|wa|whatsapp|linktr)\.(?:com|me|ee)$/i;

interface AcceptedRows { acceptedRows(key: string): Array<Record<string, unknown>> }

/** The sites of the saved parents of the page-reading detail steps; null when no such step exists or when saved parents carry no site at all (no rule can be read then). */
export function savedParentSites(plan: Pick<PricedPlan, "stages">, items: AcceptedRows): Set<string> | null {
  const parents = [...new Set(plan.stages.filter((s) => s.parent_key && s.deliver !== false && PAGE_SOURCE.test(String(s.endpoint_id ?? ""))).map((s) => s.parent_key as string))];
  if (parents.length === 0) return null;
  const sites = new Set<string>();
  let saved = 0;
  let withSite = 0;
  for (const key of parents) {
    for (const row of items.acceptedRows(key)) {
      saved += 1;
      let has = false;
      for (const [field, value] of Object.entries(row)) {
        if (!SITE_FIELD.test(field) || typeof value !== "string" || !value.trim()) continue;
        const site = siteOf(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
        if (site && !SOCIAL_HOST.test(site)) { sites.add(site); has = true; }
      }
      if (has) withSite += 1;
    }
  }
  // companies are saved but none names its site: the rule cannot tell one company's page from another's, so it does not stop anything
  if (saved > 0 && withSite === 0) return null;
  return sites;
}

export function executionPageReuse(mission: { request_text?: string | null }, plan: Pick<PricedPlan, "stages">, items: () => AcceptedRows | undefined): NonNullable<WebGatewayDeps["pageReuse"]> {
  return {
    countryHint: countryOfRequestText(String(mission.request_text ?? "")),
    parentSites: async () => { const store = items(); return store ? savedParentSites(plan, store) : null; },
  };
}
