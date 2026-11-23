import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getMultiProviderContracts } from "../../src/lib/multiProvider/catalog";

export interface EndpointContractValidationResult {
  endpoint_id: string;
  valid: boolean;
  sha256?: string;
  error?: string;
}

export interface RegistryValidationSummary {
  total: number;
  valid: number;
  errors: EndpointContractValidationResult[];
}

export const AdapterPaginationSchema = z.object({
  style: z.enum(["cursor", "page", "offset", "none"]).nullable(),
  page_size_param: z.string().nullable(),
  max_page_size: z.number().nullable(),
  cursor_param: z.string().nullable(),
  cursor_path: z.string().nullable(),
  automated_paging_ready: z.boolean().nullable(),
});

export const AdapterContractSchema = z.object({
  endpoint_id: z.string(),
  provider: z.string(),
  platform_family: z.string(),
  category: z.string().nullable(),
  contract_status: z.enum(["full", "partial", "unknown"]),
  inputs_schema: z.record(z.string(), z.unknown()).or(z.array(z.unknown())).nullable(),
  outputs_schema: z.record(z.string(), z.unknown()).nullable(),
  pagination: AdapterPaginationSchema,
  query_syntax: z.object({
    notes: z.string().nullable(),
    operators: z.array(z.string()),
  }).nullable(),
  needs_session: z.boolean(),
  schema_fingerprint: z.string(),
  drifted: z.boolean(),
  capability: z.string().nullable().optional(),
  capability_tags: z.array(z.string()).optional(),
  cost: z.object({
    unit: z.string(),
    usd: z.number().nullable(),
    credits: z.number().nullable().optional(),
    currency: z.string(),
  }).nullable().optional(),
  observed: z.object({
    ok_rate: z.number(),
    samples: z.number(),
  }).nullable().optional(),
}).passthrough();

export type AdapterContract = z.infer<typeof AdapterContractSchema>;

export interface CoverageReport {
  total_endpoints: number;
  total_platform_families: number;
  contracts: {
    full: number;
    partial: number;
    unknown: number;
  };
  coverage_percent: {
    full: number;
    actionable: number;
  };
  by_platform_family: Record<string, {
    total: number;
    full: number;
    partial: number;
    unknown: number;
  }>;
  generated_at: string;
}

const PAGE_SIZE_KEYWORDS = ["limit", "pagesize", "page_size", "per_page", "count", "size", "max_results"];
const CURSOR_KEYWORDS = ["cursor", "next_cursor", "starting_after", "nexttoken", "continuation_token"];
const PAGE_KEYWORDS = ["page", "page_number", "page_no"];
const OFFSET_KEYWORDS = ["offset", "start", "skip"];

/**
 * Computes a deterministic SHA-256 fingerprint of an endpoint contract schema object.
 * Canonicalizes keys to ensure consistent hashing across environments.
 */
