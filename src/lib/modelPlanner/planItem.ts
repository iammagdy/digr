import { createAndSaveManagedQuote, type ManagedQuoteResult, type PlanItem } from "../../functions/shared/planManager";
import type { Capability } from "../../functions/shared/capabilityRegistry";
import { unitPricePointsFromCost } from "../recordPricing";
import { MODEL_PLAN_PARAM, MODEL_PLAN_PURPOSE_PARAM, MODEL_PLAN_REQUEST_PARAM, MODEL_PLAN_SLUG } from "./constants";
import type { ValidatedPlan } from "./validate";

/**
 * Turns a VALIDATED plan into the one quote item the existing machinery stores, prices (by the shared per-record function, from the plan's measured cost) and reserves.
 * The item's `params` hold only underscore keys, which the gateway client never sends to a source: the approved step spec, the customer's words and the purpose.
 */
export function buildModelPlanItem(plan: ValidatedPlan, extra: { customerRequest: string; purpose?: string | null }): PlanItem {
  const first = plan.steps[0];
  const last = plan.steps[plan.steps.length - 1];
  return {
    capabilitySlug: MODEL_PLAN_SLUG,
    endpointId: first.step.endpointId,
    params: {
      [MODEL_PLAN_PARAM]: plan.stored,
      [MODEL_PLAN_REQUEST_PARAM]: extra.customerRequest.slice(0, 400),
      ...(extra.purpose ? { [MODEL_PLAN_PURPOSE_PARAM]: extra.purpose.slice(0, 300) } : {}),
    },
    targetVolumeMin: 1,
    // the rows the customer receives AS CODE COUNTED THEM (the sum of the delivered stages): the same number the price, the hold and the card use, never the model's declared volume
    targetVolumeMax: plan.deliveredVolume,
    paginationStrategy: "cursor",
    pricingUnit: "item",
    unitCostUsd: plan.price.costPerRecordUsd,
  };
}

/** The capability the quote writer prices the item against: one synthetic entry, its cost per delivered record is the plan's measured cost (never a number from the model). */
export function modelPlanCapability(plan: ValidatedPlan): Capability {
  const first = plan.steps[0];
  return {
    id: MODEL_PLAN_SLUG,
    slug: MODEL_PLAN_SLUG,
    platform: (first.endpoint.platform as any) || "web",
    category: (first.endpoint.platform as any) || "web",
    nameAr: "جمع بيانات",
    nameEn: "Data collection",
    descriptionAr: plan.summaryAr,
    paramsSchema: "{}",
    tregEndpointId: first.step.endpointId,
    tregMethod: first.endpoint.method === "GET" ? "GET" : "POST",
    pricingUnit: "item",
    unitCostUsd: plan.price.costPerRecordUsd,
    maxRows: 25_000,
    paginationType: "cursor",
    enabled: true,
  };
}

export interface ModelPlanQuoteInput {
  tables: any;
  conversationId: string;
  userId: string;
  userBalance: number;
  plan: ValidatedPlan;
  customerRequest: string;
  purpose?: string | null;
  outputFormats?: Array<"xlsx" | "pdf" | "csv">;
}

/** The card's real sample rows: up to three, masked, with the plan's own Arabic headers. Absent for a sensitive plan (nothing is sampled for it). */
export interface QuoteSampleRows { columns: Array<{ key: string; titleAr: string }>; rows: Array<Record<string, unknown>> }

export async function createModelPlanQuote(input: ModelPlanQuoteInput): Promise<{ quote: ManagedQuoteResult; sampleRows: QuoteSampleRows | null }> {
  const item = buildModelPlanItem(input.plan, { customerRequest: input.customerRequest, purpose: input.purpose });
  const unitPoints = unitPricePointsFromCost(input.plan.price.costPerRecordUsd);
  const quote = await createAndSaveManagedQuote(input.tables, {
    conversationId: input.conversationId,
    userId: input.userId,
    plan: { summaryAr: input.plan.summaryAr, items: [item], outputFormats: input.outputFormats ?? ["xlsx", "pdf", "csv"] },
    userBalance: input.userBalance,
    capabilities: [modelPlanCapability(input.plan)],
    enforceScope: true,
    unitPriceOverride: (it) => (it.capabilitySlug === MODEL_PLAN_SLUG ? unitPoints : null),
  });
  const sampleRows = input.plan.sampleRows.length > 0 ? { columns: input.plan.sampleColumns, rows: input.plan.sampleRows } : null;
  return { quote, sampleRows };
}
