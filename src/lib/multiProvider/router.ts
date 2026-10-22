import { effectiveJobPointsCap } from "../jobPointsCap";
import { maxVolumeUnderCap, reserveForUnits, chargeForUnits, unitPricePointsFromCost } from "../recordPricing";
import { unitPricePointsForCapability } from "../../functions/shared/quotes";
import { capabilityById } from "./catalog";
import { CHAIN_CAPABILITY_SLUG, ROUTE_DEFS, YIELD, estimateRoute, type RouteEstimate } from "./routes";
import type { DataProviderId, RouteDef, RouteRequest } from "./types";

/**
 * The router: deterministic first, model second.
 *  1. CODE builds the list of ALLOWED routes (flag on, provider enabled, key present, health ok, daily-cap headroom, estimated cost
 *     within the job cap, every capability verified, the request covered).
 *  2. The MODEL may only CHOOSE among them, as small structured JSON; code validates the choice. An invalid choice, a failed call or no
 *     model at all means code picks the cheapest allowed route. At most one short model call per plan.
 * The model never decides or states a price, a cap, or whether a spend is allowed: it is shown route ids, short strengths and a cost
 * RANK, and its answer carries no number that anything reads.
 */

export interface ProviderState {
  enabled: boolean;
  keyPresent: boolean;
  healthOk: boolean;
  /** The admin-editable daily limit of this provider (USD). 0 blocks every spend. */
  dailyCapUsd: number;
  /** What this provider has really cost the platform since the UTC day started (read from provider_costs). */
  spentTodayUsd: number;
}

export interface RouterState {
  flagOn: boolean;
  providers: Record<DataProviderId, ProviderState>;
  /** The per-job points cap in force (`effectiveJobPointsCap`). */
  jobCapPoints: number;
}

export function defaultRouterState(flagOn: boolean, providers: Record<DataProviderId, ProviderState>): RouterState {
  return { flagOn, providers, jobCapPoints: effectiveJobPointsCap() };
}

export type ExclusionReason =
  | "flag_off" | "provider_disabled" | "key_missing" | "unhealthy" | "cap_exceeded"
  | "unverified_price" | "blocked_capability" | "not_covering" | "over_job_cap" | "no_volume";

export interface ExcludedRoute { routeId: string; reason: ExclusionReason; provider?: DataProviderId; capabilityId?: string }

export interface AllowedRoute {
  id: string;
  route: RouteDef;
  estimate: RouteEstimate;
  /** Rows the plan can hold under the job cap (never above the request). */
  count: number;
  /** The job's unit price in points: the ONE shared rule applied to the cost of one delivered row. */
  unitPricePoints: number;
  /** Fractional unit price of each stage (informational: how the price splits). */
  stageUnitPricePoints: Array<{ stage: string; points: number }>;
  /** ceil(count x unit x 1.15): the reserve of the plan. */
  reservePoints: number;
  /** ceil(count x unit): what is charged when every planned row is delivered. */
  chargeAtTargetPoints: number;
}

export interface RouteList { allowed: AllowedRoute[]; excluded: ExcludedRoute[] }

function plannedProviders(estimate: RouteEstimate): DataProviderId[] {
  return [...new Set(estimate.stages.map((s) => s.provider).filter((p): p is DataProviderId => p !== null))];
}

/** Builds the allowed routes for a request. Pure: every fact it needs is in `state`. */
export function buildAllowedRoutes(request: RouteRequest, state: RouterState, routes: RouteDef[] = ROUTE_DEFS): RouteList {
  const allowed: AllowedRoute[] = [];
  const excluded: ExcludedRoute[] = [];
  const exclude = (routeId: string, reason: ExclusionReason, extra: Partial<ExcludedRoute> = {}) => excluded.push({ routeId, reason, ...extra });

  for (const route of routes) {
    if (!state.flagOn) { exclude(route.id, "flag_off"); continue; }
    if (!(request.count >= 1)) { exclude(route.id, "no_volume"); continue; }
    const first = estimateRoute(route, request);
    if (!first.sellable) { exclude(route.id, first.blockedBy?.reason === "unverified_price" ? "unverified_price" : "blocked_capability", { capabilityId: first.blockedBy?.capabilityId }); continue; }
    if (!first.covers) { exclude(route.id, "not_covering"); continue; }
    // Every capability that could serve a stage must be sellable too: a fallback with an unverified price is never used.
    const unitPricePoints = unitPricePointsForCapability({ slug: CHAIN_CAPABILITY_SLUG, unitCostUsd: first.costPerDeliveredRowUsd });
    if (!(unitPricePoints > 0)) { exclude(route.id, "no_volume"); continue; }
    const fitting = Math.min(Math.floor(request.count), maxVolumeUnderCap(state.jobCapPoints, unitPricePoints, YIELD.budgetBuffer));
    if (fitting < 1) { exclude(route.id, "over_job_cap"); continue; }
    const estimate = fitting === Math.floor(request.count) ? first : estimateRoute(route, { ...request, count: fitting });

    let blocked: ExcludedRoute | null = null;
    for (const provider of plannedProviders(estimate)) {
      const p = state.providers[provider];
      if (!p || !p.enabled) { blocked = { routeId: route.id, reason: "provider_disabled", provider }; break; }
      if (!p.keyPresent) { blocked = { routeId: route.id, reason: "key_missing", provider }; break; }
      if (!p.healthOk) { blocked = { routeId: route.id, reason: "unhealthy", provider }; break; }
      const needed = (estimate.providerJobUsd[provider] ?? 0) * (1 + YIELD.budgetBuffer);
      if (p.dailyCapUsd <= 0 || p.spentTodayUsd + needed > p.dailyCapUsd + 1e-12) { blocked = { routeId: route.id, reason: "cap_exceeded", provider }; break; }
    }
    if (blocked) { excluded.push(blocked); continue; }

    allowed.push({
      id: route.id,
      route,
      estimate,
      count: fitting,
      unitPricePoints,
      stageUnitPricePoints: estimate.stages.filter((s) => s.costPerDeliveredRowUsd > 0).map((s) => ({ stage: s.stage, points: unitPricePointsFromCost(s.costPerDeliveredRowUsd) })),
      reservePoints: reserveForUnits(fitting, unitPricePoints, YIELD.budgetBuffer),
      chargeAtTargetPoints: chargeForUnits(fitting, unitPricePoints),
    });
  }
  return { allowed, excluded };
}

