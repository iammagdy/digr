import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import {
  buildCapabilityRegistry, discoverCapabilities, researchNeedOf, readRegistryRouterFlag, REGISTRY_ROUTER_FLAG_KEY, safeFallback, chainBindingIssues, routerCompare, routerReject, routedFieldsOf, MIN_MEASURED_ATTEMPTS,
  type Capability, type CapabilityRegistry, type RoutingFacts, type StageDiscovery, type VerificationLevel, type MeasuredCalls,
} from "../src/lib/agentMission/capabilities";
import { loadRegistryArtifact, minLevelFor, routingFactsOf } from "../src/lib/agentMission/capabilities/routingFacts";

/**
 * PHASE 4, THE INTELLIGENT TOOL ROUTER (docs/intelligence/PHASES-2-4-BASELINE.md). Unit rules on synthetic capabilities (labelled), then the router over the REAL catalog snapshot with the REAL reviewed registry artifact.
 */
const catalog = loadTregCatalog();
const artifact = loadRegistryArtifact();
const allowed = (id: string) => !blockedEndpointReason(id) && policyVerdict(id, { isAdmin: false, verifiedBusiness: false }).allowed;
const realRegistry = (handCards = true) => buildCapabilityRegistry(catalog, { isAllowed: allowed, webKeys: { firecrawl: true, contextdev: true }, dailyCapUsd: { firecrawl: 1, contextdev: 1 }, handCards });
const facts = (isTest: boolean, healthOf?: RoutingFacts["healthOf"]) => routingFactsOf(artifact, { minLevel: minLevelFor(isTest), ...(healthOf ? { healthOf } : {}) });

// ---------------------------------------------------------------------------------------- synthetic capabilities (SIMULATED: not provider data)
const NONE: MeasuredCalls = { attempts: 0, ok: 0, withRows: 0, empty: 0, emptyPaid: 0, failed: 0, refused: 0, rows: 0, costUsd: 0, costNull: 0, p50Ms: null };
function cap(id: string, over: Partial<Capability> = {}): Capability {
  return {
    id, provider: "treg", operation: "social.parents", platform: "tiktok", takes: ["query"], outputs: ["id", "url", "text", "date"], outputsKnown: true, pagination: true, maxRowsPerCall: 20,
    filters: { date: false, country: false, language: false }, usdPerRow: 0.001, privacy: "public", unavailable: null, summary: id, limits: null, access: "treg_direct",
    pricing: { unit: "call", usd: 0.02, basis: "verified", billedOnFailure: false }, ...over,
  };
}
const registryOf = (caps: Capability[]): CapabilityRegistry => ({ all: caps, byId: new Map(caps.map((c) => [c.id, [c]])) });
function synthFacts(levels: Record<string, VerificationLevel>, measured: Record<string, Partial<MeasuredCalls>> = {}, minLevel: VerificationLevel = "fixture_verified", health: Record<string, "ok" | "demoted" | "skipped"> = {}): RoutingFacts {
  return { levelOf: (id) => levels[id] ?? "advertised", measuredOf: (id) => (measured[id] ? { ...NONE, ...measured[id] } : null), minLevel, healthOf: (id) => health[id] ?? "ok" };
}
const tiktokVideos = researchNeedOf({ request: "هات ٥٠ فيديو تيك توك عن السياحة في مصر" });

