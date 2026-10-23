import { multiProviderEnabled } from "../../lib/multiProvider/flag";
import { CHAIN_CAPABILITY_SLUG, ROUTE_DEFS, estimateRoute } from "../../lib/multiProvider/routes";
import type { Capability } from "./capabilityRegistry";

/**
 * The one capability the multi-provider feature adds to the catalog: contact data of companies from public pages, from «مصادر متاحة».
 * It exists ONLY while MULTI_PROVIDER_ENABLED is on; with the flag off `withMultiProviderCapabilities` returns the very same list it was
 * given. The price is not decided here: the unit cost below is a listing figure (the cheapest chain for a typical request); the quote
 * writer asks the router for the route of the actual request and prices THAT, with the one shared pricing rule.
 */
export function multiProviderListingCostUsd(): number {
  const costs = ROUTE_DEFS.filter((r) => r.kind === "chain")
    .map((route) => estimateRoute(route, { count: 10, requiredFields: ["work_email"] }))
    .filter((e) => e.sellable && e.costPerDeliveredRowUsd > 0)
    .map((e) => e.costPerDeliveredRowUsd);
  return costs.length ? Math.min(...costs) : 0;
}

export function buildMultiProviderCapability(): Capability {
  const unitCostUsd = multiProviderListingCostUsd();
  return {
    id: CHAIN_CAPABILITY_SLUG,
    slug: CHAIN_CAPABILITY_SLUG,
    platform: "companies",
    category: "companies",
    status: "verified",
    unit: "profile",
    nameAr: "بيانات تواصل الشركات من مصادر متاحة",
    nameEn: "Company contact data from available sources",
    descriptionAr: "نجد شركات حسب القطاع والدولة ثم نقرأ صفحاتها العامة (التواصل وعن الشركة والفريق) لنستخرج البريد المهني والهاتف التجاري، ولا نسلّم ولا نحتسب إلا السجلات التي تحققنا من الحقول المطلوبة فيها.",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: {
        industry: { type: "string", description: "قطاع الشركات المطلوبة" },
        country: { type: "string", description: "الدولة" },
        keyword: { type: "string", description: "كلمة تخصص النشاط (اختياري)" },
        requiredFields: { type: "array", items: { type: "string", enum: ["work_email", "office_phone", "profile_link", "decision_maker"] }, description: "الحقول المطلوب التحقق منها: work_email و office_phone تشترطان نجاح التحقق قبل التسليم" },
      },
      required: ["industry", "country"],
    }),
    tregEndpointId: "mp.business.contacts",
    tregMethod: "POST",
    pricingUnit: "item",
    unitCostUsd,
    estimatedCostUsdPerUnit: unitCostUsd,
    maxRows: 200,
    maxItemsPerCall: 10,
    paginationType: "cursor",
    estimatedSuccessRate: 0.35,
    enabled: unitCostUsd > 0,
    requiredInputs: ["country", "industry"],
  };
}

/** With the flag off: the SAME array, untouched. With it on: the list plus the chain capability (never twice). */
export function withMultiProviderCapabilities(list: Capability[], env: Record<string, string | undefined> = process.env): Capability[] {
  if (!multiProviderEnabled(env)) return list;
  if (list.some((c) => c.slug === CHAIN_CAPABILITY_SLUG)) return list;
  const capability = buildMultiProviderCapability();
  return capability.enabled ? [...list, capability] : list;
}
