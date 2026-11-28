import writeActions from "../../../data/treg/treg_write_actions.json";
import catalogIndex from "../../../data/treg/treg_catalog_index.json";
import dataPolicy from "../../../data/treg/data_policy.json";
import sellableAdditions from "../../../data/treg/sellable_additions.json";
import type { CatalogEndpoint, EndpointAdapterContract } from "./catalog";

/**
 * The hard block list for the data gateway. Enforced in code at the one place every gateway call passes (`executeTregCall`), whatever the plan, the model or a
 * stored quote says. A blocked endpoint is never sent a request.
 *
 *  - `write_action`: one of the 276 endpoints that create, edit, delete, post, reply, send… (data/treg/treg_write_actions.json). Never callable.
 *  - `own_account`: an endpoint that acts on an account of ours, when the caller knows its scope (the live describe says so).
 *  - `paused_provider`: any endpoint whose PROVIDER is paused, by provider name («apollo», «datagma», owner decision), whatever the catalog says.
 *  - `policy_blocked`: an endpoint the DATA CATEGORY policy classifies as «blocked» (data/treg/data_policy.json: for example the private-messaging deep links), whatever else is true.
 *  - `not_sellable`: an endpoint of a KNOWN provider that is not in the sellable catalog snapshot (data/treg/treg_catalog_index.json, built from
 *    treg_catalog_sellable.json, whose own-account, write and paused endpoints were removed). This covers the 652 own-account endpoints and the 12 paused ones
 *    without listing them, and an id a model made up inside a real provider.
 *
 * An id whose provider is not in the catalog at all (a placeholder such as «x.y.z», a product slug) is not matched by the `not_sellable` rule: the gateway answers it
 * with «not found» at no cost. Paused providers are blocked by name (`PAUSED_PROVIDERS`), because the snapshot cannot list their endpoints.
 */
export type EndpointBlockReason = "write_action" | "own_account" | "paused_provider" | "policy_blocked" | "not_sellable";

/** Providers that are paused: every endpoint of these providers is blocked by NAME (the snapshot carries only a count of paused endpoints, not their ids). */
export const PAUSED_PROVIDERS: readonly string[] = dataPolicy.pausedProviders;
const PAUSED_SET: ReadonlySet<string> = new Set(PAUSED_PROVIDERS);

const WRITE_IDS: ReadonlySet<string> = new Set((writeActions as Array<{ id: string }>).map((e) => e.id));
const SELLABLE_IDS: ReadonlySet<string> = new Set(catalogIndex.ids);
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set([...catalogIndex.providers, ...[...WRITE_IDS].map(providerOf)]);
const BLOCKED_POLICY_IDS: ReadonlySet<string> = new Set(
  Object.keys((dataPolicy as any).endpoints ?? {}).filter((id) => (dataPolicy as any).endpoints[id] === "blocked")
);

export const SUPPORTED_DELIVERY_COST_UNITS: ReadonlySet<string> = new Set([
  "ad",
  "analysis_unit",
  "call",
  "character",
  "domain",
  "employee",
  "index_item_unit",
  "item",
  "keyword",
  "page",
  "per_success",
  "post",
  "quota_row",
  "record",
  "result",
  "review",
  "row",
  "step",
  "target",
  "user",
  "utf8_byte",
]);
export const SUPPORTED_DELIVERY_BILLING_TYPES: ReadonlySet<string> = new Set([
  "per_call",
  "per_record",
  "per_result",
  "per_success",
  "quota_rows",
]);
const SUPPORTED_HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "POST"]);

export interface CatalogAdditionEntry {
  endpoint: CatalogEndpoint;
  policy: "public";
  contract: EndpointAdapterContract;
}

export interface ValidatedCatalogAdditions {
  valid: boolean;
  version: number;
  entries: CatalogAdditionEntry[];
  byId: ReadonlyMap<string, CatalogAdditionEntry>;
  endpoints: CatalogEndpoint[];
  contracts: EndpointAdapterContract[];
  providers: ReadonlySet<string>;
  deniedIds: ReadonlySet<string>;
  rejectionReason?: string;
}

