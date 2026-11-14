import { blockedEndpointReason } from "../../treg/blockList";
import { loadTregCatalog } from "../../treg/catalog";
import { policyVerdict } from "../../treg/dataPolicy";
import { buildCapabilityRegistry } from "../capabilities";
import { loadRegistryArtifact, minLevelFor, routingFactsOf } from "../capabilities/routingFacts";
import type { ShadowContext } from "./compare";

/**
 * PHASE 7: THE SHADOW CONTEXT, built from the committed files only (the TREG catalog snapshot, the reviewed registry artifact, the data policy, the hand cards): no network, no database, no secret, no switch. Read once per process, like the catalog
 * snapshot and the registry artifact themselves. The registry is built for an ORDINARY account (the data policy a customer is held to), with the web providers assumed to have a key and a small cap (the worker's real key and cap facts are not read).
 */
let cached: ShadowContext | null = null;

export function buildShadowContext(options: { nowMs?: number } = {}): ShadowContext {
  if (cached && options.nowMs === undefined) return cached;
  const catalog = loadTregCatalog();
  const artifact = loadRegistryArtifact();
  const allowed = (id: string): boolean => !blockedEndpointReason(id) && policyVerdict(id, { isAdmin: false, verifiedBusiness: false }).allowed;
  const registry = buildCapabilityRegistry(catalog, { isAllowed: allowed, webKeys: { firecrawl: true, contextdev: true }, dailyCapUsd: { firecrawl: 1, contextdev: 1 }, handCards: true, extendedFamilies: true });
  const ctx: ShadowContext = {
    catalog, artifact, registry,
    facts: (account) => routingFactsOf(artifact, { minLevel: minLevelFor(account === "test") }),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  };
  if (options.nowMs === undefined) cached = ctx;
  return ctx;
}