describe("4.1 hard filters", () => {
  it("verification: below the account's minimum, broken or deprecated is excluded, however cheap", () => {
    const reg = registryOf([cap("cheap.broken", { usdPerRow: 0.00001 }), cap("cheap.advertised", { usdPerRow: 0.00002 }), cap("good", { usdPerRow: 0.01 })]);
    const d = discoverCapabilities(tiktokVideos, reg, { routing: synthFacts({ "cheap.broken": "broken", good: "live_verified" }) });
    const s = d.stages[0];
    expect(s.selected).toBe("good");
    expect(s.rejected).toEqual(expect.arrayContaining([{ id: "cheap.broken", reason: "broken_or_deprecated" }, { id: "cheap.advertised", reason: "below_verification" }]));
  });

  it("price: an unknown price is excluded (never promoted to the plan); a call above the safe bound is excluded", () => {
    const reg = registryOf([cap("unpriced", { usdPerRow: null, pricing: { unit: "call", usd: null, basis: "unknown", billedOnFailure: null } }), cap("dear", { pricing: { unit: "call", usd: 5, basis: "verified", billedOnFailure: false } }), cap("ok")]);
    const d = discoverCapabilities(tiktokVideos, reg, { routing: { ...synthFacts({ unpriced: "live_verified", dear: "live_verified", ok: "live_verified" }), maxUsdPerCall: 1 } });
    expect(d.stages[0].eligible.map((e) => e.id)).toEqual(["ok"]);
    expect(d.stages[0].rejected).toEqual(expect.arrayContaining([{ id: "unpriced", reason: "price_unknown" }, { id: "dear", reason: "over_call_bound" }]));
  });

  it("runtime health: a source skipped for configuration or validation failures is excluded; a demoted one ranks after a healthy equal", () => {
    const reg = registryOf([cap("a", { usdPerRow: 0.0001 }), cap("b", { usdPerRow: 0.0002 }), cap("c", { usdPerRow: 0.0003 })]);
    const d = discoverCapabilities(tiktokVideos, reg, { routing: synthFacts({ a: "live_verified", b: "live_verified", c: "live_verified" }, {}, "fixture_verified", { a: "skipped", b: "demoted" }) });
    expect(d.stages[0].eligible.map((e) => e.id)).toEqual(["c", "b"]);
    expect(d.stages[0].rejected).toContainEqual({ id: "a", reason: "runtime_unhealthy" });
  });

  it("a stage that FEEDS a dependent stage must document its outputs (a leaf may prove them on a sample)", () => {
    const need = researchNeedOf({ request: "هات تعليقات تيك توك عن السياحة" });
    const parentUnknown = cap("parent.unknown", { outputsKnown: false, outputs: [], usdPerRow: 0.00001 });
    const parentKnown = cap("parent.known");
    const comments = cap("comments", { operation: "social.comments", takes: ["post_ref", "url"], outputs: ["id", "text", "author", "date"] });
    const d = discoverCapabilities(need, registryOf([parentUnknown, parentKnown, comments]), { routing: synthFacts({ "parent.unknown": "live_verified", "parent.known": "live_verified", comments: "live_verified" }) });
    expect(d.stages[0].selected).toBe("parent.known");
    expect(d.stages[0].rejected).toContainEqual({ id: "parent.unknown", reason: "outputs_unproven_for_dependent" });
    expect(chainBindingIssues(d.stages)).toEqual([]);
  });
});