export function computeContractFingerprint(contractData: unknown): string {
  const canonical = JSON.stringify(contractData, Object.keys((contractData as object) || {}).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Extracts recognized search operators from a parameter note.
 */
export function extractQueryOperators(note: string | null | undefined): string[] {
  if (!note || typeof note !== "string") return [];
  const matches = note.match(/([a-zA-Z0-9_-]+:)/g);
  if (!matches) return [];
  return Array.from(new Set(matches.map((m) => m.toLowerCase())));
}

/**
 * Synthesizes a deterministic AdapterContract from public endpoint schema metadata.
 * Strictly adheres to the zero-guessing invariant (Point 5.1):
 * - Any parameter or limit not declared remains strictly null.
 * - contract_status is "full" ONLY if inputs, outputs, paging parameter, and max page size are all declared.
 * - contract_status is "partial" if inputs and outputs are declared but pagination details or limits are missing.
 * - contract_status is "unknown" if inputs or outputs are undeclared (raw HTTP schema).
 */
export function synthesizeAdapterContract(endpoint: any, curated?: any): AdapterContract {
  const endpoint_id = String(endpoint.id || endpoint.endpoint_id || "unknown");
  const provider = String(endpoint.provider || (endpoint_id.split(".")[0] ?? "unknown"));
  const platform_family = String(endpoint.platform || "unknown").toLowerCase();
  const category = endpoint.category ? String(endpoint.category) : null;

  const inputs = Array.isArray(endpoint.inputs) ? endpoint.inputs : [];
  const inputs_schema = inputs.length > 0 ? {
    type: "object",
    properties: Object.fromEntries(
      inputs.map((inp: any) => [
        inp.name,
        {
          type: inp.type ?? "string",
          in: inp.in ?? "query",
          required: Boolean(inp.required),
          minimum: typeof inp.minimum === "number" ? inp.minimum : null,
          maximum: typeof inp.maximum === "number" ? inp.maximum : null,
          default: inp.default ?? null,
          enum: Array.isArray(inp.enum) ? inp.enum : null,
          note: inp.note ?? null,
        },
      ])
    ),
    required: inputs.filter((inp: any) => inp.required).map((inp: any) => inp.name),
  } : null;

  const hasOutputs = Boolean(endpoint.list_path || endpoint.item_fields || endpoint.example_response_trimmed || curated?.results_path);
  const outputs_schema = hasOutputs ? {
    list_path: endpoint.list_path ?? curated?.results_path ?? null,
    cursor_path: endpoint.cursor_path ?? curated?.pagination?.cursor_out_path ?? null,
    item_fields: endpoint.item_fields ?? null,
    example_response_trimmed: endpoint.example_response_trimmed ?? null,
  } : null;

  // Page-size parameter detection (Point 5.1):
  let page_size_param: string | null = null;
  let max_page_size: number | null = null;

  for (const inp of inputs) {
    const lowerName = String(inp.name || "").toLowerCase().replace(/[-_]/g, "");
    if (PAGE_SIZE_KEYWORDS.some((kw) => kw.replace(/[-_]/g, "") === lowerName)) {
      page_size_param = inp.name;
      if (typeof inp.maximum === "number" && inp.maximum > 0) {
        max_page_size = inp.maximum;
      }
      break;
    }
  }

  // Paging style detection (Point 5.1):
  let style: "cursor" | "page" | "offset" | null = null;
  let cursor_param: string | null = null;
  let cursor_path: string | null = endpoint.cursor_path ?? null;

  for (const inp of inputs) {
    const lowerName = String(inp.name || "").toLowerCase();
    if (CURSOR_KEYWORDS.some((kw) => lowerName.includes(kw))) {
      style = "cursor";
      cursor_param = inp.name;
      break;
    }
  }

  if (!style) {
    for (const inp of inputs) {
      const lowerName = String(inp.name || "").toLowerCase();
      if (PAGE_KEYWORDS.includes(lowerName)) {
        style = "page";
        break;
      }
    }
  }

  if (!style) {
    for (const inp of inputs) {
      const lowerName = String(inp.name || "").toLowerCase();
      if (OFFSET_KEYWORDS.includes(lowerName)) {
        style = "offset";
        break;
      }
    }
  }

  if (!style && cursor_path) {
    style = "cursor";
  }

  if (!style && Array.isArray(endpoint.pagination)) {
    const pag = endpoint.pagination.map((p: any) => String(p).toLowerCase());
    if (pag.some((p: string) => p.includes("cursor"))) {
      style = "cursor";
    } else if (pag.some((p: string) => p.includes("page"))) {
      style = "page";
    } else if (pag.some((p: string) => p.includes("offset"))) {
      style = "offset";
    }
  }

  // Overlay curated research contract if present
  if (curated) {
    if (curated.pagination) {
      if (typeof curated.pagination.max_page_size === "number" && curated.pagination.max_page_size > 0) {
        max_page_size = curated.pagination.max_page_size;
      }
      if (curated.pagination.requested_page_size_param) {
        page_size_param = curated.pagination.requested_page_size_param;
      }
      if (curated.pagination.cursor_in_param) {
        cursor_param = curated.pagination.cursor_in_param;
        style = "cursor";
      }
      if (curated.pagination.cursor_out_path) {
        cursor_path = curated.pagination.cursor_out_path;
        style = "cursor";
      }
      if (curated.pagination.kind === "cursor") style = "cursor";
      if (curated.pagination.kind === "page") style = "page";
      if (curated.pagination.kind === "offset") style = "offset";
    }
  }

  // automated_paging_ready:
  let automated_paging_ready: boolean | null = null;
  if (curated?.pagination?.automated_paging_ready !== undefined) {
    automated_paging_ready = curated.pagination.automated_paging_ready;
  } else if (style !== null && page_size_param !== null) {
    automated_paging_ready = true;
  } else if (style === null) {
    automated_paging_ready = false;
  }

  // Query parameter syntax:
  const queryInput = inputs.find((i: any) => ["query", "q", "search", "keyword"].includes(String(i.name || "").toLowerCase()));
  const queryNote = queryInput?.note ? String(queryInput.note) : null;
  const queryOperators = extractQueryOperators(queryNote);
  const query_syntax = queryInput ? {
    notes: queryNote,
    operators: queryOperators,
  } : null;

  // needs_session:
  const needs_session = Boolean(
    endpoint.scope === "own_account" ||
    (endpoint.summary && /session|cookie|login/i.test(endpoint.summary)) ||
    curated?.needs_session === true
  );

  // Deterministic schema fingerprint:
  const schema_fingerprint = computeContractFingerprint({
    inputs: inputs_schema,
    outputs: outputs_schema,
  });

  const capability = endpoint.capability ? String(endpoint.capability) : (curated?.capability ? String(curated.capability) : null);
  const capability_tags = Array.isArray(endpoint.capability_tags)
    ? endpoint.capability_tags
    : (capability ? [capability] : []);

  const cost = endpoint.cost ? {
    unit: endpoint.cost.unit ?? "call",
    usd: typeof endpoint.cost.usd === "number" ? endpoint.cost.usd : null,
    credits: typeof endpoint.cost.credits === "number" ? endpoint.cost.credits : null,
    currency: endpoint.cost.currency ?? "USD",
  } : null;

  const observed = endpoint.observed && typeof endpoint.observed.ok_rate === "number" ? {
    ok_rate: endpoint.observed.ok_rate,
    samples: typeof endpoint.observed.samples === "number" ? endpoint.observed.samples : 0,
  } : null;

  // Strict Zero-Guess Invariant (Point 5.1):
  let contract_status: "full" | "partial" | "unknown" = "unknown";
  if (inputs_schema !== null && outputs_schema !== null && page_size_param !== null && max_page_size !== null) {
    contract_status = "full";
  } else if (inputs_schema !== null && outputs_schema !== null) {
    contract_status = "partial";
  } else {
    contract_status = "unknown";
  }

  const contract: AdapterContract = {
    endpoint_id,
    provider,
    platform_family,
    category,
    capability,
    capability_tags,
    contract_status,
    inputs_schema,
    outputs_schema,
    pagination: {
      style,
      page_size_param,
      max_page_size,
      cursor_param,
      cursor_path,
      automated_paging_ready,
    },
    query_syntax,
    needs_session,
    schema_fingerprint,
    drifted: false,
    cost,
    observed,
    ...(curated ? {
      best_for: curated.best_for ?? null,
      not_for: curated.not_for ?? null,
      results_path: curated.results_path ?? outputs_schema?.list_path ?? null,
      mcp_results_path: curated.mcp_results_path ?? null,
      dedupe_key: curated.dedupe_key ?? null,
      billing: curated.billing ?? null,
    } : {}),
  };

  return contract;
}

/**
 * Computes coverage metrics and breakdowns per platform family (Point 5.2).
 */
export function generateCoverageReport(contracts: AdapterContract[]): CoverageReport {
  const total_endpoints = contracts.length;
  const platformStats: Record<string, { total: number; full: number; partial: number; unknown: number }> = {};
  const statusCounts = { full: 0, partial: 0, unknown: 0 };

  for (const c of contracts) {
    const pf = c.platform_family || "unknown";
    if (!platformStats[pf]) {
      platformStats[pf] = { total: 0, full: 0, partial: 0, unknown: 0 };
    }
    platformStats[pf].total += 1;
    platformStats[pf][c.contract_status] += 1;
    statusCounts[c.contract_status] += 1;
  }

  const total_platform_families = Object.keys(platformStats).length;
  const full_percent = total_endpoints > 0 ? Number(((statusCounts.full / total_endpoints) * 100).toFixed(1)) : 0;
  const actionable_percent = total_endpoints > 0 ? Number((((statusCounts.full + statusCounts.partial) / total_endpoints) * 100).toFixed(1)) : 0;

  return {
    total_endpoints,
    total_platform_families,
    contracts: statusCounts,
    coverage_percent: {
      full: full_percent,
      actionable: actionable_percent,
    },
    by_platform_family: platformStats,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Ingests sellable endpoints, synthesizes adapter contracts, and writes artifacts:
 * - data/treg/adapter_contracts.json
 * - data/treg/contract_coverage_report.json
 */
export function generateCatalogContracts(options: {
  catalogPath?: string;
  registryPath?: string;
  outputPath?: string;
  coveragePath?: string;
} = {}): { contracts: AdapterContract[]; report: CoverageReport } {
  const catPath = options.catalogPath ?? path.join(process.cwd(), "data", "treg", "treg_catalog_sellable.json");
  const regPath = options.registryPath ?? path.join(process.cwd(), "data", "treg", "treg_research_endpoint_registry.json");
  const outPath = options.outputPath ?? path.join(process.cwd(), "data", "treg", "adapter_contracts.json");
  const covPath = options.coveragePath ?? path.join(process.cwd(), "data", "treg", "contract_coverage_report.json");

  if (!existsSync(catPath)) {
    throw new Error(`Catalog sellable file not found at ${catPath}`);
  }

  const catalogRaw = JSON.parse(readFileSync(catPath, "utf-8"));
  const endpoints: any[] = Array.isArray(catalogRaw.endpoints) ? catalogRaw.endpoints : [];

  const curatedMap = new Map<string, any>();
  if (existsSync(regPath)) {
    try {
      const regRaw = JSON.parse(readFileSync(regPath, "utf-8"));
      if (Array.isArray(regRaw.endpoints)) {
        for (const ep of regRaw.endpoints) {
          if (ep && typeof ep.endpoint_id === "string") {
            curatedMap.set(ep.endpoint_id, ep);
          }
        }
      }
    } catch {
      // fallback
    }
  }

  const contracts: AdapterContract[] = [];
  for (const ep of endpoints) {
    if (!ep || !ep.id) continue;
    const curated = curatedMap.get(ep.id);
    const contract = synthesizeAdapterContract(ep, curated);
    contracts.push(contract);
  }

  // Phase 6 Multi-Provider Unification: include Firecrawl & Context.dev contracts
  const multiProviderContracts = getMultiProviderContracts();
  for (const mpc of multiProviderContracts) {
    if (!contracts.some((c) => c.endpoint_id === mpc.endpoint_id)) {
      contracts.push(mpc as AdapterContract);
    }
  }

  const report = generateCoverageReport(contracts);

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    version: "1.0.0",
    total: contracts.length,
    generated_at: report.generated_at,
    endpoints: contracts,
  }, null, 2), "utf-8");

  mkdirSync(path.dirname(covPath), { recursive: true });
  writeFileSync(covPath, JSON.stringify(report, null, 2), "utf-8");

  return { contracts, report };
}

/**
 * Loads adapter contracts from disk. Handles both wrapped and unwrapped array formats.
 */
export function loadAdapterContracts(filePath?: string): AdapterContract[] {
  const resolvedPath = filePath ?? path.join(process.cwd(), "data", "treg", "adapter_contracts.json");
  if (!existsSync(resolvedPath)) {
    throw new Error(`Adapter contracts file not found at ${resolvedPath}`);
  }
  const raw = JSON.parse(readFileSync(resolvedPath, "utf-8"));
  let contracts: AdapterContract[] = [];
  if (Array.isArray(raw)) contracts = raw;
  else if (raw && Array.isArray(raw.endpoints)) contracts = raw.endpoints;

  // Unify with synthesized multi-provider contracts (Phase 6)
  const mpContracts = getMultiProviderContracts() as unknown as AdapterContract[];
  for (const mpc of mpContracts) {
    if (!contracts.some((c) => c.endpoint_id === mpc.endpoint_id)) {
      contracts.push(mpc);
    }
  }

  return contracts;
}

export { getMultiProviderContracts as synthesizeMultiProviderContracts };


/**
 * Fetches public catalog metadata for a specific endpoint from public TREG route.
 * Auth is NOT required for public catalog reads.
 */
export async function fetchPublicEndpointMetadata(
  endpointId: string,
  baseUrl = "https://treg.to"
): Promise<any> {
  const url = `${baseUrl}/catalog/endpoints/${encodeURIComponent(endpointId)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "Diger-Treg-Refresher/1.0",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch metadata for ${endpointId}: HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Queries the public agent-oriented catalog search route.
 * Auth is NOT required.
 */
export async function fetchPublicCatalogSearch(
  query: string,
  baseUrl = "https://treg.to"
): Promise<any> {
  const url = `${baseUrl}/catalog/search?engine=agent&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "Diger-Treg-Refresher/1.0",
    },
  });
  if (!res.ok) {
    throw new Error(`Catalog search failed: HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Validates overlay contracts in the given registry file against schema invariants.
 */
export function validateRegistryContracts(
  registryPath?: string
): RegistryValidationSummary {
  const resolvedPath = registryPath ?? path.join(process.cwd(), "data", "treg", "treg_research_endpoint_registry.json");
  if (!existsSync(resolvedPath)) {
    throw new Error(`Registry file not found at ${resolvedPath}`);
  }

  const raw = JSON.parse(readFileSync(resolvedPath, "utf-8"));
  const endpoints: any[] = Array.isArray(raw.endpoints) ? raw.endpoints : [];
  const errors: EndpointContractValidationResult[] = [];
  let validCount = 0;

  for (const ep of endpoints) {
    const id = ep.endpoint_id;
    if (!id || typeof id !== "string") {
      errors.push({ endpoint_id: "unknown", valid: false, error: "Missing or invalid endpoint_id" });
      continue;
    }

    if (ep.pagination) {
      if (ep.pagination.default_page_size !== null && (typeof ep.pagination.default_page_size !== "number" || ep.pagination.default_page_size <= 0)) {
        errors.push({ endpoint_id: id, valid: false, error: "Invalid default_page_size" });
        continue;
      }
      if (ep.pagination.max_page_size !== null && typeof ep.pagination.max_page_size !== "number") {
        errors.push({ endpoint_id: id, valid: false, error: "max_page_size must be number or null" });
        continue;
      }
    }

    if (ep.dedupe_key !== null && typeof ep.dedupe_key !== "string") {
      errors.push({ endpoint_id: id, valid: false, error: "dedupe_key must be string or null" });
      continue;
    }

    validCount++;
  }

  return {
    total: endpoints.length,
    valid: validCount,
    errors,
  };
}

/**
 * CLI runner for public contract refresh / validation.
 */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isRefresh = args.includes("--refresh") || args.includes("--all") || args.includes("--generate");
  const isValidateOnly = (args.includes("--validate") || args.length === 0) && !isRefresh;

  console.log(`[TREG Refresher] Running in mode: ${isRefresh ? "refresh" : "validate"}`);

  if (isRefresh) {
    console.log("[TREG Refresher] Synthesizing contracts for all sellable endpoints...");
    const { contracts, report } = generateCatalogContracts();
    console.log(`[TREG Refresher] Synthesized ${contracts.length} contracts across ${report.total_platform_families} platform families.`);
    console.log(`[TREG Refresher] Full: ${report.contracts.full}, Partial: ${report.contracts.partial}, Unknown: ${report.contracts.unknown}`);
  }

  const summary = validateRegistryContracts();
  console.log(`[TREG Refresher] Validated ${summary.valid}/${summary.total} curated endpoint contracts.`);
  if (summary.errors.length > 0) {
    console.error(`[TREG Refresher] Found ${summary.errors.length} validation errors:`, summary.errors);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith("refresh-catalog-contracts.ts")) {
  main().catch((err) => {
    console.error("[TREG Refresher] Execution error:", err);
    process.exit(1);
  });
}
