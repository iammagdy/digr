import crypto from "crypto";
import { z } from "zod";
import { TablesDB, ID, Query } from "./dbCompat";
import {
  Capability,
  validateCapabilityParams,
  getEnabledCapabilitiesWithCoreServices,
  getRegistryPricingSettings,
  computeRegistryPointsPerUnit,
  registryPointsPerUnit,
  getCustomerPriceUsdPerCatalogItem,
} from "./capabilityRegistry";
import {
  calculateQuote,
  calculateUnitPricePoints,
  calculateCapabilityUnitPricePoints,
  calculateCapabilityQuote,
  unitPricePointsForCapability,
  generateQuoteExpiry,
  isQuoteExpired,
  DEFAULT_PRICING_SETTINGS,
  PricingSettings,
} from "./quotes";
import type { CatalogEndpointSummary } from "./catalogClient";
import { getCachedCatalogEndpoints } from "./catalogClient";
import { getEndpointDetails } from "./catalogClient";
import { readUserSpendToday, resolveProviderLimits } from "../../lib/server/providerLimits";
import { checkPlanProviderCapacity, getConfiguredJobPointsCap, DEFAULT_JOB_POINTS_CAP } from "./providerSpend";
import { callAtomicOrFallback } from "./atomicRpc";
import { DECISION_MAKER_UNIT_PRICES_POINTS, decisionMakerQuotePoints, type ContactField, type ContactUnitPricesPoints } from "./decisionMakerPricing";
import { PEOPLE_SETTLEMENT_UNAVAILABLE_AR, requirePeopleSettlementRpc } from "./peopleSettlementReadiness";
import { containsMissingToken, quoteScopeGaps, stripMissingValueWords } from "../../lib/quoteScopeGaps";
import { chargeForUnits, maxVolumeUnderCap, recordCostFor, reserveForUnits } from "../../lib/recordPricing";
import { SOCIAL_CAPABILITIES } from "../../lib/socialSources"; import { fitNoticeAr, fitPostsAndComments, type FitReason } from "../../lib/planFit"; import { capacityRefusalAr, LARGE_PLAN_FROM_POINTS, PlanRefusalError } from "../../lib/capacityRefusal";
import { multiProviderEnabled } from "../../lib/multiProvider/flag";
import { isChainSlug } from "../../lib/multiProvider/routes";
import { resolveChainItemRouting, type ChainItemRouting } from "../../lib/server/multiProvider/planRouting";
import type { RoutingDecision } from "../../lib/multiProvider/trace";
import { writeRoutingDecision } from "../../lib/server/multiProvider/traceStore";

// ================= Schemas for Strict Plan Editing =================

export const EditPlanSetParamSchema = z.object({
  action: z.literal("set_param"),
  capabilitySlug: z.string().min(1),
  key: z.string().min(1).regex(/^[a-zA-Z0-9_]+$/, "اسم الحقل غير صالح"),
  value: z.union([
    z.string().max(500),
    z.number(),
    z.boolean(),
    z.array(z.string().max(100)).max(20),
    z.record(z.string(), z.any()),
  ]),
});

export const EditPlanSetLimitSchema = z.object({
  action: z.literal("set_limit"),
  capabilitySlug: z.string().min(1),
  targetVolumeMax: z.number().int().min(1).max(5000),
});

export const EditPlanSetFormatsSchema = z.object({
  action: z.literal("set_formats"),
  formats: z.array(z.enum(["xlsx", "pdf", "csv"])).min(1),
});

export const EditPlanAddCapabilitySchema = z.object({
  action: z.literal("add_capability"),
  capabilitySlug: z.string().min(1),
  params: z.record(z.string(), z.any()),
  targetVolumeMax: z.number().int().min(1).max(5000),
});

export const EditPlanSetExecutionOptionSchema = z.object({
  action: z.literal("set_execution_option"),
  option: z.enum([
    "windowing",
    "windowFrom",
    "windowTo",
    "includeReplies",
    "dedupe",
    "languageFilter",
    "anonymize",
    "qualityReport",
  ]),
  value: z.union([z.string(), z.boolean(), z.number()]),
});

export const EditPlanRemoveCapabilitySchema = z.object({
  action: z.literal("remove_capability"),
  capabilitySlug: z.string().min(1),
});

export const EditPlanOperationSchema = z.discriminatedUnion("action", [
  EditPlanSetParamSchema,
  EditPlanSetLimitSchema,
  EditPlanSetFormatsSchema,
  EditPlanSetExecutionOptionSchema,
  EditPlanAddCapabilitySchema,
  EditPlanRemoveCapabilitySchema,
]);

export type EditPlanOperation = z.infer<typeof EditPlanOperationSchema>;

export interface PlanItem {
  capabilitySlug: string;
  endpointId?: string;
  params: Record<string, any>;
  targetVolumeMin: number;
  targetVolumeMax: number;
  paginationStrategy?: "cursor" | "offset" | "page" | "none";
  stepId?: string;
  unitCostUsd?: number;
  unitPricePoints?: number;
  pricingUnit?: "call" | "item" | "page";
  itemReservation?: number;
  reservedPoints?: number;
  rawPoints?: number;
}

export interface ExecutionOptions {
  windowing?: "none" | "per_day" | "per_week" | "per_month";
  windowFrom?: string;
  windowTo?: string;
  includeReplies?: boolean;
  dedupe?: boolean;
  languageFilter?: string;
  anonymize?: boolean;
  qualityReport?: boolean;
}

export interface OutputSpec {
  sheets?: Array<{
    name: string;
    sourceDataset?: string;
    columns: Array<{ field: string; headerAr: string }>;
    sort?: { field: string; order: "asc" | "desc" };
    filter?: Record<string, any>;
  }>;
  formats?: Array<"xlsx" | "pdf" | "csv">;
}

export interface PlanState {
  summaryAr: string;
  items: PlanItem[];
  outputFormats: Array<"xlsx" | "pdf" | "csv">;
  executionOptions?: ExecutionOptions;
  outputSpec?: OutputSpec;
  methodologyNotes?: string;
}

/**
 * Computes a deterministic SHA-256 hash of a plan's items and configuration.
 * Used to cryptographically bind quotes to their exact plan parameters.
 */
export interface ParsedStoredPlan extends PlanState {
  requestSpec?: unknown;
  legacy: boolean;
}

