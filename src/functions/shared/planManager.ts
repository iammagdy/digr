import crypto from "crypto";
import { z } from "zod";
import { TablesDB, ID, Query } from "node-appwrite";
import {
  Capability,
  validateCapabilityParams,
  getEnabledCapabilities,
} from "./capabilityRegistry";
import {
  calculateQuote,
  generateQuoteExpiry,
  isQuoteExpired,
  DEFAULT_PRICING_SETTINGS,
  PricingSettings,
} from "./quotes";

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
  params: Record<string, any>;
  targetVolumeMin: number;
  targetVolumeMax: number;
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

export interface ParsedStoredPlan extends PlanState {
  requestSpec?: unknown;
  legacy: boolean;
}

const DEFAULT_OUTPUT_FORMATS: Array<"xlsx" | "pdf" | "csv"> = ["xlsx", "pdf", "csv"];

/** Read both legacy arrays and the versioned plan envelope stored in itemsJson. */
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

/**
 * Computes a deterministic SHA-256 hash of a plan's items and configuration.
 * Used to cryptographically bind quotes to their exact plan parameters.
 */
export function computePlanHash(items: PlanItem[], formats: string[] = ["xlsx", "pdf", "csv"], config?: Partial<PlanState>): string {
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
      ...(config ? { targetVolumeMin: it.targetVolumeMin } : {}),
    };
  });

  const canonicalPlan: Record<string, unknown> = {
    items: sorted,
    formats: [...formats].sort(),
  };
  if (config) {
    canonicalPlan.configuration = {
      executionOptions: config.executionOptions || {},
      outputSpec: config.outputSpec || null,
      methodologyNotes: config.methodologyNotes || "",
    };
  }
  const canonical = JSON.stringify(canonicalPlan);

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
  // Deep clone to prevent mutating input
  const newItems: PlanItem[] = JSON.parse(JSON.stringify(currentPlan.items));
  let newFormats: Array<"xlsx" | "pdf" | "csv"> = [...currentPlan.outputFormats];

  let newExecutionOptions: ExecutionOptions | undefined = currentPlan.executionOptions
    ? { ...currentPlan.executionOptions }
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
    items: newItems,
    outputFormats: newFormats,
    executionOptions: newExecutionOptions,
  };
}

/**
 * Validates plan items against server-only capability schemas.
 */
export function validatePlanAgainstSchemas(
  planItems: PlanItem[],
  capabilities: Capability[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const it of planItems) {
    const matchedCap = capabilities.find((c) => c.slug === it.capabilitySlug);
    if (!matchedCap) {
      errors.push(`الخدمة '${it.capabilitySlug}' غير متوفرة أو معطلة في الكتالوج`);
      continue;
    }

    if (!matchedCap.enabled) {
      errors.push(`الخدمة '${matchedCap.nameAr}' غير مفعلة حالياً`);
      continue;
    }

    const valRes = validateCapabilityParams(matchedCap, it.params);
    if (!valRes.valid) {
      errors.push(...(valRes.errors || [`مدخلات غير صالحة للخدمة ${matchedCap.nameAr}`]));
    }

    if (it.targetVolumeMax > matchedCap.maxRows) {
      errors.push(`الحد الأقصى المطلوب (${it.targetVolumeMax}) يتجاوز سقف الخدمة المسموح (${matchedCap.maxRows})`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export interface QuoteCreationInput {
  conversationId: string;
  userId: string;
  plan: PlanState;
  userBalance: number;
  capabilities: Capability[];
  pricingSettings?: PricingSettings;
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
  quotedPoints: number;
  isAffordable: boolean;
  downscaledOffer?: {
    maxAffordableUnits: number;
    affordableQuotedPoints: number;
    rawCostPoints?: number;
  };
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
    pricingSettings = DEFAULT_PRICING_SETTINGS,
  } = input;

  // 1. Calculate pricing for all plan items
  let totalQuotedPoints = 0;
  let totalVolumeMax = 0;
  let effectiveUnitPrice = 0;
  let primaryUnitCost = 0.001;

  for (const it of plan.items) {
    const cap = capabilities.find((c) => c.slug === it.capabilitySlug) || capabilities[0];
    primaryUnitCost = cap.unitCostUsd;
    const itemQuote = calculateQuote(it.targetVolumeMax, cap.unitCostUsd, userBalance, pricingSettings);
    totalQuotedPoints += itemQuote.quotedPoints;
    totalVolumeMax += it.targetVolumeMax;
    effectiveUnitPrice = itemQuote.unitPricePoints;
  }

  // Recalculate affordability for the composite quote
  const quoteCalc = calculateQuote(totalVolumeMax, primaryUnitCost, userBalance, pricingSettings);

  const planHash = computePlanHash(plan.items, plan.outputFormats, plan);
  const quoteId = ID.unique();
  const expiresAt = generateQuoteExpiry(30); // 30 minutes expiry
  const nowIso = new Date().toISOString();

  // 2. Invalidate / supersede previous proposed quotes for this conversation
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
      summaryAr: plan.summaryAr,
      itemsJson: JSON.stringify(serializeStoredPlan(plan)),
      targetVolumeMax: totalVolumeMax,
      unitPricePoints: quoteCalc.unitPricePoints,
      quotedPoints: quoteCalc.quotedPoints,
      settingsVersion: "v1.0",
      expiresAt,
      createdAt: nowIso,
    },
  });

  return {
    quoteId,
    status: "proposed",
    planHash,
    summaryAr: plan.summaryAr,
    items: plan.items,
    outputFormats: plan.outputFormats,
    targetVolumeMax: totalVolumeMax,
    unitPricePoints: quoteCalc.unitPricePoints,
    quotedPoints: quoteCalc.quotedPoints,
    isAffordable: quoteCalc.isAffordable,
    downscaledOffer: quoteCalc.downscaledOffer,
    userBalance,
    expiresAt,
    createdAt: nowIso,
  };
}
