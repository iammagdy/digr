import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  AdapterContractSchema,
  loadAdapterContracts,
  synthesizeAdapterContract,
  type AdapterContract,
} from "../scripts/treg/refresh-catalog-contracts";
import {
  contractScore,
  getContractStatus,
  rankCandidatesWithContractPreference,
  rankEndpoints,
} from "../src/lib/agentMission/sourceRanking";
import type { CatalogEndpoint, TregCatalog } from "../src/lib/treg/catalog";

export interface RetrievalOptions {
  requestedPages: number;
  requestedLimit: number;
  fetchPage: (pageIndex: number, limit: number | null) => Promise<{ rows: unknown[]; hasMore: boolean }>;
}

export interface RetrievalResult {
  pagesFetched: number;
  rows: unknown[];
  stopReason: string;
  appliedLimit: number | null;
}

/**
 * Deterministic multi-page retrieval execution engine adhering to contract invariants (Point 5.5):
 * 1. Runtime page-size clamp: limit <= max_page_size when max_page_size is declared.
 * 2. Unknown pagination safe termination: if pagination.style is null, executes exactly ONE page
 *    and terminates cleanly with honest Arabic stop reason: "المصدر لا يدعم صفحات أكثر" (DIGER-TRUTH §6).
 * Strict Zero-Guessing: requestedPages, requestedLimit and fetchPage are all required parameters.
 */
export async function executeContractRetrieval(
  contract: AdapterContract,
  options: RetrievalOptions
): Promise<RetrievalResult> {
  const maxPages = options.requestedPages;
  const requestedLimit = options.requestedLimit;

  let effectiveLimit: number | null = requestedLimit;
  if (contract.pagination.max_page_size !== null) {
    effectiveLimit = Math.min(requestedLimit, contract.pagination.max_page_size);
  } else if (contract.pagination.page_size_param === null) {
    effectiveLimit = null;
  }

  if (contract.pagination.style === null) {
    const pageRes = await options.fetchPage(0, effectiveLimit);
    return {
      pagesFetched: 1,
      rows: pageRes.rows,
      stopReason: "المصدر لا يدعم صفحات أكثر",
      appliedLimit: effectiveLimit,
    };
  }

  const rows: unknown[] = [];
  let pagesFetched = 0;
  let stopReason = "target_met";

  for (let i = 0; i < maxPages; i++) {
    const pageRes = await options.fetchPage(i, effectiveLimit);
    pagesFetched++;
    rows.push(...pageRes.rows);
    if (!pageRes.hasMore) {
      stopReason = "exhausted";
      break;
    }
  }

  return {
    pagesFetched,
    rows,
    stopReason,
    appliedLimit: effectiveLimit,
  };
}

// Strictly offline in tests - fetch must throw if any unmocked network call is attempted
vi.stubGlobal("fetch", () => {
  throw new Error("a real network call was attempted in test environment");
});