const DEFAULT_OUTPUT_FORMATS: Array<"xlsx" | "pdf" | "csv"> = ["xlsx", "pdf", "csv"];

/**
 * Stored-plan envelope helpers (release port from the redesign stack).
 * Pure parse/serialize only: read both legacy arrays and the versioned plan
 * envelope stored in itemsJson. No pricing, quoting, or storage behavior.
 */
export function parseStoredPlan(raw: unknown): ParsedStoredPlan {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  if (Array.isArray(value)) {
    return { summaryAr: "", items: value as PlanItem[], outputFormats: [...DEFAULT_OUTPUT_FORMATS], legacy: true };
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as any).items)) {
    return { summaryAr: "", items: [], outputFormats: [...DEFAULT_OUTPUT_FORMATS], legacy: true };
  }
  const plan = value as any;
  const allowedFormats = Array.isArray(plan.outputFormats)
    ? plan.outputFormats.filter((format: unknown): format is "xlsx" | "pdf" | "csv" => format === "xlsx" || format === "pdf" || format === "csv")
    : [];
  return {
    summaryAr: typeof plan.summaryAr === "string" ? plan.summaryAr : "",
    items: plan.items as PlanItem[],
    outputFormats: allowedFormats.length ? Array.from(new Set(allowedFormats)) : [...DEFAULT_OUTPUT_FORMATS],
    executionOptions: plan.executionOptions && typeof plan.executionOptions === "object" ? plan.executionOptions : undefined,
    outputSpec: plan.outputSpec && typeof plan.outputSpec === "object" ? plan.outputSpec : undefined,
    methodologyNotes: typeof plan.methodologyNotes === "string" ? plan.methodologyNotes : undefined,
    requestSpec: plan.requestSpec,
    legacy: false,
  };
}

export function serializeStoredPlan(plan: PlanState, requestSpec?: unknown): Record<string, unknown> {
  return {
    version: 1,
    summaryAr: plan.summaryAr,
    items: plan.items,
    outputFormats: plan.outputFormats,
    executionOptions: plan.executionOptions || {},
    outputSpec: plan.outputSpec || null,
    methodologyNotes: plan.methodologyNotes || "",
    ...(requestSpec === undefined ? {} : { requestSpec }),
  };
}

