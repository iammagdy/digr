import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAndSaveManagedQuote } from "../src/functions/shared/planManager";
import { APPROVED_CAPABILITY_CATALOG, getCatalogCapabilities, getEnabledCapabilitiesWithCoreServices, sanitizeCapabilitiesForLlm } from "../src/functions/shared/capabilityRegistry";
import { buildMultiProviderCapability, withMultiProviderCapabilities } from "../src/functions/shared/multiProviderCapability";
import { calculateFinalSettlement, DEFAULT_PRICING_SETTINGS, unitPricePointsForCapability } from "../src/functions/shared/quotes";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { setRouteChooserForTesting, setRouterStateForTesting, createClaudeRouteChooser, normalizeRequiredFields } from "../src/lib/server/multiProvider/planRouting";
import { buildAllowedRoutes, type ProviderState, type RouterState } from "../src/lib/multiProvider/router";
import { CHAIN_CAPABILITY_SLUG, routeByCode, routeCodeOf } from "../src/lib/multiProvider/routes";
import { customerFacingCapabilityLabel } from "../src/lib/customerFacingRequestLabels";
import { JOB_MAX_POINTS_CAP } from "../src/lib/jobPointsCap";
import { NO_ROUTE_AR } from "../src/lib/multiProvider/copy";
import { chargeForUnits, reserveForUnits } from "../src/lib/recordPricing";

const ok = (over: Partial<ProviderState> = {}): ProviderState => ({ enabled: true, keyPresent: true, healthOk: true, dailyCapUsd: 100, spentTodayUsd: 0, ...over });
const stateOf = (providers: Partial<Record<"treg" | "firecrawl" | "contextdev", ProviderState>> = {}, flagOn = true): RouterState => ({ flagOn, jobCapPoints: JOB_MAX_POINTS_CAP, providers: { treg: ok(), firecrawl: ok(), contextdev: ok(), ...providers } });

const mockTables: any = {
  from: () => {
    const chain: any = { select() { return this; }, eq() { return this; }, not() { return this; }, order() { return this; }, limit: async () => ({ data: [], error: null }), insert: async () => ({ error: null }), update() { return this; }, in() { return this; }, then(resolve: any) { resolve({ error: null }); } };
    return chain;
  },
};

const chainItem = (over: Record<string, any> = {}, volume = 3) => ({ capabilitySlug: CHAIN_CAPABILITY_SLUG, params: { industry: "مقاولات", country: "مصر", requiredFields: ["work_email"], ...over }, targetVolumeMin: 1, targetVolumeMax: volume });
const quote = (items: any[], balance = 100_000, capabilities = withMultiProviderCapabilities(APPROVED_CAPABILITY_CATALOG, { MULTI_PROVIDER_ENABLED: "true" })) =>
  createAndSaveManagedQuote(mockTables, { conversationId: "c_mp", userId: "u_mp", userBalance: balance, capabilities, pricingSettings: DEFAULT_PRICING_SETTINGS, plan: { summaryAr: "خطة", items, outputFormats: ["xlsx"] } });

let saved: string | undefined;
beforeEach(() => { saved = process.env.MULTI_PROVIDER_ENABLED; setProviderBalanceForTesting(1000); });
afterEach(() => {
  if (saved === undefined) delete process.env.MULTI_PROVIDER_ENABLED; else process.env.MULTI_PROVIDER_ENABLED = saved;
  setRouterStateForTesting(null); setRouteChooserForTesting(undefined); resetProviderBalanceCacheForTesting(); vi.restoreAllMocks();
});

