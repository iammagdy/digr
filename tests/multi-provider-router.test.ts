import { describe, expect, it, vi } from "vitest";
import { buildAllowedRoutes, chooseRoute, cheapestAllowed, routeOptions, validateChoice, type ProviderState, type RouterState } from "../src/lib/multiProvider/router";
import { CHAIN_CAPABILITY_SLUG, ROUTE_DEFS, YIELD, estimateRoute } from "../src/lib/multiProvider/routes";
import { capabilityById } from "../src/lib/multiProvider/catalog";
import { JOB_MAX_POINTS_CAP } from "../src/lib/jobPointsCap";
import { chargeForUnits, reserveForUnits, unitPricePointsFromCost } from "../src/lib/recordPricing";
import { calculateFinalSettlement, unitPricePointsForCapability } from "../src/functions/shared/quotes";
import type { RouteRequest } from "../src/lib/multiProvider/types";

const ok = (over: Partial<ProviderState> = {}): ProviderState => ({ enabled: true, keyPresent: true, healthOk: true, dailyCapUsd: 100, spentTodayUsd: 0, ...over });
const state = (over: Partial<RouterState> = {}, providers: Partial<Record<"treg" | "firecrawl" | "contextdev", ProviderState>> = {}): RouterState => ({
  flagOn: true, jobCapPoints: JOB_MAX_POINTS_CAP, providers: { treg: ok(), firecrawl: ok(), contextdev: ok(), ...providers }, ...over,
});
const request: RouteRequest = { industry: "مقاولات", country: "مصر", count: 3, requiredFields: ["work_email"] };

describe("the router: code builds the allowed routes", () => {
  it("lists every chain when everything is on, each with a reserve inside the job cap", () => {
    const { allowed, excluded } = buildAllowedRoutes(request, state());
    expect(allowed.map((a) => a.id).sort()).toEqual(ROUTE_DEFS.filter((r) => r.kind === "chain").map((r) => r.id).sort());
    expect(excluded.find((e) => e.routeId === "single:treg-companies")?.reason).toBe("not_covering");
    for (const a of allowed) expect(a.reservePoints).toBeLessThanOrEqual(JOB_MAX_POINTS_CAP);
  });

  it("flag off: nothing is allowed", () => {
    const { allowed, excluded } = buildAllowedRoutes(request, state({ flagOn: false }));
    expect(allowed).toEqual([]);
    expect(excluded.every((e) => e.reason === "flag_off")).toBe(true);
  });

  it("a disabled provider, a missing key and a failing health check each remove the routes that need it", () => {
    for (const [prov, reason] of [["firecrawl", "provider_disabled"], ["contextdev", "key_missing"], ["treg", "unhealthy"]] as const) {
      const bad = prov === "firecrawl" ? ok({ enabled: false }) : prov === "contextdev" ? ok({ keyPresent: false }) : ok({ healthOk: false });
      const { allowed, excluded } = buildAllowedRoutes(request, state({}, { [prov]: bad }));
      const mentions = (id: string) => id.includes(prov);
      expect(allowed.some((a) => a.estimate.stages.some((s) => s.provider === prov))).toBe(false);
      expect(excluded.filter((e) => e.reason === reason).length).toBeGreaterThan(0);
      expect(allowed.length).toBeGreaterThan(0);
      void mentions;
    }
  });

  it("a cap with no headroom blocks the route (the estimated spend plus the buffer must fit under the provider's daily cap)", () => {
    const base = buildAllowedRoutes(request, state()).allowed.find((a) => a.id === "chain:firecrawl>firecrawl")!;
    const need = (base.estimate.providerJobUsd.firecrawl ?? 0) * (1 + YIELD.budgetBuffer);
    expect(need).toBeGreaterThan(0);
    const tight = buildAllowedRoutes(request, state({}, { firecrawl: ok({ dailyCapUsd: need + 0.0001, spentTodayUsd: 0.001 }) }));
    expect(tight.excluded.find((e) => e.routeId === "chain:firecrawl>firecrawl")?.reason).toBe("cap_exceeded");
    const roomy = buildAllowedRoutes(request, state({}, { firecrawl: ok({ dailyCapUsd: need + 0.5, spentTodayUsd: 0.4 }) }));
    expect(roomy.allowed.some((a) => a.id === "chain:firecrawl>firecrawl")).toBe(true);
    const zero = buildAllowedRoutes(request, state({}, { firecrawl: ok({ dailyCapUsd: 0 }) }));
    expect(zero.allowed.some((a) => a.estimate.stages.some((s) => s.provider === "firecrawl"))).toBe(false);
  });

  it("an unverified price blocks the capability: a route that needs it is excluded", () => {
    const unverified = { ...capabilityById("firecrawl.scrape")!, priceStatus: "UNVERIFIED" as const, costPerUnitUsd: null, costPerCallUsd: null, creditsPerCall: null, blockedReason: "unverified_price" as const };
    const original = capabilityById("firecrawl.scrape")!;
    Object.assign(original, unverified);
    try {
      const { allowed, excluded } = buildAllowedRoutes(request, state());
      expect(allowed.some((a) => a.estimate.stages.some((s) => s.capabilityId === "firecrawl.scrape"))).toBe(false);
      expect(excluded.some((e) => e.reason === "unverified_price" && e.capabilityId === "firecrawl.scrape")).toBe(true);
    } finally {
      // restore the registry for the other tests
      Object.assign(original, { priceStatus: "VERIFIED", costPerUnitUsd: 0.005, costPerCallUsd: 0.005, creditsPerCall: 1, blockedReason: undefined });
      delete (original as any).blockedReason;
    }
    expect(buildAllowedRoutes(request, state()).allowed.length).toBeGreaterThan(0);
  });

  it("a request too big for the job cap is cut to what the cap holds, never above it; a request nothing can serve inside the cap is excluded", () => {
    const big = buildAllowedRoutes({ ...request, count: 5000 }, state());
    for (const a of big.allowed) { expect(a.count).toBeLessThan(5000); expect(a.reservePoints).toBeLessThanOrEqual(JOB_MAX_POINTS_CAP); }
    const none = buildAllowedRoutes(request, state({ jobCapPoints: 1 }));
    expect(none.allowed).toEqual([]);
    expect(none.excluded.every((e) => ["over_job_cap", "not_covering"].includes(e.reason))).toBe(true);
  });

  it("with no contact field required the directory route covers the request and is the cheapest", () => {
    const { allowed } = buildAllowedRoutes({ ...request, requiredFields: [] }, state());
    expect(allowed.some((a) => a.id === "single:treg-companies")).toBe(true);
    expect(cheapestAllowed(allowed)!.id).toBe("single:treg-companies");
  });
});

