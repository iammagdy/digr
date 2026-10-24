import { customerFacingCapabilityLabel } from "./customerFacingRequestLabels";
import { planActivityLabelAr } from "./planParameters";

/** The parts of a quote this note compares. Both come from the saved quotes of the same conversation. */
export interface PlanNoteSide {
  unitPricePoints?: number;
  items?: Array<{ capabilitySlug?: string; params?: Record<string, any> }>;
}

const CONTACT_FIELD_AR: Record<string, string> = { work_email: "البريد المهني", phone: "الهاتف المكتبي" };

function contactFieldsOf(side: PlanNoteSide): string[] {
  const fields = side.items?.[0]?.params?.requiredContactFields;
  return Array.isArray(fields) ? fields.filter((f): f is string => typeof f === "string") : [];
}

/**
 * ONE sentence, written by code, for the plan card: why this plan's price per record or title differs from the plan this conversation priced just
 * before it («the short version» of the same request): a different kind of data, added contact fields, or a different activity. Null when neither
 * the price per record nor the activity changed (a new count alone is not a change of price or title). It changes no price: it only explains.
 */
export function planChangeNoteAr(previous: PlanNoteSide | null | undefined, next: PlanNoteSide): string | null {
  const before = previous?.items?.[0];
  const after = next.items?.[0];
  if (!before || !after || !previous) return null;
  const priceChanged = Math.abs(Number(previous.unitPricePoints ?? 0) - Number(next.unitPricePoints ?? 0)) > 0.0005;
  const kindBefore = customerFacingCapabilityLabel(before.capabilitySlug);
  const kindAfter = customerFacingCapabilityLabel(after.capabilitySlug);
  const activityBefore = planActivityLabelAr(before.params);
  const activityAfter = planActivityLabelAr(after.params);
  const kindChanged = kindBefore !== kindAfter;
  const activityChanged = Boolean(activityBefore && activityAfter && activityBefore !== activityAfter);
  const addedFields = contactFieldsOf(next).filter((field) => !contactFieldsOf(previous).includes(field));
  if (!priceChanged && !kindChanged && !activityChanged && addedFields.length === 0) return null;

  const titleChanged = kindChanged || activityChanged;
  const what = priceChanged && titleChanged ? "تغيّر السعر والعنوان" : priceChanged ? "تغيّر سعر السجل" : titleChanged ? "تغيّر عنوان الخطة" : "اختلفت الخطة";
  if (kindChanged) return `${what} عن الخطة السابقة لأن طلبك الآن ${kindAfter} بدل ${kindBefore}، ولكل نوع سعره.`;
  if (addedFields.length > 0) {
    const names = addedFields.map((field) => CONTACT_FIELD_AR[field] || "بيانات التواصل").join(" و");
    return `${what} عن الخطة السابقة لأنك أضفت بيانات تواصل (${names})، ويُحتسب كل حقل مطلوب عند إرجاعه فقط.`;
  }
  if (activityChanged) return `${what} عن الخطة السابقة لأن النشاط اختلف (من ${activityBefore} إلى ${activityAfter}).`;
  return `${what} عن الخطة السابقة لأن تفاصيل طلبك تغيّرت.`;
}

/** The newest plan the conversation priced before this turn, from the history rows the handler already holds. */
export function previousPlanQuoteOf(history: Array<{ role: string; quote?: any }>): PlanNoteSide | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i];
    if (row.role !== "assistant" || !row.quote || typeof row.quote !== "object") continue;
    const items = Array.isArray(row.quote.items) ? row.quote.items : null;
    if (items && items.length > 0) return { unitPricePoints: Number(row.quote.unitPricePoints), items };
  }
  return null;
}