describe("flag OFF: behaviour is the behaviour of main", () => {
  it("the catalog functions return the same list they were given, with no chain capability anywhere", async () => {
    delete process.env.MULTI_PROVIDER_ENABLED;
    const list = [...APPROVED_CAPABILITY_CATALOG];
    expect(withMultiProviderCapabilities(list)).toBe(list);
    for (const off of ["", "false", "0", "no", "TRUE1", "yes"]) expect(withMultiProviderCapabilities(list, { MULTI_PROVIDER_ENABLED: off })).toBe(list);
    const catalog = await getCatalogCapabilities();
    expect(catalog.map((c) => c.slug)).toEqual(APPROVED_CAPABILITY_CATALOG.map((c) => c.slug));
    expect((await getEnabledCapabilitiesWithCoreServices()).some((c) => c.slug === CHAIN_CAPABILITY_SLUG)).toBe(false);
    expect(sanitizeCapabilitiesForLlm(catalog).some((c) => c.slug === CHAIN_CAPABILITY_SLUG)).toBe(false);
  });

  it("a plan that names the chain capability is refused like any unknown service, and no router or model runs", async () => {
    delete process.env.MULTI_PROVIDER_ENABLED;
    const chooser = vi.fn();
    setRouteChooserForTesting(chooser);
    const withCap = [...APPROVED_CAPABILITY_CATALOG, buildMultiProviderCapability()];
    await expect(quote([chainItem()], 100_000, withCap)).rejects.toThrow("الخدمة المطلوبة غير معتمدة أو غير موجودة في الكتالوج.");
    expect(chooser).not.toHaveBeenCalled();
  });

  it("an existing capability is quoted exactly as before (the provider capacity gate still applies to it)", async () => {
    delete process.env.MULTI_PROVIDER_ENABLED;
    const q = await quote([{ capabilitySlug: "social-x-posts", params: { query: "x" }, targetVolumeMin: 1, targetVolumeMax: 300 }], 1_000_000, APPROVED_CAPABILITY_CATALOG);
    expect(q).toMatchObject({ expectedPoints: 36, quotedPoints: 41, targetVolumeMax: 300 });
  });
});