describe("charge arithmetic of a chain: the shared rule, per stage and in total", () => {
  const allowed = buildAllowedRoutes(request, state()).allowed;
  const route = allowed.find((a) => a.id === "chain:treg>firecrawl")!;

  it("the job unit price is the ONE shared rule applied to the cost of one delivered row; the stage prices add up to it (rounded up once)", () => {
    expect(route.unitPricePoints).toBe(unitPricePointsForCapability({ slug: CHAIN_CAPABILITY_SLUG, unitCostUsd: route.estimate.costPerDeliveredRowUsd }));
    const stageSum = route.estimate.stages.reduce((a, s) => a + unitPricePointsFromCost(s.costPerDeliveredRowUsd || 1e-9), 0);
    expect(route.stageUnitPricePoints.map((s) => s.stage)).toEqual(["discover", "enrich"]);
    expect(route.unitPricePoints).toBeGreaterThanOrEqual(route.stageUnitPricePoints.reduce((a, s) => a + s.points, 0) - 1e-6);
    expect(route.unitPricePoints).toBeLessThan(stageSum + route.estimate.stages.length + 1);
    // 5,500 points per USD of provider cost
    expect(route.unitPricePoints).toBeGreaterThanOrEqual(route.estimate.costPerDeliveredRowUsd * 5500);
    expect(route.unitPricePoints).toBeLessThan(route.estimate.costPerDeliveredRowUsd * 5500 + 1);
  });

  it("charge = ceil(delivered x unit), reserve = ceil(volume x unit x 1.15), a charge never passes the reserve", () => {
    expect(route.reservePoints).toBe(reserveForUnits(route.count, route.unitPricePoints, 0.15));
    expect(route.chargeAtTargetPoints).toBe(chargeForUnits(route.count, route.unitPricePoints));
    for (const delivered of [0, 1, route.count - 1, route.count, route.count + 5]) {
      const { chargePoints, refundPoints } = calculateFinalSettlement(delivered, route.unitPricePoints, route.reservePoints);
      expect(chargePoints).toBeLessThanOrEqual(route.reservePoints);
      expect(chargePoints + refundPoints).toBe(route.reservePoints);
      if (delivered <= route.count) expect(chargePoints).toBe(chargeForUnits(delivered, route.unitPricePoints));
    }
    expect(calculateFinalSettlement(0, route.unitPricePoints, route.reservePoints)).toEqual({ chargePoints: 0, refundPoints: route.reservePoints });
  });

  it("the provider budget of a job is the estimate plus 15%, per stage with its own call bound", () => {
    const e = estimateRoute(route.route, { ...request, count: route.count });
    expect(e.budgetUsd).toBeCloseTo(e.estimatedJobUsd * 1.15, 8);
    const discover = e.stages.find((s) => s.stage === "discover")!;
    const enrich = e.stages.find((s) => s.stage === "enrich")!;
    expect(discover.maxCalls).toBeGreaterThanOrEqual(1);
    expect(enrich.maxCalls).toBeGreaterThanOrEqual(e.candidates);
    expect(enrich.maxCalls).toBeLessThanOrEqual(420);
    expect(e.stages.find((s) => s.stage === "verify")).toMatchObject({ maxCalls: 0, jobUsd: 0 });
  });
});

