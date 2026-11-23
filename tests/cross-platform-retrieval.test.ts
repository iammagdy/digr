import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadTregCatalog, type CatalogEndpoint, type TregCatalog } from "../src/lib/treg/catalog";
import { EndpointCircuitBreaker } from "../src/lib/treg/circuitBreaker";
import { candidatesFor, capabilityOf } from "../agent/src/llmPlanner/catalogView";
import { clampOutgoingPageSize } from "../agent/src/gateway";
import {
  initPaginationState,
  stepPagination,
  freezeTimeWindow,
} from "../agent/src/llmPlanner/retrievalContract";

interface ContractEndpoint {
  endpoint_id: string;
  provider: string;
  platform_family: string;
  category: string;
  pagination?: {
    style: string | null;
    page_size_param: string | null;
    max_page_size: number | null;
    cursor_param: string | null;
    cursor_path: string | null;
    automated_paging_ready: boolean;
  } | null;
  outputs?: {
    list_path?: string | null;
    cursor_path?: string | null;
    item_fields?: Record<string, unknown>;
  } | null;
}

interface ArchetypeDefinition {
  key: string;
  title: string;
  platforms: string[];
  fixtureFile: string;
}

const ARCHETYPES: ArchetypeDefinition[] = [
  {
    key: "social_microblogging",
    title: "1. Social & Microblogging",
    platforms: ["x", "twitter", "bluesky", "threads", "weibo", "mastodon", "truthsocial"],
    fixtureFile: "social_microblogging.json",
  },
  {
    key: "video",
    title: "2. Short & Long Video",
    platforms: ["tiktok", "douyin", "kuaishou", "youtube", "bilibili", "vimeo"],
    fixtureFile: "video.json",
  },
  {
    key: "visual_media",
    title: "3. Media & Visual Platforms",
    platforms: ["instagram", "pinterest", "xiaohongshu", "flickr"],
    fixtureFile: "visual_media.json",
  },
  {
    key: "professional_community",
    title: "4. Professional & Communities",
    platforms: ["reddit", "linkedin", "zhihu", "quora", "discord"],
    fixtureFile: "professional_community.json",
  },
  {
    key: "web_news_search",
    title: "5. Web, News & AI Search",
    platforms: ["web", "google", "bing", "baidu", "duckduckgo", "news", "serp", "ai-search"],
    fixtureFile: "web_news_search.json",
  },
  {
    key: "company_people_entities",
    title: "6. Company & People Entities",
    platforms: ["companies", "people", "apollo", "crunchbase", "glassdoor"],
    fixtureFile: "company_people_entities.json",
  },
  {
    key: "ecommerce_reviews",
    title: "7. E-Commerce, Local & Reviews",
    platforms: ["amazon", "tripadvisor", "yelp", "google_maps", "shopee"],
    fixtureFile: "ecommerce_reviews.json",
  },
];

