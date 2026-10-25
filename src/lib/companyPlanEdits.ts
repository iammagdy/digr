import { detectCountryFromText, detectIndustryFromText, isoCountryCodeFromName } from "./planParameters";

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

/** The generic phrase a decision-makers card shows in the «نوع البحث» field when no job title was given: never a title to send. */
const PEOPLE_GENERIC_SCOPE = "صناع القرار والمهنيون";

/**
 * Edits of a decision-makers plan. The country is stored as the ISO code its parameters use (it used to be dropped on save, so the plan still
 * showed the old country after reopening), and the job-title field changes the title (it used to write a «query» the service does not read).
 */
export function buildPeoplePlanEditOperations(capabilitySlug: string, title: string, country: string): CompanyPlanEditOperation[] {
  const operations: CompanyPlanEditOperation[] = [];
  const countryInfo = detectCountryFromText(country);
  const iso = countryInfo ? isoCountryCodeFromName(countryInfo.canonicalEnglish) : /^[A-Za-z]{2}$/.test(country.trim()) ? country.trim().toUpperCase() : undefined;
  if (iso) operations.push({ action: "set_param", capabilitySlug, key: "country", value: iso });
  const cleanTitle = title.trim();
  if (cleanTitle && cleanTitle !== PEOPLE_GENERIC_SCOPE && cleanTitle !== "[object Object]") operations.push({ action: "set_param", capabilitySlug, key: "title", value: cleanTitle });
  return operations;
}

/** A social plan that carries a region (its country filter): the edited country replaces it. */
export function buildSocialRegionEditOperations(capabilitySlug: string, country: string): CompanyPlanEditOperation[] {
  const countryInfo = detectCountryFromText(country);
  const iso = countryInfo ? isoCountryCodeFromName(countryInfo.canonicalEnglish) : undefined;
  return iso ? [{ action: "set_param", capabilitySlug, key: "region", value: iso }] : [];
}

/** The parameters a plan can carry its country in (a company search, a decision-makers search, a social region filter, a generic service's location). */
const COUNTRY_PARAM_KEYS = ["country", "countryCode", "region", "regionCode", "location", "geo"] as const;
const ISO_COUNTRY_PARAM_KEYS = new Set<string>(["countryCode", "region", "regionCode", "geo"]);

/** The country parameters a plan really has (present in its parameters, even when empty): when there is one, the editor offers the country field. */
export function planCountryParamKeys(params: Record<string, unknown> | null | undefined): string[] {
  if (!params || typeof params !== "object") return [];
  const keys: string[] = COUNTRY_PARAM_KEYS.filter((key) => key in params);
  const query = params.query as { location?: unknown } | undefined;
  if (query && typeof query === "object" && "location" in query && !keys.includes("location")) keys.push("location");
  return keys;
}

/**
 * Edits of the country of a plan that no other builder owns (a service with its own country or location parameter): each parameter the plan has
 * is rewritten in the form it already uses (an ISO code for a code field, the English name for a name field). A country no rule reads changes nothing.
 */
export function buildGenericCountryEditOperations(capabilitySlug: string, country: string, params: Record<string, unknown> | null | undefined): CompanyPlanEditOperation[] {
  const countryInfo = detectCountryFromText(country);
  if (!countryInfo) return [];
  const iso = isoCountryCodeFromName(countryInfo.canonicalEnglish);
  const operations: CompanyPlanEditOperation[] = [];
  for (const key of planCountryParamKeys(params)) {
    const existing = typeof params?.[key] === "string" ? String(params?.[key]) : "";
    const isoField = ISO_COUNTRY_PARAM_KEYS.has(key) || /^[A-Za-z]{2}$/.test(existing.trim());
    const value = isoField ? iso : countryInfo.canonicalEnglish;
    if (value) operations.push({ action: "set_param", capabilitySlug, key, value });
  }
  return operations;
}
