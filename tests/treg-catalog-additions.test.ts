import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BLOCK_LIST_SIZES,
  CATALOG_SNAPSHOT,
  VALIDATED_ADDITIONS,
  blockedEndpointReason,
  isEndpointBlocked,
  validateCatalogAdditions,
  setValidatedAdditionsForTest,
  getValidatedAdditions,
} from "../src/lib/treg/blockList";
import {
  DATA_POLICY_COUNTS,
  categoryOf,
  policyRuleOf,
} from "../src/lib/treg/dataPolicy";
import {
  loadTregPriceBaseline,
  loadTregCatalog,
  clearTregCatalogCache,
  isSellable,
} from "../src/lib/treg/catalog";

const EXPECTED_SNAPSHOT_SHA = "5d8a125d5a563d892cfabceef2a21a0429191bba8017e2707d1bf626035315cc";
const EXPECTED_WRITE_ACTIONS_SHA = "0570489d74ee86b4abc14e7e66764546cbb0eae924c63d2518823ed179754909";

function makeSyntheticEndpoint(overrides: Record<string, unknown> = {}) {
  return {
    id: "synthetic.company.search",
    provider: "synthetic",
    platform: "companies",
    category: "companies",
    capability: "search",
    name: "Synthetic Company Search",
    summary: "Searches synthetic company data",
    method: "POST",
    path: "/api/v1/companies/search",
    kind: "direct",
    tier: "standard",
    async: false,
    async_config: null,
    inputs: [],
    pagination: ["offset", "limit"],
    cost: {
      unit: "record",
      usd: 0.001,
      type: "per_record",
      currency: "USD",
      value: 0.001,
      per: 1,
      billing_note: null,
      failed_or_empty_billed: null,
    },
    observed: null,
    scope: "read",
    cost_confidence: "high",
    siblings: [],
    test_request: null,
    list_path: "companies",
    cursor_path: "next_offset",
    item_fields: null,
    example_response_trimmed: null,
    ...overrides,
  };
}

function makeSyntheticContract(overrides: Record<string, unknown> = {}) {
  return {
    endpoint_id: "synthetic.company.search",
    role: "delivery",
    dispatch: "funded",
    helpers: {
      count: "synthetic.company.count",
      schema: "synthetic.company.schema",
    },
    pagination: {
      cursor_in_param: "offset",
      cursor_out_path_rest: "next_offset",
      cursor_out_path_mcp: "next_offset",
      default_page_size: 50,
      max_page_size: 500,
      max_page_size_semantics: "clamp",
      automated_paging_ready: true,
      stop_rule: "has_more",
      cursor_style: "offset",
      limit_field: "limit",
    },
    ...overrides,
  };
}

function makeSyntheticBatch() {
  return {
    version: 1,
    entries: [
      {
        endpoint: makeSyntheticEndpoint({
          id: "synthetic.company.search",
          provider: "synthetic",
          cost: { unit: "record", usd: 0.001, type: "per_record", currency: "USD", value: 0.001, per: 1, billing_note: null, failed_or_empty_billed: null },
        }),
        policy: "public" as const,
        contract: makeSyntheticContract({
          endpoint_id: "synthetic.company.search",
          role: "delivery",
          dispatch: "funded",
          helpers: { count: "synthetic.company.count", schema: "synthetic.company.schema" },
        }),
      },
      {
        endpoint: makeSyntheticEndpoint({
          id: "synthetic.company.count",
          provider: "synthetic",
          path: "/api/v1/companies/count",
          cost: { unit: "call", usd: 0, type: "free", currency: "USD", value: 0, per: 1, billing_note: null, failed_or_empty_billed: null },
        }),
        policy: "public" as const,
        contract: makeSyntheticContract({
          endpoint_id: "synthetic.company.count",
          role: "count",
          dispatch: undefined,
          helpers: undefined,
        }),
      },
      {
        endpoint: makeSyntheticEndpoint({
          id: "synthetic.company.schema",
          provider: "synthetic",
          method: "GET",
          path: "/api/v1/companies/schema",
          cost: { unit: "call", usd: 0, type: "free", currency: "USD", value: 0, per: 1, billing_note: null, failed_or_empty_billed: null },
        }),
        policy: "public" as const,
        contract: makeSyntheticContract({
          endpoint_id: "synthetic.company.schema",
          role: "schema",
          dispatch: undefined,
          helpers: undefined,
        }),
      },
    ],
  };
}