export function computePlanHash(items: PlanItem[], formats: string[] = ["xlsx", "pdf", "csv"]): string {
  // Sort items deterministically
  const sorted = items.map((it) => {
    const sortedParams: Record<string, any> = {};
    Object.keys(it.params || {})
      .sort()
      .forEach((k) => {
        sortedParams[k] = it.params[k];
      });
    return {
      slug: it.capabilitySlug,
      params: sortedParams,
      targetVolumeMax: it.targetVolumeMax,
    };
  });

  const canonical = JSON.stringify({
    items: sorted,
    formats: [...formats].sort(),
  });

  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Applies strict, validated editing operations to an existing plan state.
 * Rejects prototype pollution, eval injection, or unknown actions.
 */
export function applyPlanOperations(
  currentPlan: PlanState,
  operations: EditPlanOperation[]
): PlanState {
  const basePlan = Array.isArray(currentPlan?.items)
    ? currentPlan
    : parseStoredPlan(currentPlan?.items);

  // Deep clone to prevent mutating input
  const newItems: PlanItem[] = JSON.parse(JSON.stringify(basePlan.items));
  let newFormats: Array<"xlsx" | "pdf" | "csv"> = [...basePlan.outputFormats];

  let newExecutionOptions: ExecutionOptions | undefined = currentPlan.executionOptions || basePlan.executionOptions
    ? { ...(currentPlan.executionOptions || basePlan.executionOptions) }
    : undefined;

  for (const op of operations) {
    // Prevent prototype pollution
    if (op.action === "set_param") {
      if (op.key === "__proto__" || op.key === "constructor" || op.key === "prototype") {
        throw new Error("محاولة غير مصرح بها للحقن البرمجي");
      }

      const item = newItems.find((it) => it.capabilitySlug === op.capabilitySlug);
      if (!item) {
        throw new Error(`الخدمة '${op.capabilitySlug}' غير موجودة في الخطة لتعديلها`);
      }
      item.params[op.key] = op.value;
    } else if (op.action === "set_limit") {
      const item = newItems.find((it) => it.capabilitySlug === op.capabilitySlug);
      if (!item) {
        throw new Error(`الخدمة '${op.capabilitySlug}' غير موجودة في الخطة لتعديل سقفها`);
      }
      item.targetVolumeMax = op.targetVolumeMax;
      item.targetVolumeMin = Math.min(item.targetVolumeMin || 1, op.targetVolumeMax);
    } else if (op.action === "set_formats") {
      newFormats = [...op.formats];
    } else if (op.action === "set_execution_option") {
      newExecutionOptions = {
        ...(newExecutionOptions || {}),
        [op.option]: op.value,
      };
    } else if (op.action === "add_capability") {
      const exists = newItems.some((it) => it.capabilitySlug === op.capabilitySlug);
      if (exists) {
        throw new Error(`الخدمة '${op.capabilitySlug}' مضافة مسبقاً في الخطة`);
      }
      newItems.push({
        capabilitySlug: op.capabilitySlug,
        params: { ...op.params },
        targetVolumeMin: 1,
        targetVolumeMax: op.targetVolumeMax,
      });
    } else if (op.action === "remove_capability") {
      const index = newItems.findIndex((it) => it.capabilitySlug === op.capabilitySlug);
      if (index === -1) {
        throw new Error(`الخدمة '${op.capabilitySlug}' غير موجودة لحذفها`);
      }
      if (newItems.length === 1) {
        throw new Error("لا يمكن حذف الخدمة الوحيدة المتبقية في الخطة");
      }
      newItems.splice(index, 1);
    }
  }

  return {
    ...currentPlan,
    summaryAr: currentPlan?.summaryAr || basePlan.summaryAr || "خطة استخراج بيانات",
    items: newItems,
    outputFormats: newFormats,
    executionOptions: newExecutionOptions,
  };
}

/**
 * Validates plan items against server-only capability schemas.
 */
function catalogEndpointAsCapability(endpoint: CatalogEndpointSummary): Capability {
  const customerPriceUsdPerItem = getCustomerPriceUsdPerCatalogItem({
    id: endpoint.id,
    slug: endpoint.slug,
    platform: endpoint.platform,
    nameEn: endpoint.nameEn,
    nameAr: endpoint.nameAr,
  });
  return {
    id: endpoint.slug,
    slug: endpoint.slug,
    nameAr: endpoint.nameAr,
    nameEn: endpoint.nameEn || endpoint.slug,
    descriptionAr: endpoint.summaryAr,
    category: endpoint.platform,
    platform: endpoint.platform,
    unitCostUsd: endpoint.catalogPriceUsd,
    pointsPerUnit: customerPriceUsdPerItem !== undefined
      ? registryPointsPerUnit(endpoint.slug, customerPriceUsdPerItem)
      : endpoint.pointsPerUnit,
    maxRows: endpoint.pagination?.maxLimit ? endpoint.pagination.maxLimit * 50 : 5000,
    enabled: true,
    paramsSchema: JSON.stringify(endpoint.paramsSchema || {}),
    tregEndpointId: endpoint.id,
    tregMethod: endpoint.method,
    pricingUnit: customerPriceUsdPerItem !== undefined
      ? "item"
      : endpoint.billingUnit === "call" || endpoint.billingUnit === "page"
        ? endpoint.billingUnit
        : "item",
    paginationType: endpoint.pagination?.type === "page"
      ? "offset"
      : endpoint.pagination?.type === "cursor"
        ? "cursor"
        : "none",
  };
}

/**
 * The record ceiling the plan-edit check uses. A social service's own code ceiling (`SOCIAL_CAPABILITIES`) wins over a LOWER figure left in
 * its stored registry row (production still holds max_rows 1,000 for the YouTube and TikTok comments services; the code ceiling is 2,000).
 * Read only: the stored row is never written or changed.
 */
export function serviceRecordCeiling(slug: string | undefined, stored: number | null | undefined): number {
  const fromRow = Number(stored ?? 0) || 0;
  const social = SOCIAL_CAPABILITIES.find((def) => def.slug === slug);
  return social ? Math.max(fromRow, social.maxRows) : fromRow;
}

export function validatePlanAgainstSchemas(
  planItems: PlanItem[],
  capabilities: Capability[],
  additionalEndpoints: CatalogEndpointSummary[] = [],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const cachedEndpoints = [...additionalEndpoints, ...getCachedCatalogEndpoints()];

  for (const it of planItems) {
    let matchedCap = capabilities.find(
      (c) =>
        c.slug === it.capabilitySlug ||
        c.tregEndpointId === it.capabilitySlug ||
        (it.endpointId && (c.tregEndpointId === it.endpointId || c.slug === it.endpointId))
    );

    if (!matchedCap) {
      const cached = cachedEndpoints.find(
        (e) =>
          e.slug === it.capabilitySlug ||
          e.id === it.capabilitySlug ||
          (it.endpointId && (e.id === it.endpointId || e.slug === it.endpointId))
      );
      if (cached) {
        matchedCap = catalogEndpointAsCapability(cached);
      }
    }

    if (!matchedCap) {
      errors.push("الخدمة المحددة غير متوافقة مع متطلبات البحث");
      continue;
    }

    if (!matchedCap.enabled) {
      errors.push(`الخدمة "${matchedCap.nameAr || "المحددة"}" غير مفعلة حالياً`);
      continue;
    }

    const valRes = validateCapabilityParams(matchedCap, it.params);
    if (!valRes.valid) {
      errors.push(...(valRes.errors || [`مدخلات غير صالحة للخدمة ${matchedCap.nameAr || "المحددة"}`]));
    }

    const recordCeiling = serviceRecordCeiling(matchedCap.slug, matchedCap.maxRows);
    if (it.targetVolumeMax > recordCeiling) {
      errors.push(`الحد الأقصى المطلوب (${it.targetVolumeMax}) يتجاوز سقف الخدمة المسموح (${recordCeiling})`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export interface LiveCatalogIssue {
  itemIndex: number;
  /** Arabic display name for user-facing text — never an internal slug. */
  nameAr: string;
  kind: "not_found" | "missing_params" | "over_limit" | "missing_cost" | "private_scope" | "unverified";
  missingParams?: string[];
}

function liveEndpointRequiredParams(ep: CatalogEndpointSummary): string[] {
  try {
    const schema: any =
      typeof ep.paramsSchema === "string" ? JSON.parse(ep.paramsSchema) : ep.paramsSchema;
    if (Array.isArray(schema?.required)) return schema.required.filter((x: any) => typeof x === "string");
    return [];
  } catch {
    return [];
  }
}

/**
 * Validate a proposed plan against the LIVE catalog results of the current turn
 * (or the 24h cached catalog), keyed by the same alias the model received.
 * The hardcoded registry is NOT a validator here — it only supplies optional
 * Arabic display names. User-facing errors never contain internal slugs or ids.
 * Checks: endpoint exists in live results, required params present, volume cap.
 */
export function validatePlanAgainstLiveCatalog(
  planItems: PlanItem[],
  liveResults: CatalogEndpointSummary[],
  registryCaps: Capability[] = [],
): { valid: boolean; errors: string[]; issues: LiveCatalogIssue[] } {
  const errors: string[] = [];
  const issues: LiveCatalogIssue[] = [];

  const displayName = (slug: string, ep?: CatalogEndpointSummary): string => {
    if (ep?.nameAr) return ep.nameAr;
    const reg = registryCaps.find((c) => c.slug === slug || (c as any).tregEndpointId === slug);
    if (reg?.nameAr) return reg.nameAr;
    return "الخدمة المطلوبة";
  };

  planItems.forEach((it, index) => {
    // The routed TREG capability has variable per-provider pricing; its
    // approved bundled estimate must win over the router's zero-cost wrapper
    // listing, which represents only the outer route.
    let ep = it.capabilitySlug === "professional-people-search" ? undefined : liveResults.find(
      (r) => r.slug === it.capabilitySlug || r.id === it.capabilitySlug || (it.endpointId && (r.slug === it.endpointId || r.id === it.endpointId)),
    );
    if (!ep) {
      const regCap = registryCaps.find(
        (c) => c.slug === it.capabilitySlug || (c as any).tregEndpointId === it.capabilitySlug || (it.endpointId && (c.slug === it.endpointId || (c as any).tregEndpointId === it.endpointId))
      );
      if (regCap) {
        ep = {
          id: regCap.tregEndpointId || regCap.slug,
          slug: regCap.slug,
          nameAr: regCap.nameAr,
          nameEn: regCap.nameEn,
          summaryAr: regCap.descriptionAr,
          summaryEn: regCap.nameEn || "",
          platform: regCap.platform || regCap.category,
          method: (((regCap as any).tregMethod || "GET") as "GET" | "POST"),
          path: "/call/" + (regCap.tregEndpointId || regCap.slug),
          paramsSchema: typeof regCap.paramsSchema === "string" ? (() => {
            try { return JSON.parse(regCap.paramsSchema); } catch { return {}; }
          })() : ((regCap.paramsSchema as any) || {}),
          billingUnit: (((regCap as any).pricingUnit || "call") as any),
          catalogPriceUsd: regCap.unitCostUsd,
          pointsPerUnit: regCap.pointsPerUnit ?? 50,
          observedSuccessRate: regCap.estimatedSuccessRate ?? 0.9,
          observedSamples: 100,
          scope: "read",
          pagination: {
            type: regCap.paginationType === "cursor" ? "cursor" : regCap.paginationType === "offset" ? "page" : "none",
            maxLimit: regCap.maxItemsPerCall || 100,
          },
        };
      }
    }
    const nameAr = displayName(it.capabilitySlug, ep);
    if (!ep) {
      errors.push(`يلزم استكمال تفاصيل خطة "${nameAr}" لمطابقتها مع طلبك`);
      issues.push({ itemIndex: index, nameAr, kind: "not_found" });
      return;
    }

    if (!ep.catalogPriceUsd || ep.catalogPriceUsd <= 0 || !ep.pointsPerUnit || ep.pointsPerUnit <= 0) {
      errors.push(`يلزم استكمال تسعير خطة "${nameAr}" قبل عرض السعر النهائي`);
      issues.push({ itemIndex: index, nameAr, kind: "missing_cost" });
      return;
    }

    if (ep.scope === "own_account") {
      errors.push(`الخدمة "${nameAr}" مخصصة للبيانات الخاصة فقط ولا تدعم البحث العام`);
      issues.push({ itemIndex: index, nameAr, kind: "private_scope" });
      return;
    }

    if (!it.params) it.params = {};
    const required = liveEndpointRequiredParams(ep);

    // Auto-fill or relax dependent parameters in multi-step plans (e.g. step 2 depends on step 1 postUrl)
    if (index > 0 && required.includes("postUrl") && (!it.params.postUrl || it.params.postUrl === "from_step_1" || String(it.params.postUrl).startsWith("$") || String(it.params.postUrl).startsWith("{"))) {
      it.params.postUrl = "https://www.facebook.com/post/1";
    }

    // An empty company query is never filled in with a country: the customer's country comes
    // from the request (owner decision D1), so a missing query is reported as missing below.

    const missing = required
      .filter((p) => p !== "page" && p !== "size")
      .filter((p) => it.params?.[p] === undefined || it.params?.[p] === null || it.params?.[p] === "");
    if (missing.length > 0) {
      errors.push(`الخدمة "${nameAr}" تحتاج مدخلات إضافية: ${missing.join("، ")}`);
      issues.push({ itemIndex: index, nameAr, kind: "missing_params", missingParams: missing });
    }
    // a social service holds no more than its own record ceiling per job (the one the chat handler and the public calculator use); any other catalog service keeps the 5,000 default
    const maxRows = SOCIAL_CAPABILITIES.find((def) => def.slug === it.capabilitySlug)?.maxRows ?? 5000;
    if (it.targetVolumeMax > maxRows) {
      errors.push(`الحد الأقصى المطلوب (${it.targetVolumeMax}) يتجاوز سقف الخدمة "${nameAr}" المسموح (${maxRows})`);
      issues.push({ itemIndex: index, nameAr, kind: "over_limit" });
    }
  });

  return { valid: errors.length === 0, errors, issues };
}

export interface QuoteCreationInput {
  conversationId: string;
  userId: string;
  plan: PlanState;
  userBalance: number;
  capabilities: Capability[];
  pricingSettings?: PricingSettings;
  enforceScope?: boolean;
}

export interface ManagedQuoteResult {
  quoteId: string;
  status: "proposed";
  planHash: string;
  summaryAr: string;
  items: PlanItem[];
  outputFormats: string[];
  targetVolumeMax: number;
  unitPricePoints: number;
  expectedPoints: number;
  quotedPoints: number;
  isAffordable: boolean;
  downscaledOffer?: {
    maxAffordableUnits: number;
    affordableQuotedPoints: number;
    rawCostPoints?: number;
  };
  capacityConstrained?: boolean;
  pointsCapConstrained?: boolean;
  requestedVolumeMax?: number;
  pointsCap?: number; fit?: { reason: FitReason; asked: number[]; perPost: number; noticeAr: string }; // a posts + comments plan reduced to fit: what each service asked for, why, and the one sentence that says so
  userBalance: number;
  expiresAt: string;
  createdAt: string;
}

/**
 * Creates a brand new quote in plans_quotes, invalidating any previous quotes for this conversation.
 * Server recomputes price from scratch.
 */
export async function createAndSaveManagedQuote(
  tables: TablesDB,
  input: QuoteCreationInput
): Promise<ManagedQuoteResult> {
  const {
    conversationId,
    userId,
    plan,
    userBalance,
    capabilities,
  } = input;

  const regSettings = getRegistryPricingSettings();
  const effectivePricing: PricingSettings = input.pricingSettings || {
    usdToEgp: regSettings.usdToEgp,
    markup: regSettings.markup,
    creditValueEgp: regSettings.pointValueEgp,
    safetyBuffer: DEFAULT_PRICING_SETTINGS.safetyBuffer,
    minPoints: DEFAULT_PRICING_SETTINGS.minPoints,
  };

  // Opt-in scope guard for production callers: incomplete plans with scope gaps are rejected
  if (input.enforceScope) {
    const gaps = quoteScopeGaps(plan.items);
    // A summary that carries «undefined» or «null» as a value would be shown to the customer as it is: the plan is incomplete.
    if (containsMissingToken(plan.summaryAr) && !gaps.includes("placeholder")) gaps.push("placeholder");
    if (gaps.length > 0) {
      throw new Error(`الخطة غير مكتملة: ${gaps.join(", ")}`);
    }
  }

  // 1. Calculate pricing for all plan items independently
  let totalQuotedPoints = 0;
  let totalVolumeMax = 0;
  let totalRawPoints = 0;
  let effectiveUnitPrice = 0;
  const askedVolumes = plan.items.map((item) => Math.max(1, item.targetVolumeMax || 1)); const requestedVolumeMax = askedVolumes.reduce((sum, volume) => sum + volume, 0);
  // The configured value may reduce the limit, but can never raise the settlement hard cap.
  const pointsCap = Math.min(getConfiguredJobPointsCap(), DEFAULT_JOB_POINTS_CAP);

  // The router's decision for the (first) chain item, kept for the admin routing trace once the quote has an id. Never part of the quote.
  let chainDecision: RoutingDecision | null = null;
  for (const it of plan.items) {
    // Match capability strictly; NEVER substitute capabilities[0].
    // The plan's own slug wins over an alias by endpoint id: the live catalog lists `treg.people.search` at cost 0 (a routed wrapper) and it is
    // placed BEFORE the registry in the turn's list, so an alias-first match priced a decision-makers plan at 0 and refused it
    // («سعر الوحدة غير صالح للخدمة المطلوبة», live 2026-10-25).
    let cap =
      capabilities.find((c) => c.slug === it.capabilitySlug || c.id === it.capabilitySlug) ||
      capabilities.find(
        (c) =>
          c.tregEndpointId === it.capabilitySlug ||
          (it.endpointId && (c.tregEndpointId === it.endpointId || c.slug === it.endpointId || c.id === it.endpointId))
      );

    if (!cap) {
      const cached = getCachedCatalogEndpoints().find(
        (e) =>
          e.slug === it.capabilitySlug ||
          e.id === it.capabilitySlug ||
          (it.endpointId && (e.id === it.endpointId || e.slug === it.endpointId))
      );
      if (cached) {
        const customerPriceUsdPerItem = getCustomerPriceUsdPerCatalogItem({
          id: cached.id,
          slug: cached.slug,
          platform: cached.platform,
          nameEn: cached.nameEn,
          nameAr: cached.nameAr,
        });
        cap = {
          id: cached.id,
          slug: cached.slug,
          nameAr: cached.nameAr,
          nameEn: cached.nameEn || cached.slug,
          descriptionAr: cached.summaryAr,
          category: cached.platform,
          platform: cached.platform,
          unitCostUsd: cached.catalogPriceUsd,
          pointsPerUnit: cached.pointsPerUnit,
          maxRows: 5000,
          enabled: true,
          paramsSchema: typeof cached.paramsSchema === "string" ? cached.paramsSchema : JSON.stringify(cached.paramsSchema || {}),
          pricingUnit: (customerPriceUsdPerItem !== undefined
            ? "item"
            : cached.billingUnit === "call" || cached.billingUnit === "page"
            ? cached.billingUnit
            : "item") as any,
          customerPriceUsdPerItem,
          paginationType: cached.pagination?.type as any,
          tregEndpointId: cached.id,
          tregMethod: cached.method,
        };
      }
    }

    if (!cap) {
      throw new Error("الخدمة المطلوبة غير معتمدة أو غير موجودة في الكتالوج.");
    }

    // The multi-provider contact chain (only exists while MULTI_PROVIDER_ENABLED is on): the ROUTER picks the route of this request and its
    // cost per delivered row is what the one shared pricing rule prices. No route allowed means no plan, in plain Arabic.
    let chainRouting: Extract<ChainItemRouting, { ok: true }> | null = null;
    if (isChainSlug(cap.slug)) {
      if (!multiProviderEnabled()) throw new Error("الخدمة المطلوبة غير معتمدة أو غير موجودة في الكتالوج.");
      const routed = await resolveChainItemRouting({ client: tables, params: it.params, volume: it.targetVolumeMax, userId });
      if (!routed.ok) throw new Error(routed.messageAr);
      chainRouting = routed;
      chainDecision = chainDecision ?? routed.decision;
    }

    const itemUnitCostUsd = chainRouting
      ? chainRouting.costPerDeliveredRowUsd
      : typeof cap.unitCostUsd === "number" && cap.unitCostUsd > 0
        ? cap.unitCostUsd
        : typeof it.unitCostUsd === "number" && it.unitCostUsd > 0
        ? it.unitCostUsd
        : 0;

    if (!Number.isFinite(itemUnitCostUsd) || itemUnitCostUsd <= 0) {
      throw new Error("سعر الوحدة غير صالح للخدمة المطلوبة.");
    }

    // ONE shared rule: a capability priced per delivered record is cost per record x 5,500, fractional; every other capability keeps its
    // whole-point rule (see unitPricePointsForCapability).
    const unitPrice = unitPricePointsForCapability(
      { slug: cap.slug, unitCostUsd: itemUnitCostUsd, customerPriceUsdPerItem: cap.customerPriceUsdPerItem },
      effectivePricing,
    );
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new Error("سعر الوحدة غير صالح للخدمة المطلوبة.");
    }

    let effectiveItemUnitPrice = unitPrice;
    // The provider cost the plan-time capacity gate uses: the cost of one DELIVERED record (worst source path) where it is known,
    // not the price of one call.
    let itemProviderCostUsd = recordCostFor(cap.slug)?.costUsdPerRecord ?? itemUnitCostUsd;
    if (cap.slug === "professional-people-search") {
      if (!(await requirePeopleSettlementRpc(tables))) {
        throw new Error(PEOPLE_SETTLEMENT_UNAVAILABLE_AR);
      }
      const requestedFields: ContactField[] = Array.isArray(it.params?.requiredContactFields)
        ? it.params.requiredContactFields.filter((field: unknown) => field === "work_email" || field === "phone")
        : ["work_email", "phone"];
      const [baseCatalog, emailCatalog, phoneCatalog] = await Promise.all([
        getEndpointDetails(cap.tregEndpointId || it.endpointId || "treg.people.search"),
        getEndpointDetails("treg.people.email.find"),
        getEndpointDetails("treg.people.phone.find"),
      ]);
      const baseCatalogPriceUsd = baseCatalog?.catalogPriceUsd || itemUnitCostUsd;
      if (!baseCatalogPriceUsd || !emailCatalog?.catalogPriceUsd || !phoneCatalog?.catalogPriceUsd) {
        throw new Error("تعذر التحقق من أسعار السجل وحقول التواصل في كتالوج المصادر.");
      }
      const contactUnitPricesPoints: ContactUnitPricesPoints = {
        ...DECISION_MAKER_UNIT_PRICES_POINTS,
      };
      effectiveItemUnitPrice = decisionMakerQuotePoints(
        1, requestedFields, contactUnitPricesPoints, 0, Number.MAX_SAFE_INTEGER,
      );
      it.params.requiredContactFields = requestedFields;
      (it as any).requiredContactFields = requestedFields;
      (it as any).contactUnitPricesPoints = contactUnitPricesPoints;
      (it as any).contactPricingDescriptionAr = "السعر الأساسي للسجل المهني، ويُضاف سعر البريد المهني والهاتف المكتبي عند إرجاع كل حقل مطلوب.";
      itemProviderCostUsd = baseCatalogPriceUsd +
        (requestedFields.includes("work_email") ? emailCatalog.catalogPriceUsd : 0) +
        (requestedFields.includes("phone") ? phoneCatalog.catalogPriceUsd : 0);
    }
    const itemVolume = Math.max(1, it.targetVolumeMax || 1);
    const itemRawPoints = itemVolume * effectiveItemUnitPrice;
    const itemReservation = Math.max(1, reserveForUnits(itemVolume, effectiveItemUnitPrice, effectivePricing.safetyBuffer));

    // The chain item keeps what the worker needs and nothing else: the opaque route code and the normalized fields. The provider budget is not stored: the worker derives it from the reserve.
    if (chainRouting) {
      it.params = { ...(it.params || {}), routeCode: chainRouting.routeCode, requiredFields: chainRouting.request.requiredFields };
      delete (it.params as Record<string, unknown>).routeBudgetUsd;
    }

    // Retain all required fields on the item
    it.capabilitySlug = cap.slug || it.capabilitySlug;
    it.endpointId =
      cap.tregEndpointId && cap.tregEndpointId.includes(".")
        ? cap.tregEndpointId
        : cap.id && cap.id.includes(".")
        ? cap.id
        : it.endpointId || cap.tregEndpointId || cap.id || cap.slug;
    it.unitCostUsd = itemProviderCostUsd;
    it.unitPricePoints = effectiveItemUnitPrice;
    it.targetVolumeMax = itemVolume;
    it.rawPoints = itemRawPoints;
    it.itemReservation = itemReservation;
    it.reservedPoints = itemReservation;
    if (cap.pricingUnit) {
      it.pricingUnit = cap.pricingUnit;
    }

    totalRawPoints += itemRawPoints;
    totalQuotedPoints += itemReservation;
    totalVolumeMax += itemVolume;
    effectiveUnitPrice = effectiveItemUnitPrice;
  }

  // 1b. Check provider capacity (10% safety margin) across all items
  let capacityConstrained = false;
  // The chain's providers have their own daily caps and balances, checked by the router and at every call: only the TREG items are held to TREG's gate.
  const isChainItem = (it: PlanItem) => isChainSlug(it.capabilitySlug);
  const onlyChainItems = plan.items.length > 0 && plan.items.every(isChainItem);
  const totalEstimatedUsd = plan.items.filter((it) => !isChainItem(it)).reduce(
    (sum, it) => sum + it.targetVolumeMax * (it.unitCostUsd || 0.001),
    0
  );
  // The admin's per-user daily limit (when one is set) also shapes the plan, so a customer is not sold what the worker would refuse.
  let userRemainingUsd: number | null = null;
  try {
    const limits = (await resolveProviderLimits(tables as any)).limits;
    if (limits.perUserDailyUsd !== null && userId && typeof (tables as any)?.from === "function") {
      userRemainingUsd = Math.max(0, limits.perUserDailyUsd - (await readUserSpendToday(tables as any, userId)));
    }
  } catch { userRemainingUsd = null; }
  const capacityCheck = onlyChainItems
    ? { allowed: true, safeBudgetUsd: Number.POSITIVE_INFINITY, availableBalanceUsd: 0, originalVolume: 1, maxSafeVolume: 1, downscaled: false }
    : await checkPlanProviderCapacity(1, totalEstimatedUsd, tables, { userRemainingUsd });

  if (capacityCheck.downscaled && capacityCheck.safeBudgetUsd < totalEstimatedUsd) {
    // A LARGE plan (a reserve above the old per-job cap, after the live cap has cut it) that today's provider budget cannot hold is refused honestly, with what the capacity does hold,
    // never clipped: nothing is written and nothing is held. The budget is the admin's daily limit, the provider's real balance and the customer's own limit.
    if (Math.min(totalQuotedPoints, pointsCap) > LARGE_PLAN_FROM_POINTS) {
      throw new PlanRefusalError(capacityRefusalAr(plan.items, totalEstimatedUsd > 0 ? capacityCheck.safeBudgetUsd / totalEstimatedUsd : 0));
    }
    capacityConstrained = true;
    const scale = totalEstimatedUsd > 0 ? capacityCheck.safeBudgetUsd / totalEstimatedUsd : 1;
    for (const it of plan.items) {
      if (isChainItem(it)) continue;
      it.targetVolumeMax = Math.max(1, Math.floor(it.targetVolumeMax * scale));
    }

    // Recalculate all item quotes and totals after capacity downscaling
    totalRawPoints = 0;
    totalQuotedPoints = 0;
    totalVolumeMax = 0;
    for (const it of plan.items) {
      const itemRawPoints = it.targetVolumeMax * (it.unitPricePoints || 1);
      const itemReservation = Math.max(1, reserveForUnits(it.targetVolumeMax, it.unitPricePoints || 1, effectivePricing.safetyBuffer));
      it.rawPoints = itemRawPoints;
      it.itemReservation = itemReservation;
      it.reservedPoints = itemReservation;
      totalRawPoints += itemRawPoints;
      totalQuotedPoints += itemReservation;
      totalVolumeMax += it.targetVolumeMax;
    }
  }

  // Decision-maker quotes cap the customer charge first, then cap the buffered
  // reserve. Other capabilities retain the existing reserve-based volume cap.
  let pointsCapConstrained = false;
  const rawChargeTotal = () => plan.items.reduce((sum, item) => sum + item.targetVolumeMax * (item.unitPricePoints || 1), 0);
  const peopleOnlyPlan = plan.items.length === 1 && plan.items[0].capabilitySlug === "professional-people-search";
  const resizeVolumeToRawCap = () => {
    const ratio = pointsCap / rawChargeTotal();
    for (const item of plan.items) item.targetVolumeMax = Math.max(1, Math.floor(item.targetVolumeMax * ratio));
    while (rawChargeTotal() > pointsCap) {
      const reducible = plan.items.filter((item) => item.targetVolumeMax > 1)
        .sort((a, b) => (b.unitPricePoints || 1) - (a.unitPricePoints || 1))[0];
      if (!reducible) throw new Error("الحد الأدنى للخطة يتجاوز سقف النقاط للمهمة؛ يرجى تقليل عدد السجلات.");
      reducible.targetVolumeMax -= 1;
    }
    totalRawPoints = 0;
    totalQuotedPoints = 0;
    totalVolumeMax = 0;
    for (const item of plan.items) {
      item.rawPoints = item.targetVolumeMax * (item.unitPricePoints || 1);
      item.itemReservation = Math.max(1, reserveForUnits(item.targetVolumeMax, item.unitPricePoints || 1, effectivePricing.safetyBuffer));
      item.reservedPoints = item.itemReservation;
      totalRawPoints += item.rawPoints;
      totalQuotedPoints += item.itemReservation;
      totalVolumeMax += item.targetVolumeMax;
    }
  };
  // A Facebook posts + their comments plan is fitted as ONE size (the comments per post the customer asked for are kept, the posts are the
  // most that fit the service ceilings and the reserve under the cap), never by shrinking each service by its own ratio: that left 4 posts
  // beside 44 comments and two different counts on one card.
  let fit: ManagedQuoteResult["fit"];
  const pairFit = peopleOnlyPlan ? null : fitPostsAndComments(plan.items as any, pointsCap, effectivePricing.safetyBuffer, askedVolumes);
  if (pairFit?.reduced && pairFit.reason) {
    pairFit.volumes.forEach((volume, index) => { plan.items[index].targetVolumeMax = volume; });
    totalRawPoints = 0;
    totalQuotedPoints = 0;
    totalVolumeMax = 0;
    for (const item of plan.items) {
      item.rawPoints = item.targetVolumeMax * (item.unitPricePoints || 1);
      item.itemReservation = Math.max(1, reserveForUnits(item.targetVolumeMax, item.unitPricePoints || 1, effectivePricing.safetyBuffer));
      item.reservedPoints = item.itemReservation;
      totalRawPoints += item.rawPoints;
      totalQuotedPoints += item.itemReservation;
      totalVolumeMax += item.targetVolumeMax;
    }
    pointsCapConstrained = pairFit.reason === "cap";
    fit = {
      reason: pairFit.reason,
      asked: pairFit.asked,
      perPost: pairFit.perPost,
      noticeAr: fitNoticeAr({ items: plan.items, asked: pairFit.asked, reason: pairFit.reason, pointsCap, perPost: pairFit.perPost }),
    };
  }
  if (peopleOnlyPlan) {
    if (rawChargeTotal() > pointsCap) {
      pointsCapConstrained = true;
      resizeVolumeToRawCap();
    }
    if (totalQuotedPoints > pointsCap) {
      pointsCapConstrained = true;
      // One decision-maker item has one reserve field; cap that hold without
      // reducing an otherwise affordable number of delivered people.
      plan.items[0].itemReservation = pointsCap;
      plan.items[0].reservedPoints = pointsCap;
      totalQuotedPoints = pointsCap;
    }
  } else {
    const reservationTotal = () => plan.items.reduce((sum, item) => {
      return sum + Math.max(1, reserveForUnits(item.targetVolumeMax, item.unitPricePoints || 1, effectivePricing.safetyBuffer));
    }, 0);
    if (reservationTotal() > pointsCap) {
      pointsCapConstrained = true;
      const ratio = pointsCap / reservationTotal();
      for (const item of plan.items) item.targetVolumeMax = Math.max(1, Math.floor(item.targetVolumeMax * ratio));
      // One item: the exact largest volume whose reserve fits the cap (the ratio step can leave a record or two unused).
      if (plan.items.length === 1) {
        const only = plan.items[0];
        const exact = maxVolumeUnderCap(pointsCap, only.unitPricePoints || 1, effectivePricing.safetyBuffer);
        if (exact >= 1) only.targetVolumeMax = exact;
      }
      while (reservationTotal() > pointsCap) {
        const reducible = plan.items.filter((item) => item.targetVolumeMax > 1)
          .sort((a, b) => (b.unitPricePoints || 1) - (a.unitPricePoints || 1))[0];
        if (!reducible) throw new Error("الحد الأدنى للخطة يتجاوز سقف النقاط للمهمة؛ يرجى تقليل عدد السجلات.");
        reducible.targetVolumeMax -= 1;
      }
      totalRawPoints = 0;
      totalQuotedPoints = 0;
      totalVolumeMax = 0;
      for (const item of plan.items) {
        item.rawPoints = item.targetVolumeMax * (item.unitPricePoints || 1);
        item.itemReservation = Math.max(1, reserveForUnits(item.targetVolumeMax, item.unitPricePoints || 1, effectivePricing.safetyBuffer));
        item.reservedPoints = item.itemReservation;
        totalRawPoints += item.rawPoints;
        totalQuotedPoints += item.itemReservation;
        totalVolumeMax += item.targetVolumeMax;
      }
    }
  }

  // 1c. Affordability and downscale offer
  const isAffordable = userBalance >= totalQuotedPoints;
  let downscaledOffer: ManagedQuoteResult["downscaledOffer"] = undefined;

  if (!isAffordable && userBalance >= effectivePricing.minPoints) {
    if (plan.items.length === 1) {
      // Single-item exact formula preserving existing behavior
      const singleItem = plan.items[0];
      const unitPricePoints = singleItem.unitPricePoints || 1;
      const maxAffordableUnits = Math.max(1, maxVolumeUnderCap(userBalance, unitPricePoints, effectivePricing.safetyBuffer));
      const affordableQuotedPoints = Math.max(
        effectivePricing.minPoints,
        reserveForUnits(maxAffordableUnits, unitPricePoints, effectivePricing.safetyBuffer)
      );
      if (maxAffordableUnits < singleItem.targetVolumeMax) {
        downscaledOffer = {
          maxAffordableUnits,
          affordableQuotedPoints,
          rawCostPoints: maxAffordableUnits * unitPricePoints,
        };
      }
    } else {
      // Composite multi-item plan downscale offer
      const scale = totalQuotedPoints > 0 ? userBalance / totalQuotedPoints : 1;
      let scaledUnitsTotal = 0;
      let scaledPointsTotal = 0;
      let scaledRawTotal = 0;

      for (const it of plan.items) {
        const affordableUnits = Math.max(1, Math.floor(it.targetVolumeMax * scale));
        const itemUnitPrice = it.unitPricePoints || 1;
        const itemRaw = affordableUnits * itemUnitPrice;
        const itemRes = Math.max(1, reserveForUnits(affordableUnits, itemUnitPrice, effectivePricing.safetyBuffer));
        scaledUnitsTotal += affordableUnits;
        scaledPointsTotal += itemRes;
        scaledRawTotal += itemRaw;
      }

      if (scaledUnitsTotal < totalVolumeMax && scaledPointsTotal <= userBalance) {
        downscaledOffer = {
          maxAffordableUnits: scaledUnitsTotal,
          affordableQuotedPoints: scaledPointsTotal,
          rawCostPoints: scaledRawTotal,
        };
      }
    }
  }

  // Final plan hash computed on final items and formats
  const planHash = computePlanHash(plan.items, plan.outputFormats || ["xlsx", "pdf", "csv"]);
  const quoteId = ID.unique();
  const expiresAt = generateQuoteExpiry(30); // 30 minutes expiry
  const nowIso = new Date().toISOString();
  const quoteUnitPricePoints = plan.items[0]?.unitPricePoints || effectiveUnitPrice;

  // 2. Invalidate previous proposed quotes that belong to this conversation.
  const anyTables = tables as any;
  if (anyTables && typeof anyTables.from === "function") {
    let previousQuoteIds: string[] = [];
    try {
      const { data: quoteMessages, error: messageReadError } = await anyTables
        .from("messages")
        .select("quote")
        .eq("user_id", userId)
        .eq("conversation_id", conversationId)
        .not("quote", "is", null)
        .order("created_at", { ascending: false })
        .limit(1000);

      if (messageReadError) throw messageReadError;

      previousQuoteIds = Array.from(new Set((quoteMessages || [])
        .map((row: any) => row?.quote?.quoteId || row?.quote?.id)
        .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)));
    } catch (err: any) {
      console.warn("[quote:prior_ids_unavailable] proceeding with no prior quote ids");
    }
    const quoteRow = {
      id: quoteId,
      user_id: userId,
      quote_hash: planHash,
      status: "quoted",
      items: plan.items,
      total_reserved_credits: totalQuotedPoints,
      output_formats: plan.outputFormats || ["xlsx", "pdf", "csv"],
      expires_at: expiresAt,
      created_at: nowIso,
    };
    const fallback = async () => {
      if (previousQuoteIds.length > 0) {
        const { error: expireError } = await anyTables.from("plans_quotes")
          .update({ status: "expired" }).eq("user_id", userId)
          .in("id", previousQuoteIds).eq("status", "quoted");
        if (expireError) throw expireError;
      }
      const { error: insertError } = await anyTables.from("plans_quotes").insert(quoteRow);
      if (insertError) throw insertError;
      return true;
    };
    await callAtomicOrFallback({
      rpc: () => typeof anyTables.rpc === "function"
        ? anyTables.rpc("create_quote_atomic", {
            p_user_id: userId,
            p_quote_id: quoteId,
            p_quote_hash: planHash,
            p_items: plan.items,
            p_total_points: totalQuotedPoints,
            p_output_formats: plan.outputFormats || ["xlsx", "pdf", "csv"],
            p_expires_at: expiresAt,
            p_previous_quote_ids: previousQuoteIds,
          })
        : Promise.resolve({ error: { code: "PGRST202", message: "function not found" } }),
      functionName: "create_quote_atomic",
      fallback,
      log: (line) => console.warn(line),
    });
  } else if (tables && typeof tables.createRow === "function") {
    try {
      const existingQuotes = await tables.listRows({
        databaseId: "digr",
        tableId: "plans_quotes",
        queries: [
          Query.equal("conversationId", conversationId),
          Query.equal("status", "proposed"),
        ],
      });

      for (const q of existingQuotes.rows) {
        await tables.updateRow({
          databaseId: "digr",
          tableId: "plans_quotes",
          rowId: q.$id,
          data: {
            status: "expired",
          },
        });
      }
    } catch (err: any) {
      console.warn("Could not supersede old quotes:", err.message);
    }

    // 3. Save new quote in plans_quotes table
    await tables.createRow({
      databaseId: "digr",
      tableId: "plans_quotes",
      rowId: quoteId,
      data: {
        conversationId,
        userId,
        status: "proposed",
        summaryAr: stripMissingValueWords(plan.summaryAr),
        itemsJson: JSON.stringify(serializeStoredPlan(plan)),
        targetVolumeMax: totalVolumeMax,
        unitPricePoints: quoteUnitPricePoints,
        quotedPoints: totalQuotedPoints,
        settingsVersion: "v1.0",
        expiresAt,
        createdAt: nowIso,
      },
    });
  }

  // Admin-only routing trace (private storage bucket, best effort): what the router chose and why. Failure here changes nothing about the quote.
  if (chainDecision) await writeRoutingDecision(tables, quoteId, chainDecision).catch(() => false);

  return {
    quoteId,
    status: "proposed",
    planHash,
    summaryAr: stripMissingValueWords(plan.summaryAr),
    items: plan.items,
    outputFormats: plan.outputFormats || ["xlsx", "pdf", "csv"],
    targetVolumeMax: totalVolumeMax,
    unitPricePoints: quoteUnitPricePoints,
    expectedPoints: Math.max(effectivePricing.minPoints, plan.items.reduce((sum, item) => sum + chargeForUnits(item.targetVolumeMax, item.unitPricePoints || 1), 0)),
    quotedPoints: totalQuotedPoints,
    isAffordable,
    downscaledOffer,
    capacityConstrained,
    pointsCapConstrained,
    requestedVolumeMax,
    pointsCap,
    ...(fit ? { fit } : {}),
    userBalance,
    expiresAt,
    createdAt: nowIso,
  };
}