export function validateCatalogAdditions(
  raw: unknown,
  pinned?: {
    sellableIds?: ReadonlySet<string>;
    writeIds?: ReadonlySet<string>;
    pausedProviders?: ReadonlySet<string>;
    blockedEndpoints?: ReadonlySet<string>;
  }
): ValidatedCatalogAdditions {
  const sellableIds = pinned?.sellableIds ?? SELLABLE_IDS;
  const writeIds = pinned?.writeIds ?? WRITE_IDS;
  const pausedProviders = pinned?.pausedProviders ?? PAUSED_SET;
  const blockedEndpoints = pinned?.blockedEndpoints ?? BLOCKED_POLICY_IDS;

  const candidateIds = new Set<string>();
  if (raw && typeof raw === "object" && Array.isArray((raw as any).entries)) {
    for (const item of (raw as any).entries) {
      if (item && typeof item === "object") {
        if (typeof item.endpoint?.id === "string") candidateIds.add(item.endpoint.id.trim());
        if (typeof item.contract?.endpoint_id === "string") candidateIds.add(item.contract.endpoint_id.trim());
      }
    }
  }

  const fail = (reason: string): ValidatedCatalogAdditions => ({
    valid: false,
    version: typeof (raw as any)?.version === "number" ? (raw as any).version : 1,
    entries: [],
    byId: new Map(),
    endpoints: [],
    contracts: [],
    providers: new Set(),
    deniedIds: candidateIds,
    rejectionReason: reason,
  });

  if (!raw || typeof raw !== "object") return fail("not_an_object");
  const r = raw as { version?: unknown; entries?: unknown };
  if (r.version !== 1) return fail("invalid_version");
  if (!Array.isArray(r.entries)) return fail("invalid_entries");

  if (r.entries.length === 0) {
    return {
      valid: true,
      version: 1,
      entries: [],
      byId: new Map(),
      endpoints: [],
      contracts: [],
      providers: new Set(),
      deniedIds: new Set(),
    };
  }

  const validatedEntries: CatalogAdditionEntry[] = [];
  const byId = new Map<string, CatalogAdditionEntry>();
  const providers = new Set<string>();

  for (const item of r.entries) {
    if (!item || typeof item !== "object") return fail("entry_not_object");
    const entry = item as Partial<CatalogAdditionEntry>;

    if (entry.policy !== "public") return fail("policy_not_public");

    const ep = entry.endpoint;
    if (!ep || typeof ep !== "object" || typeof ep.id !== "string") return fail("invalid_endpoint");
    const id = ep.id.trim();
    if (!id) return fail("empty_endpoint_id");

    if (byId.has(id)) return fail(`duplicate_manifest_id: ${id}`);
    if (sellableIds.has(id)) return fail(`duplicate_base_id: ${id}`);
    if (writeIds.has(id)) return fail(`write_action_id: ${id}`);
    if (blockedEndpoints.has(id)) return fail(`policy_denied_id: ${id}`);

    const provider = String(ep.provider ?? "").trim();
    if (!provider) return fail(`missing_provider: ${id}`);
    if (providerOf(id) !== provider) return fail(`provider_namespace_mismatch: ${id}`);

    if (pausedProviders.has(provider.toLowerCase())) return fail(`paused_provider_id: ${id}`);

    // a) scope must be the documented read scope (same value the base snapshot uses for read endpoints); a missing scope is rejected.
    if (typeof ep.scope !== "string" || !ep.scope.trim()) return fail(`missing_scope: ${id}`);
    const scope = ep.scope.trim().toLowerCase();
    if (scope === "own_account") return fail(`own_account_scope: ${id}`);
    if (scope !== "read") return fail(`invalid_scope: ${id}`);

    // b) method must be a supported HTTP method (exact literal "GET" or "POST" only, no lowercase, no padding); missing/other rejected.
    if (typeof ep.method !== "string" || !SUPPORTED_HTTP_METHODS.has(ep.method)) {
      return fail(`unsupported_method: ${id}`);
    }

    const contract = entry.contract;
    if (!contract || typeof contract !== "object" || typeof contract.endpoint_id !== "string") {
      return fail(`invalid_contract: ${id}`);
    }
    if (contract.endpoint_id.trim() !== id) return fail(`contract_endpoint_id_mismatch: ${id}`);

    const role = contract.role;
    if (role !== "delivery" && role !== "count" && role !== "schema") return fail(`invalid_contract_role: ${id}`);

    if (role === "delivery") {
      // c) role "delivery": cost must be finite (Number.isFinite) and > 0 USD, in a supported unit, and the cost fields consistent with each other
      if (contract.dispatch !== "funded") return fail(`delivery_must_be_funded: ${id}`);
      if (!ep.cost || typeof ep.cost !== "object") return fail(`delivery_cost_missing: ${id}`);
      const cost = ep.cost;
      if (typeof cost.usd !== "number" || !Number.isFinite(cost.usd) || cost.usd <= 0) {
        return fail(`delivery_cost_must_be_finite_positive: ${id}`);
      }
      if (typeof cost.unit !== "string" || !SUPPORTED_DELIVERY_COST_UNITS.has(cost.unit)) {
        return fail(`delivery_unsupported_unit: ${id}`);
      }
      if (
        typeof cost.type !== "string" ||
        cost.type.trim() !== cost.type ||
        !SUPPORTED_DELIVERY_BILLING_TYPES.has(cost.type)
      ) {
        return fail(`delivery_cost_inconsistent: ${id}`);
      }
      if (cost.value !== undefined && cost.value !== null) {
        if (typeof cost.value !== "number" || !Number.isFinite(cost.value) || cost.value <= 0) {
          return fail(`delivery_cost_value_invalid: ${id}`);
        }
      }
    } else {
      // d) roles "count" and "schema": cost must be PRESENT and exactly free type, USD 0 (finite), unit per call; missing cost, negative/non-numeric USD, or any non-free type is rejected.
      if (!ep.cost || typeof ep.cost !== "object") return fail(`helper_cost_missing: ${id}`);
      const cost = ep.cost;
      if (cost.type !== "free") return fail(`helper_type_must_be_free: ${id}`);
      if (typeof cost.usd !== "number" || !Number.isFinite(cost.usd) || cost.usd !== 0 || Object.is(cost.usd, -0)) {
        return fail(`helper_usd_must_be_zero: ${id}`);
      }
      if (cost.unit !== "call") return fail(`helper_unit_must_be_call: ${id}`);
      if (cost.value !== undefined && cost.value !== null) {
        if (typeof cost.value !== "number" || !Number.isFinite(cost.value) || cost.value !== 0 || Object.is(cost.value, -0)) {
          return fail(`helper_cost_value_invalid: ${id}`);
        }
      }
    }

    if (contract.helpers) {
      if (typeof contract.helpers !== "object" || contract.helpers === null) return fail(`invalid_helpers_object: ${id}`);
      const helpers = contract.helpers as { count?: unknown; schema?: unknown };
      const hCount = helpers.count;
      const hSchema = helpers.schema;
      if (hCount !== undefined) {
        if (typeof hCount !== "string" || !hCount.trim()) return fail(`invalid_count_helper_id: ${id}`);
        if (providerOf(hCount) !== provider) return fail(`cross_source_helper: ${hCount}`);
      }
      if (hSchema !== undefined) {
        if (typeof hSchema !== "string" || !hSchema.trim()) return fail(`invalid_schema_helper_id: ${id}`);
        if (providerOf(hSchema) !== provider) return fail(`cross_source_helper: ${hSchema}`);
      }
    }

    const validated: CatalogAdditionEntry = {
      endpoint: ep as CatalogEndpoint,
      policy: "public",
      contract: contract as EndpointAdapterContract,
    };
    validatedEntries.push(validated);
    byId.set(id, validated);
    providers.add(provider);
  }

  // Cross-reference checks within manifest
  for (const item of validatedEntries) {
    if (item.contract.helpers) {
      const helpers = item.contract.helpers as { count?: string; schema?: string };
      if (helpers.count) {
        const h = byId.get(helpers.count);
        if (!h) return fail(`missing_helper: ${helpers.count}`);
        if (h.contract.role !== "count") return fail(`invalid_helper_role: ${helpers.count}`);
        if (!h.endpoint.cost || typeof h.endpoint.cost.usd !== "number" || !Number.isFinite(h.endpoint.cost.usd) || h.endpoint.cost.usd !== 0 || Object.is(h.endpoint.cost.usd, -0) || h.endpoint.cost.type !== "free" || h.endpoint.cost.unit !== "call") {
          return fail(`paid_helper: ${helpers.count}`);
        }
      }
      if (helpers.schema) {
        const h = byId.get(helpers.schema);
        if (!h) return fail(`missing_helper: ${helpers.schema}`);
        if (h.contract.role !== "schema") return fail(`invalid_helper_role: ${helpers.schema}`);
        if (!h.endpoint.cost || typeof h.endpoint.cost.usd !== "number" || !Number.isFinite(h.endpoint.cost.usd) || h.endpoint.cost.usd !== 0 || Object.is(h.endpoint.cost.usd, -0) || h.endpoint.cost.type !== "free" || h.endpoint.cost.unit !== "call") {
          return fail(`paid_helper: ${helpers.schema}`);
        }
      }
    }
  }

  return {
    valid: true,
    version: 1,
    entries: validatedEntries,
    byId,
    endpoints: validatedEntries.map((e) => e.endpoint),
    contracts: validatedEntries.map((e) => e.contract),
    providers,
    deniedIds: new Set(),
  };
}

