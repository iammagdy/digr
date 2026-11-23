import { describe, expect, it } from "vitest";
import { loadTregCatalog, type CatalogEndpoint } from "../src/lib/treg/catalog";
import { priorRowsPerCall } from "../src/lib/agentMission/sourceRanking";
import { buildCapabilityRegistry } from "../src/lib/agentMission/capabilities/registry";
import { computeContractFingerprint, validateRegistryContracts } from "../scripts/treg/refresh-catalog-contracts";

describe("TREG Catalog Data Overlay & Metadata Contract (Phase 1)", () => {
  const catalog = loadTregCatalog();
  const availability = { isAllowed: () => true };
  const registry = buildCapabilityRegistry(catalog, availability);

  it("assertion 1: anyapi.x.user.posts reports maxRowsPerCall === 100 and cursor_in_param === 'cursor'", () => {
    const endpoint = catalog.byId.get("anyapi.x.user.posts");
    expect(endpoint).toBeDefined();
    expect(endpoint?.adapter_contract).toBeDefined();
    expect(endpoint?.adapter_contract?.pagination?.cursor_in_param).toBe("cursor");

    const rows = priorRowsPerCall(endpoint!);
    expect(rows).toBe(100);

    const cap = registry.byId.get("anyapi.x.user.posts")?.[0];
    expect(cap).toBeDefined();
    expect(cap?.maxRowsPerCall).toBe(100);
    expect(cap?.adapter_contract?.pagination?.cursor_in_param).toBe("cursor");
  });

  it("assertion 2: crawl4ai.x.search.posts contains sessionless rule limitation text", () => {
    const endpoint = catalog.byId.get("crawl4ai.x.search.posts");
    expect(endpoint).toBeDefined();

    const cap = registry.byId.get("crawl4ai.x.search.posts")?.[0];
    expect(cap).toBeDefined();
    expect(cap?.limitations).toContain("from:<account>");
    expect(cap?.limitations).toContain("Sessionless free-text topic search");
    expect(cap?.limits).toContain("from:<account>");
  });

  it("assertion 3: x.x.search-posts-all lists next_token as continuation input", () => {
    const endpoint = catalog.byId.get("x.x.search-posts-all");
    expect(endpoint).toBeDefined();
    expect(endpoint?.adapter_contract?.pagination?.cursor_in_param).toBe("next_token");
  });

  it("assertion 4: response paths distinguish REST vs MCP", () => {
    const anyapiSearch = catalog.byId.get("anyapi.x.search.posts");
    expect(anyapiSearch).toBeDefined();
    expect(anyapiSearch?.adapter_contract?.results_path).toBe("$.output.data.items");
    expect(anyapiSearch?.adapter_contract?.mcp_results_path).toBe("$.body.output.data.items");
    expect(anyapiSearch?.adapter_contract?.pagination?.cursor_out_path).toBe("$.output.data.nextCursor");
    expect(anyapiSearch?.adapter_contract?.pagination?.mcp_cursor_out_path).toBe("$.body.output.data.nextCursor");
  });

  it("assertion 5: priorRowsPerCall returns 100 when maximum is 100, and 20 when unspecified", () => {
    const endpointWithMax100: CatalogEndpoint = {
      id: "synthetic.test.max100",
      provider: "synthetic",
      platform: "x",
      category: null,
      capability: "x.search.posts",
      name: "Synthetic 100",
      summary: null,
      method: "GET",
      path: "/test",
      kind: "direct",
      tier: "core",
      async: null,
      async_config: null,
      inputs: [
        {
          name: "limit",
          in: "query",
          type: "integer",
          required: false,
          enum: null,
          minimum: 1,
          maximum: 100,
          default: 20,
          example: 20,
          note: null,
        },
      ],
      pagination: ["limit"],
      cost: null,
      observed: null,
      scope: "any_account",
      cost_confidence: null,
      siblings: [],
      test_request: null,
      list_path: null,
      cursor_path: null,
      item_fields: null,
      example_response_trimmed: null,
      adapter_contract: {
        pagination: {
          max_page_size: 100,
        },
      } as any,
    };
    expect(priorRowsPerCall(endpointWithMax100)).toBe(100);

    const endpointUnspecified: CatalogEndpoint = {
      ...endpointWithMax100,
      id: "synthetic.test.unspecified",
      adapter_contract: null,
      inputs: [
        {
          name: "limit",
          in: "query",
          type: "integer",
          required: false,
          enum: null,
          minimum: null,
          maximum: null,
          default: null,
          example: null,
          note: null,
        },
      ],
    };
    expect(priorRowsPerCall(endpointUnspecified)).toBe(20);
  });

  it("assertion 6: endpoint with automated_paging_ready === false has pagination: false in capability", () => {
    const crawl4aiCap = registry.byId.get("crawl4ai.x.search.posts")?.[0];
    expect(crawl4aiCap).toBeDefined();
    expect(crawl4aiCap?.pagination).toBe(false);
  });

  it("strict null preservation: missing or unverified fields remain strictly null", () => {
    const endpoint = catalog.byId.get("crawl4ai.x.search.posts");
    expect(endpoint?.adapter_contract).toBeDefined();
    // current_status in crawl4ai.x.search.posts is null in registry
    expect(endpoint?.adapter_contract?.current_status).toBeNull();
    // pagination cursor_in_param is null
    expect(endpoint?.adapter_contract?.pagination?.cursor_in_param).toBeNull();
  });

  it("uncontracted endpoints leave adapter_contract as null", () => {
    const uncontracted = catalog.endpoints.find((e) => !e.id.startsWith("anyapi.") && !e.id.startsWith("crawl4ai.") && !e.id.startsWith("x."));
    if (uncontracted) {
      expect(uncontracted.adapter_contract).toBeNull();
    }
  });

  it("refresher validation helper validates contracts cleanly", () => {
    const summary = validateRegistryContracts();
    expect(summary.total).toBe(32);
    expect(summary.valid).toBe(32);
    expect(summary.errors.length).toBe(0);

    const fp = computeContractFingerprint({ test: "data", id: 123 });
    expect(typeof fp).toBe("string");
    expect(fp.length).toBe(64);
  });
});
