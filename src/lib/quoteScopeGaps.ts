import { isSocialCapabilitySlug, validateSocialParams } from "./socialSources";
import {
  detectCountryFromText,
  detectIndustryFromText,
  industryDisplayLabelAr,
  socialContentTopicFromTitle,
} from "./planParameters";

export interface PlanScopeChip {
  label: string;
  value: string;
}

const countryNamesAr = new Intl.DisplayNames(["ar"], { type: "region" });

function resolveCountryAr(val: unknown): string {
  const text = String(val ?? "").trim();
  if (!text) return "يلزم تحديد الدولة";
  const detected = detectCountryFromText(text);
  if (detected?.arabicLabel) return detected.arabicLabel;
  if (/^[A-Z]{2}$/i.test(text)) {
    try {
      const ar = countryNamesAr.of(text.toUpperCase());
      if (ar && ar.toUpperCase() !== text.toUpperCase()) return ar;
    } catch {
      // fallback
    }
  }
  return text;
}

/**
 * Converts English digits (0-9) to Arabic-Indic digits (٠-٩).
 */
export function toArabicDigits(val: number | string): string {
  const digits = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
  return String(val).replace(/[0-9]/g, (d) => digits[Number(d)]);
}

function hasPlaceholderText(val: unknown): boolean {
  if (typeof val === "string") {
    return /يلزم تحديد/.test(val);
  }
  if (Array.isArray(val)) {
    return val.some(hasPlaceholderText);
  }
  if (val && typeof val === "object") {
    return Object.values(val).some(hasPlaceholderText);
  }
  return false;
}

/**
 * Evaluates whether a plan's items have missing required parameters (scope gaps).
 * Pure function, shared client/server.
 * Returns array of gap codes: "country" | "industry" | "title" | "social_params" | "placeholder" | "empty_plan".
 */
export function quoteScopeGaps(
  items: Array<{
    capabilitySlug?: string;
    endpointId?: string;
    slug?: string;
    params?: Record<string, any>;
    targetVolumeMax?: number;
    [key: string]: any;
  }> | undefined | null
): string[] {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return ["empty_plan"];
  }

  const gaps: string[] = [];

  for (const item of items) {
    // 1. Placeholder check: any param string matching /يلزم تحديد/ -> placeholder
    if (hasPlaceholderText(item.params) || hasPlaceholderText((item as any).query)) {
      gaps.push("placeholder");
    }

    const slug = String(item.capabilitySlug || item.endpointId || item.slug || "").toLowerCase();
    const params = item.params || {};
    const query = (params.query && typeof params.query === "object" ? params.query : (item as any).query) || {};

    const isCompany = /compan|b2b/i.test(slug);
    const isPeople = slug.includes("people");
    const isSocial = isSocialCapabilitySlug(item.capabilitySlug || slug);

    if (isCompany) {
      // company -> needs query.location.include[0] non-empty AND (query.industry.include or query.keyword.include)
      const locInclude = query.location?.include;
      const hasLocation =
        Array.isArray(locInclude)
          ? locInclude.length > 0 && typeof locInclude[0] === "string" && locInclude[0].trim().length > 0 && !/يلزم تحديد/.test(locInclude[0])
          : (typeof params.location === "string" && params.location.trim().length > 0 && !/يلزم تحديد/.test(params.location)) ||
            (typeof params.country === "string" && params.country.trim().length > 0 && !/يلزم تحديد/.test(params.country));

      if (!hasLocation) {
        gaps.push("country");
      }

      const indInclude = query.industry?.include;
      const kwInclude = query.keyword?.include || query.keywords?.include;
      const hasIndustry =
        (Array.isArray(indInclude) && indInclude.some((x: any) => typeof x === "string" && x.trim().length > 0 && !/يلزم تحديد/.test(x))) ||
        (typeof params.industry === "string" && params.industry.trim().length > 0 && !/يلزم تحديد/.test(params.industry));
      const hasKeyword =
        (Array.isArray(kwInclude) && kwInclude.some((x: any) => typeof x === "string" && x.trim().length > 0 && !/يلزم تحديد/.test(x))) ||
        (typeof params.keyword === "string" && params.keyword.trim().length > 0 && !/يلزم تحديد/.test(params.keyword)) ||
        (typeof params.keywords === "string" && params.keywords.trim().length > 0 && !/يلزم تحديد/.test(params.keywords));

      if (!hasIndustry && !hasKeyword) {
        gaps.push("industry");
      }
    } else if (isPeople) {
      // people -> country and (title or keywords)
      const countryVal = params.country || params.location || query.location?.include?.[0];
      const hasCountry = typeof countryVal === "string" && countryVal.trim().length > 0 && !/يلزم تحديد/.test(countryVal);
      if (!hasCountry) {
        gaps.push("country");
      }

      const titleVal = params.title || params.jobTitle || query.title || query.jobTitle?.include?.[0];
      const kwVal = params.keywords || params.keyword || query.keywords || query.keyword?.include?.[0];
      const hasTitle =
        (typeof titleVal === "string" && titleVal.trim().length > 0 && !/يلزم تحديد/.test(titleVal)) ||
        (Array.isArray(titleVal) && titleVal.length > 0 && titleVal.some((t: any) => typeof t === "string" && t.trim().length > 0 && !/يلزم تحديد/.test(t)));
      const hasKeywords =
        (typeof kwVal === "string" && kwVal.trim().length > 0 && !/يلزم تحديد/.test(kwVal)) ||
        (Array.isArray(kwVal) && kwVal.length > 0 && kwVal.some((k: any) => typeof k === "string" && k.trim().length > 0 && !/يلزم تحديد/.test(k)));
      const isDecisionMakers = Array.isArray(params.requiredContactFields) && params.requiredContactFields.length > 0;

      if (!hasTitle && !hasKeywords && !isDecisionMakers) {
        gaps.push("title");
      }
    } else if (isSocial) {
      // social -> validateSocialParams
      const socialErr = validateSocialParams(item.capabilitySlug || slug, params);
      if (socialErr) {
        gaps.push("social_params");
      }
    }
  }

  return Array.from(new Set(gaps));
}