export const VALIDATED_ADDITIONS: ValidatedCatalogAdditions = validateCatalogAdditions(sellableAdditions);
let activeValidatedAdditions: ValidatedCatalogAdditions = VALIDATED_ADDITIONS;

export function getValidatedAdditions(): ValidatedCatalogAdditions {
  return activeValidatedAdditions;
}

export function setValidatedAdditionsForTest(additions: ValidatedCatalogAdditions | null): void {
  activeValidatedAdditions = additions ?? VALIDATED_ADDITIONS;
}

/** The provider part of an endpoint id: everything before the first dot. */
export function providerOf(endpointId: string): string {
  const id = String(endpointId ?? "").trim();
  const dot = id.indexOf(".");
  return dot > 0 ? id.slice(0, dot) : "";
}

/** Why an endpoint may never be called, or null when it may. `scope` is the catalog's own scope of the endpoint when the caller has it. */
export function blockedEndpointReason(
  endpointId: string,
  scope?: string | null,
  additions: ValidatedCatalogAdditions = getValidatedAdditions()
): EndpointBlockReason | null {
  const id = String(endpointId ?? "").trim();
  if (!id) return null;
  if (WRITE_IDS.has(id)) return "write_action";
  if (String(scope ?? "").toLowerCase() === "own_account") return "own_account";
  const provider = providerOf(id);
  if (provider && PAUSED_SET.has(provider.toLowerCase())) return "paused_provider";
  if (BLOCKED_POLICY_IDS.has(id)) return "policy_blocked";

  if (additions.valid && additions.byId.has(id)) {
    return null;
  }

  if (additions.deniedIds.has(id) && !SELLABLE_IDS.has(id)) {
    return "not_sellable";
  }

  if (
    provider &&
    (KNOWN_PROVIDERS.has(provider) || (additions.valid && additions.providers.has(provider))) &&
    !SELLABLE_IDS.has(id)
  ) {
    return "not_sellable";
  }
  return null;
}

export const isEndpointBlocked = (endpointId: string, scope?: string | null): boolean => blockedEndpointReason(endpointId, scope) !== null;

/** Sizes of the lists in force (for the admin trace and the tests). */
export const BLOCK_LIST_SIZES = { writeActions: WRITE_IDS.size, sellable: SELLABLE_IDS.size, providers: KNOWN_PROVIDERS.size } as const;
export const CATALOG_SNAPSHOT = catalogIndex.source;
