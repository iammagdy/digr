import { createHash } from "crypto";
import { searchCatalog } from "../../functions/shared/catalogClient";
import { APPROVED_CAPABILITY_CATALOG } from "../../functions/shared/capabilityRegistry";

export interface ResolvedJobExecutionSpec {
  capabilitySlug: string;
  endpointId: string;
  method: "GET" | "POST";
  params: Record<string, any>;
  paginationStrategy: "cursor" | "offset" | "page" | "none";
  pricingUnit: "call" | "item" | "page";
  unitCostUsd: number;
  pageSize: number;
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
              params = { ...firstItem.params };
            }
            if (
              firstItem.paginationStrategy === "cursor" ||
              firstItem.paginationStrategy === "offset" ||
              firstItem.paginationStrategy === "page" ||
              firstItem.paginationStrategy === "none"
            ) {
              paginationStrategy = firstItem.paginationStrategy;
            }
          }
        }
      }
    }
  } catch {
    // Continue with capability catalog resolution
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

  const rawPageSize = Number(params?.limit || params?.count || params?.per_page || 10);
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(50, rawPageSize) : 10;

  return {
    capabilitySlug,
    endpointId,
    method,
    params,
    paginationStrategy,
    pricingUnit,
    unitCostUsd: resolvedUnitCostUsd,
    pageSize,
  };
}
