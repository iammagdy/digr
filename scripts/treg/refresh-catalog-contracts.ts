import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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

/**
 * Computes a deterministic SHA-256 fingerprint of an endpoint contract schema object.
 * Canonicalizes keys to ensure consistent hashing across environments.
 */
export function computeContractFingerprint(contractData: unknown): string {
  const canonical = JSON.stringify(contractData, Object.keys(contractData as object || {}).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

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
      "Accept": "application/json",
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
      "Accept": "application/json",
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

    // Invariant: pagination contract checks
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

    // Invariant: dedupe_key check
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
  const isValidateOnly = args.includes("--validate") || args.length === 0;
  const isDryRun = args.includes("--dry-run");

  console.log(`[TREG Refresher] Running in mode: ${isValidateOnly ? "validate" : "refresh"}`);
  const summary = validateRegistryContracts();
  console.log(`[TREG Refresher] Validated ${summary.valid}/${summary.total} endpoint contracts.`);
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