describe("treg-catalog-additions (G1a + G1b)", () => {
  afterEach(() => {
    setValidatedAdditionsForTest(null);
    clearTregCatalogCache();
  });

  describe("checked-in dormant manifest state", () => {
    it("checked-in sellable_additions.json is valid empty JSON", () => {
      const raw = JSON.parse(readFileSync("data/treg/sellable_additions.json", "utf-8"));
      expect(raw).toEqual({ version: 1, entries: [] });
    });

    it("VALIDATED_ADDITIONS is valid and contains exactly 0 entries", () => {
      expect(VALIDATED_ADDITIONS.valid).toBe(true);
      expect(VALIDATED_ADDITIONS.version).toBe(1);
      expect(VALIDATED_ADDITIONS.entries).toHaveLength(0);
      expect(VALIDATED_ADDITIONS.endpoints).toHaveLength(0);
      expect(VALIDATED_ADDITIONS.contracts).toHaveLength(0);
      expect(VALIDATED_ADDITIONS.byId.size).toBe(0);
      expect(VALIDATED_ADDITIONS.providers.size).toBe(0);
      expect(VALIDATED_ADDITIONS.deniedIds.size).toBe(0);
    });

    it("pinned files, counts, and SHA-256 remain completely unchanged", () => {
      const snapshotBytes = readFileSync("data/treg/treg_catalog_sellable.json");
      expect(createHash("sha256").update(snapshotBytes).digest("hex")).toBe(EXPECTED_SNAPSHOT_SHA);

      const writeBytes = readFileSync("data/treg/treg_write_actions.json");
      expect(createHash("sha256").update(writeBytes).digest("hex")).toBe(EXPECTED_WRITE_ACTIONS_SHA);

      expect(BLOCK_LIST_SIZES.sellable).toBe(3276);
      expect(BLOCK_LIST_SIZES.writeActions).toBe(276);
      expect(CATALOG_SNAPSHOT.count).toBe(3276);
      expect(DATA_POLICY_COUNTS.public).toBe(2993);

      const catalog = loadTregCatalog();
      expect(catalog.count).toBe(3276);
      expect(catalog.endpoints).toHaveLength(3276);
    });
  });

  describe("parameterized invalid-set tests", () => {
    const invalidCases: Array<{
      name: string;
      candidateId: string;
      builder: () => unknown;
      expectedBlockReason?: string | null;
    }> = [
      {
        name: "duplicate base snapshot ID",
        candidateId: "anyapi.x.user.posts",
        expectedBlockReason: null,
        builder: () => ({
          version: 1,
          entries: [
            {
              endpoint: makeSyntheticEndpoint({ id: "anyapi.x.user.posts", provider: "anyapi" }),
              policy: "public",
              contract: makeSyntheticContract({ endpoint_id: "anyapi.x.user.posts" }),
            },
          ],
        }),
      },
      {
        name: "duplicate manifest ID within batch",
        candidateId: "synthetic.dup.one",
        builder: () => ({
          version: 1,
          entries: [
            {
              endpoint: makeSyntheticEndpoint({ id: "synthetic.dup.one", provider: "synthetic" }),
              policy: "public",
              contract: makeSyntheticContract({ endpoint_id: "synthetic.dup.one" }),
            },
            {
              endpoint: makeSyntheticEndpoint({ id: "synthetic.dup.one", provider: "synthetic" }),
              policy: "public",
              contract: makeSyntheticContract({ endpoint_id: "synthetic.dup.one" }),
            },
          ],
        }),
      },
      {
        name: "write action ID in manifest",
        candidateId: "openmart.deny-rules.create",
        expectedBlockReason: "write_action",
        builder: () => ({
          version: 1,
          entries: [
            {
              endpoint: makeSyntheticEndpoint({ id: "openmart.deny-rules.create", provider: "openmart" }),
              policy: "public",
              contract: makeSyntheticContract({ endpoint_id: "openmart.deny-rules.create" }),
            },
          ],
        }),
      },
      {
        name: "paused provider ID in manifest",
        candidateId: "apollo.company.search",
        expectedBlockReason: "paused_provider",
        builder: () => ({
          version: 1,
          entries: [
            {
              endpoint: makeSyntheticEndpoint({ id: "apollo.company.search", provider: "apollo" }),
              policy: "public",
              contract: makeSyntheticContract({ endpoint_id: "apollo.company.search" }),
            },
          ],
        }),
      },
      {
        name: "base policy-denied ID in manifest",
        candidateId: "tikhub.x.douyin-app-v3-open-douyin-app-to-send-private-message",
        expectedBlockReason: "policy_blocked",
        builder: () => ({
          version: 1,
          entries: [
            {
              endpoint: makeSyntheticEndpoint({
                id: "tikhub.x.douyin-app-v3-open-douyin-app-to-send-private-message",
                provider: "tikhub",
              }),
              policy: "public",
              contract: makeSyntheticContract({
                endpoint_id: "tikhub.x.douyin-app-v3-open-douyin-app-to-send-private-message",
              }),
            },
          ],
        }),
      },
      {
        name: "malformed cost: zero delivery cost",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          b.entries[0].endpoint.cost.usd = 0;
          return b;
        },
      },
      {
        name: "malformed cost: negative delivery cost",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          b.entries[0].endpoint.cost.usd = -0.05;
          return b;
        },
      },
      {
        name: "malformed role: unknown role",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          (b.entries[0].contract as any).role = "invalid_role";
          return b;
        },
      },
      {
        name: "delivery without funded dispatch",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          (b.entries[0].contract as any).dispatch = "unfunded";
          return b;
        },
      },
      {
        name: "paid helper with positive cost",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          b.entries[1].endpoint.cost.usd = 0.05;
          return b;
        },
      },
      {
        name: "helper with non-call unit",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          b.entries[1].endpoint.cost.unit = "result";
          return b;
        },
      },
      {
        name: "cross-source helper",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          b.entries[0].contract.helpers.count = "otherprov.company.count";
          return b;
        },
      },
      {
        name: "missing helper referenced in contract",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          b.entries[0].contract.helpers.count = "synthetic.company.missing";
          return b;
        },
      },
      {
        name: "invalid version",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          b.version = 2;
          return b;
        },
      },
      {
        name: "provider ID namespace mismatch",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          b.entries[0].endpoint.provider = "mismatched";
          return b;
        },
      },
      {
        name: "non-public policy",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          (b.entries[0] as any).policy = "sensitive";
          return b;
        },
      },
      {
        name: "helper cost removed",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          delete (b.entries[1].endpoint as any).cost;
          return b;
        },
      },
      {
        name: "helper USD -1",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          (b.entries[1].endpoint.cost as any).usd = -1;
          return b;
        },
      },
      {
        name: "helper nonzero per-call cost with USD 0",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          (b.entries[1].endpoint.cost as any).type = "per_call";
          (b.entries[1].endpoint.cost as any).usd = 0;
          return b;
        },
      },
      {
        name: "delivery unsupported unit",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          (b.entries[0].endpoint.cost as any).unit = "unsupported_unit";
          return b;
        },
      },
      {
        name: "delivery USD 1e309",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          (b.entries[0].endpoint.cost as any).usd = 1e309;
          return b;
        },
      },
      {
        name: "unsupported method",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          (b.entries[0].endpoint as any).method = "DELETE";
          return b;
        },
      },
      {
        name: "read scope removed",
        candidateId: "synthetic.company.search",
        builder: () => {
          const b = makeSyntheticBatch();
          delete (b.entries[0].endpoint as any).scope;
          return b;
        },
      },
    ];

    it.each(invalidCases)("$name is rejected at all three boundaries", ({ candidateId, builder, expectedBlockReason }) => {
      const raw = builder();
      const result = validateCatalogAdditions(raw);

      // 1. Validator outcome: entire batch rejected
      expect(result.valid).toBe(false);
      expect(result.entries).toHaveLength(0);
      expect(result.endpoints).toHaveLength(0);
      expect(result.contracts).toHaveLength(0);
      expect(result.deniedIds.has(candidateId)).toBe(true);

      // 2. Hard admission boundary
      const blockReason = blockedEndpointReason(candidateId, null, result);
      if (expectedBlockReason !== undefined) {
        expect(blockReason).toBe(expectedBlockReason);
      } else {
        expect(blockReason).toBe("not_sellable");
      }

      // 3. Data policy boundary
      const category = categoryOf(candidateId, result);
      if (candidateId === "anyapi.x.user.posts") {
        // Base snapshot entries retain their base policy classification
        expect(category).toBe("public");
      } else {
        expect(category).toBe("blocked");
      }

      // 4. Catalog loader boundary: additions not merged, count stays 3276
      const baseline = loadTregPriceBaseline({ additions: result });
      expect(baseline.count).toBe(3276);
      if (candidateId === "anyapi.x.user.posts") {
        // Base entries remain in the base snapshot and sellable (F2)
        expect(baseline.byId.has(candidateId)).toBe(true);
        expect(isSellable(candidateId, baseline)).toBe(true);
      } else if (candidateId === "tikhub.x.douyin-app-v3-open-douyin-app-to-send-private-message") {
        // Base entry remains in the base snapshot
        expect(baseline.byId.has(candidateId)).toBe(true);
      } else {
        expect(baseline.byId.has(candidateId)).toBe(false);
        expect(isSellable(candidateId, baseline)).toBe(false);
      }

      // Every candidate ID in the batch receives hard refusal and blocked policy (unless base ID)
      for (const id of result.deniedIds) {
        if (id === "anyapi.x.user.posts") {
          expect(blockedEndpointReason(id, null, result)).toBeNull();
          expect(categoryOf(id, result)).toBe("public");
        } else if (id === "openmart.deny-rules.create") {
          expect(blockedEndpointReason(id, null, result)).toBe("write_action");
          expect(categoryOf(id, result)).toBe("blocked");
        } else if (id === "apollo.company.search") {
          expect(blockedEndpointReason(id, null, result)).toBe("paused_provider");
          expect(categoryOf(id, result)).toBe("blocked");
        } else if (id === "tikhub.x.douyin-app-v3-open-douyin-app-to-send-private-message") {
          expect(blockedEndpointReason(id, null, result)).toBe("policy_blocked");
          expect(categoryOf(id, result)).toBe("blocked");
        } else {
          expect(blockedEndpointReason(id, null, result)).toBe("not_sellable");
          expect(categoryOf(id, result)).toBe("blocked");
        }
      }
    });
  });

  describe("valid synthetic manifest integration", () => {
    it("valid synthetic additions are admitted at all three boundaries", () => {
      const validRaw = makeSyntheticBatch();
      const validResult = validateCatalogAdditions(validRaw);

      expect(validResult.valid).toBe(true);
      expect(validResult.entries).toHaveLength(3);
      expect(validResult.endpoints).toHaveLength(3);
      expect(validResult.contracts).toHaveLength(3);
      expect(validResult.deniedIds.size).toBe(0);

      // 1. Hard admission boundary
      expect(isSellable("synthetic.company.search")).toBe(false); // without active additions, not sellable
      expect(blockedEndpointReason("synthetic.company.search", null, validResult)).toBeNull();
      expect(blockedEndpointReason("synthetic.company.count", null, validResult)).toBeNull();
      expect(blockedEndpointReason("synthetic.company.schema", null, validResult)).toBeNull();
      // Any unlisted endpoint under synthetic provider is blocked as not_sellable once synthetic is in validated additions
      expect(blockedEndpointReason("synthetic.company.unlisted", null, validResult)).toBe("not_sellable");

      // 2. Policy boundary
      expect(categoryOf("synthetic.company.search", validResult)).toBe("public");
      expect(policyRuleOf("synthetic.company.search", validResult)).toBe("catalog_additions_explicit");

      // 3. Loader boundary
      const catalog = loadTregPriceBaseline({ additions: validResult });
      expect(catalog.count).toBe(3279);
      expect(catalog.byId.has("synthetic.company.search")).toBe(true);
      expect(catalog.byId.has("synthetic.company.count")).toBe(true);
      expect(catalog.byId.has("synthetic.company.schema")).toBe(true);
      expect(isSellable("synthetic.company.search", catalog)).toBe(true);

      // Check adapter contract is attached
      const ep = catalog.byId.get("synthetic.company.search");
      expect(ep?.adapter_contract).toBeDefined();
      expect(ep?.adapter_contract?.role).toBe("delivery");
      expect(ep?.adapter_contract?.dispatch).toBe("funded");
      expect(ep?.adapter_contract?.helpers).toEqual({
        count: "synthetic.company.count",
        schema: "synthetic.company.schema",
      });

      // Check generic descriptors preserved
      const pagination = ep?.adapter_contract?.pagination as any;
      expect(pagination?.cursor_style).toBe("offset");
      expect(pagination?.limit_field).toBe("limit");
    });

    it("custom dir fixture cannot mint authority and loads only base without additions", () => {
      const validResult = validateCatalogAdditions(makeSyntheticBatch());
      const tmpDir = mkdtempSync(path.join(tmpdir(), "treg-custom-"));
      try {
        // Copy base files to custom dir
        const baseDir = path.join(process.cwd(), "data", "treg");
        writeFileSync(path.join(tmpDir, "treg_catalog_sellable.json"), readFileSync(path.join(baseDir, "treg_catalog_sellable.json")));
        writeFileSync(path.join(tmpDir, "treg_write_actions.json"), readFileSync(path.join(baseDir, "treg_write_actions.json")));

        const customCatalog = loadTregPriceBaseline({ dir: tmpDir, additions: validResult });
        expect(customCatalog.count).toBe(3276);
        expect(customCatalog.byId.has("synthetic.company.search")).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("global setValidatedAdditionsForTest integrates seamlessly with readers", () => {
      const validResult = validateCatalogAdditions(makeSyntheticBatch());
      setValidatedAdditionsForTest(validResult);

      expect(getValidatedAdditions().valid).toBe(true);
      expect(blockedEndpointReason("synthetic.company.search")).toBeNull();
      expect(categoryOf("synthetic.company.search")).toBe("public");
      expect(policyRuleOf("synthetic.company.search")).toBe("catalog_additions_explicit");

      const catalog = loadTregCatalog();
      expect(catalog.count).toBe(3279);
      expect(catalog.byId.has("synthetic.company.search")).toBe(true);
    });

    it("base denials retain precedence over addition candidates", () => {
      // Candidate matching write action
      const writeCandidate = "openmart.deny-rules.create";
      const writeResult = validateCatalogAdditions({
        version: 1,
        entries: [
          {
            endpoint: makeSyntheticEndpoint({ id: writeCandidate, provider: "openmart" }),
            policy: "public",
            contract: makeSyntheticContract({ endpoint_id: writeCandidate }),
          },
        ],
      });
      expect(blockedEndpointReason(writeCandidate, null, writeResult)).toBe("write_action");

      // Candidate matching paused provider
      const pausedCandidate = "apollo.company.search";
      const pausedResult = validateCatalogAdditions({
        version: 1,
        entries: [
          {
            endpoint: makeSyntheticEndpoint({ id: pausedCandidate, provider: "apollo" }),
            policy: "public",
            contract: makeSyntheticContract({ endpoint_id: pausedCandidate }),
          },
        ],
      });
      expect(blockedEndpointReason(pausedCandidate, null, pausedResult)).toBe("paused_provider");
    });
  });
});