describe("flag ON: the capability, the label and the quote", () => {
  beforeEach(() => { process.env.MULTI_PROVIDER_ENABLED = "true"; });

  it("adds the chain capability once, with an Arabic customer label and no people wording", async () => {
    const catalog = await getCatalogCapabilities();
    expect(catalog.filter((c) => c.slug === CHAIN_CAPABILITY_SLUG)).toHaveLength(1);
    expect(withMultiProviderCapabilities(catalog)).toBe(catalog);
    expect(customerFacingCapabilityLabel(CHAIN_CAPABILITY_SLUG)).toBe("بيانات تواصل الشركات");
    const cap = buildMultiProviderCapability();
    expect(cap.nameAr).toMatch(/مصادر متاحة/);
    expect(`${cap.nameAr} ${cap.descriptionAr}`).not.toMatch(/firecrawl|context|treg|[A-Za-z]{4,}/i);
  });

  it("prices the route the router chose with the ONE shared rule, holds the plan to the cap, and keeps only an opaque route code on the item", async () => {
    setRouterStateForTesting(stateOf());
    const q = await quote([chainItem({}, 50)]);
    const item = q.items[0];
    expect(item.unitPricePoints).toBe(unitPricePointsForCapability({ slug: CHAIN_CAPABILITY_SLUG, unitCostUsd: item.unitCostUsd! }));
    expect(q.quotedPoints).toBeLessThanOrEqual(JOB_MAX_POINTS_CAP);
    expect(q.pointsCapConstrained).toBe(true);
    expect(q.targetVolumeMax).toBeLessThan(50);
    expect(q.expectedPoints).toBe(chargeForUnits(q.targetVolumeMax, item.unitPricePoints!));
    expect(q.quotedPoints).toBe(reserveForUnits(q.targetVolumeMax, item.unitPricePoints!, 0.15));
    expect(calculateFinalSettlement(q.targetVolumeMax, item.unitPricePoints!, q.quotedPoints).chargePoints).toBe(q.expectedPoints);
    expect(routeByCode(item.params.routeCode)).toBeTruthy();
    expect(item.params.requiredFields).toEqual(["work_email"]);
    expect(Object.keys(item.params).sort()).toEqual(["country", "industry", "requiredFields", "routeCode"]);
    const json = JSON.stringify(item.params);
    expect(json).not.toMatch(/firecrawl|contextdev|context\.dev|treg|chain:|usd|budget/i);
  });

  it("a chain-only plan is not shrunk by TREG's own balance or daily gate (the chain's providers are checked by the router and at every call)", async () => {
    setRouterStateForTesting(stateOf());
    setProviderBalanceForTesting(0);
    const q = await quote([chainItem({}, 2)]);
    expect(q.targetVolumeMax).toBe(2);
    expect(q.capacityConstrained).toBe(false);
  });

  it("the model's valid choice is used, code prices it, and the model is asked once per plan: an edit keeps the route without asking again", async () => {
    const state = stateOf();
    setRouterStateForTesting(state);
    const allowed = buildAllowedRoutes({ industry: "مقاولات", country: "مصر", count: 3, requiredFields: ["work_email"] }, state).allowed;
    const pick = allowed.find((a) => a.id === "chain:contextdev>contextdev")!;
    const chooser = vi.fn(async () => ({ routeId: pick.id, reason: "x" }));
    setRouteChooserForTesting(chooser);
    const first = await quote([chainItem()]);
    expect(first.items[0].params.routeCode).toBe(routeCodeOf(pick.id));
    expect(first.items[0].unitPricePoints).toBe(pick.unitPricePoints);
    expect(chooser).toHaveBeenCalledTimes(1);
    const edited = await quote([{ ...chainItem({ routeCode: first.items[0].params.routeCode }, 5) }]);
    expect(edited.items[0].params.routeCode).toBe(first.items[0].params.routeCode);
    expect(chooser).toHaveBeenCalledTimes(1);
  });

  it("an invalid choice or a failing model falls back to the cheapest allowed route that covers the request", async () => {
    const state = stateOf();
    setRouterStateForTesting(state);
    const allowed = buildAllowedRoutes({ industry: "مقاولات", country: "مصر", count: 3, requiredFields: ["work_email"] }, state).allowed;
    const cheapest = [...allowed].sort((a, b) => a.estimate.costPerDeliveredRowUsd - b.estimate.costPerDeliveredRowUsd)[0];
    for (const chooser of [async () => ({ routeId: "chain:nowhere>nowhere", reason: "x" }), async () => { throw new Error("overloaded"); }, async () => "garbage"]) {
      setRouteChooserForTesting(chooser as any);
      const q = await quote([chainItem()]);
      expect(q.items[0].params.routeCode).toBe(routeCodeOf(cheapest.id));
    }
    setRouteChooserForTesting(null);
    expect((await quote([chainItem()])).items[0].params.routeCode).toBe(routeCodeOf(cheapest.id));
  });

  it("a cap that is exceeded blocks that provider's routes: the plan uses what is left, and no allowed route means no plan, in plain Arabic", async () => {
    setRouterStateForTesting(stateOf({ firecrawl: ok({ dailyCapUsd: 0 }) }));
    setRouteChooserForTesting(async ({ options }) => ({ routeId: options[0].routeId, reason: "x" }));
    const q = await quote([chainItem()]);
    expect(routeByCode(q.items[0].params.routeCode)!.id).not.toMatch(/firecrawl/);
    setRouterStateForTesting(stateOf({ firecrawl: ok({ dailyCapUsd: 0 }), contextdev: ok({ spentTodayUsd: 100 }) }));
    await expect(quote([chainItem()])).rejects.toThrow(NO_ROUTE_AR);
  });

  it("with the router state coming from a flag-off system nothing is allowed", async () => {
    setRouterStateForTesting(stateOf({}, false));
    await expect(quote([chainItem()])).rejects.toThrow(NO_ROUTE_AR);
  });

  it("a request with no contact field gets the email by default (a plain company list is the existing directory's job)", () => {
    expect(normalizeRequiredFields([])).toEqual(["work_email"]);
    expect(normalizeRequiredFields(["decision_maker"])).toEqual(["work_email", "decision_maker"]);
    expect(normalizeRequiredFields(["office_phone", "junk", "office_phone"])).toEqual(["office_phone"]);
    expect(normalizeRequiredFields("x")).toEqual(["work_email"]);
  });
});