describe("4.1 ranking order: coverage, evidence, chaining, volume, measured yield, cost per usable row, latency, id", () => {
  const countryNeed = researchNeedOf({ request: "هات ٥٠ فيديو تيك توك عن السياحة في السعودية" });
  it("a CHEAPER source that cannot carry the requested country never wins over one that can (journey 17)", () => {
    const reg = registryOf([cap("cheap.nocountry", { usdPerRow: 0.00001 }), cap("dear.country", { usdPerRow: 0.01, filters: { date: false, country: true, language: false } })]);
    const d = discoverCapabilities(countryNeed, reg, { routing: synthFacts({ "cheap.nocountry": "production_eligible", "dear.country": "live_verified" }) });
    expect(d.stages[0].selected).toBe("dear.country");
    expect(d.limitations.filter((l) => l.code === "filter_not_enforceable")).toEqual([]);
  });
  it("same coverage: stronger evidence wins over a cheaper, weaker one", () => {
    const reg = registryOf([cap("cheap.fixture", { usdPerRow: 0.00001 }), cap("dear.pe", { usdPerRow: 0.01 })]);
    const d = discoverCapabilities(tiktokVideos, reg, { routing: synthFacts({ "cheap.fixture": "fixture_verified", "dear.pe": "production_eligible" }) });
    expect(d.stages[0].eligible.map((e) => e.id)).toEqual(["dear.pe", "cheap.fixture"]);
  });
  it("same coverage and evidence: Diger's measured yield, ONLY when both are measured; then the cost per usable row; then latency; then the id", () => {
    const reg = registryOf([cap("lowyield", { usdPerRow: 0.0001 }), cap("highyield", { usdPerRow: 0.001 }), cap("unmeasured.cheap", { usdPerRow: 0.00001 })]);
    const f = synthFacts({ lowyield: "live_verified", highyield: "live_verified", "unmeasured.cheap": "live_verified" }, { lowyield: { attempts: 10, rows: 20, costUsd: 0.002 }, highyield: { attempts: 10, rows: 180, costUsd: 0.18 } });
    const d = discoverCapabilities(tiktokVideos, reg, { routing: f });
    const ids = d.stages[0].eligible.map((e) => e.id);
    expect(ids.indexOf("highyield")).toBeLessThan(ids.indexOf("lowyield"));
    expect(MIN_MEASURED_ATTEMPTS).toBe(3);
    // no invented score: a source with no measurement is compared on price with each measured one, never given a yield
    expect(d.stages[0].eligible.find((e) => e.id === "unmeasured.cheap")!.routed!.measuredYield).toBeNull();
    const tie = registryOf([cap("b.same"), cap("a.same")]);
    expect(discoverCapabilities(tiktokVideos, tie, { routing: synthFacts({ "a.same": "live_verified", "b.same": "live_verified" }) }).stages[0].eligible.map((e) => e.id)).toEqual(["a.same", "b.same"]);
  });
  it("the cheapest wins only when coverage, evidence, chaining and volume are equal", () => {
    const reg = registryOf([cap("x.dear", { usdPerRow: 0.01 }), cap("x.cheap", { usdPerRow: 0.001 })]);
    expect(discoverCapabilities(tiktokVideos, reg, { routing: synthFacts({ "x.dear": "live_verified", "x.cheap": "live_verified" }) }).stages[0].selected).toBe("x.cheap");
  });
  it("routedFieldsOf and routerReject are what discovery uses (direct check)", () => {
    const c = cap("z", { usdPerRow: null, pricing: { unit: "call", usd: null, basis: "unknown", billedOnFailure: null } });
    const f = synthFacts({ z: "live_verified" });
    expect(routerReject(c, { key: "k", operation: "social.parents", platform: "tiktok", parentKey: null, requires: ["url"], prefers: [], accepts: ["query"], volume: null, deliver: true }, false, f, routedFieldsOf(c, f, 0, 0))).toBe("price_unknown");
    expect(typeof routerCompare).toBe("function");
  });
});

describe("4.2 safe fallbacks", () => {
  const stage = (): StageDiscovery => {
    const reg = registryOf([
      cap("primary", { usdPerRow: 0.0001, filters: { date: false, country: true, language: false } }),
      cap("alt.nocountry", { usdPerRow: 0.00005 }),
      cap("alt.country", { usdPerRow: 0.001, filters: { date: false, country: true, language: false } }),
    ]);
    const need = researchNeedOf({ request: "هات ٥٠ فيديو تيك توك عن السياحة في السعودية" });
    return discoverCapabilities(need, reg, { routing: synthFacts({ primary: "production_eligible", "alt.nocountry": "production_eligible", "alt.country": "live_verified" }) }).stages[0];
  };
  it("a timeout falls back to the next validated candidate that carries the SAME constraints (journey 19)", () => {
    const s = stage();
    expect(s.selected).toBe("primary");
    expect(safeFallback(s, "primary", "timeout")).toMatchObject({ id: "alt.country" });
  });
  it("a refusal (policy, cap, budget) is never worked around", () => {
    for (const f of ["refused_policy", "refused_cap", "refused_budget"] as const) expect(safeFallback(stage(), "primary", f).id).toBeNull();
  });
  it("no alternative carries the constraints within the bound: an honest partial, never a silent substitute", () => {
    const r = safeFallback(stage(), "primary", "provider_error", { exclude: ["alt.country"] });
    expect(r.id).toBeNull();
    expect(r.reason).toContain("honest partial");
    expect(safeFallback(stage(), "primary", "timeout", { maxUsdPerCall: 0.001, usdPerCallOf: (id) => (id === "alt.country" ? 0.02 : 0.001) }).id).toBeNull();
  });
});