// ---- Choice ----------------------------------------------------------------------------------------------------------------

/** What the model sees about one allowed route. No USD, no points: a rank and plain strengths. */
export interface RouteOption { routeId: string; costRank: number; stages: string[]; strengths: string }

export type RouteChooser = (input: { options: RouteOption[]; request: { industry?: string; country?: string; requiredFields: string[]; count: number } }) => Promise<unknown>;

export interface RouteChoice {
  route: AllowedRoute;
  source: "model" | "cheapest_allowed" | "only_option";
  /** The model's one-line reason, when it chose and the choice was valid. Internal: never shown to a customer. */
  reason: string | null;
  /** Why code decided instead of the model, when it did. */
  fallbackReason?: "no_chooser" | "model_failed" | "invalid_choice";
}

const STRENGTH: Record<string, string> = {
  "treg.companies.search": "directory of companies with structured rows (name, website, country, industry); no contact data; measured cost per record; very cheap discovery",
  "firecrawl.search": "web search that returns page content candidates; best at finding companies a directory lacks; results are pages, filtered to homepages by code",
  "contextdev.search": "ranked web search; cheaper per 10 results; results are pages, filtered to homepages by code",
  "firecrawl.scrape": "reads public pages as text with links; deterministic; caching of recent pages; robots rules checked by code first",
  "contextdev.scrape": "reads public pages as markdown with per-output success flags; robots rules checked by code first",
};

export function routeOptions(allowed: AllowedRoute[]): RouteOption[] {
  const ranked = [...allowed].sort(byCost);
  return allowed.map((a) => ({
    routeId: a.id,
    costRank: ranked.findIndex((r) => r.id === a.id) + 1,
    stages: a.estimate.stages.map((s) => s.stage),
    strengths: a.estimate.stages.map((s) => (s.capabilityId ? STRENGTH[s.capabilityId] ?? capabilityById(s.capabilityId)?.reliabilityNote ?? "" : "contacts verified in code: domain match, mailto or label evidence")).filter(Boolean).join(" | "),
  }));
}

const byCost = (a: AllowedRoute, b: AllowedRoute) =>
  a.estimate.costPerDeliveredRowUsd - b.estimate.costPerDeliveredRowUsd || a.reservePoints - b.reservePoints || (a.id < b.id ? -1 : 1);

export function cheapestAllowed(allowed: AllowedRoute[]): AllowedRoute | null {
  return allowed.length ? [...allowed].sort(byCost)[0] : null;
}

/** Validates the model's answer: an exact route id from the allowed list and a short text reason. Anything else is invalid. */
export function validateChoice(raw: unknown, allowed: AllowedRoute[]): { routeId: string; reason: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.routeId !== "string") return null;
  const route = allowed.find((a) => a.id === obj.routeId);
  if (!route) return null;
  const reason = typeof obj.reason === "string" ? obj.reason.replace(/\s+/g, " ").trim().slice(0, 240) : "";
  return { routeId: route.id, reason };
}

/**
 * Picks the route. One allowed route needs no model. With several, ONE model call (at most) may choose; its answer is validated by
 * code, and any failure falls back to the cheapest allowed route that covers the request (every allowed route does).
 */
export async function chooseRoute(allowed: AllowedRoute[], request: RouteRequest, chooser?: RouteChooser | null): Promise<RouteChoice | null> {
  if (allowed.length === 0) return null;
  if (allowed.length === 1) return { route: allowed[0], source: "only_option", reason: null };
  const cheapest = cheapestAllowed(allowed) as AllowedRoute;
  if (!chooser) return { route: cheapest, source: "cheapest_allowed", reason: null, fallbackReason: "no_chooser" };
  let raw: unknown;
  try {
    raw = await chooser({ options: routeOptions(allowed), request: { industry: request.industry, country: request.country, requiredFields: request.requiredFields, count: request.count } });
  } catch {
    return { route: cheapest, source: "cheapest_allowed", reason: null, fallbackReason: "model_failed" };
  }
  const valid = validateChoice(raw, allowed);
  if (!valid) return { route: cheapest, source: "cheapest_allowed", reason: null, fallbackReason: "invalid_choice" };
  return { route: allowed.find((a) => a.id === valid.routeId) as AllowedRoute, source: "model", reason: valid.reason || null };
}