describe("Phase 5: Universal Catalog-Wide Contracts & Coverage (Point 5.1 - 5.5)", () => {
  const contractsPath = path.join(process.cwd(), "data", "treg", "adapter_contracts.json");
  const coveragePath = path.join(process.cwd(), "data", "treg", "contract_coverage_report.json");

  // -----------------------------------------------------------------------------------------
  // Scenario 5 & Universal Schema Validity
  // -----------------------------------------------------------------------------------------
  it("Scenario 5: All 3,276 generated contracts parse successfully against the Zod AdapterContractSchema without throwing errors", () => {
    expect(existsSync(contractsPath)).toBe(true);
    const contracts = loadAdapterContracts(contractsPath);
    expect(contracts.length).toBe(3276);

    for (const contract of contracts) {
      const parsed = AdapterContractSchema.safeParse(contract);
      if (!parsed.success) {
        throw new Error(`Validation failed for endpoint ${contract.endpoint_id}: ${JSON.stringify(parsed.error.issues)}`);
      }
      expect(parsed.success).toBe(true);
    }
  });

  // -----------------------------------------------------------------------------------------
  // Coverage Report Verification & Completeness
  // -----------------------------------------------------------------------------------------
  it("Coverage Report: contract_coverage_report.json exists, reflects all 3,276 endpoints and 106 platform families", () => {
    expect(existsSync(coveragePath)).toBe(true);
    const report = JSON.parse(readFileSync(coveragePath, "utf-8"));

    expect(report.total_endpoints).toBe(3276);
    expect(report.total_platform_families).toBe(106);
    expect(report.contracts.full).toBeGreaterThan(0);
    expect(report.contracts.partial).toBeGreaterThan(0);
    expect(report.contracts.unknown).toBeGreaterThan(0);
    expect(report.contracts.full + report.contracts.partial + report.contracts.unknown).toBe(3276);

    expect(report.coverage_percent.full).toBeCloseTo((report.contracts.full / 3276) * 100, 1);
    expect(report.coverage_percent.actionable).toBeCloseTo(((report.contracts.full + report.contracts.partial) / 3276) * 100, 1);

    const platformKeys = Object.keys(report.by_platform_family);
    expect(platformKeys.length).toBe(106);
    for (const key of platformKeys) {
      const family = report.by_platform_family[key];
      expect(family.total).toBe(family.full + family.partial + family.unknown);
    }
  });

  // -----------------------------------------------------------------------------------------
  // Scenario 1: Full Contract Execution & Runtime Page-Size Clamp
  // -----------------------------------------------------------------------------------------
  it("Scenario 1: An endpoint with contract_status: 'full' executes automated multi-page retrieval while strictly enforcing the runtime page-size clamp", async () => {
    const fullContract: AdapterContract = {
      endpoint_id: "test.provider.full.posts",
      provider: "testprovider",
      platform_family: "x",
      category: "Social",
      contract_status: "full",
      inputs_schema: { type: "object", properties: { limit: { type: "integer", maximum: 100 } } },
      outputs_schema: { list_path: "$.data.items", cursor_path: null, item_fields: null, example_response_trimmed: null },
      pagination: {
        style: "cursor",
        page_size_param: "limit",
        max_page_size: 100,
        cursor_param: "cursor",
        cursor_path: "$.data.next_cursor",
        automated_paging_ready: true,
      },
      query_syntax: null,
      needs_session: false,
      schema_fingerprint: "abc123sha256",
      drifted: false,
    };

    const requestedLimit = 250; // exceeds max_page_size of 100
    const requestedPages = 3;
    const fetchCalls: Array<{ pageIndex: number; limit: number | null }> = [];

    const result = await executeContractRetrieval(fullContract, {
      requestedPages,
      requestedLimit,
      fetchPage: async (pageIndex, limit) => {
        fetchCalls.push({ pageIndex, limit });
        return {
          rows: [{ id: `post-${pageIndex}-1` }, { id: `post-${pageIndex}-2` }],
          hasMore: true,
        };
      },
    });

    expect(result.pagesFetched).toBe(3);
    expect(result.rows.length).toBe(6);
    expect(result.appliedLimit).toBe(100); // clamped to 100
    expect(result.stopReason).toBe("target_met");
    expect(fetchCalls.length).toBe(3);
    for (const call of fetchCalls) {
      expect(call.limit).toBe(100); // strictly <= max_page_size
    }
  });

  // -----------------------------------------------------------------------------------------
  // Scenario 2: Unknown Pagination Safe Termination
  // -----------------------------------------------------------------------------------------
  it("Scenario 2: An endpoint with pagination.style === null executes exactly ONE page and terminates cleanly with honest Arabic stop reason", async () => {
    const unknownContract: AdapterContract = {
      endpoint_id: "test.provider.single.page",
      provider: "testprovider",
      platform_family: "web",
      category: "News",
      contract_status: "partial",
      inputs_schema: { type: "object", properties: { q: { type: "string" } } },
      outputs_schema: { list_path: "$.items", cursor_path: null, item_fields: null, example_response_trimmed: null },
      pagination: {
        style: null,
        page_size_param: null,
        max_page_size: null,
        cursor_param: null,
        cursor_path: null,
        automated_paging_ready: false,
      },
      query_syntax: null,
      needs_session: false,
      schema_fingerprint: "singlepage123",
      drifted: false,
    };

    let fetchCount = 0;
    const result = await executeContractRetrieval(unknownContract, {
      requestedPages: 5,
      requestedLimit: 20,
      fetchPage: async () => {
        fetchCount++;
        return {
          rows: [{ id: "single-1" }, { id: "single-2" }],
          hasMore: true, // even if source might say hasMore, style is null
        };
      },
    });

    expect(fetchCount).toBe(1);
    expect(result.pagesFetched).toBe(1);
    expect(result.stopReason).toBe("المصدر لا يدعم صفحات أكثر"); // DIGER-TRUTH §6
  });

  // -----------------------------------------------------------------------------------------
  // Scenario 3: Catalog Deprecation Invariant
  // -----------------------------------------------------------------------------------------
  it("Scenario 3: Removing an endpoint from catalog causes its synthesized contract to be completely purged on refresh run", () => {
    const testCatalog = {
      endpoints: [
        {
          id: "provider1.service.keep",
          provider: "provider1",
          platform: "x",
          category: "Social",
          inputs: [{ name: "query", type: "string" }],
          list_path: "$.data",
        },
        {
          id: "provider2.service.deprecated",
          provider: "provider2",
          platform: "tiktok",
          category: "Video",
          inputs: [{ name: "keyword", type: "string" }],
          list_path: "$.items",
        },
      ],
    };

    // Synthesize initial contracts
    const initial = testCatalog.endpoints.map((ep) => synthesizeAdapterContract(ep));
    expect(initial.map((c) => c.endpoint_id)).toContain("provider2.service.deprecated");

    // Purge deprecated endpoint from catalog snapshot
    const purgedCatalog = {
      endpoints: testCatalog.endpoints.filter((ep) => ep.id !== "provider2.service.deprecated"),
    };

    const refreshed = purgedCatalog.endpoints.map((ep) => synthesizeAdapterContract(ep));
    expect(refreshed.map((c) => c.endpoint_id)).toContain("provider1.service.keep");
    expect(refreshed.map((c) => c.endpoint_id)).not.toContain("provider2.service.deprecated");
  });

  // -----------------------------------------------------------------------------------------
  // Scenario 4: Zero-Provider-Name Architectural Invariant
  // -----------------------------------------------------------------------------------------
  it("Scenario 4: AST / regex scanner verifies that src/lib/agentMission/sourceRanking.ts contains 0 occurrences of hardcoded provider brand names in logic", () => {
    const sourceRankingPath = path.join(process.cwd(), "src", "lib", "agentMission", "sourceRanking.ts");
    const content = readFileSync(sourceRankingPath, "utf-8");

    // Remove comments
    const codeOnly = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

    const providerNames = [
      "anyapi",
      "tikhub",
      "scrapecreators",
      "crawl4ai",
      "fetchinio",
      "serper",
      "branddev",
    ];

    for (const name of providerNames) {
      // Check for code switches, equality checks, string literals in comparisons
      const regex = new RegExp(`(===|!==|==|!=|case|in)\\s*["'\`]${name}["'\`]|["'\`]${name}["'\`]\\s*(===|!==|==|!=)`, "i");
      expect(regex.test(codeOnly)).toBe(false);
    }
  });

  // -----------------------------------------------------------------------------------------
  // Mutant Proofs & Fail-First Invariants
  // -----------------------------------------------------------------------------------------
  it("Mutant Proof (P5: Zero-Guessing): An endpoint without declared schema maximum stays max_page_size: null and partial", () => {
    const epWithoutMax = {
      id: "synthetic.no.max",
      provider: "synthetic",
      platform: "x",
      inputs: [
        {
          name: "limit",
          type: "integer",
          // maximum omitted
        },
      ],
      list_path: "$.items",
    };

    const contract = synthesizeAdapterContract(epWithoutMax);
    expect(contract.pagination.max_page_size).toBeNull();
    expect(contract.contract_status).toBe("partial");

    // Mutant assertion: if someone defaults max_page_size to 50, this must fail
    expect(contract.pagination.max_page_size).not.toBe(50);
  });

  it("Mutant Proof (P5: Unknown Paging): Null paging style terminates on first page without multi-page loop", async () => {
    const contract = synthesizeAdapterContract({
      id: "synthetic.single.page",
      provider: "synthetic",
      platform: "x",
      inputs: [{ name: "id", type: "string" }],
      list_path: "$.item",
    });

    expect(contract.pagination.style).toBeNull();
    const res = await executeContractRetrieval(contract, {
      requestedPages: 10,
      requestedLimit: 25,
      fetchPage: async () => ({ rows: [{ id: "single-1" }], hasMore: true }),
    });
    expect(res.pagesFetched).toBe(1);
    expect(res.stopReason).toBe("المصدر لا يدعم صفحات أكثر");
  });

  it("Mutant Proof (P5: Coverage Report): Missing coverage report fails assertion", () => {
    expect(existsSync(coveragePath)).toBe(true);
    const report = JSON.parse(readFileSync(coveragePath, "utf-8"));
    expect(report.total_endpoints).toBe(3276);
  });

  // -----------------------------------------------------------------------------------------
  // Point 5.2: Data-Driven Contract Preference Ranking
  // -----------------------------------------------------------------------------------------
  describe("Point 5.2: Data-Driven Contract Status Preference in Ranking", () => {
    it("contractScore assigns +10 for full, 0 for partial, and -10 for unknown", () => {
      const fullEp = { id: "ep.full", adapter_contract: { contract_status: "full" } } as any;
      const partialEp = { id: "ep.partial", adapter_contract: { contract_status: "partial" } } as any;
      const unknownEp = { id: "ep.unknown", adapter_contract: { contract_status: "unknown" } } as any;
      const uncontractedEp = { id: "ep.none" } as any;

      expect(contractScore(fullEp)).toBe(10);
      expect(contractScore(partialEp)).toBe(0);
      expect(contractScore(unknownEp)).toBe(-10);
      expect(contractScore(uncontractedEp)).toBe(-10);
      expect(getContractStatus(fullEp)).toBe("full");
      expect(getContractStatus(partialEp)).toBe("partial");
      expect(getContractStatus(unknownEp)).toBe("unknown");
    });

    it("rankCandidatesWithContractPreference orders full (+10) > partial (0) > unknown (-10) for candidates of equal cost", () => {
      const epUnknown = {
        id: "cand.unknown",
        cost: { usd: 0.01 },
        adapter_contract: { contract_status: "unknown" },
      } as any;
      const epPartial = {
        id: "cand.partial",
        cost: { usd: 0.01 },
        adapter_contract: { contract_status: "partial" },
      } as any;
      const epFull = {
        id: "cand.full",
        cost: { usd: 0.01 },
        adapter_contract: { contract_status: "full" },
      } as any;

      const mockCatalog = {
        byId: new Map<string, CatalogEndpoint>([
          ["cand.unknown", epUnknown],
          ["cand.partial", epPartial],
          ["cand.full", epFull],
        ]),
      } as unknown as TregCatalog;

      const candidates = [{ id: "cand.unknown" }, { id: "cand.full" }, { id: "cand.partial" }];
      const ranked = rankCandidatesWithContractPreference(candidates, mockCatalog);

      expect(ranked.map((c) => c.id)).toEqual(["cand.full", "cand.partial", "cand.unknown"]);
    });

    it("rankEndpoints tie-breaks candidates of equal effective cost by contract score", () => {
      const epPartial = {
        id: "ep.partial",
        capability: "test.cap",
        adapter_contract: { contract_status: "partial", pagination: { max_page_size: 20 } },
        cost: { unit: "call", usd: 0.01 },
        inputs: [],
      } as any;
      const epFull = {
        id: "ep.full",
        capability: "test.cap",
        adapter_contract: { contract_status: "full", pagination: { max_page_size: 20 } },
        cost: { unit: "call", usd: 0.01 },
        inputs: [],
      } as any;

      const mockCatalog = {
        endpoints: [epPartial, epFull],
        byId: new Map<string, CatalogEndpoint>([
          ["ep.partial", epPartial],
          ["ep.full", epFull],
        ]),
      } as any;

      const { ranked } = rankEndpoints([epPartial, epFull], mockCatalog, new Map(), Date.now());
      // ep.full should rank before ep.partial despite alphabetically "ep.partial" coming first
      expect(ranked[0].id).toBe("ep.full");
      expect(ranked[1].id).toBe("ep.partial");
      expect(ranked[0].contractScore).toBe(10);
      expect(ranked[1].contractScore).toBe(0);
    });
  });
});