describe("4.4 multi-step dependencies", () => {
  it("an invented chain (reviews read from companies) is flagged; a parent whose field does not feed the child is flagged", () => {
    const companies: StageDiscovery = { stage: { key: "companies", operation: "companies.discover", platform: null, parentKey: null, requires: ["name"], prefers: [], accepts: ["query"], volume: null, deliver: true }, eligible: [], rejected: [], selected: null, link: null };
    const reviews: StageDiscovery = { stage: { key: "rev", operation: "places.reviews", platform: null, parentKey: "companies", requires: ["text"], prefers: [], accepts: ["place_ref"], volume: null, deliver: true }, eligible: [], rejected: [], selected: null, link: null };
    expect(chainBindingIssues([companies, reviews])).toContain("rev: places.reviews cannot follow companies.discover");
  });
  it("over the real registry, every chain the router builds is bound by a documented field (companies → contacts, places → reviews, posts → comments → replies, search → page)", () => {
    const f = facts(true);
    for (const request of ["شركات مقاولات في مصر وإيميلاتها الرسمية", "تقييمات مطاعم في المعادي", "هات تعليقات وردود تيك توك عن السياحة", "مقالات عن السياحة في مصر"]) {
      const d = discoverCapabilities(researchNeedOf({ request }), realRegistry(), { routing: f });
      expect(chainBindingIssues(d.stages.filter((s) => s.selected)), request).toEqual([]);
    }
  });
});

describe("the router over the REAL registry artifact", () => {
  it("a production account gets only production-eligible capabilities: TikTok comments and replies are served by verified hand cards", () => {
    const d = discoverCapabilities(researchNeedOf({ request: "هات تعليقات وردود تيك توك عن السياحة" }), realRegistry(), { routing: facts(false) });
    expect(d.status).toBe("supported");
    for (const s of d.stages) expect(s.eligible.every((e) => e.routed!.level === "production_eligible"), s.stage.key).toBe(true);
    expect(d.stages.find((s) => s.stage.operation === "social.replies")!.selected).toBe("anyapi.tiktok.comment_replies");
  });
  it("a production account asking for companies: no production-eligible companies source exists, so the answer is honest («not verified yet»), never a guess", () => {
    const d = discoverCapabilities(researchNeedOf({ request: "عايز ٥٠ شركة مقاولات في مصر" }), realRegistry(), { routing: facts(false) });
    expect(d.status).toBe("unsupported");
    expect(d.unsupported[0].reason).toBe("not_verified");
    expect(d.messageAr).toContain("لم نتحقق بعد");
    expect(d.messageAr).not.toMatch(/tomba|treg|firecrawl|context/i);
  });
  it("a test account may use live-verified sources: companies are served by a source Diger measured", () => {
    const d = discoverCapabilities(researchNeedOf({ request: "عايز ٥٠ شركة مقاولات في مصر" }), realRegistry(), { routing: facts(true) });
    expect(d.status).toBe("supported");
    expect(["live_verified", "fixture_verified", "production_eligible"]).toContain(d.stages[0].eligible[0].routed!.level);
  });
  it("runtime health from the planning's own recent calls removes a skipped source", () => {
    const d0 = discoverCapabilities(researchNeedOf({ request: "هات تعليقات تيك توك عن السياحة" }), realRegistry(), { routing: facts(false) });
    const first = d0.stages[0].selected!;
    const d1 = discoverCapabilities(researchNeedOf({ request: "هات تعليقات تيك توك عن السياحة" }), realRegistry(), { routing: facts(false, (id) => (id === first ? "skipped" : "ok")) });
    expect(d1.stages[0].selected).not.toBe(first);
    expect(d1.stages[0].rejected).toContainEqual({ id: first, reason: "runtime_unhealthy" });
  });
  it("FLAGS OFF: without routing, discovery is byte-identical to before (no router fields, same order)", () => {
    const need = researchNeedOf({ request: "هات ٣٠٠ تعليق من تيك توك عن السياحة" });
    const plain = discoverCapabilities(need, realRegistry(false));
    expect(JSON.stringify(plain)).not.toContain('"routed"');
    expect(plain.stages.map((s) => s.selected)).toEqual(discoverCapabilities(need, realRegistry(false), {}).stages.map((s) => s.selected));
  });
  it("the switch is OFF unless set, scoped like the others", () => {
    const u1 = "00000000-0000-0000-0000-0000000000a1";
    expect(readRegistryRouterFlag({}, u1)).toBe(false);
    expect(readRegistryRouterFlag({ [REGISTRY_ROUTER_FLAG_KEY]: { user_ids: [u1] } }, u1)).toBe(true);
    expect(readRegistryRouterFlag({ [REGISTRY_ROUTER_FLAG_KEY]: { user_ids: [u1] } }, "00000000-0000-0000-0000-0000000000a2")).toBe(false);
  });
});
