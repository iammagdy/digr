import { unitPricePointsFromCost } from "../recordPricing";
import { CAPABILITIES, capabilityById, isSellable } from "./catalog";
import type { CapabilityDef, DataField, DataProviderId, RequiredField, RouteDef, RouteRequest, RouteStage } from "./types";

/**
 * Routes and chains. A chain is explicit and bounded: discover companies, read each company's public contact pages, verify in code.
 * Every stage lists the capabilities it may use (the planned one first, then the fallbacks) and a hard bound on its billed calls.
 * Prices come from the capability registry; the yields below are ASSUMED (conservative) until a verification run measures them,
 * exactly like the per-record costs that are marked ASSUMED in `recordPricing.ts`.
 */

/** The slug of the one capability the customer's plan carries when the feature is on. Contains none of the words the worker uses to guess a directory or social job. */
export const CHAIN_CAPABILITY_SLUG = "mp-business-contacts";
export const isChainSlug = (slug: string | undefined | null): boolean => slug === CHAIN_CAPABILITY_SLUG;

export const YIELD = {
  /** Share of discovered results that become a candidate company with a readable homepage. ASSUMED, conservative. */
  websiteShare: { "treg.companies.search": 0.7, "firecrawl.search": 0.5, "contextdev.search": 0.5 } as Record<string, number>,
  /** Share of candidates whose public pages give a VERIFIED value of every required field. ASSUMED, conservative. */
  verifiedShare: { none: 0.45, email: 0.35, phone: 0.45, both: 0.25 },
  /** A decision maker also needs a team page that lists leaders with a leadership title: this factor on the share above, and this share when it is the only field asked. ASSUMED, conservative. */
  decisionMakerFactor: 0.6,
  decisionMakerOnlyShare: 0.3,
  /** Pages read per candidate: the homepage (it lists the contact page) and one contact page. */
  pagesPerCompany: 2,
  /** The provider-spend allowance above the estimate: the same 15% buffer the reserve carries. */
  budgetBuffer: 0.15,
} as const;

export const HARD_LIMITS = {
  /** Most discovery results of one job (a search returns at most 100 in one call). */
  maxDiscoveryResults: 100,
  /** Most candidate companies enriched in one job. */
  maxCandidates: 200,
  /** Most billed enrichment calls of one job. */
  maxEnrichCalls: 420,
  /** Most TREG directory pages of one job. */
  maxDirectoryPages: 12,
} as const;

export function verifiedShareFor(required: RequiredField[]): number {
  const email = required.includes("work_email");
  const phone = required.includes("office_phone");
  const decision = required.includes("decision_maker");
  if (decision && !email && !phone) return YIELD.decisionMakerOnlyShare;
  const contact = email && phone ? YIELD.verifiedShare.both : email ? YIELD.verifiedShare.email : phone ? YIELD.verifiedShare.phone : YIELD.verifiedShare.none;
  return decision ? contact * YIELD.decisionMakerFactor : contact;
}

const DISCOVERY_IDS = ["treg.companies.search", "firecrawl.search", "contextdev.search"] as const;
const SCRAPE_IDS = ["firecrawl.scrape", "contextdev.scrape"] as const;
const SHORT: Record<DataProviderId, string> = { treg: "treg", firecrawl: "firecrawl", contextdev: "contextdev" };

const cap = (id: string): CapabilityDef => capabilityById(id) as CapabilityDef;

/** The discovery capabilities ordered with the planned one first, then the rest by cost per result (the cheapest fallback first). */
function ordered(ids: readonly string[], first: string): string[] {
  const rest = ids.filter((id) => id !== first).sort((a, b) => (cap(a)?.costPerUnitUsd ?? Infinity) - (cap(b)?.costPerUnitUsd ?? Infinity));
  return [first, ...rest];
}

/** Every route the router may consider, built from the registry: one single-provider route and one chain per (discovery, reading) pair. */
export function buildRouteDefs(): RouteDef[] {
  const routes: RouteDef[] = [];
  routes.push({
    id: "single:treg-companies",
    kind: "single",
    stages: [{ stage: "discover", capabilityIds: ["treg.companies.search"], maxCalls: HARD_LIMITS.maxDirectoryPages }],
    fields: [...cap("treg.companies.search").fields],
  });
  for (const discover of DISCOVERY_IDS) {
    for (const read of SCRAPE_IDS) {
      const d = cap(discover);
      const r = cap(read);
      // The structured read of the same provider (a team page into names and titles) is part of the reading stage when it is sellable.
      const structured = capabilityById(r.provider === "firecrawl" ? "firecrawl.scrape_json" : "contextdev.scrape_json");
      const fields = new Set<DataField>([...d.fields, ...r.fields, ...(structured && isSellable(structured) ? structured.fields : [])]);
      routes.push({
        id: `chain:${SHORT[d.provider]}>${SHORT[r.provider]}`,
        kind: "chain",
        stages: [
          { stage: "discover", capabilityIds: ordered(DISCOVERY_IDS, discover), maxCalls: 0 },
          { stage: "enrich", capabilityIds: ordered(SCRAPE_IDS, read), maxCalls: 0 },
          { stage: "verify", capabilityIds: [], maxCalls: 0 },
        ],
        fields: [...fields],
      });
    }
  }
  return routes;
}

