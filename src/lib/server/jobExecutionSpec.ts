import { createHash } from "crypto";
import { searchCatalog, getEndpointDetails } from "../../functions/shared/catalogClient";
import { APPROVED_CAPABILITY_CATALOG } from "../../functions/shared/capabilityRegistry";
import { SOCIAL_ROWS_PER_CHUNK, estimateSocialChunkCostUsd, getSocialCapability } from "../socialSources";

const RETRY_JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export function isValidRetryJobId(value: unknown): value is string {
  return typeof value === "string" && RETRY_JOB_ID_PATTERN.test(value);
}

export interface ResolvedJobExecutionSpec {
  capabilitySlug: string;
  endpointId: string;
  method: "GET" | "POST";
  params: Record<string, any>;
  paginationStrategy: "cursor" | "offset" | "page" | "none";
  pricingUnit: "call" | "item" | "page";
  unitCostUsd: number;
  pageSize: number;
  outputFormats: Array<"xlsx" | "pdf" | "csv">;
  /** Failed job whose collected rows this retry reuses (set only by the server when the retry quote was created). */
  retryOfJobId?: string;
}

export async function resolveJobExecutionSpec(
  adminClient: any,
  jobId: string,
  userId: string,
  rawEndpointId: string,
  unitPricePoints: number
): Promise<ResolvedJobExecutionSpec> {
  let capabilitySlug = rawEndpointId || "tiktok-profile";
  let endpointId = rawEndpointId || "tikhub.tiktok.user.profile";
  let method: "GET" | "POST" | undefined;
  let params: Record<string, any> = {};
  let paginationStrategy: "cursor" | "offset" | "page" | "none" | undefined;
  let pricingUnit: "call" | "item" | "page" = "call";
  let unitCostUsd: number | undefined;
  let itemTargetVolumeMax = 0;
  let outputFormats: Array<"xlsx" | "pdf" | "csv"> = ["xlsx", "pdf", "csv"];
  let retryOfJobId: string | undefined;

  // 1. Match accepted quote in plans_quotes where 'job_quote_' + md5(quote.id) === jobId
  try {
    const qSelect = adminClient?.from?.("plans_quotes")?.select?.("*");
    if (qSelect && typeof qSelect.eq === "function") {
      const { data: quotes } = await qSelect.eq("user_id", userId);
      if (Array.isArray(quotes)) {
        const matched = quotes.find((q: any) => {
          if (!q?.id) return false;
          const digest = createHash("md5").update(String(q.id)).digest("hex");
          return `job_quote_${digest}` === jobId || q.id === jobId;
        });
        if (matched) {
          const selectedFormats = Array.isArray(matched.output_formats)
            ? matched.output_formats.filter((format: unknown): format is "xlsx" | "pdf" | "csv" =>
                format === "xlsx" || format === "pdf" || format === "csv")
            : [];
          if (selectedFormats.length > 0) outputFormats = Array.from(new Set(selectedFormats));
          const items = Array.isArray(matched.items)
            ? matched.items
            : Array.isArray(matched.items?.items)
            ? matched.items.items
            : [];
          const firstItem = items[0];
          if (firstItem && typeof firstItem === "object") {
            if (firstItem.capabilitySlug) capabilitySlug = String(firstItem.capabilitySlug);
            if (firstItem.endpointId) endpointId = String(firstItem.endpointId);
            if (firstItem.method === "GET" || firstItem.method === "POST") {
              method = firstItem.method;
            }
            if (firstItem.params && typeof firstItem.params === "object") {
              // The retry marker is an internal instruction; it must never reach the provider.
              const { retryOfJobId: marker, ...providerParams } = firstItem.params as Record<string, any>;
              params = { ...providerParams };
              if (isValidRetryJobId(marker)) retryOfJobId = marker;
            }
            if (typeof firstItem.targetVolumeMax === "number" && firstItem.targetVolumeMax > 0) {
              itemTargetVolumeMax = firstItem.targetVolumeMax;
            }
            if (
              firstItem.paginationStrategy === "cursor" ||
              firstItem.paginationStrategy === "offset" ||
              firstItem.paginationStrategy === "page" ||
              firstItem.paginationStrategy === "none"
            ) {
              paginationStrategy = firstItem.paginationStrategy;
            }
            if (typeof firstItem.unitCostUsd === "number" && firstItem.unitCostUsd > 0) {
              unitCostUsd = Number(firstItem.unitCostUsd);
            }
            if (
              firstItem.pricingUnit === "call" ||
              firstItem.pricingUnit === "item" ||
              firstItem.pricingUnit === "page"
            ) {
              pricingUnit = firstItem.pricingUnit;
            }
          }
        }
      }
    }
  } catch {
    // Continue with capability catalog resolution
  }

  // Verified social services carry their own source chain: nothing else in the catalog applies to them,
  // and one chunk may make several provider calls, so the spend estimate is the whole chunk's worst case.
  const socialCapability = getSocialCapability(capabilitySlug);
  if (socialCapability) {
    const firstSource =
      socialCapability.comments?.[0] || Object.values(socialCapability.discover).flat().filter(Boolean)[0];
    return {
      capabilitySlug: socialCapability.slug,
      endpointId: firstSource?.endpointId || endpointId,
      method: firstSource?.method || "POST",
      params,
      paginationStrategy: "cursor",
      pricingUnit: "call",
      unitCostUsd: estimateSocialChunkCostUsd(socialCapability),
      pageSize: SOCIAL_ROWS_PER_CHUNK,
      outputFormats,
      ...(retryOfJobId ? { retryOfJobId } : {}),
    };
  }

  // 2. Match capability in capability_registry table if available
  try {
    const capSelect = adminClient?.from?.("capability_registry")?.select?.("*");
    if (capSelect && typeof capSelect.eq === "function") {
      const { data: dbCap } = await capSelect.eq("slug", capabilitySlug).maybeSingle();
      if (dbCap) {
        if (dbCap.endpoint_id && !dbCap.endpoint_id.startsWith("/v1/")) {
          endpointId = String(dbCap.endpoint_id);
        }
        if (typeof dbCap.unit_cost_usd === "number" && dbCap.unit_cost_usd > 0) {
          unitCostUsd = Number(dbCap.unit_cost_usd);
        }
        if (
          dbCap.pagination_type === "cursor" ||
          dbCap.pagination_type === "offset" ||
          dbCap.pagination_type === "page" ||
          dbCap.pagination_type === "none"
        ) {
          paginationStrategy = paginationStrategy || dbCap.pagination_type;
        }
        if (
          dbCap.pricing_unit === "call" ||
          dbCap.pricing_unit === "item" ||
          dbCap.pricing_unit === "page"
        ) {
          pricingUnit = dbCap.pricing_unit;
        }
      }
    }
  } catch {
    // Fallback to APPROVED_CAPABILITY_CATALOG
  }

  // 2b. Match in live TREG catalog via getEndpointDetails
  try {
    const details = await getEndpointDetails(endpointId || capabilitySlug);
    if (details) {
      if (!endpointId || endpointId === capabilitySlug || !endpointId.includes(".")) {
        endpointId = details.id || endpointId;
      }
      method = method || details.method;
      paginationStrategy = paginationStrategy || details.pagination?.type;
      if (details.billingUnit === "call" || details.billingUnit === "item" || details.billingUnit === "page") {
        pricingUnit = details.billingUnit;
      }
      if (unitCostUsd === undefined && details.catalogPriceUsd > 0) {
        unitCostUsd = details.catalogPriceUsd;
      }
    }
  } catch {
    // Continue
  }

  // 3. Match APPROVED_CAPABILITY_CATALOG
  const approvedCap = APPROVED_CAPABILITY_CATALOG.find(
    (c) =>
      c.slug === capabilitySlug ||
      c.slug === rawEndpointId ||
      c.tregEndpointId === rawEndpointId ||
      c.tregEndpointId === endpointId
  );

  if (approvedCap) {
    capabilitySlug = approvedCap.slug;
    endpointId = approvedCap.tregEndpointId;
    method = method || approvedCap.tregMethod;
    paginationStrategy = paginationStrategy || approvedCap.paginationType;
    pricingUnit = approvedCap.pricingUnit;
    if (unitCostUsd === undefined && approvedCap.unitCostUsd > 0) {
      unitCostUsd = approvedCap.unitCostUsd;
    }
  } else if (endpointId === capabilitySlug || endpointId.startsWith("/v1/")) {
    try {
      const catalogHits = await searchCatalog(capabilitySlug);
      if (catalogHits.length > 0) {
        endpointId = catalogHits[0].id || endpointId;
        method = method || catalogHits[0].method;
        paginationStrategy = paginationStrategy || catalogHits[0].pagination?.type;
        if (unitCostUsd === undefined && catalogHits[0].catalogPriceUsd > 0) {
          unitCostUsd = catalogHits[0].catalogPriceUsd;
        }
      }
    } catch {
      // Keep resolved endpointId
    }
  }

  if (
    capabilitySlug === "tiktok-profile" ||
    rawEndpointId === "tiktok-profile" ||
    rawEndpointId === "tikhub.tiktok.user.profile" ||
    endpointId === "tikhub.tiktok.user.profile"
  ) {
    capabilitySlug = "tiktok-profile";
    endpointId = "tikhub.tiktok.user.profile";
    method = "GET";
    paginationStrategy = "none";
    unitCostUsd = 0.001;

    // Clean and normalize username -> uniqueId, remove leading @
    const cleanParams: Record<string, any> = { ...(params || {}) };
    if (cleanParams.username && !cleanParams.uniqueId) {
      cleanParams.uniqueId = String(cleanParams.username).replace(/^@/, "");
      delete cleanParams.username;
    } else if (cleanParams.uniqueId && typeof cleanParams.uniqueId === "string") {
      cleanParams.uniqueId = cleanParams.uniqueId.replace(/^@/, "");
    }
    params = cleanParams;
  }

  if (!method) {
    if (
      endpointId === "tikhub.tiktok.user.profile" ||
      endpointId.startsWith("scrapecreators.") ||
      endpointId.startsWith("tikhub.")
    ) {
      method = "GET";
    } else {
      method = "POST";
    }
  }

  if (!paginationStrategy) {
    paginationStrategy = endpointId === "tikhub.tiktok.user.profile" ? "none" : "cursor";
  }

  // Derive unitCostUsd from unitPricePoints / 5500 if not explicitly found in catalog
  const resolvedUnitCostUsd =
    typeof unitCostUsd === "number" && unitCostUsd > 0
      ? unitCostUsd
      : Math.max(0.0001, Number(((Number(unitPricePoints) || 1) / 5500).toFixed(6)));

  const isSearchDirectory =
    capabilitySlug.includes("compan") ||
    endpointId.includes("compan") ||
    capabilitySlug.includes("people") ||
    endpointId.includes("people") ||
    endpointId.startsWith("icypeas.");

  const defaultBatchSize = isSearchDirectory
    ? Math.min(50, Math.max(10, itemTargetVolumeMax || 50))
    : 10;

  const rawPageSize = Number(params?.limit || params?.count || params?.per_page || params?.size || defaultBatchSize);
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(50, rawPageSize) : defaultBatchSize;

  return {
    capabilitySlug,
    endpointId,
    method,
    params,
    paginationStrategy,
    pricingUnit,
    unitCostUsd: resolvedUnitCostUsd,
    pageSize,
    outputFormats,
    ...(retryOfJobId ? { retryOfJobId } : {}),
  };
}
