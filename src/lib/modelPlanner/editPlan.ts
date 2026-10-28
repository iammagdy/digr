import type { ManagedQuoteResult } from "../../functions/shared/planManager";
import { toArabicDigits } from "../arabicDigits";
import { resolveAccountAccess, PURPOSE_REQUIRED_AR } from "../server/sensitiveAccess";
import { loadTregCatalog, type TregCatalog } from "../treg/catalog";
import { SENSITIVE_NOT_VERIFIED_AR, type AccountAccess } from "../treg/dataPolicy";
import { MODEL_PLAN_PARAM, MODEL_PLAN_PURPOSE_PARAM, MODEL_PLAN_REQUEST_PARAM, MODEL_PLAN_SLUG } from "./constants";
import { createModelPlanQuote } from "./planItem";
import { ProposePlanSchema, type ProposePlanInput, type StoredModelPlan } from "./types";
import { validatePlan, type ValidationResult } from "./validate";

/**
 * EDITING a model plan. The customer may change what the card offers to change: the volume, the delivery formats, a points cap (the route applies the cap as a volume). The plan
 * itself (which endpoint, which parameters, the field map, the filters) is not rewritten by the customer's edit. Every edit goes through CODE VALIDATION AND PRICING again:
 * the stored plan is rebuilt as a proposal and validated like a new one (the endpoint is still sellable and allowed for this account, every parameter still has its provenance in the
 * customer's own words, the stated period still stands), the price is computed again from today's catalog cost and the measured values of the real sample the plan was priced
 * on, and a NEW quote supersedes the old one. A step the edit did not touch is not sampled again (no provider call).
 */
export const EDIT_NOT_AVAILABLE_AR = "هذا التعديل غير متاح لهذه الخطة؛ يمكنك تغيير العدد أو صيغ التسليم أو الحد الأقصى للنقاط.";
export const EDIT_REJECTED_AR = "تعذّر اعتماد هذا التعديل على الخطة؛ لم يتغير عرض السعر ولم يُحجز أي رصيد.";

/** The stored plan, written back as the proposal the model made, with the new volume. */
export function proposalFromStored(stored: StoredModelPlan, summaryAr: string, newVolume: number): ProposePlanInput {
  const last = stored.steps[stored.steps.length - 1];
  const oldVolume = last.volume;
  return ProposePlanSchema.parse({
    summaryAr,
    ...(stored.topic ? { topic: stored.topic } : {}),
    ...(stored.platformChoiceAr ? { platformChoiceAr: stored.platformChoiceAr } : {}),
    ...(stored.foundEntities ? { foundEntities: stored.foundEntities } : {}),
    steps: stored.steps.map((s, i) => ({
      endpointId: s.endpointId,
      // the last step carries the volume; a listing step that was asked for the same volume follows it
      volume: i === stored.steps.length - 1 || s.volume === oldVolume ? newVolume : s.volume,
      params: s.params.map((p) => ({ ...p })),
      fieldMap: s.fieldMap,
      filters: s.filters,
      ...(s.perItem ? { perItem: s.perItem } : {}),
    })),
  });
}

export interface RevalidateInput {
  stored: StoredModelPlan;
  summaryAr: string;
  customerText: string;
  newVolume: number;
  access: AccountAccess;
  purpose?: string | null;
  catalog?: TregCatalog;
  today?: Date;
}

/** Validates and prices a stored plan again with a new volume: pure, no network. */
export function revalidateStoredPlan(input: RevalidateInput): ValidationResult {
  const last = input.stored.steps[input.stored.steps.length - 1];
  const oldWord = toArabicDigits(last.volume);
  const summary = input.summaryAr.includes(oldWord) ? input.summaryAr.split(oldWord).join(toArabicDigits(input.newVolume)) : input.summaryAr;
  return validatePlan(proposalFromStored(input.stored, summary, input.newVolume), {
    customerText: input.customerText,
    access: input.access,
    catalog: input.catalog ?? loadTregCatalog(),
    samples: new Map(),
    purpose: input.purpose ?? null,
    today: input.today,
    approved: input.stored,
  });
}

export type EditOperation = { action: string; targetVolumeMax?: number; formats?: string[] };

export type EditModelPlanResult = { ok: true; quote: ManagedQuoteResult } | { ok: false; messageAr: string };

/** One edit of a saved model-plan quote item: only the volume and the formats; everything is validated and priced again, and a new quote is saved. */
export async function editModelPlanQuote(args: {
  tables: any;
  client?: any;
  conversationId: string;
  userId: string;
  userBalance: number;
  quoteItem: { capabilitySlug?: string; params?: Record<string, any> };
  summaryAr: string;
  outputFormats: Array<"xlsx" | "pdf" | "csv">;
  operations: ReadonlyArray<EditOperation>;
  catalog?: TregCatalog;
  today?: Date;
}): Promise<EditModelPlanResult> {
  const stored = args.quoteItem.params?.[MODEL_PLAN_PARAM] as StoredModelPlan | undefined;
  if (args.quoteItem.capabilitySlug !== MODEL_PLAN_SLUG || !stored || stored.v !== 1 || !Array.isArray(stored.steps) || stored.steps.length === 0) return { ok: false, messageAr: EDIT_REJECTED_AR };
  let volume = stored.steps[stored.steps.length - 1].volume;
  let formats = args.outputFormats;
  for (const op of args.operations) {
    if (op.action === "set_limit" && Number.isInteger(op.targetVolumeMax) && (op.targetVolumeMax as number) >= 1) volume = op.targetVolumeMax as number;
    else if (op.action === "set_formats" && Array.isArray(op.formats) && op.formats.length > 0) formats = op.formats.filter((f): f is "xlsx" | "pdf" | "csv" => f === "xlsx" || f === "pdf" || f === "csv");
    else return { ok: false, messageAr: EDIT_NOT_AVAILABLE_AR };
  }
  const customerRequest = String(args.quoteItem.params?.[MODEL_PLAN_REQUEST_PARAM] ?? "");
  const purpose = String(args.quoteItem.params?.[MODEL_PLAN_PURPOSE_PARAM] ?? "") || null;
  const access = await resolveAccountAccess(args.client ?? args.tables, args.userId);
  const verdict = revalidateStoredPlan({ stored, summaryAr: args.summaryAr, customerText: customerRequest, newVolume: volume, access, purpose, catalog: args.catalog, today: args.today });
  if (!verdict.ok) {
    if (verdict.issues.some((i) => i.code === "not_allowed")) return { ok: false, messageAr: SENSITIVE_NOT_VERIFIED_AR };
    if (verdict.issues.some((i) => i.code === "sensitive_purpose")) return { ok: false, messageAr: PURPOSE_REQUIRED_AR };
    return { ok: false, messageAr: EDIT_REJECTED_AR };
  }
  const { quote } = await createModelPlanQuote({ tables: args.tables, conversationId: args.conversationId, userId: args.userId, userBalance: args.userBalance, plan: verdict.plan, customerRequest, purpose, outputFormats: formats });
  return { ok: true, quote };
}
