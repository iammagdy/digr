import { detectCountryFromText, detectIndustryFromText } from "./planParameters";

export type CompanyPlanEditOperation =
  | { action: "set_param"; capabilitySlug: string; key: string; value: unknown };

/** Build edits independently of the keyword field so country and industry can be changed alone. */
export function buildCompanyPlanEditOperations(
  capabilitySlug: string,
  keyword: string,
  country: string,
  industry: string,
  previous?: { keyword?: string; country?: string; industry?: string },
): CompanyPlanEditOperation[] {
  const operations: CompanyPlanEditOperation[] = [];
  const cleanKeyword = keyword.trim();
  const countryInfo = detectCountryFromText(country);
  const industryInfo = detectIndustryFromText(industry);
  const query: Record<string, any> = {};
  const previousCountry = previous?.country ? detectCountryFromText(previous.country) : null;
  const previousIndustry = previous?.industry ? detectIndustryFromText(previous.industry) : null;
  const scopeChanged = Boolean(previous && (
    previousCountry?.canonicalEnglish !== countryInfo?.canonicalEnglish ||
    previousIndustry?.arabicLabel !== industryInfo.arabicLabel
  ));
  const staleInferredKeyword = scopeChanged && cleanKeyword === (previous?.keyword || "").trim();

  if (staleInferredKeyword) {
    operations.push({ action: "set_param", capabilitySlug, key: "search", value: industryInfo.arabicLabel });
  } else if (cleanKeyword && cleanKeyword !== "[object Object]") {
    query.keyword = { include: [cleanKeyword] };
    operations.push({ action: "set_param", capabilitySlug, key: "search", value: cleanKeyword });
  }
  if (countryInfo) {
    query.location = { include: [countryInfo.canonicalEnglish] };
    operations.push({ action: "set_param", capabilitySlug, key: "country", value: countryInfo.canonicalEnglish });
    operations.push({ action: "set_param", capabilitySlug, key: "location", value: countryInfo.canonicalEnglish });
  }
  if (industryInfo.arabicLabel !== "قواعد بيانات الشركات") {
    operations.push({ action: "set_param", capabilitySlug, key: "industry", value: industryInfo.arabicLabel });
    if (industryInfo.exactTaxonomy?.length) query.industry = { include: industryInfo.exactTaxonomy };
    if (!query.keyword && industryInfo.englishKeywords.length) {
      query.keyword = { include: industryInfo.englishKeywords };
    }
  }
  if (Object.keys(query).length > 0) {
    operations.push({ action: "set_param", capabilitySlug, key: "query", value: query });
  }
  return operations;
}
