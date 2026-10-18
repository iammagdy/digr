import { formatAr } from "../../lib/arabicDigits";
import { getConfiguredJobPointsCap } from "./providerSpend";
import { decisionMakerQuotePoints, DECISION_MAKER_UNIT_PRICES_POINTS } from "./decisionMakerPricing";
import { DEFAULT_PRICING_SETTINGS } from "./quotes";

export interface PriorConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  quote?: any;
  plan?: any;
  requestStatus?: string;
}

function quoteItems(message: PriorConversationMessage): any[] {
  const items = message.quote?.items ?? message.plan?.items;
  if (Array.isArray(items)) return items;
  if (Array.isArray(items?.items)) return items.items;
  return [];
}

function hasPriorPlanOrDelivery(messages: PriorConversationMessage[]): boolean {
  return messages.some((message) => {
    if (message.role === "assistant") {
      return quoteItems(message).length > 0 ||
        Boolean(message.quote?.quoteId || message.quote?.planHash) ||
        /أعددت لك خطة الاستخراج وعرض السعر|تم إكمال استخراج|تم حفظ ملفات النتائج/.test(message.content);
    }
    return message.role === "user" && message.requestStatus === "accepted";
  });
}

function isResultFeedback(text: string): boolean {
  return /(?:email|e-mail|mail|إيميل|ايميل|إيميلات|ايميلات|البريد|غلط|خطأ|مش\s*(?:موجود|متاح|صح|مظبوط|مطابق)|ما\s*فيش|مفيش|ناقص|مفقود|ليه|لماذا|ازاي|إزاي|مشكلة|مشاكل|wrong|missing|why)/i.test(text);
}

function isEmailFeedback(text: string): boolean {
  return /(?:email|e-mail|mail|إيميل|ايميل|إيميلات|ايميلات|البريد)/i.test(text);
}

function isCompanyPlan(messages: PriorConversationMessage[], currentBrief: { platforms?: string[] }): boolean {
  if ((currentBrief.platforms || []).some((platform) => /compan|b2b|شرك/i.test(platform))) return true;
  return messages.some((message) => {
    if (message.role !== "assistant") return false;
    return quoteItems(message).some((item) => /compan|b2b|icypeas/i.test(
      `${item?.capabilitySlug || ""} ${item?.endpointId || ""}`,
    ));
  }) || messages.some((message) => message.role === "user" && /شركة|شركات|مؤسسة|مؤسسات/.test(message.content));
}

/**
 * Turn result feedback into an answer instead of re-entering discovery and
 * accidentally creating the same quote again.
 */
export function buildResultFollowupReply(
  text: string,
  messages: PriorConversationMessage[],
  currentBrief: { platforms?: string[]; targetVolume?: number } = {},
): string | null {
  if (!text.trim() || !hasPriorPlanOrDelivery(messages) || !isResultFeedback(text)) return null;

  if (isEmailFeedback(text) && isCompanyPlan(messages, currentBrief)) {
    const companyQuote = [...messages].reverse().find((message) =>
      message.role === "assistant" && quoteItems(message).some((item) =>
        /compan|b2b|icypeas/i.test(`${item?.capabilitySlug || ""} ${item?.endpointId || ""}`),
      ),
    )?.quote;
    const companyItem = companyQuote?.items?.[0];
    const volume = Math.max(1, Math.floor(Number(
      companyQuote?.targetVolumeMax || companyItem?.targetVolumeMax || currentBrief.targetVolume || 1,
    )));
    const fields = ["work_email", "phone"] as const;
    const cap = getConfiguredJobPointsCap();
    const deliveryPoints = decisionMakerQuotePoints(volume, [...fields], DECISION_MAKER_UNIT_PRICES_POINTS, 0, cap);
    const reservePoints = decisionMakerQuotePoints(
      volume,
      [...fields],
      DECISION_MAKER_UNIT_PRICES_POINTS,
      DEFAULT_PRICING_SETTINGS.safetyBuffer,
      cap,
    );

    return `بحث الشركات يعرض بيانات الشركة، ولا يشمل بريد الأشخاص. أقدر أجهز لك بحث صناع قرار للعدد نفسه. السعر لكل شخص: السجل الأساسي ${formatAr(DECISION_MAKER_UNIT_PRICES_POINTS.basePerson)} نقطة، ويُضاف ${formatAr(DECISION_MAKER_UNIT_PRICES_POINTS.workEmail)} للبريد المهني و${formatAr(DECISION_MAKER_UNIT_PRICES_POINTS.phone)} للهاتف المكتبي عند إرجاع كل حقل. للعدد نفسه، السعر المتوقع ${formatAr(deliveryPoints)} نقطة، والحجز المتوقع ${formatAr(reservePoints)} نقطة بعد احتياطي التنفيذ. لا يُحتسب الحقل إذا لم يُرجع، ولا يُحجز رصيد قبل موافقتك. هل تريد أن أجهز الخطة؟`;
  }

  return "وصلت ملاحظتك على النتيجة. ما الحقل أو السجل الذي تريد مراجعته؟";
}