describe("the one short model call", () => {
  const options = [{ routeId: "chain:a>b", costRank: 1, stages: ["discover", "enrich", "verify"], strengths: "x" }, { routeId: "chain:c>d", costRank: 2, stages: ["discover"], strengths: "y" }];
  let savedEnv: Record<string, string | undefined>;
  beforeEach(() => {
    savedEnv = { LLM_PROVIDER: process.env.LLM_PROVIDER, LLM_ENABLED: process.env.LLM_ENABLED, LLM_LIVE: process.env.LLM_LIVE, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL, LLM_MODEL: process.env.LLM_MODEL };
    process.env.LLM_PROVIDER = "anthropic"; process.env.LLM_ENABLED = "true"; delete process.env.LLM_LIVE; process.env.ANTHROPIC_API_KEY = "testonly-anthropic-key-0123456789"; delete process.env.ANTHROPIC_MODEL; delete process.env.LLM_MODEL;
  });
  afterEach(() => { for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; } vi.unstubAllGlobals(); });

  it("sends one forced-tool request with the configured model, a short timeout and NO price, cap or USD; returns the tool input", async () => {
    const inserted: any[] = [];
    const client = { from: (t: string) => ({ insert: async (row: any) => { inserted.push({ t, row }); return { error: null }; } }) };
    const fetchMock = vi.fn(async (_url: string, init: any) => new Response(JSON.stringify({ content: [{ type: "tool_use", name: "choose_route", input: { routeId: "chain:c>d", reason: "ok" } }], usage: { input_tokens: 300, output_tokens: 20 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const chooser = createClaudeRouteChooser(client, "u1")!;
    const out = await chooser({ options, request: { industry: "x", country: "y", requiredFields: ["work_email"], count: 3 } });
    expect(out).toEqual({ routeId: "chain:c>d", reason: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.tool_choice).toEqual({ type: "tool", name: "choose_route" });
    expect(body.max_tokens).toBeLessThanOrEqual(200);
    expect(body.tools[0].input_schema.properties.routeId.enum).toEqual(["chain:a>b", "chain:c>d"]);
    expect(JSON.stringify(body.messages)).not.toMatch(/usd|\$|point|price|cap\b|budget|0\.\d{3}/i);
    expect(body.system).toMatch(/never decide prices, limits or whether anything is allowed/);
    expect(init.headers["x-api-key"]).toBe("testonly-anthropic-key-0123456789");
    expect(inserted[0]).toMatchObject({ t: "llm_usage", row: { reason: "route_choice", model: "claude-haiku-5-5", tokens_in: 300, tokens_out: 20 } });
  });

  it("an error status or a thrown network error makes the chooser throw (the router then falls back); an assistant that is off has no chooser", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 529 })));
    await expect(createClaudeRouteChooser(null, null)!({ options, request: { requiredFields: [], count: 1 } })).rejects.toThrow(/http_529/);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    await expect(createClaudeRouteChooser(null, null)!({ options, request: { requiredFields: [], count: 1 } })).rejects.toThrow();
    process.env.LLM_ENABLED = "false";
    expect(createClaudeRouteChooser(null, null)).toBeNull();
    process.env.LLM_ENABLED = "true"; process.env.LLM_PROVIDER = "fake";
    expect(createClaudeRouteChooser(null, null)).toBeNull();
  });
});

describe("flag OFF: the router state is built without touching a provider, a key or the database", () => {
  it("answers «not allowed» for every provider and reads nothing", async () => {
    delete process.env.MULTI_PROVIDER_ENABLED;
    const { loadRouterState } = await import("../src/lib/server/multiProvider/planRouting");
    const trap = new Proxy({}, { get() { throw new Error("nothing may be read while the feature is off"); } });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const s = await loadRouterState(trap);
      expect(s.flagOn).toBe(false);
      expect(Object.values(s.providers).every((p) => !p.enabled && !p.keyPresent && !p.healthOk && p.dailyCapUsd === 0)).toBe(true);
      expect(buildAllowedRoutes({ count: 5, requiredFields: ["work_email"] }, s).allowed).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
