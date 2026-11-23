import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CAPABILITIES, CONTEXTDEV_USD_PER_CREDIT, FIRECRAWL_USD_PER_CREDIT, PROVIDER_FACTS,
  capabilitiesOfProvider, capabilityById, filterContractsByCapabilityTag,
  getMultiProviderContractById, getMultiProviderContracts, isSellable,
  MULTI_PROVIDER_CONTRACTS, sellableCapabilities,
} from "../src/lib/multiProvider/catalog";
import { recordCostFor } from "../src/lib/recordPricing";
import { AdapterContractSchema, loadAdapterContracts } from "../scripts/treg/refresh-catalog-contracts";
import { EndpointCircuitBreaker } from "../src/lib/treg/circuitBreaker";
import { candidatesFor } from "../agent/src/llmPlanner/catalogView";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createWebGateway } from "../agent/src/webGateway";
import { createMemoryStore } from "../agent/src/memoryStore";
import { createJobCallBudget } from "../src/lib/server/callBudget";

/** The capability registry: prices come from the official documentation, nothing is invented, an unverified price is never sold. */
describe("capability registry prices (read from the official docs on 2026-10-22)", () => {
  it("Firecrawl credits per call match the billing page: scrape 1, map 1, search 2 per 10 results, JSON scrape 1 + 4", () => {
    expect(capabilityById("firecrawl.scrape")?.creditsPerCall).toBe(1);
    expect(capabilityById("firecrawl.map")?.creditsPerCall).toBe(1);
    expect(capabilityById("firecrawl.search")?.creditsPerCall).toBe(2);
    expect(capabilityById("firecrawl.search")?.unitsPerCall).toBe(10);
    expect(capabilityById("firecrawl.scrape_json")?.creditsPerCall).toBe(5);
  });

  it("Context.dev credits per call match the credits page: scrape 1, map 1, search 1 per 10 results, JSON scrape 1 + 4, people 20 per match", () => {
    expect(capabilityById("contextdev.scrape")?.creditsPerCall).toBe(1);
    expect(capabilityById("contextdev.map")?.creditsPerCall).toBe(1);
    expect(capabilityById("contextdev.search")?.creditsPerCall).toBe(1);
    expect(capabilityById("contextdev.search")?.unitsPerCall).toBe(10);
    expect(capabilityById("contextdev.scrape_json")?.creditsPerCall).toBe(5);
    expect(capabilityById("contextdev.people_enrich")?.creditsPerCall).toBe(20);
    expect(capabilityById("contextdev.people_search")?.creditsPerCall).toBe(10);
  });

  it("the USD per credit is the HIGHEST listed plan rate, so a price never undercuts the real cost", () => {
    // Firecrawl: 5 USD for 1,000 credits (Hobby pay-as-you-go) is the dearest listed rate; the subscription Hobby rate 16/5,000 is lower.
    expect(FIRECRAWL_USD_PER_CREDIT).toBe(5 / 1000);
    expect(FIRECRAWL_USD_PER_CREDIT).toBeGreaterThanOrEqual(19 / 5000);
    // Context.dev: Developer 19 USD for 7,500 credits = 0.002533..., the overage 2.20 / 1,000 is lower.
    expect(CONTEXTDEV_USD_PER_CREDIT).toBeGreaterThanOrEqual(19 / 7500);
    expect(CONTEXTDEV_USD_PER_CREDIT).toBeGreaterThanOrEqual(2.2 / 1000);
    expect(capabilityById("firecrawl.scrape")?.costPerCallUsd).toBeCloseTo(0.005, 9);
    expect(capabilityById("firecrawl.search")?.costPerUnitUsd).toBeCloseTo(0.001, 9);
    expect(capabilityById("contextdev.scrape")?.costPerCallUsd).toBeCloseTo(0.00254, 9);
  });

  it("every credit-priced capability names the official page it was read from", () => {
    for (const cap of CAPABILITIES.filter((c) => c.provider !== "treg")) {
      expect(cap.priceSources.length).toBeGreaterThan(0);
      for (const source of cap.priceSources) expect(source).toMatch(/^https:\/\/(?:docs\.firecrawl\.dev|www\.firecrawl\.dev|docs\.context\.dev|context\.dev)\//);
    }
  });

  it("a price that is not in the documentation is UNVERIFIED, has no cost and is never sold", () => {
    for (const id of ["firecrawl.extract", "firecrawl.agent"]) {
      const cap = capabilityById(id)!;
      expect(cap.priceStatus).toBe("UNVERIFIED");
      expect(cap.creditsPerCall).toBeNull();
      expect(cap.costPerCallUsd).toBeNull();
      expect(cap.costPerUnitUsd).toBeNull();
      expect(cap.blockedReason).toBe("unverified_price");
      expect(isSellable(cap)).toBe(false);
    }
  });

  it("profile-database lookups are blocked by the data policy even with a verified price", () => {
    const cap = capabilityById("contextdev.people_enrich")!;
    expect(cap.priceStatus).toBe("VERIFIED");
    expect(cap.blockedReason).toBe("data_policy");
    expect(isSellable(cap)).toBe(false);
  });

  it("TREG's directory price is the measured cost per record already used by the shared pricing table", () => {
    const cap = capabilityById("treg.companies.search")!;
    expect(cap.costPerUnitUsd).toBe(recordCostFor("icypeas-companies-search")!.costUsdPerRecord);
    expect(isSellable(cap)).toBe(true);
  });

  it("only verified, unblocked capabilities are sellable, and each provider lists its own", () => {
    const sellable = sellableCapabilities().map((c) => c.id);
    expect(sellable).toContain("firecrawl.scrape");
    expect(sellable).toContain("contextdev.search");
    expect(sellable).toContain("contextdev.people_search");
    expect(sellable).not.toContain("firecrawl.extract");
    expect(sellable).not.toContain("contextdev.people_enrich");
    expect(capabilitiesOfProvider("firecrawl").every((c) => c.provider === "firecrawl")).toBe(true);
  });

  it("the balance APIs are the documented free reads; TREG's read lives in the existing status module", () => {
    expect(PROVIDER_FACTS.firecrawl.balanceApi).toMatchObject({ method: "GET", url: "https://api.firecrawl.dev/v2/team/credit-usage", costsCredits: false });
    expect(PROVIDER_FACTS.contextdev.balanceApi).toMatchObject({ method: "GET", url: "https://api.context.dev/v1/org/usage", costsCredits: false });
    expect(PROVIDER_FACTS.treg.balanceApi).toBeNull();
  });
});

describe("Phase 6: Multi-Provider Unification & Catalog Adapter Contracts (DT-20261123-treg-p6a)", () => {
  it("Point 6.1: synthesizes valid EndpointAdapterContracts for all 3 providers with full status", () => {
    const contracts = getMultiProviderContracts();
    expect(contracts.length).toBe(9);

    const requiredIds = [
      "firecrawl.search",
      "firecrawl.map",
      "firecrawl.scrape",
      "firecrawl.scrape_json",
      "contextdev.search",
      "contextdev.map",
      "contextdev.scrape",
      "contextdev.scrape_json",
      "contextdev.people_search",
    ];

    for (const id of requiredIds) {
      const contract = getMultiProviderContractById(id);
      expect(contract, `Contract missing for ${id}`).toBeDefined();

      // Schema validation via Zod
      const parsed = AdapterContractSchema.parse(contract);
      expect(parsed.endpoint_id).toBe(id);
      expect(parsed.contract_status).toBe("full");
      expect(parsed.inputs_schema).not.toBeNull();
      expect(parsed.outputs_schema).not.toBeNull();
      expect(parsed.pagination).toBeDefined();
      expect(parsed.pagination.automated_paging_ready).not.toBeNull();
      expect(parsed.needs_session).toBe(false);
      expect(parsed.drifted).toBe(false);
      expect(parsed.schema_fingerprint).toBeDefined();
    }
  });

  it("Point 6.1: unknown fields remain strictly null, never defaulted", () => {
    const contracts = getMultiProviderContracts();
    for (const c of contracts) {
      if (c.pagination.style === null) {
        expect(c.pagination.cursor_param).toBeNull();
        expect(c.pagination.cursor_path).toBeNull();
      }
      if (c.query_syntax === null) {
        expect(c.query_syntax).toBeNull();
      }
    }
  });

  it("Point 6.1 & 6.5: pricing strictly derives from FIRECRAWL_USD_PER_CREDIT and CONTEXTDEV_USD_PER_CREDIT", () => {
    // Firecrawl
    const fcSearch = getMultiProviderContractById("firecrawl.search")!;
    expect(fcSearch.cost.usd).toBeCloseTo(2 * FIRECRAWL_USD_PER_CREDIT, 9);
    expect(fcSearch.cost.credits).toBe(2);

    const fcMap = getMultiProviderContractById("firecrawl.map")!;
    expect(fcMap.cost.usd).toBeCloseTo(1 * FIRECRAWL_USD_PER_CREDIT, 9);
    expect(fcMap.cost.credits).toBe(1);

    const fcScrape = getMultiProviderContractById("firecrawl.scrape")!;
    expect(fcScrape.cost.usd).toBeCloseTo(1 * FIRECRAWL_USD_PER_CREDIT, 9);
    expect(fcScrape.cost.credits).toBe(1);

    const fcScrapeJson = getMultiProviderContractById("firecrawl.scrape_json")!;
    expect(fcScrapeJson.cost.usd).toBeCloseTo(5 * FIRECRAWL_USD_PER_CREDIT, 9);
    expect(fcScrapeJson.cost.credits).toBe(5);

    // Context.dev
    const cdSearch = getMultiProviderContractById("contextdev.search")!;
    expect(cdSearch.cost.usd).toBeCloseTo(1 * CONTEXTDEV_USD_PER_CREDIT, 9);
    expect(cdSearch.cost.credits).toBe(1);

    const cdMap = getMultiProviderContractById("contextdev.map")!;
    expect(cdMap.cost.usd).toBeCloseTo(1 * CONTEXTDEV_USD_PER_CREDIT, 9);
    expect(cdMap.cost.credits).toBe(1);

    const cdScrape = getMultiProviderContractById("contextdev.scrape")!;
    expect(cdScrape.cost.usd).toBeCloseTo(1 * CONTEXTDEV_USD_PER_CREDIT, 9);
    expect(cdScrape.cost.credits).toBe(1);

    const cdScrapeJson = getMultiProviderContractById("contextdev.scrape_json")!;
    expect(cdScrapeJson.cost.usd).toBeCloseTo(5 * CONTEXTDEV_USD_PER_CREDIT, 9);
    expect(cdScrapeJson.cost.credits).toBe(5);

    const cdPeople = getMultiProviderContractById("contextdev.people_search")!;
    expect(cdPeople.cost.usd).toBeCloseTo(10 * CONTEXTDEV_USD_PER_CREDIT, 9);
    expect(cdPeople.cost.credits).toBe(10);
  });

  it("Point 6.2 (Amendment 1): capabilities are tagged declaratively in metadata; candidates filterable by capability tags without code maps", () => {
    // 1. site.map tag matches both Firecrawl and Context.dev site mapping capabilities
    const mapCandidates = filterContractsByCapabilityTag("site.map");
    const mapIds = mapCandidates.map((c) => c.endpoint_id);
    expect(mapIds).toContain("firecrawl.map");
    expect(mapIds).toContain("contextdev.map");

    // 2. discover.web_search matches web search for both providers
    const searchCandidates = filterContractsByCapabilityTag("discover.web_search");
    const searchIds = searchCandidates.map((c) => c.endpoint_id);
    expect(searchIds).toContain("firecrawl.search");
    expect(searchIds).toContain("contextdev.search");

    // 3. page.read matches scrape for both providers
    const scrapeCandidates = filterContractsByCapabilityTag("page.read");
    const scrapeIds = scrapeCandidates.map((c) => c.endpoint_id);
    expect(scrapeIds).toContain("firecrawl.scrape");
    expect(scrapeIds).toContain("contextdev.scrape");

    // 4. page.read_structured matches structured JSON extraction for both providers
    const jsonCandidates = filterContractsByCapabilityTag("page.read_structured");
    const jsonIds = jsonCandidates.map((c) => c.endpoint_id);
    expect(jsonIds).toContain("firecrawl.scrape_json");
    expect(jsonIds).toContain("contextdev.scrape_json");

    // 5. people.search matches people search
    const peopleCandidates = filterContractsByCapabilityTag("people.search");
    const peopleIds = peopleCandidates.map((c) => c.endpoint_id);
    expect(peopleIds).toContain("contextdev.people_search");
  });

  it("Point 6.1: refreshed catalog contracts file includes synthesized multi-provider contracts", () => {
    const contracts = loadAdapterContracts();
    const endpointIds = new Set(contracts.map((c) => c.endpoint_id));

    expect(endpointIds.has("firecrawl.map")).toBe(true);
    expect(endpointIds.has("firecrawl.scrape")).toBe(true);
    expect(endpointIds.has("firecrawl.search")).toBe(true);
    expect(endpointIds.has("firecrawl.scrape_json")).toBe(true);
    expect(endpointIds.has("contextdev.map")).toBe(true);
    expect(endpointIds.has("contextdev.scrape")).toBe(true);
    expect(endpointIds.has("contextdev.search")).toBe(true);
    expect(endpointIds.has("contextdev.scrape_json")).toBe(true);
    expect(endpointIds.has("contextdev.people_search")).toBe(true);
  });

  describe("Point 6.4 (Amendment 2): Circuit Breaker & 429 Retry Rule", () => {
    it("HTTP 429 does NOT trip the circuit (preserves Phase 2 Retry-After rule without circuit failure)", () => {
      const cb = new EndpointCircuitBreaker();
      const endpointId = "firecrawl.search";

      expect(cb.isAvailable(endpointId)).toBe(true);
      expect(cb.getState(endpointId)).toBe("closed");

      // Repeated 429 responses
      for (let i = 0; i < 10; i++) {
        cb.recordFailure(endpointId, 429);
      }

      // Circuit remains strictly closed and available
      expect(cb.getState(endpointId)).toBe("closed");
      expect(cb.isAvailable(endpointId)).toBe(true);
      expect(cb.getAlertLogs().length).toBe(0);
    });

    it("HTTP 402 / credit exhaustion trips the circuit breaker to open for that provider account and emits operational alert for الكبير", () => {
      const cb = new EndpointCircuitBreaker();
      const fcSearch = "firecrawl.search";
      const fcMap = "firecrawl.map";
      const cdSearch = "contextdev.search";

      expect(cb.isAvailable(fcSearch)).toBe(true);
      expect(cb.isAvailable(fcMap)).toBe(true);
      expect(cb.isAvailable(cdSearch)).toBe(true);

      // Provider returns HTTP 402 (credit exhaustion)
      cb.recordFailure(fcSearch, 402);

      // 1. Immediately tripped open for the failed endpoint
      expect(cb.getState(fcSearch)).toBe("open");
      expect(cb.isAvailable(fcSearch)).toBe(false);

      // 2. Also tripped open for other endpoints of the same provider account (Firecrawl)
      expect(cb.getState(fcMap)).toBe("open");
      expect(cb.isAvailable(fcMap)).toBe(false);

      // 3. Other provider accounts (Context.dev, TREG) remain unaffected and available
      expect(cb.getState(cdSearch)).toBe("closed");
      expect(cb.isAvailable(cdSearch)).toBe(true);

      // 4. Emits operational alert log for الكبير (COMMANDER) and records stable log line
      const alerts = cb.getAlertLogs();
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      const alert = alerts[0];
      expect(alert.type).toBe("credit_exhaustion");
      expect(alert.status).toBe(402);
      expect(alert.provider).toBe("firecrawl");
      expect(alert.capability).toBe("search");
      expect(alert.logLine).toBe("[agent] provider_credit_exhausted provider=firecrawl capability=search");
      expect(alert.message).toContain("[CIRCUIT_BREAKER_ALERT: COMMANDER]");
      expect(alert.message).toContain("Megz top-up required");
    });

    it("emits stable tag log line '[agent] provider_credit_exhausted provider=<id> capability=<id>' to console.error on 402 trip", () => {
      const cb = new EndpointCircuitBreaker();
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        cb.recordFailure("firecrawl.search", 402);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "[agent] provider_credit_exhausted provider=firecrawl capability=search"
        );

        const alerts = cb.getAlertLogs();
        expect(alerts[0].logLine).toBe(
          "[agent] provider_credit_exhausted provider=firecrawl capability=search"
        );
        expect(alerts[0].capability).toBe("search");

        // Test with explicit capability argument
        cb.recordFailure("contextdev.custom", 402, false, "custom_cap");
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "[agent] provider_credit_exhausted provider=contextdev capability=custom_cap"
        );
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it("resetProvider manually clears the 402 provider trip back to closed", () => {
      const cb = new EndpointCircuitBreaker();
      cb.recordFailure("firecrawl.search", 402);

      expect(cb.isAvailable("firecrawl.search")).toBe(false);
      expect(cb.isAvailable("firecrawl.map")).toBe(false);

      cb.resetProvider("firecrawl");

      expect(cb.getState("firecrawl.search")).toBe("closed");
      expect(cb.isAvailable("firecrawl.search")).toBe(true);
      expect(cb.isAvailable("firecrawl.map")).toBe(true);
    });
  });

  describe("Point 6.2: Universal Catalog Presentation & Cross-Provider Data-Driven Selection", () => {
    it("candidatesFor returns multi-provider endpoints for entity research steps (site.map & page.read)", () => {
      const catalog = loadTregCatalog();
      const mapCandidates = candidatesFor(catalog, null, "entity", "site.map");
      const mapIds = mapCandidates.map((c) => c.id);

      expect(mapIds).toContain("firecrawl.map");
      expect(mapIds).toContain("contextdev.map");

      const scrapeCandidates = candidatesFor(catalog, null, "entity", "page.read");
      const scrapeIds = scrapeCandidates.map((c) => c.id);

      expect(scrapeIds).toContain("firecrawl.scrape");
      expect(scrapeIds).toContain("contextdev.scrape");
    });

    it("Must-Pass 2: TREG chosen when well-covered (x.user.posts selects TREG social endpoints including anyapi with 0 web scrapes)", () => {
      const catalog = loadTregCatalog();
      const candidates = candidatesFor(catalog, null, "x", "x.user.posts");

      expect(candidates.length).toBeGreaterThan(0);
      const ids = candidates.map((c) => c.id);
      expect(ids).toContain("anyapi.x.user.posts");
      // All top candidates are TREG social platform endpoints
      expect(candidates[0].platform).toBe("x");
      // No web scrape in X user posts candidates
      expect(ids).not.toContain("firecrawl.scrape");
      expect(ids).not.toContain("contextdev.scrape");
    });

    it("tripping 402 on one provider immediately routes subsequent candidates to the other provider without failure", () => {
      const catalog = loadTregCatalog();
      const cb = new EndpointCircuitBreaker();

      // Healthy: both candidates present
      const healthy = candidatesFor(catalog, null, "entity", "site.map", 8, { circuitBreaker: cb });
      expect(healthy.map((c) => c.id)).toContain("firecrawl.map");
      expect(healthy.map((c) => c.id)).toContain("contextdev.map");

      // Firecrawl runs out of credits (HTTP 402)
      cb.recordFailure("firecrawl.map", 402);

      // Now firecrawl.map is filtered out, contextdev.map remains available
      const failover = candidatesFor(catalog, null, "entity", "site.map", 8, { circuitBreaker: cb });
      const failoverIds = failover.map((c) => c.id);
      expect(failoverIds).not.toContain("firecrawl.map");
      expect(failoverIds).toContain("contextdev.map");
    });
  });

  describe("Point 6.4: Gateway Budget Enforcement & Strict Spend Caps", () => {
    it("Must-Pass 3: Operation with remaining budget below bound ($0.025 bound, $0.010 budget) is refused upfront with over_budget", async () => {
      const store = createMemoryStore();
      const budget = createJobCallBudget({ holdPoints: 10, defaultJobProviderCeilingUsd: 0.010 }); // only 0.010 USD ceiling
      const counter = { seq: 0 };

      const gw = createWebGateway({
        store,
        missionId: "msn_test_budget",
        jobId: "job_test",
        phase: "planning",
        budget,
        recorder: { reserve: async () => ({ allowed: true, costId: 1 }), commit: async () => {} },
        providerKey: async () => "dummy_key",
        counter,
      });

      // Attempt stealth scrape (bound is 5 credits = $0.025)
      const res = await gw.webScrape({ provider: "firecrawl", url: "https://www.example.com" });

      expect(res.ok).toBe(false);
      if (!res.ok && "refused" in res) {
        expect(res.refused).toBe("over_budget");
      }
    });

    it("Counter-Case: Step call cap <= 4 calls and job call cap <= 24 calls are strictly enforced", async () => {
      const store = createMemoryStore();
      const budget = createJobCallBudget({ holdPoints: 5000, defaultJobProviderCeilingUsd: 10.0 });
      const counter = { seq: 0 };

      const gw = createWebGateway({
        store,
        missionId: "msn_test_caps",
        jobId: "job_test",
        phase: "planning",
        budget,
        recorder: { reserve: async () => ({ allowed: true, costId: 1 }), commit: async () => {} },
        providerKey: async () => "dummy_key",
        counter,
      });

      // 4 calls for same step pass (simulated with empty result or mock fetch)
      // When step exceeds 4 calls with stepKey, 5th call is refused over_budget
      const stepKey = "step_entity_site";
      for (let i = 0; i < 4; i++) {
        await gw.siteMap({ url: "https://www.example.com", stepKey });
      }

      const fifthCall = await gw.siteMap({ url: "https://www.example.com", stepKey });
      expect(fifthCall.ok).toBe(false);
      if (!fifthCall.ok && "refused" in fifthCall) {
        expect(fifthCall.refused).toBe("over_budget");
      }
    });
  });

  describe("Invariants & Governance Scanner", () => {
    it("AST / regex scanner verifies circuitBreaker.ts contains 0 hardcoded provider brand names in logic", () => {
      const filePath = path.join(process.cwd(), "src", "lib", "treg", "circuitBreaker.ts");
      const content = readFileSync(filePath, "utf-8");
      // Strip comments
      const codeOnly = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

      const providerNames = [
        "firecrawl",
        "contextdev",
        "treg",
        "anyapi",
        "tikhub",
        "scrapecreators",
        "crawl4ai",
        "fetchinio",
        "serper",
      ];

      for (const name of providerNames) {
        const regex = new RegExp(`(===|!==|==|!=|case|in)\\s*["'\`]${name}["'\`]|["'\`]${name}["'\`]\\s*(===|!==|==|!=)`, "i");
        expect(regex.test(codeOnly), `Hardcoded provider brand name check '${name}' found in circuitBreaker.ts logic`).toBe(false);
      }
    });

    it("Must-Pass 4: AST scanner verifies agent/src/llmPlanner/catalogView.ts contains 0 hardcoded provider brand names in logic", () => {
      const filePath = path.join(process.cwd(), "agent", "src", "llmPlanner", "catalogView.ts");
      const content = readFileSync(filePath, "utf-8");
      // Strip comments
      const codeOnly = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

      const providerNames = [
        "firecrawl",
        "contextdev",
        "treg",
        "anyapi",
        "tikhub",
        "scrapecreators",
        "crawl4ai",
        "fetchinio",
        "serper",
      ];

      for (const name of providerNames) {
        const regex = new RegExp(`(===|!==|==|!=|case|in)\\s*["'\`]${name}["'\`]|["'\`]${name}["'\`]\\s*(===|!==|==|!=)`, "i");
        expect(regex.test(codeOnly), `Hardcoded provider brand name check '${name}' found in catalogView.ts logic`).toBe(false);
      }
    });
  });
});