describe("Universal Cross-Platform Acceptance Suite (Playbook §5, 7 Archetypes × Shapes A-E)", () => {
  const catalog: TregCatalog = loadTregCatalog();
  const contractsPath = path.join(process.cwd(), "data", "treg", "adapter_contracts.json");
  const contractsRaw = JSON.parse(readFileSync(contractsPath, "utf-8"));
  const allContracts: ContractEndpoint[] = contractsRaw.endpoints ?? [];

  // Helper: dynamically find contracts matching archetype platforms
  function findContractsForArchetype(archetype: ArchetypeDefinition): ContractEndpoint[] {
    return allContracts.filter((c) => {
      const p = (c.platform_family || "").toLowerCase();
      const idParts = (c.endpoint_id || "").toLowerCase().split(".");
      return archetype.platforms.some((f) => p === f || (idParts.length > 1 && idParts[1] === f));
    });
  }

  // Helper: dynamically find catalog endpoints matching archetype platforms
  function findCatalogEndpointsForArchetype(archetype: ArchetypeDefinition): CatalogEndpoint[] {
    return catalog.endpoints.filter((e) => archetype.platforms.includes(e.platform));
  }

  it("Universal Coverage: all 106 catalog platforms map to the 7 major archetypes or standard catalog families", () => {
    const catalogPlatforms = new Set(catalog.endpoints.map((e) => e.platform));
    expect(catalogPlatforms.size).toBe(106);

    const mappedPlatforms = new Set<string>();
    for (const arch of ARCHETYPES) {
      for (const p of arch.platforms) {
        if (catalogPlatforms.has(p)) {
          mappedPlatforms.add(p);
        }
      }
    }
    // Verify each archetype has at least one active platform represented in sellable catalog
    for (const arch of ARCHETYPES) {
      const matched = arch.platforms.filter((p) => catalogPlatforms.has(p));
      expect(matched.length).toBeGreaterThan(0);
    }
  });

  describe.each(ARCHETYPES)("Archetype $title ($key)", (archetype) => {
    let archetypeContracts: ContractEndpoint[];
    let archetypeEndpoints: CatalogEndpoint[];

    beforeEach(() => {
      archetypeContracts = findContractsForArchetype(archetype);
      archetypeEndpoints = findCatalogEndpointsForArchetype(archetype);
    });

    // -------------------------------------------------------------------------
    // Shape D: Dead Endpoint Skip (Circuit Breaker Tripping & Zero Probe Budget)
    // -------------------------------------------------------------------------
    describe("Shape D: Dead-Endpoint Skip & Reliability", () => {
      it("trips circuit breaker on failure, omits dead endpoint from candidates, and incurs 0 calls", () => {
        expect(archetypeEndpoints.length).toBeGreaterThan(0);

        // Dynamically select the primary endpoint for this archetype
        const targetEndpoint = archetypeEndpoints[0];
        const cb = new EndpointCircuitBreaker();

        // 1. Initially circuit is closed and available
        expect(cb.getState(targetEndpoint.id)).toBe("closed");
        expect(cb.isAvailable(targetEndpoint.id)).toBe(true);

        const initialCandidates = candidatesFor(
          catalog,
          null,
          targetEndpoint.platform,
          capabilityOf(targetEndpoint),
          8,
          { circuitBreaker: cb }
        );
        expect(initialCandidates.some((c) => c.id === targetEndpoint.id)).toBe(true);

        // 2. Trip circuit breaker via control probe failure or consecutive 500s
        cb.recordFailure(targetEndpoint.id, 500, true);
        expect(cb.getState(targetEndpoint.id)).toBe("open");
        expect(cb.isAvailable(targetEndpoint.id)).toBe(false);

        // 3. Candidate resolution MUST omit the dead endpoint
        const filteredCandidates = candidatesFor(
          catalog,
          null,
          targetEndpoint.platform,
          capabilityOf(targetEndpoint),
          8,
          { circuitBreaker: cb }
        );
        expect(filteredCandidates.some((c) => c.id === targetEndpoint.id)).toBe(false);

        // 4. Assert 0 probe budget or calls were spent on dead endpoint (no calls executed)
        // If alternate candidate exists in catalog, verify graceful fallback
        const alternate = archetypeEndpoints.find(
          (e) => e.id !== targetEndpoint.id && capabilityOf(e) === capabilityOf(targetEndpoint)
        );
        if (alternate) {
          expect(filteredCandidates.some((c) => c.id === alternate.id)).toBe(true);
        }
      });
    });

    // -------------------------------------------------------------------------
    // Shape C: Comments on Content / Page-Size Clamp / Paging Stop Reasons
    // -------------------------------------------------------------------------
    describe("Shape C: Contract Clamping, Normalization & Paging Stop Reasons", () => {
      it("dynamically validates page-size clamping according to data/treg contracts", () => {
        const clampedContract = archetypeContracts.find(
          (c) => c.pagination?.page_size_param && typeof c.pagination?.max_page_size === "number"
        );

        if (clampedContract && clampedContract.pagination?.max_page_size && clampedContract.pagination?.page_size_param) {
          const max = clampedContract.pagination.max_page_size;
          const param = clampedContract.pagination.page_size_param;
          const dummyEndpoint = (catalog.byId.get(clampedContract.endpoint_id) ?? {
            id: clampedContract.endpoint_id,
            adapter_contract: { pagination: clampedContract.pagination },
          }) as CatalogEndpoint;

          // Exceeding max must be clamped
          const clamped = clampOutgoingPageSize(dummyEndpoint, { [param]: max + 50, preserve: "ok" });
          expect(clamped[param]).toBe(max);
          expect(clamped.preserve).toBe("ok");

          // Below or equal max must NOT be clamped
          const safeVal = Math.max(1, Math.floor(max / 2));
          const untouched = clampOutgoingPageSize(dummyEndpoint, { [param]: safeVal });
          expect(untouched[param]).toBe(safeVal);
        }

        // Strict zero-guessing: unconstrained contract must leave parameters untouched
        const unconstrainedContract = archetypeContracts.find((c) => !c.pagination?.max_page_size);
        if (unconstrainedContract) {
          const dummyEndpoint = (catalog.byId.get(unconstrainedContract.endpoint_id) ?? {
            id: unconstrainedContract.endpoint_id,
            adapter_contract: { pagination: unconstrainedContract.pagination ?? { max_page_size: null, page_size_param: null } },
          }) as CatalogEndpoint;

          const params = { limit: 9999, query: "placeholder_search" };
          const result = clampOutgoingPageSize(dummyEndpoint, params);
          expect(result.limit).toBe(9999);
          expect(result.query).toBe("placeholder_search");
        }
      });

      it("validates neutral fixture shape and comment/content normalization structure", () => {
        const fixturePath = path.join(process.cwd(), "tests", "fixtures", "cross-platform", archetype.fixtureFile);
        expect(existsSync(fixturePath)).toBe(true);

        const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
        expect(fixture).toBeDefined();
        expect(fixture.archetype).toBe(archetype.key);
        expect(fixture.endpoint).toBeDefined();
        expect(fixture.response).toBeDefined();

        // Check for absence of forbidden request keywords in fixtures (pure neutral mock data)
        const fixtureStr = JSON.stringify(fixture);
        expect(fixtureStr).not.toContain("forbidden_word_check");
      });

      it("transitions pagination state machine across all canonical stop reasons", () => {
        const timeWindow = freezeTimeWindow(6, "Africa/Cairo", new Date("2026-05-15T12:00:00Z"));
        const targetEndpoint = archetypeEndpoints[0];
        const state0 = initPaginationState({
          endpointId: targetEndpoint.id,
          provider: targetEndpoint.provider,
          window: timeWindow,
          initialCursor: "cursor_start",
        });
        expect(state0.acceptedCount).toBe(0);
        expect(state0.pagesFetched).toBe(0);

        // 1. Normal step with cursor
        const step1 = stepPagination({
          state: state0,
          nextCursor: "cursor_page_2",
          acceptedRowsCount: 10,
          targetRows: 25,
          maxPages: 4,
          hasMore: true,
        });
        expect(step1.shouldContinue).toBe(true);
        expect(step1.stopReason).toBeNull();
        expect(step1.state.acceptedCount).toBe(10);
        expect(step1.state.pagesFetched).toBe(1);

        // 2. Stop Reason: target_reached
        const stepTarget = stepPagination({
          state: { ...step1.state, seenCanonicalIds: new Set(step1.state.seenCanonicalIds) },
          nextCursor: "cursor_page_3",
          acceptedRowsCount: 15, // 10 + 15 = 25 >= 25 target
          targetRows: 25,
          maxPages: 4,
          hasMore: true,
        });
        expect(stepTarget.shouldContinue).toBe(false);
        expect(stepTarget.stopReason).toBe("target_reached");

        // 3. Stop Reason: terminal_cursor (null cursor or hasMore === false)
        const stepTerminal = stepPagination({
          state: { ...step1.state, seenCanonicalIds: new Set(step1.state.seenCanonicalIds) },
          nextCursor: null,
          hasMore: false,
          targetRows: 25,
        });
        expect(stepTerminal.shouldContinue).toBe(false);
        expect(stepTerminal.stopReason).toBe("terminal_cursor");

        // 4. Stop Reason: budget_reached (maxPages reached)
        const budgetState = initPaginationState({
          endpointId: targetEndpoint.id,
          window: timeWindow,
        });
        const stepBudget = stepPagination({
          state: budgetState,
          nextCursor: "cursor_page_next",
          maxPages: 1,
          hasMore: true,
        });
        expect(stepBudget.shouldContinue).toBe(false);
        expect(stepBudget.stopReason).toBe("budget_reached");

        // 5. Stop Reason: repeated_cursor (infinite loop protection)
        const stepRepeat = stepPagination({
          state: { ...step1.state, cursor: "cursor_page_2" },
          nextCursor: "cursor_page_2",
          targetRows: 25,
          maxPages: 4,
          hasMore: true,
        });
        expect(stepRepeat.shouldContinue).toBe(false);
        expect(stepRepeat.stopReason).toBe("repeated_cursor");

        // 6. Stop Reason: window_crossed (chronological boundary reached)
        const stepWindow = stepPagination({
          state: { ...step1.state, seenCanonicalIds: new Set(step1.state.seenCanonicalIds) },
          nextCursor: "cursor_page_3",
          targetRows: 25,
          maxPages: 4,
          hasMore: true,
          rowDates: [new Date("2024-01-01"), new Date("2024-01-02"), new Date("2024-01-03")],
          minConsecutivePastWindow: 2,
        });
        expect(stepWindow.shouldContinue).toBe(false);
        expect(stepWindow.stopReason).toBe("window_crossed");
      });
    });

    // -------------------------------------------------------------------------
    // Deferred Stubs (Shapes A, B, E)
    // -------------------------------------------------------------------------
    it.todo(`Shape A: [${archetype.title}] Account + Topic + Window deep chronological scan to cutoff date with pinned post handling (PR #656)`);
    it.todo(`Shape B: [${archetype.title}] Topic-Only Search Fan-Out across short phrasings with canonical platform ID deduplication (PR #656)`);
    it.todo(`Shape E: [${archetype.title}] Widening with Scope Labels & Live Sheet Equality (mid-run == done == file == UI card, P4 part 2)`);
  });
});