/**
 * Returns the scope chips to display on the plan card.
 * Country chip only for company/people plans or when params.region exists;
 * social without region shows no country chip.
 * For tweets (social-x-posts), returns exactly 2 chips (topic, volume) without "الدولة".
 */
export function planScopeRows(
  items: Array<{
    capabilitySlug?: string;
    endpointId?: string;
    slug?: string;
    params?: Record<string, any>;
    targetVolumeMax?: number;
    volume?: number;
    [key: string]: any;
  }> | undefined | null,
  conversationTitle?: string
): PlanScopeChip[] {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return [];
  }

  const primary = items[0];
  const slug = String(primary.capabilitySlug || primary.endpointId || primary.slug || "").toLowerCase();
  const params = primary.params || {};
  const query = (params.query && typeof params.query === "object" ? params.query : (primary as any).query) || {};

  const isCompany = /compan|b2b/i.test(slug);
  const isPeople = slug.includes("people");
  const isSocial = isSocialCapabilitySlug(primary.capabilitySlug || slug) || /social|tiktok|youtube|facebook|instagram|x-posts|twitter|reddit/i.test(slug);

  const chips: PlanScopeChip[] = [];

  // Country chip: ONLY for company/people plans or when params.region exists; social without region shows no country chip.
  const hasRegion = Boolean(params.region);
  const shouldShowCountry = isCompany || isPeople || hasRegion;

  if (shouldShowCountry) {
    let countryDisplay = "";
    if (hasRegion) {
      countryDisplay = resolveCountryAr(params.region);
    } else {
      const rawCountry = query.location?.include?.[0] || params.location || params.country;
      countryDisplay = resolveCountryAr(rawCountry);
    }
    chips.push({
      label: "الدولة / النطاق:",
      value: countryDisplay,
    });
  }

  // Scope / Topic / Industry chip
  if (isPeople) {
    const titleVal = params.title || params.jobTitle || query.title || query.jobTitle?.include?.[0];
    const kwVal = params.keywords || params.keyword || query.keywords || query.keyword?.include?.[0];
    const scopeVal =
      (typeof titleVal === "string" && titleVal.trim()) ||
      (typeof kwVal === "string" && kwVal.trim()) ||
      "صناع القرار والمهنيون";
    chips.push({
      label: "نوع البحث:",
      value: scopeVal,
    });
  } else if (isSocial) {
    const rawVal =
      params.query ||
      params.channel ||
      params.url ||
      (conversationTitle ? socialContentTopicFromTitle(conversationTitle) : "") ||
      "الموضوع المطلوب";
    chips.push({
      label: "موضوع المحتوى:",
      value: String(rawVal).trim(),
    });
  } else {
    // Company or general
    const rawInd =
      query.industry?.include?.[0] ||
      params.industry ||
      query.keyword?.include?.[0] ||
      params.keyword ||
      params.search ||
      "النشاط المطلوب";
    const detectedInd = detectIndustryFromText(String(rawInd));
    const indVal = detectedInd?.arabicLabel || industryDisplayLabelAr(String(rawInd));
    chips.push({
      label: "النشاط / التخصص:",
      value: indVal,
    });
  }

  // Volume chip
  const vol = primary.targetVolumeMax || primary.volume || (primary.params && primary.params.count) || 1;
  chips.push({
    label: "العدد المطلوب:",
    value: `حتى ${toArabicDigits(vol)} سجل`,
  });

  return chips;
}