export const ROUTE_DEFS: RouteDef[] = buildRouteDefs();
export const routeById = (id: string): RouteDef | undefined => ROUTE_DEFS.find((r) => r.id === id);

/**
 * The plan item stores an OPAQUE route code, never the route id: the id names the providers («chain:firecrawl>contextdev»), and a
 * plan item travels in the quote the customer's browser receives. The code is a short hash of the id; only code can map it back.
 */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
export const routeCodeOf = (routeId: string): string => `r${fnv1a(`digr-route:${routeId}`)}`;
export const routeByCode = (code: unknown): RouteDef | undefined => (typeof code === "string" ? ROUTE_DEFS.find((r) => routeCodeOf(r.id) === code) : undefined);

export interface StageEstimate {
  stage: RouteStage["stage"];
  capabilityId: string | null;
  provider: DataProviderId | null;
  /** Billed calls this stage may make in one job (the hard bound). */
  maxCalls: number;
  /** USD this stage costs per DELIVERED row at the assumed yields. */
  costPerDeliveredRowUsd: number;
  /** The unit price of this stage in points per delivered row (fractional, informational: the job's price is the shared rule on the total). */
  unitPricePoints: number;
  /** The share of what enters the stage that goes on to the next one (ASSUMED until measured). */
  expectedYield: number | null;
  /** Provider USD this stage may spend in the whole job (estimate, before the buffer). */
  jobUsd: number;
}

export interface RouteEstimate {
  route: RouteDef;
  /** Null when a stage's capability is not sellable (an unverified price, a data policy block) or the route cannot deliver the request. */
  sellable: boolean;
  blockedBy?: { capabilityId: string; reason: "unverified_price" | "data_policy" | "unbounded_cost" | "unknown" };
  covers: boolean;
  stages: StageEstimate[];
  /** Candidate results the discovery stage must ask for, and candidate companies the enrichment stage reads. */
  discoveryResults: number;
  candidates: number;
  costPerDeliveredRowUsd: number;
  /** Provider USD of the whole job (estimate) per provider. */
  providerJobUsd: Partial<Record<DataProviderId, number>>;
  estimatedJobUsd: number;
  /** The most the job may spend with providers: the estimate plus the 15% buffer. */
  budgetUsd: number;
}

const round9 = (n: number) => Math.round(n * 1e9) / 1e9;

function coversRequest(route: RouteDef, required: RequiredField[]): boolean {
  const have = new Set<DataField>(route.fields);
  return required.every((f) => have.has(f));
}

