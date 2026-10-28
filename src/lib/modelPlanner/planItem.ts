import { createAndSaveManagedQuote, type ManagedQuoteResult, type PlanItem } from "../../functions/shared/planManager";
import type { Capability } from "../../functions/shared/capabilityRegistry";
import { unitPricePointsFromCost } from "../recordPricing";
import { MODEL_PLAN_PARAM, MODEL_PLAN_PURPOSE_PARAM, MODEL_PLAN_REQUEST_PARAM, MODEL_PLAN_SLUG } from "./constants";
import type { ValidatedPlan } from "./validate";
import { fitStagesToTotal } from "./stageFit";

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

/** The plan with its stages (and each step's volume) fitted to a smaller total: what a cut by the live capacity or the points cap leaves, so the stored plan says the same number the quote does. */
export function fitPlanToTotal(plan: ValidatedPlan, total: number): ValidatedPlan {
  const stages = plan.stored.stages;
  if (!stages || stages.length === 0) {
    const first = plan.stored.steps.length === 1 ? Math.max(1, Math.floor(total)) : null;
    if (first === null || first >= plan.deliveredVolume) return plan;
    return { ...plan, deliveredVolume: first, stored: { ...plan.stored, steps: plan.stored.steps.map((s) => ({ ...s, volume: first })) } };
  }
  const fitted = fitStagesToTotal(stages, total);
  if (fitted.total >= plan.deliveredVolume) return plan;
  return {
    ...plan,
    deliveredVolume: fitted.total,
    stored: { ...plan.stored, stages: fitted.stages, steps: plan.stored.steps.map((s, i) => ({ ...s, volume: fitted.stages[i]?.effVolume ?? s.volume })) },
  };
}

export async function createModelPlanQuote(input: ModelPlanQuoteInput): Promise<{ quote: ManagedQuoteResult; sampleRows: QuoteSampleRows | null }> {
  const unitPoints = unitPricePointsFromCost(input.plan.price.costPerRecordUsd);
  const make = (plan: ValidatedPlan) => createAndSaveManagedQuote(input.tables, {
    conversationId: input.conversationId,
    userId: input.userId,
    plan: { summaryAr: input.plan.summaryAr, items: [buildModelPlanItem(plan, { customerRequest: input.customerRequest, purpose: input.purpose })], outputFormats: input.outputFormats ?? ["xlsx", "pdf", "csv"] },
    userBalance: input.userBalance,
    capabilities: [modelPlanCapability(plan)],
    enforceScope: true,
    unitPriceOverride: (it) => (it.capabilitySlug === MODEL_PLAN_SLUG ? unitPoints : null),
  });
  let quote = await make(input.plan);
  // THE QUOTE'S SIZE IS THE STORED PLAN'S SIZE: when the live capacity or the points cap cut the volume, the plan is fitted to the cut figure and quoted again, so the card's stages, its total, the
  // panel and the hold all carry one number (a card that said «حتى ٢٠» beside a capacity of ١ was this mismatch).
  const cut = Number(quote.items?.[0]?.targetVolumeMax);
  if (Number.isFinite(cut) && cut >= 1 && cut < input.plan.deliveredVolume) {
    const fitted = fitPlanToTotal(input.plan, cut);
    if (fitted !== input.plan) {
      try { await (input.tables as any)?.from?.("plans_quotes")?.update?.({ status: "superseded" })?.eq?.("id", quote.quoteId); } catch { /* an unused quote row is harmless */ }
      quote = await make(fitted);
    }
  }
  const sampleRows = input.plan.sampleRows.length > 0 ? { columns: input.plan.sampleColumns, rows: input.plan.sampleRows } : null;
  return { quote, sampleRows };
}
