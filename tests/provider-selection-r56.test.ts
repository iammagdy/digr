import { describe, expect, it, vi } from "vitest";
import { buildTools, dearerWebProviderMessage, newRunState, type ToolContext } from "../agent/src/tools";
import { createWebGateway } from "../agent/src/webGateway";
import { makeHarness } from "./helpers/agentHarness";
import { fakeContextDev } from "./helpers/fakeContextDev";
import { statsFromCalls } from "../src/lib/agentMission/sourceRanking";
import { WEB_SOURCES } from "../src/lib/agentMission/sources";
import { CONTEXTDEV_USD_PER_CREDIT, FIRECRAWL_USD_PER_CREDIT } from "../src/lib/multiProvider/catalog";

/**
 * ROUND 56, PROVIDER SELECTION ON THE WEB: Firecrawl and Context.dev search the web and read a page with the same inputs and outputs; Context.dev is cheaper by the
 * documented prices. In planning, Firecrawl is used for an input only after Context.dev gave nothing for THAT input, or when Context.dev has no key or is failing,
 * never because the model says so, and never a second, dearer call for an input Context.dev already answered. Each result keeps its own provider in the call log.
 * Realistic catalog: the real web source table (sources.ts) and the real web gateway with a fake provider. No network: fetch is stubbed.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const NOW = Date.parse("2026-11-13T00:00:00Z");

describe("the documented web prices: Context.dev is the cheaper provider for the same search and page read", () => {
  it("the web source table uses the provider constants, and contextdev costs less per call for both operations", () => {
    const usd = (id: string) => WEB_SOURCES.find((s) => s.id === id)!.usdPerCall;
    expect(usd("contextdev.search")).toBeCloseTo(CONTEXTDEV_USD_PER_CREDIT, 8);
    expect(usd("firecrawl.search")).toBeCloseTo(2 * FIRECRAWL_USD_PER_CREDIT, 8);
    expect(usd("contextdev.scrape")).toBeCloseTo(CONTEXTDEV_USD_PER_CREDIT, 8);
    expect(usd("firecrawl.scrape")).toBeCloseTo(FIRECRAWL_USD_PER_CREDIT, 8);
    expect(usd("contextdev.search")).toBeLessThan(usd("firecrawl.search"));
    expect(usd("contextdev.scrape")).toBeLessThan(usd("firecrawl.scrape"));
  });
});

describe("dearerWebProviderMessage (pure)", () => {
  const both = { firecrawl: true, contextdev: true } as const;
  const ctx = (phase: "planning" | "execution" = "planning", state = newRunState(), stats = new Map()) => ({ phase, state, stats, now: NOW });
  it("Firecrawl first, with Context.dev available: refused, naming the cheaper provider and both prices; a sentence does not change it", () => {
    const m = dearerWebProviderMessage(ctx(), both, "search", "firecrawl", { query: "شركات برمجيات في مصر", why: "firecrawl is better for this" });
    expect(m).toContain("contextdev.search");
    expect(m).toContain("does not excuse");
  });
  it("Context.dev itself, Firecrawl without a Context.dev key, or the execution phase: no refusal", () => {
    expect(dearerWebProviderMessage(ctx(), both, "search", "contextdev", { query: "x" })).toBeNull();
    expect(dearerWebProviderMessage(ctx(), { firecrawl: true, contextdev: false }, "search", "firecrawl", { query: "x" })).toBeNull();
    expect(dearerWebProviderMessage(ctx("execution"), both, "scrape", "firecrawl", { url: "https://a.example" })).toBeNull();
  });
  it("Context.dev gave nothing for THIS input: Firecrawl may try it; another input is still Context.dev's first", () => {
    const state = newRunState();
    state.webOutcomes.set("contextdev.scrape", [{ rows: 0, key: "https://a.example|" }]);
    expect(dearerWebProviderMessage(ctx("planning", state), both, "scrape", "firecrawl", { url: "https://A.example" })).toBeNull();
    expect(dearerWebProviderMessage(ctx("planning", state), both, "scrape", "firecrawl", { url: "https://b.example" })).toContain("contextdev.scrape does the same job");
  });
  it("Context.dev already answered THIS input: no second, dearer call for it", () => {
    const state = newRunState();
    state.webOutcomes.set("contextdev.search", [{ rows: 10, key: "شركات|eg" }]);
    expect(dearerWebProviderMessage(ctx("planning", state), both, "search", "firecrawl", { query: "شركات", country: "EG" })).toContain("already answered");
  });
  it("Context.dev's recorded calls are failing: Firecrawl goes through", () => {
    const stats = statsFromCalls([{ endpoint_id: "contextdev.search", status: "refused", refused_reason: "source_unavailable:contextdev", created_at: new Date(NOW - 5 * 60_000).toISOString(), rows_returned: 0, cost_usd: 0 } as any]);
    expect(dearerWebProviderMessage(ctx("planning", newRunState(), stats), both, "search", "firecrawl", { query: "x" })).toBeNull();
  });
});

describe("through the real web_search / web_scrape tools (fake providers, the real gateway)", () => {
  function setup(world: Parameters<typeof fakeContextDev>[0]) {
    const h = makeHarness({ phase: "planning" });
    const fake = fakeContextDev(world);
    h.ctx.web = createWebGateway({ store: h.store, missionId: h.mission.id, jobId: h.mission.job_id, phase: h.ctx.phase, budget: h.budget, recorder: { reserve: async () => ({ allowed: true, costId: 1 }), commit: async () => undefined }, providerKey: async () => "k", fetchFn: fake.fetchFn as any, counter: { seq: 0 } });
    (h.ctx as ToolContext).webAvailable = { firecrawl: true, contextdev: true };
    (h.ctx as ToolContext).now = NOW;
    const tools = Object.fromEntries(buildTools(h.ctx).map((t) => [t.name, t]));
    const hosts = () => fake.requests.map((r) => new URL(r.url).hostname);
    return { h, tools, fake, hosts };
  }
  const isFirecrawl = (host: string) => host.includes("firecrawl");

  it("a Firecrawl search first is refused before any request; Context.dev answers; Firecrawl for the same query is then refused as a duplicate", async () => {
    const t = setup({ search: () => [{ url: "https://co.example", title: "شركة", description: "x" }] });
    const first: any = await t.tools.web_search.handler({ provider: "firecrawl", query: "شركات برمجيات في مصر", why: "firecrawl has better coverage" });
    expect(first).toMatchObject({ ok: false, refused: "choose_cheapest" });
    expect(t.fake.requests).toHaveLength(0);
    const cheap: any = await t.tools.web_search.handler({ provider: "contextdev", query: "شركات برمجيات في مصر" });
    expect(cheap.ok).toBe(true);
    expect(t.hosts().some(isFirecrawl)).toBe(false);
    const again: any = await t.tools.web_search.handler({ provider: "firecrawl", query: "شركات برمجيات في مصر" });
    expect(again).toMatchObject({ refused: "choose_cheapest" });
    expect(again.message).toContain("already answered");
    expect(t.hosts().some(isFirecrawl)).toBe(false);
  });

  it("Context.dev read a page and gave nothing: Firecrawl may read THAT page (a verifiable limitation), and each call keeps its own provider in the call log", async () => {
    const t = setup({ scrape: () => ({ markdown: "" }) });
    const cheap: any = await t.tools.web_scrape.handler({ provider: "contextdev", url: "https://co.example/contact" });
    const dear: any = await t.tools.web_scrape.handler({ provider: "firecrawl", url: "https://co.example/contact" });
    expect(dear.refused).toBeUndefined();
    expect(t.hosts().filter(isFirecrawl)).toHaveLength(1);
    const logged = await t.h.store.listCalls(t.h.mission.id);
    expect(logged.map((c) => c.endpoint_id)).toEqual(["contextdev.scrape", "firecrawl.scrape"]);
    void cheap;
  });
  it("Context.dev refused by its own daily limit for a query: Firecrawl is not blocked for that query (no deadlock between the two rules)", async () => {
    const t = setup({ search: () => [{ url: "https://co.example", title: "شركة", description: "x" }] });
    const realSearch = t.h.ctx.web!.webSearch.bind(t.h.ctx.web);
    t.h.ctx.web!.webSearch = async (input: any) => (input.provider === "contextdev" ? { ok: false, call_id: "c1", refused: "daily_cap", message: "the provider's daily limit has no room" } as any : realSearch(input));
    const capped: any = await t.tools.web_search.handler({ provider: "contextdev", query: "شركات" });
    expect(capped.refused).toBe("daily_cap");
    const dear: any = await t.tools.web_search.handler({ provider: "firecrawl", query: "شركات" });
    expect(dear.refused).toBeUndefined();
    expect(t.hosts().filter(isFirecrawl)).toHaveLength(1);
  });
});