describe("the model only chooses among allowed routes; code validates and falls back", () => {
  const { allowed } = buildAllowedRoutes(request, state());
  const cheapest = cheapestAllowed(allowed)!;
  const other = allowed.find((a) => a.id !== cheapest.id)!;

  it("accepts a valid choice and keeps its one-line reason", async () => {
    const chooser = vi.fn(async () => ({ routeId: other.id, reason: "الصفحات أوضح" }));
    const choice = await chooseRoute(allowed, request, chooser);
    expect(choice).toMatchObject({ source: "model", reason: "الصفحات أوضح" });
    expect(choice!.route.id).toBe(other.id);
    expect(chooser).toHaveBeenCalledTimes(1);
  });

  it("an invalid choice (unknown id, excluded route, wrong shape) falls back to the cheapest allowed route", async () => {
    for (const bad of [{ routeId: "chain:nope>nope", reason: "x" }, { routeId: "single:treg-companies", reason: "x" }, "chain:treg>firecrawl", null, { reason: "x" }, { routeId: 5 }, [other.id]]) {
      const choice = await chooseRoute(allowed, request, async () => bad);
      expect(choice).toMatchObject({ source: "cheapest_allowed", fallbackReason: "invalid_choice" });
      expect(choice!.route.id).toBe(cheapest.id);
    }
  });

  it("a model failure falls back to the cheapest allowed route; no chooser means the same; one option needs no model", async () => {
    expect(await chooseRoute(allowed, request, async () => { throw new Error("overloaded"); })).toMatchObject({ source: "cheapest_allowed", fallbackReason: "model_failed" });
    expect(await chooseRoute(allowed, request, null)).toMatchObject({ source: "cheapest_allowed", fallbackReason: "no_chooser" });
    const chooser = vi.fn();
    expect(await chooseRoute([allowed[0]], request, chooser)).toMatchObject({ source: "only_option" });
    expect(chooser).not.toHaveBeenCalled();
    expect(await chooseRoute([], request, chooser)).toBeNull();
  });

  it("a route whose provider is capped is never offered to the model, so it can never be chosen", async () => {
    const capped = buildAllowedRoutes(request, state({}, { firecrawl: ok({ dailyCapUsd: 0 }) }));
    const seen: string[] = [];
    const choice = await chooseRoute(capped.allowed, request, async ({ options }) => { seen.push(...options.map((o) => o.routeId)); return { routeId: "chain:treg>firecrawl", reason: "x" }; });
    expect(seen.some((id) => id.includes("firecrawl"))).toBe(false);
    expect(choice!.source).toBe("cheapest_allowed");
    expect(choice!.route.estimate.stages.some((s) => s.provider === "firecrawl")).toBe(false);
  });

  it("the model sees ids, stages, a cost RANK and strengths: no USD, no points, no cap", () => {
    const options = routeOptions(allowed);
    expect(options.map((o) => o.costRank).sort((a, b) => a - b)).toEqual(allowed.map((_, i) => i + 1));
    expect(JSON.stringify(options)).not.toMatch(/usd|\$|point|cap|price|0\.\d{3}/i);
    expect(validateChoice({ routeId: other.id, reason: "x".repeat(900) }, allowed)!.reason.length).toBeLessThanOrEqual(240);
  });
});