/** Estimates one route for one request: the cost per delivered row by stage, the calls each stage may make, and the provider spend of the job. */
export function estimateRoute(route: RouteDef, request: RouteRequest): RouteEstimate {
  const count = Math.max(0, Math.floor(request.count));
  const covers = coversRequest(route, request.requiredFields);
  const base: RouteEstimate = { route, sellable: true, covers, stages: [], discoveryResults: 0, candidates: 0, costPerDeliveredRowUsd: 0, providerJobUsd: {}, estimatedJobUsd: 0, budgetUsd: 0 };

  const discoverStage = route.stages.find((s) => s.stage === "discover");
  const enrichStage = route.stages.find((s) => s.stage === "enrich");
  const discoverCap = discoverStage ? cap(discoverStage.capabilityIds[0]) : undefined;
  const enrichCap = enrichStage ? cap(enrichStage.capabilityIds[0]) : undefined;

  for (const c of [discoverCap, enrichCap]) {
    if (c && !isSellable(c)) {
      return { ...base, sellable: false, blockedBy: { capabilityId: c.id, reason: c.blockedReason ?? "unknown" } };
    }
  }
  if (!discoverCap) return { ...base, sellable: false, blockedBy: { capabilityId: "none", reason: "unknown" } };

  const websiteShare = route.kind === "single" ? 1 : (YIELD.websiteShare[discoverCap.id] ?? 0.5);
  const verified = route.kind === "single" ? 1 : verifiedShareFor(request.requiredFields);
  const deliveredPerResult = websiteShare * verified;

  const discoveryUsdPerResult = discoverCap.costPerUnitUsd ?? 0;
  const needsDecisionMaker = request.requiredFields.includes("decision_maker");
  const needsContact = request.requiredFields.some((f) => f === "work_email" || f === "office_phone");
  // The homepage always; a contact page when an email or phone is asked; a team page (structured read, its own price) when a decision maker is asked.
  const plainPages = needsContact || !needsDecisionMaker ? YIELD.pagesPerCompany : 1;
  const pages = plainPages + (needsDecisionMaker ? 1 : 0);
  const structuredCap = enrichCap ? capabilityById(enrichCap.provider === "firecrawl" ? "firecrawl.scrape_json" : "contextdev.scrape_json") : undefined;
  const structuredSellable = Boolean(structuredCap && isSellable(structuredCap));
  const enrichUsdPerCandidate = route.kind === "single" || !enrichCap
    ? 0
    : plainPages * (enrichCap.costPerUnitUsd ?? 0) + (needsDecisionMaker && structuredSellable ? (structuredCap!.costPerUnitUsd ?? 0) : 0);
  const usdPerResult = discoveryUsdPerResult + websiteShare * enrichUsdPerCandidate;
  const costPerDeliveredRowUsd = deliveredPerResult > 0 ? round9(usdPerResult / deliveredPerResult) : 0;

  const results = deliveredPerResult > 0 ? Math.ceil(count / deliveredPerResult) : 0;
  const discoveryResults = Math.min(results, route.kind === "single" ? HARD_LIMITS.maxDirectoryPages * (discoverCap.unitsPerCall || 10) : HARD_LIMITS.maxDiscoveryResults);
  const candidates = route.kind === "single" ? discoveryResults : Math.min(Math.ceil(discoveryResults * websiteShare), HARD_LIMITS.maxCandidates);

  const discoveryCalls = Math.max(1, Math.ceil(discoveryResults / (discoverCap.unitsPerCall || 1)));
  const discoverMaxCalls = route.kind === "single" ? Math.min(discoveryCalls, HARD_LIMITS.maxDirectoryPages) : Math.min(discoveryCalls + 1, 3);
  const enrichMaxCalls = route.kind === "single" ? 0 : Math.min(Math.ceil(candidates * pages), HARD_LIMITS.maxEnrichCalls);

  const discoverJobUsd = round9(discoveryResults * discoveryUsdPerResult);
  const enrichJobUsd = round9(candidates * enrichUsdPerCandidate);
  const stagePoints = (usdPerRow: number) => (usdPerRow > 0 ? unitPricePointsFromCost(usdPerRow) : 0);
  const discoverUsdRow = deliveredPerResult > 0 ? round9(discoveryUsdPerResult / deliveredPerResult) : 0;
  const stages: StageEstimate[] = [
    { stage: "discover", capabilityId: discoverCap.id, provider: discoverCap.provider, maxCalls: discoverMaxCalls, costPerDeliveredRowUsd: discoverUsdRow, unitPricePoints: stagePoints(discoverUsdRow), expectedYield: route.kind === "single" ? 1 : websiteShare, jobUsd: discoverJobUsd },
  ];
  if (route.kind === "chain" && enrichCap) {
    const enrichUsdRow = deliveredPerResult > 0 ? round9((websiteShare * enrichUsdPerCandidate) / deliveredPerResult) : 0;
    stages.push({ stage: "enrich", capabilityId: enrichCap.id, provider: enrichCap.provider, maxCalls: enrichMaxCalls, costPerDeliveredRowUsd: enrichUsdRow, unitPricePoints: stagePoints(enrichUsdRow), expectedYield: verified, jobUsd: enrichJobUsd });
    stages.push({ stage: "verify", capabilityId: null, provider: null, maxCalls: 0, costPerDeliveredRowUsd: 0, unitPricePoints: 0, expectedYield: 1, jobUsd: 0 });
  }

  const providerJobUsd: Partial<Record<DataProviderId, number>> = {};
  for (const s of stages) if (s.provider) providerJobUsd[s.provider] = round9((providerJobUsd[s.provider] ?? 0) + s.jobUsd);
  const estimatedJobUsd = round9(stages.reduce((a, s) => a + s.jobUsd, 0));
  return {
    ...base,
    stages,
    discoveryResults,
    candidates,
    costPerDeliveredRowUsd,
    providerJobUsd,
    estimatedJobUsd,
    budgetUsd: round9(estimatedJobUsd * (1 + YIELD.budgetBuffer)),
  };
}

export const ALL_CAPABILITY_IDS = CAPABILITIES.map((c) => c.id);
